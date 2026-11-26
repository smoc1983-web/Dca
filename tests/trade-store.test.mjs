import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TradeLedgerStore} from '../cloudflare/trade-store.mjs';
const schema=readFileSync(new URL('../cloudflare/trade-ledger-schema.sql',import.meta.url),'utf8');
function port(db){
  return {prepare(sql){let args=[];return {
    bind(...v){args=v;return this;},
    async all(){return {results:db.prepare(sql).all(...args)};},
    async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
  };}};
}
const fill=(extra={})=>({source:'manual',confirmed:true,id:'f1',cycleId:'c1',symbol:'ADAUSDT',baseAsset:'ADA',quoteAsset:'USDT',tf:'5m',time:1000,side:'buy',price:100,quantity:1,fee:0,...extra});
const op=(execution,extra={})=>({kind:'fill',opId:'op-'+execution.source+'-'+execution.id,actor:'test',recordedAt:5000,execution,...extra});
const correction=(execution,extra={})=>op(execution,{kind:'correct',opId:'fix1',expectedVersion:1,reason:'receipt verified',...extra});
function fixture(t){const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());return {db,store:new TradeLedgerStore(port(db))};}
test('persistent history survives close and reopen with third-asset fee',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dca-ledger-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'ledger.sqlite');let db=new DatabaseSync(path);
  try{
    db.exec(schema);let s=new TradeLedgerStore(port(db));
    await s.write(op(fill({fee:.01,feeAsset:'BNB',feeQuoteRate:500})));
    const before=await s.snapshot();db.close();db=new DatabaseSync(path);s=new TradeLedgerStore(port(db));
    assert.deepEqual(await s.snapshot(),before);assert.equal(before.cycles[0].averageCost,105);
  }finally{db.close();}
});
test('duplicate operation and repeat original import are idempotent',async t=>{
  const {store}=fixture(t);const original=op(fill());
  assert.equal((await store.write(original)).status,'stored');
  assert.equal((await store.write(original)).status,'duplicate');
  assert.equal((await store.write({...original,opId:'other'})).status,'duplicate');
  await assert.rejects(store.write({...original,actor:'different'}),/Conflicting operation/);
  await assert.rejects(store.write(op(fill({price:90}),{opId:'other2'})),/Conflicting execution/);
  assert.equal((await store.audit()).length,1);
});
test('manual correction preserves original audit and replay; stale correction denied',async t=>{
  const {store}=fixture(t);await store.write(op(fill()));
  await store.write(op(fill({id:'f2',time:2000,side:'sell',price:110})));
  const fix=correction(fill({price:90}));await store.write(fix);
  const s=await store.snapshot();assert.equal(s.cycles[0].realized,20);assert.equal(s.executions[0].version,2);
  assert.equal((await store.audit())[0].execution.price,100);
  assert.equal((await store.write(fix)).status,'duplicate');
  assert.equal((await store.write(op(fill(),{opId:'reimport'}))).status,'duplicate');
  await assert.rejects(store.write(correction(fill({price:80}),{opId:'fix2'})),/Stale/);
  assert.equal((await store.audit()).length,3);
});
test('invalid correction or fill is not written and cannot corrupt downstream sells',async t=>{
  const {store}=fixture(t);await store.write(op(fill()));
  await store.write(op(fill({id:'f2',time:2000,side:'sell',price:110})));
  const before=await store.snapshot();
  await assert.rejects(store.write(correction(fill({quantity:.5}))),/exceeds/);
  await assert.rejects(store.write(correction(fill({cycleId:'changed'}))),/cycleId/);
  await assert.rejects(store.write(op(fill({id:'f3'}))),/closed/);
  assert.deepEqual(await store.snapshot(),before);assert.equal((await store.audit()).length,2);
});
test('streams separate and model corrections prohibited',async t=>{
  const {store}=fixture(t);await store.write(op(fill()));await store.write(op(fill({source:'model'})));
  assert.equal((await store.snapshot()).cycles.length,2);
  await assert.rejects(store.write(correction(fill({source:'model'}))),/Only manual/);
  await assert.rejects(store.write(op(fill({id:'x',confirmed:false}))),/confirmed/);
});
test('competing writes revalidate and cannot oversell',async t=>{
  const {db,store}=fixture(t);await store.write(op(fill()));
  const second=new TradeLedgerStore(port(db));
  const sell=id=>op(fill({id,time:2000,side:'sell',quantity:.75,price:110}));
  const results=await Promise.allSettled([store.write(sell('a')),second.write(sell('b'))]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.match(results.find(x=>x.status==='rejected').reason.message,/exceeds/);
  assert.equal((await store.snapshot()).cycles[0].quantity,.25);
});
test('SQL audit rows cannot be updated or deleted',async t=>{
  const {db,store}=fixture(t);await store.write(op(fill()));
  assert.throws(()=>db.exec("UPDATE trade_ledger_audit SET payload='{}'"),/append-only/);
  assert.throws(()=>db.exec('DELETE FROM trade_ledger_audit'),/append-only/);
  assert.equal((await store.audit()).length,1);
});
