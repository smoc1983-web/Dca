import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DEFAULTS,newState,advance,message} from './watchlist-engine.mjs';
import {stepEntry,queue,fetchBars,main} from './watchlist-runtime.mjs';
import {aggregate} from './research.mjs';
const bar=(time,close)=>({time,closeTime:time+3600000-1,open:close,high:close,low:close,close});
test('new engine preserves original UNI calculations when symbol filters and slippage are unchanged',async()=>{
  const old=await import('./reference-engine.mjs');const a=old.newState(),b=newState();
  for(let i=0;i<5000;i++){
    const c=bar(i*3600000,7+2*Math.sin(i/27)+.6*Math.sin(i/4));
    const x=old.advance(a,c),y=advance(b,c);
    assert.equal(x?.event?.kind,y?.event?.kind);assert.deepEqual(a,b);
  }
});
test('BTC quantity step permits a small dollar DCA; message contains BTC and correct timeframe',()=>{
  const p={...DEFAULTS,symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',tick:.01,qtyStep:.00001};
  const s=newState(p);Object.assign(s,{qty:.001,average:100000,lastEntry:100000,invested:100,cash:700,cycleEquity:800});
  const event=advance(s,bar(0,95000),p).event;
  assert.equal(event.kind,'DCA1');assert.ok(event.quantity>0);assert.match(event.id,/BTCUSDT/);
  const text=message('4h',event,p);assert.match(text,/BTCUSDT/);assert.match(text,/4 ч/);assert.match(text,/37.50 USDT/);assert.match(text,/Новый TP/);
});
test('shared allocation and wallet cash reject unaffordable DCA without rejecting indicator updates',()=>{
  const p={...DEFAULTS,symbol:'AAAUSDT'},s=newState();Object.assign(s,{qty:10,average:7,lastEntry:7,invested:70,cash:730,cycleEquity:800});
  const state={portfolio:{cash:30},entries:{a:{symbol:'AAAUSDT',tf:'1h',params:p,s,entryEnabled:true}}};
  assert.equal(stepEntry(state,'a',bar(0,6.65),{budgetMode:'shared',totalBudget:100,maxUsage:.7}),null);
  assert.equal(s.qty,10);assert.equal(s.lastTime,0);assert.equal(state.portfolio.cash,30);
});
test('TP is an explicit alert with asset, timeframe and stable duplicate protection',()=>{
  const p={...DEFAULTS,symbol:'SOLUSDT',baseAsset:'SOL',quoteAsset:'USDT'},s=newState();Object.assign(s,{qty:1,average:7,cash:793,invested:7,lastEntry:7,cycleEquity:800});
  const event=advance(s,bar(0,7.21),p).event;assert.equal(event.kind,'TP');
  const state={activatedAt:0,outbox:[]},entry={tf:'1h',params:p};
  queue(state,entry,event,event.closeTime+1,180);queue(state,entry,event,event.closeTime+1,180);
  assert.equal(state.outbox.length,1);assert.match(state.outbox[0].text,/ТЕЙК-ПРОФИТ/);assert.match(state.outbox[0].text,/SOLUSDT/);
  const late={activatedAt:0,outbox:[]};queue(late,entry,event,event.closeTime+181000,180);assert.equal(late.outbox[0].status,'expired');
});
test('45 minute aggregation is UTC aligned and drops an incomplete final bar',()=>{
  const rows=Array.from({length:11},(_,i)=>[i*300000,10+i,11+i,9+i,10.5+i]);
  const bars=aggregate(rows,'45m');assert.equal(bars.length,1);assert.equal(bars[0].time,0);assert.equal(bars[0].closeTime,2700000-1);assert.equal(bars[0].close,18.5);
});
test('runtime custom timeframe requests the correct base and rejects a gap',async()=>{
  const rows=Array.from({length:3},(_,i)=>[i*900000,7,8,6,7,1,(i+1)*900000-1]);
  let requested;
  const bridge=async r=>{requested=r.parameters;return rows;};
  const bars=await fetchBars(bridge,'LDOUSDT','45m',0,2700000);assert.equal(requested.interval,'15m');assert.equal(bars.length,1);
  rows[1][0]++;await assert.rejects(()=>fetchBars(bridge,'LDOUSDT','45m',0,2700000),/Gap/);
});
test('shared single-cycle mode suppresses other starts and still permits DCA on the active position',()=>{
  const p={...DEFAULTS,symbol:'AAAUSDT'},flat=newState(p),active=newState(p);
  Object.assign(flat,{lastTime:0,previousClose:100,ema:100,emas:[100,100,100,100,100],changes:14,gain:1,loss:2,rsi:31});
  Object.assign(active,{qty:1,average:100,lastEntry:100,invested:100,cash:700,cycleEquity:800});
  const state={portfolio:{cash:700},entries:{a:{symbol:'AAAUSDT',tf:'1h',params:p,s:active,entryEnabled:true},b:{symbol:'BBBUSDT',tf:'1h',params:p,s:flat,entryEnabled:true}}};
  const settings={budgetMode:'shared',totalBudget:800,maxUsage:.7,maxActiveCycles:1};
  assert.equal(stepEntry(state,'b',bar(3600000,90),settings),null);assert.equal(flat.qty,0);
  assert.equal(stepEntry(state,'a',bar(0,95),settings).kind,'DCA1');assert.ok(active.qty>1);
});
test('migration retains both old UNI positions, warms new symbols flat and diagnose never writes or sends',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'DCA800-test-')),app=path.join(root,'Документы теста'),runtime=path.join(app,'data');fs.mkdirSync(runtime,{recursive:true});
  const atomic=(file,data)=>fs.writeFileSync(file,JSON.stringify(data));const oldArg=process.argv[2];
  const now=Math.floor(Date.parse('2026-11-01T12:00:00Z')/3600000)*3600000+1000;
  const mk=(tf,qty)=>{const s=newState();Object.assign(s,{lastTime:now-1000-({ '15m':900000,'1h':3600000}[tf]),previousClose:7,ema:7,qty,average:7,lastEntry:7,invested:qty*7,cash:800-qty*7,cycleEquity:800});return s;};
  const old={engines:{'15m':mk('15m',1),'1h':mk('1h',2)},outbox:[{id:'delivered-before',status:'delivered',message_id:42},{id:'interrupted',status:'sending'}]};
  atomic(path.join(runtime,'state.json'),old);const original=fs.readFileSync(path.join(runtime,'state.json'),'utf8');
  const config={ownerComputer:os.hostname(),serviceDirectory:app,runtimeDirectory:'data',mode:'live',maxSignalAgeSeconds:180,pollSeconds:20,watchlist:{budgetMode:'shared',totalBudget:800,maxUsage:.7,maxActiveCycles:1}};
  atomic(path.join(app,'config.json'),config);atomic(path.join(app,'markets.json'),[{symbol:'BTCUSDT',tf:'5m',params:{...DEFAULTS,symbol:'BTCUSDT'},enabled:true},{symbol:'UNIUSDT',tf:'15m',params:{...DEFAULTS,symbol:'UNIUSDT',qtyStep:.01},enabled:true}]);
  let sends=0;const bridge=async r=>{
    if(r.operation==='telegram'){assert.equal(r.method,'getMe');return {id:8949218869};}
    if(r.endpoint==='time')return {serverTime:now};
    const p=r.parameters,step=({'5m':300000,'15m':900000,'1h':3600000})[p.interval],rows=[];
    for(let t=p.startTime;t<=p.endTime;t+=step)rows.push([t,7,7,7,7,1,t+step-1]);return rows;
  };
  try{
    process.argv[2]='--prepare';await main({app,bridge,atomic});const prepared=JSON.parse(fs.readFileSync(path.join(runtime,'watchlist-state.json')));
    assert.equal(prepared.entries['BTCUSDT:5m'].s.qty,0);assert.deepEqual(prepared.entries['UNIUSDT:15m'].s,old.engines['15m']);assert.deepEqual(prepared.entries['UNIUSDT:1h'].s,old.engines['1h']);
    assert.equal(prepared.entries['UNIUSDT:15m'].legacy,true);assert.equal(prepared.entries['UNIUSDT:1h'].entryEnabled,false);assert.equal(prepared.portfolio.cash,779);
    assert.equal(prepared.outbox[0].message_id,42);assert.equal(prepared.outbox[1].status,'uncertain');
    const before=fs.readFileSync(path.join(runtime,'watchlist-state.json'),'utf8');process.argv[2]='--diagnose';await main({app,bridge,atomic});assert.equal(fs.readFileSync(path.join(runtime,'watchlist-state.json'),'utf8'),before);assert.equal(fs.existsSync(path.join(app,'status.json')),false);
    process.argv[2]='--once';await main({app,bridge,atomic});assert.equal(JSON.parse(fs.readFileSync(path.join(app,'status.json'))).health,'ok');assert.equal(fs.readFileSync(path.join(runtime,'state.json'),'utf8'),original);assert.equal(sends,0);
    assert.equal(fs.existsSync(path.join(runtime,'process.lock')),true);fs.unlinkSync(path.join(runtime,'process.lock'));
    await assert.rejects(async()=>{process.argv[2]='--prepare';await main({app,bridge,atomic});},/exists/);
  }finally{process.argv[2]=oldArg;fs.rmSync(root,{recursive:true,force:true});}
});
