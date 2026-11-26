import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {main} from './watchlist-runtime.mjs';import {newState,intervalMs} from './watchlist-engine.mjs';
const markets=JSON.parse(fs.readFileSync('C:/Users/USER/Documents/DCA800Notifications/markets.json','utf8'));
const current=JSON.parse(fs.readFileSync('C:/Users/USER/Documents/DCA800Notifications/data/watchlist-state.json','utf8'));
const prices=Object.fromEntries(Object.values(current.entries).map(e=>[e.symbol,e.s.previousClose]));
for(const scenario of [{kind:'START',ratio:.9,qty:0},{kind:'DCA1',ratio:.95,qty:1},{kind:'TP',ratio:1.03,qty:1}]){
  test('all '+markets.length+' configured pairs deliver '+scenario.kind+' independently, using each configured timeframe, without duplicates',async()=>{
    const app=fs.mkdtempSync(path.join(os.tmpdir(),'DCA800-all20-')),data=path.join(app,'data');fs.mkdirSync(data);const oldArg=process.argv[2];
    const end=5400000,state={version:2,activatedAt:0,portfolio:{cash:800},outbox:[],entries:{}},messages=[];
    const atomic=(file,obj)=>fs.writeFileSync(file,JSON.stringify(obj));
    for(const market of markets){const p={...market.params,signalOnly:true},s=newState(p),step=intervalMs(market.tf),base=prices[market.symbol];
      Object.assign(s,{lastTime:end-2*step,previousClose:base,ema:base,emas:[base,base,base,base,base],changes:14,gain:base/100,loss:base/50,rsi:31,qty:scenario.qty?100/base:0,average:scenario.qty?base:0,invested:scenario.qty?100:0,lastEntry:scenario.qty?base:null,cash:scenario.qty?700:800,cycleEquity:scenario.qty?800:null});
      state.entries[market.symbol+':'+market.tf]={symbol:market.symbol,tf:market.tf,params:p,s,entryEnabled:true,legacy:false};
    }
    atomic(path.join(data,'watchlist-state.json'),state);atomic(path.join(app,'config.json'),{serviceDirectory:app,ownerComputer:os.hostname(),runtimeDirectory:'data',mode:'live',maxSignalAgeSeconds:180,pollSeconds:20,watchlist:{budgetMode:'signals',totalBudget:800,maxUsage:.7,maxActiveCycles:null}});
    const bridge=async r=>{
      if(r.operation==='telegram'){messages.push(r);return {message_id:messages.length};}
      if(r.endpoint==='time')return {serverTime:end+1};
      const p=r.parameters,step=intervalMs(p.interval),rows=[],price=prices[p.symbol]*scenario.ratio;for(let t=p.startTime;t<=p.endTime;t+=step)rows.push([t,price,price,price,price,1,t+step-1]);return rows;
    };
    try{
      process.argv[2]='--once';await main({app,bridge,atomic});fs.unlinkSync(path.join(data,'process.lock'));
      assert.equal(messages.length,markets.length);const saved=JSON.parse(fs.readFileSync(path.join(data,'watchlist-state.json')));assert.equal(saved.outbox.length,markets.length);
      for(const market of markets){const item=saved.outbox.find(x=>x.id.startsWith(market.symbol+':'+market.tf+':'));assert.ok(item,market.symbol);assert.equal(item.event.kind,scenario.kind);assert.equal(item.status,'delivered');assert.match(item.text,/НАБЛЮДЕНИЕ/);assert.ok(item.text.includes(market.symbol));assert.ok(item.text.includes('ТФ: '+market.tf.slice(0,-1)+' '+(market.tf.endsWith('m')?'мин':'ч')));}
      await main({app,bridge,atomic});fs.unlinkSync(path.join(data,'process.lock'));assert.equal(messages.length,markets.length);
      assert.equal(JSON.parse(fs.readFileSync(path.join(app,'status.json'))).maxActiveCycles,null);
    }finally{process.argv[2]=oldArg;fs.rmSync(app,{recursive:true,force:true});}
  });
}
