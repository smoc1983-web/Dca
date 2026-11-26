import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {main} from 'file:///C:/Users/USER/Documents/DCA800Notifications/watchlist-runtime.mjs';
import {newState,DEFAULTS} from 'file:///C:/Users/USER/Documents/DCA800Notifications/watchlist-engine.mjs';
for(const scenario of [{kind:'START',price:90,qty:0,label:'СТАРТ'},{kind:'DCA1',price:95,qty:1,label:'УСРЕДНЕНИЕ DCA1'},{kind:'TP',price:103,qty:1,label:'ТЕЙК-ПРОФИТ'}]){
  test('complete '+scenario.kind+' pipeline persists one delivery and does not resend the same candle',async()=>{
    const app=fs.mkdtempSync(path.join(os.tmpdir(),'DCA800-flow-')),data=path.join(app,'data');fs.mkdirSync(data);
    const atomic=(file,obj)=>fs.writeFileSync(file,JSON.stringify(obj));const oldArg=process.argv[2],p={...DEFAULTS,symbol:'AAAUSDT',baseAsset:'AAA',quoteAsset:'USDT'};
    const s=newState(p);Object.assign(s,{lastTime:0,previousClose:100,ema:100,emas:[100,100,100,100,100],changes:14,gain:1,loss:2,rsi:31,qty:scenario.qty,average:scenario.qty?100:0,invested:scenario.qty?100:0,lastEntry:scenario.qty?100:null,cash:scenario.qty?700:800,cycleEquity:scenario.qty?800:null});
    atomic(path.join(app,'config.json'),{serviceDirectory:app,ownerComputer:os.hostname(),runtimeDirectory:'data',mode:'live',maxSignalAgeSeconds:180,pollSeconds:20,watchlist:{budgetMode:'shared',totalBudget:800,maxUsage:.7,maxActiveCycles:1}});
    atomic(path.join(data,'watchlist-state.json'),{version:2,activatedAt:0,portfolio:{cash:s.cash},outbox:[],entries:{'AAAUSDT:5m':{symbol:'AAAUSDT',tf:'5m',params:p,s,entryEnabled:true,legacy:false}}});
    const requests=[];const bridge=async r=>{
      if(r.operation==='telegram'){requests.push(r);return {message_id:100+requests.length};}
      if(r.endpoint==='time')return {serverTime:600001};
      return [[300000,scenario.price,scenario.price,scenario.price,scenario.price,1,599999]];
    };
    try{
      process.argv[2]='--once';await main({app,bridge,atomic});fs.unlinkSync(path.join(data,'process.lock'));
      assert.equal(requests.length,1);assert.match(requests[0].text,new RegExp(scenario.label));assert.match(requests[0].text,/ТФ: 5 мин/);
      const persisted=JSON.parse(fs.readFileSync(path.join(data,'watchlist-state.json')));assert.equal(persisted.outbox[0].status,'delivered');assert.equal(persisted.outbox[0].event.kind,scenario.kind);
      await main({app,bridge,atomic});fs.unlinkSync(path.join(data,'process.lock'));assert.equal(requests.length,1);
    }finally{process.argv[2]=oldArg;fs.rmSync(app,{recursive:true,force:true});}
  });
}
