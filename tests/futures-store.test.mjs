import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FuturesStore} from '../cloudflare/futures-store.mjs';
const schema=readFileSync(new URL('../cloudflare/futures-store-schema.sql',import.meta.url),'utf8');
function port(db){return {prepare(sql){let args=[];return {bind(...v){args=v;return this;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}};}
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(schema);return {db,s:new FuturesStore(port(db))};}
const buy=(o={})=>({id:'b',cycleId:'c',symbol:'ADAUSDT',source:'manual-futures',confirmed:true,synthetic:true,time:1,kind:'buy',leverage:3,price:'105',quantity:'2',fee:'0.21',feeAsset:'USDT',dca:0,...o});
const dca=buy({id:'d',time:2,price:'95',quantity:'2',fee:'0.19',dca:1});
const sell=buy({id:'s',time:3,kind:'sell',price:'110',quantity:'1',fee:'0.11',dca:null});
const cmd=(opId,expectedRevision,event,o={})=>({opId,expectedRevision,event,actor:'test',recordedAt:10,confirmed:true,kind:'append',...o});
test('exact replay survives database close and reopen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dca-futures-'));const path=join(dir,'db.sqlite');let db=new DatabaseSync(path);
 try{db.exec(schema);let s=new FuturesStore(port(db));await s.write(cmd('b',0,buy()));await s.write(cmd('d',1,dca));await s.write(cmd('s',2,sell));
 const before=await s.snapshot();assert.equal(before.cycles[0].quantity,'3');assert.equal(before.cycles[0].averageEntry,'100');db.close();db=new DatabaseSync(path);s=new FuturesStore(port(db));assert.deepEqual(await s.snapshot(),before);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('operation and event duplicate detection, canonical decimal inputs',async t=>{
 const {s}=fixture(t);const first=cmd('b',0,buy());await s.write(first);assert.equal((await s.write(first)).status,'duplicate');
 assert.equal((await s.write(cmd('other',0,buy({price:105})))).status,'duplicate');
 await assert.rejects(s.write(cmd('other',1,buy({price:'106'}))),/Conflicting futures event/);
 await assert.rejects(s.write({...first,actor:'another'}),/Conflicting futures operation/);
 assert.equal((await s.snapshot()).revision,1);
});
test('correction retains original audit and recalculates all downstream fills',async t=>{
 const {s}=fixture(t);const original=cmd('b',0,buy());await s.write(original);await s.write(cmd('d',1,dca));await s.write(cmd('s',2,sell));
 const fix=cmd('fix',3,buy({price:'100',fee:'0.2'}),{kind:'correct',expectedVersion:1,reason:'Receipt correction'});await s.write(fix);
 const a=await s.snapshot();assert.equal(a.events[0].version,2);assert.equal(a.cycles[0].averageEntry,'97.5');assert.equal(a.cycles[0].grossRealizedPnl,'12.5');assert.equal(a.cycles[0].netRealizedCashEffect,'12');
 assert.equal((await s.audit())[0].event.price,'105');assert.equal((await s.write(original)).status,'duplicate');
 await assert.rejects(s.write(cmd('fix2',4,buy(),{kind:'correct',expectedVersion:1,reason:'stale'})),/Stale futures event version/);
});
test('invalid corrections and downstream oversell cannot persist',async t=>{
 const {s}=fixture(t);await s.write(cmd('b',0,buy()));await s.write(cmd('s',1,{...sell,quantity:'2'}));const before=await s.snapshot();
 await assert.rejects(s.write(cmd('fix',2,buy({quantity:'1'}),{kind:'correct',expectedVersion:1,reason:'invalid'})),/exceeds futures quantity/);
 await assert.rejects(s.write(cmd('fix2',2,buy({leverage:2}),{kind:'correct',expectedVersion:1,reason:'invalid'})),/cannot change leverage/);
 assert.deepEqual(await s.snapshot(),before);
});
test('concurrent writers cannot both commit a stale revision',async t=>{
 const {db,s}=fixture(t);const other=new FuturesStore(port(db));const outcomes=await Promise.allSettled([s.write(cmd('b',0,buy())),other.write(cmd('b2',0,buy({id:'b2',cycleId:'c2',symbol:'BTCUSDT'})))]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled'&&x.value.status==='stored').length,1);assert.equal((await s.snapshot()).revision,1);
});
test('funding persists separately; audit is immutable and failed insert rolls back',async t=>{
 const {db,s}=fixture(t);await s.write(cmd('b',0,buy()));
 db.exec("CREATE TRIGGER injected BEFORE INSERT ON dev_futures_audit BEGIN SELECT RAISE(ABORT,'Injected failure'); END;");
 const f=cmd('f',1,buy({id:'f',kind:'funding',time:2,amount:'-0.5'}));await assert.rejects(s.write(f),/Injected failure/);assert.equal((await s.snapshot()).revision,1);
 db.exec('DROP TRIGGER injected');await s.write(f);assert.equal((await s.snapshot()).cycles[0].settledFunding,'-0.5');
 assert.throws(()=>db.exec('DELETE FROM dev_futures_audit'),/append-only/);assert.throws(()=>db.exec("UPDATE dev_futures_audit SET payload='{}'"),/append-only/);
});
test('risk calculation uses authoritative stored fills and rejects stale revision',async t=>{
 const {s}=fixture(t);await s.write(cmd('b',0,buy()));await s.write(cmd('d',1,dca));
 const raw={expectedRevision:2,synthetic:true,mode:'cross',collateralWallet:'800',plans:[{cycleId:'c',symbol:'ADAUSDT',leverage:3,nominals:['210','200','250','300','350','400'],completedSteps:[0,1]}],risk:[{cycleId:'c',markPrice:'90',lastPrice:'100',maintenanceTiers:[{upTo:'10000',rate:'0.005'}],exitFeeRate:'0.001',adverseFundingRate:'0.001',fundingPeriods:1,futureEntryFeeRate:'0.001'}],scenarios:[{id:'gap',markPrices:{c:'50'}}]};
 const r=await s.stress({...raw,events:[]});assert.equal(r.cycles[0].quantity,'4');assert.equal(r.stress.current.accounts[0].unrealizedPnl,'-40');assert.equal(r.recommendationAllowed,false);
 await s.write(cmd('s',2,sell));await assert.rejects(s.stress(raw),/Stale futures risk revision/);
});
test('synthetic restriction and time checks enforced on write',async t=>{
 const {s}=fixture(t);await assert.rejects(s.write(cmd('bad',0,buy({synthetic:false}))),/synthetic/);
 await assert.rejects(s.write(cmd('bad',0,buy({time:20}))),/Future event/);
 await assert.rejects(s.write(cmd('bad',0,buy({leverage:4}))),/Leverage/);assert.equal((await s.snapshot()).revision,0);
});
