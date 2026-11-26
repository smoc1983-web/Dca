import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AtomicModelStore} from '../cloudflare/atomic-model-store.mjs';
import {DEFAULTS,intervalMs} from '../cloudflare/watchlist-engine.mjs';
const schema=['trade-ledger-schema.sql','atomic-model-schema.sql'].map(f=>readFileSync(new URL('../cloudflare/'+f,import.meta.url),'utf8')).join('\n');
const p={...DEFAULTS,symbol:'ADAUSDT',qtyStep:.000001,tick:.0001,slippageBps:2},tf='5m',step=intervalMs(tf),id='atomic-test';
const bar=(i,price)=>({time:i*step,closeTime:(i+1)*step-1,open:price,high:price,low:price,close:price});
function port(db){return {prepare(sql){let args=[];return {bind(...v){args=v;return this;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}};}
async function setup(db){db.exec(schema);const s=new AtomicModelStore(port(db));await s.register(id,tf,p);return s;}
async function warm(s){for(let i=0;i<20;i++)await s.step(id,bar(i,100+i*.1));}
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return db;}
test('atomic START, DCA1-5, TP with ledger and test outbox reconciliation',async t=>{
  const s=await setup(fixture(t));await warm(s);
  let r=await s.step(id,bar(20,95));assert.equal(r.event.kind,'START');
  for(let i=0;i<5;i++){r=await s.step(id,bar(21+i,r.state.lastEntry*(1-p.drops[i])*(1-1e-7)));assert.equal(r.event.kind,'DCA'+(i+1));}
  r=await s.step(id,bar(26,r.state.average*1.031));assert.equal(r.event.kind,'TP');
  const snap=await s.ledger.snapshot();assert.equal(snap.executions.length,7);assert.equal((await s.outbox(id)).length,7);
  assert.equal((await s.load(id)).state.qty,0);assert.ok(Math.abs(snap.cycles[0].realized-(r.state.cash-p.initialCapital))<1e-8);
});
test('trigger error rolls back cursor, ledger and outbox',async t=>{
  const db=fixture(t),s=await setup(db);await warm(s);const before=await s.load(id);
  db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON dev_model_outbox BEGIN SELECT RAISE(ABORT,'Injected outbox error'); END;");
  await assert.rejects(s.step(id,bar(20,95)),/Injected outbox error/);
  assert.deepEqual(await s.load(id),before);assert.equal((await s.ledger.snapshot()).executions.length,0);assert.equal((await s.outbox(id)).length,0);
  db.exec('DROP TRIGGER injected_failure');assert.equal((await s.step(id,bar(20,95))).event.kind,'START');
  assert.equal((await s.ledger.snapshot()).executions.length,1);
});
test('file DB restart and duplicate candle preserve exact cursor and single event',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dca-atomic-'));const path=join(dir,'test.sqlite');let db=new DatabaseSync(path);
  try{let s=await setup(db);await warm(s);await s.step(id,bar(20,95));const before=await s.load(id);
    db.close();db=new DatabaseSync(path);s=await setup(db);
    assert.deepEqual(await s.load(id),before);assert.equal((await s.step(id,bar(20,95))).status,'duplicate');
    assert.equal((await s.ledger.snapshot()).executions.length,1);assert.equal((await s.outbox(id)).length,1);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('concurrent same candle commits once and different replay is rejected',async t=>{
  const db=fixture(t),s=await setup(db);await warm(s);const other=new AtomicModelStore(port(db));
  const result=await Promise.all([s.step(id,bar(20,95)),other.step(id,bar(20,95))]);
  assert.deepEqual(result.map(x=>x.status).sort(),['duplicate','stored']);
  assert.equal((await s.ledger.snapshot()).executions.length,1);assert.equal((await s.outbox(id)).length,1);
  await assert.rejects(s.step(id,bar(20,94)),/Conflicting candle/);
});
test('config cannot change; gap and invalid candle do not advance cursor',async t=>{
  const s=await setup(fixture(t));await s.step(id,bar(0,100));const before=await s.load(id);
  await assert.rejects(s.register(id,tf,{...p,fee:.002}),/configuration mismatch/);
  await assert.rejects(s.step(id,bar(2,100)),/Candle gap/);
  await assert.rejects(s.step(id,{...bar(1,100),low:101}),/Invalid candle/);
  assert.deepEqual(await s.load(id),before);
});
test('no-event candle is persisted without creating an execution or outbox row',async t=>{
  const s=await setup(fixture(t));const r=await s.step(id,bar(0,100));
  assert.equal(r.event,null);assert.equal((await s.load(id)).state.lastTime,0);
  assert.equal((await s.ledger.snapshot()).executions.length,0);assert.equal((await s.outbox(id)).length,0);
});
