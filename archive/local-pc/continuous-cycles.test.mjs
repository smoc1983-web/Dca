import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {main} from './watchlist-runtime.mjs';
import {newState,DEFAULTS} from './watchlist-engine.mjs';

async function fixture(activatedAt,run){
  const app=fs.mkdtempSync(path.join(os.tmpdir(),'DCA800-continuous-')),data=path.join(app,'data');
  fs.mkdirSync(data);
  const oldArg=process.argv[2],messages=[],atomic=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
  const p={...DEFAULTS,symbol:'AAAUSDT',baseAsset:'AAA',quoteAsset:'USDT',signalOnly:true};
  const s=newState(p);
  Object.assign(s,{lastTime:0,previousClose:100,ema:100,emas:[100,100,100,100,100],changes:14,gain:1,loss:2,rsi:31});
  const config={serviceDirectory:app,ownerComputer:os.hostname(),runtimeDirectory:'data',mode:'live',maxSignalAgeSeconds:180,pollSeconds:20,watchlist:{budgetMode:'signals',totalBudget:800,maxUsage:.7,maxActiveCycles:null}};
  const seed={version:2,activatedAt,portfolio:{cash:800,usedAsSharedWallet:false},outbox:[],cycleSync:{source:'fixture-chart',checkedAt:'1970-01-01T00:00:00Z'},entries:{'AAAUSDT:5m':{symbol:'AAAUSDT',tf:'5m',params:p,s,entryEnabled:true,legacy:false,cycleSync:{source:'fixture-chart'}}}};
  atomic(path.join(app,'config.json'),config);atomic(path.join(data,'watchlist-state.json'),seed);
  let now=900001;
  const bars=new Map([[300000,90],[600000,85],[900000,83],[1200000,91]]);
  const bridge=async r=>{
    if(r.operation==='telegram'){messages.push(r);return {message_id:100+messages.length};}
    if(r.endpoint==='time')return {serverTime:now};
    assert.equal(r.endpoint,'klines');
    const rows=[];for(let t=r.parameters.startTime;t<=r.parameters.endTime;t+=300000){const price=bars.get(t);assert.ok(price,'test candle '+t);rows.push([t,price,price,price,price,1,t+299999]);}return rows;
  };
  const once=async nextNow=>{if(nextNow!==undefined)now=nextNow;process.argv[2]='--once';const previousExitListeners=new Set(process.listeners('exit'));try{await main({app,bridge,atomic});}finally{const lock=path.join(data,'process.lock');if(fs.existsSync(lock))fs.unlinkSync(lock);for(const listener of process.listeners('exit'))if(!previousExitListeners.has(listener))process.removeListener('exit',listener);}};
  const read=()=>JSON.parse(fs.readFileSync(path.join(data,'watchlist-state.json'),'utf8'));
  try{await run({app,data,messages,once,read,bridge,atomic,config});}
  finally{process.argv[2]=oldArg;fs.rmSync(app,{recursive:true,force:true});}
}

for(const activatedAt of [0,800000]){
  test('offline START reconstructs cycle and fresh DCA1 sends once; activation cutoff '+activatedAt,async()=>{
    await fixture(activatedAt,async({app,messages,once,read})=>{
      await once();
      let state=read();assert.equal(state.entries['AAAUSDT:5m'].s.dca,1);
      assert.equal(state.entries['AAAUSDT:5m'].s.invested,62.5);
      assert.equal(messages.length,1);assert.match(messages[0].text,/DCA1/);
      assert.equal(state.outbox.find(x=>x.event.kind==='DCA1').status,'delivered');
      const oldStart=state.outbox.find(x=>x.event.kind==='START');
      if(activatedAt===0)assert.equal(oldStart.status,'expired');else assert.equal(oldStart,undefined);
      const status=JSON.parse(fs.readFileSync(path.join(app,'status.json'),'utf8'));
      assert.equal(status.cycleSync.source,'fixture-chart');
      assert.equal(status.timeframes['AAAUSDT:5m'].nextDca.number,2);
      assert.equal(status.timeframes['AAAUSDT:5m'].nextDca.budget,56.25);
      assert.equal(status.timeframes['AAAUSDT:5m'].cycleSync.source,'fixture-chart');
      await once();assert.equal(messages.length,1,'restart never resends the same event');
      await once(1200001);assert.equal(read().entries['AAAUSDT:5m'].s.dca,1);assert.equal(messages.length,1);
      await once(1500001);state=read();assert.equal(state.entries['AAAUSDT:5m'].s.qty,0);assert.equal(messages.length,2);assert.match(messages[1].text,/ТЕЙК-ПРОФИТ/);
      await once();assert.equal(messages.length,2,'TP delivery also persists over restart');
    });
  });
}

test('stale DCA still advances state but is never delivered as a current order',async()=>{
  await fixture(0,async({messages,once,read})=>{
    await once(1200001);
    const state=read();assert.equal(state.entries['AAAUSDT:5m'].s.dca,1);
    assert.equal(messages.length,0);assert.deepEqual(state.outbox.map(x=>[x.event.kind,x.status]),[['START','expired'],['DCA1','expired']]);
    await once();assert.equal(messages.length,0);
  });
});

test('signals preparation refuses an implicit flat warmup before reading market or legacy state',async()=>{
  await fixture(0,async({app,data,atomic})=>{
    fs.unlinkSync(path.join(data,'watchlist-state.json'));process.argv[2]='--prepare';let calls=0;
    await assert.rejects(main({app,atomic,bridge:async()=>{calls++;throw Error('must not access transport');}}),/validated historical-cycle seed or replay anchor/);
    assert.equal(calls,0);assert.equal(fs.existsSync(path.join(data,'watchlist-state.json')),false);
  });
});

test('installation guard prevents a replay and any Telegram delivery',async()=>{
  await fixture(0,async({app,messages,once,read})=>{
    fs.writeFileSync(path.join(app,'INSTALLATION-PENDING.json'),'{}');
    await assert.rejects(once(),/install|pending|activation/i);
    assert.equal(messages.length,0);assert.equal(read().entries['AAAUSDT:5m'].s.lastTime,0);
  });
});
