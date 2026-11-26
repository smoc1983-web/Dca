import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {DEFAULTS,newState,intervalMs} from '../cloudflare/watchlist-engine.mjs';
import {TradeLedgerStore} from '../cloudflare/trade-store.mjs';
import {prepareModelStep,recordModelStep} from '../cloudflare/model-ledger.mjs';
import {executionsCsv,cyclesCsv} from '../cloudflare/ledger-csv.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8, String(a)+' != '+String(b));
const step=intervalMs('5m'),tf='5m',modelId='test-v1';
const params={...DEFAULTS,symbol:'ADAUSDT',tick:.0001,qtyStep:.000001,slippageBps:2};
const schema=readFileSync(new URL('../cloudflare/trade-ledger-schema.sql',import.meta.url),'utf8');
function fixture(t){
  const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());
  const port={prepare(sql){let args=[];return {bind(...v){args=v;return this;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}};
  return new TradeLedgerStore(port);
}
const bar=(time,price)=>({time,closeTime:time+step-1,open:price,high:price,low:price,close:price});
const input=(state,candle,p=params,id=modelId)=>({state,candle,params:p,tf,modelId:id});
async function start(store,p=params){
  let s=newState(p);
  // Warm up with rising prices; a single sharp decline crosses RSI below 30 without exceeding crash filter.
  for(let i=0;i<20;i++)s=(await recordModelStep(store,input(s,bar(i*step,100+i*.1),p))).state;
  const before=s,c=bar(20*step,95);
  const r=await recordModelStep(store,input(s,c,p));
  assert.equal(r.event.kind,'START');return {before,c,r};
}
async function full(t,exit){
  const store=fixture(t),p=exit==='STOP'?{...params,emergency:.4}:params;
  let {r}=await start(store,p),s=r.state;
  for(let i=0;i<5;i++){
    const price=s.lastEntry*(1-p.drops[i])*(1-1e-7);
    r=await recordModelStep(store,input(s,bar(s.lastTime+step,price),p));
    assert.equal(r.event.kind,'DCA'+(i+1));s=r.state;
    const [cycle]=(await store.snapshot()).cycles;
    near(cycle.quantity,s.qty);near(cycle.averageEntry,s.average);near(cycle.cost,p.initialCapital-s.cash);
  }
  const price=exit==='STOP'?1:s.average*1.031;
  r=await recordModelStep(store,input(s,bar(s.lastTime+step,price),p));
  assert.equal(r.event.kind,exit);
  const snap=await store.snapshot(),[c]=snap.cycles;
  assert.equal(snap.executions.length,7);assert.equal(c.quantity,0);near(c.realized,r.state.cash-p.initialCapital);
  assert.equal(c.durationMs,6*step);assert.ok(c.feesQuote>0);
  return {store,snap};
}
test('real engine START to DCA5 to TP: ledger reconciles cash, quantity and fees',async t=>{const {snap}=await full(t,'TP');assert.ok(snap.cycles[0].realized>0);});
test('real engine START to DCA5 to STOP: ledger records net loss',async t=>{const {snap}=await full(t,'STOP');assert.ok(snap.cycles[0].realized<0);});
test('replay after commit without cursor update is idempotent; input state untouched',async t=>{
  const store=fixture(t),{before,c,r}=await start(store),copy=structuredClone(before);
  const retry=await recordModelStep(store,input(before,c));
  assert.deepEqual(retry.state,r.state);assert.deepEqual(before,copy);assert.equal((await store.snapshot()).executions.length,1);
  assert.equal((await recordModelStep(store,input(r.state,c))).event,null);
});
test('storage failure does not mutate input cursor; missing historical START rejected',async t=>{
  const store=fixture(t),{before,c,r}=await start(store),copy=structuredClone(before);
  await assert.rejects(recordModelStep({snapshot:async()=>({cycles:[],executions:[]}),write:async()=>{throw Error('storage failure');}},input(before,c)),/storage failure/);
  assert.deepEqual(before,copy);
  const empty=fixture(t);
  await assert.rejects(recordModelStep(empty,input(r.state,bar(r.state.lastTime+step,r.state.lastEntry*.94))),/Missing recorded START/);
  assert.equal((await empty.snapshot()).executions.length,0);
  assert.throws(()=>prepareModelStep(input({...r.state,cycleStartedAt:null},bar(r.state.lastTime+step,r.state.lastEntry*.94))),/Missing cycle origin/);
});
test('CSV uses explicit source, preserves negative numeric PnL and protects formula text',async t=>{
  const {store}=await full(t,'STOP');
  await store.write({kind:'fill',opId:'manual1',actor:'test',recordedAt:1,execution:{source:'manual',confirmed:true,id:'=1+1',cycleId:'manual,"cycle"',symbol:'ADAUSDT',tf:'5m',baseAsset:'ADA',quoteAsset:'USDT',time:1,side:'buy',price:10,quantity:1,fee:0}});
  const snap=await store.snapshot(),model=executionsCsv(snap,'model'),manual=executionsCsv(snap,'manual'),cycles=cyclesCsv(snap,'model');
  assert.equal(model.trim().split('\r\n').length,8);
  assert.equal(manual.trim().split('\r\n').length,2);assert.ok(manual.includes('"\'=1+1"'));assert.ok(manual.includes('"manual,""cycle"""'));
  assert.ok(!model.includes('manual,'));assert.ok(cycles.includes(','+String(snap.cycles.find(x=>x.source==='model').realized)+','));
  assert.throws(()=>executionsCsv(snap),/Explicit source/);
});
