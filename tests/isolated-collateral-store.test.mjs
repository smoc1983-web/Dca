import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IsolatedCollateralStore} from '../cloudflare/isolated-collateral-store.mjs';
const schema=readFileSync(new URL('../cloudflare/isolated-collateral-schema.sql',import.meta.url),'utf8');
function port(db){return {prepare(sql){let args=[];return {bind(...v){args=v;return this;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}};}};}
const initial=(o={})=>({synthetic:true,mode:'isolated',venue:'walt-test',accountId:'a',observedAt:1,freeCollateral:'100',dcaReserve:'60',protectionCap:'30',positions:[{cycleId:'c',symbol:'BTCUSDT',leverage:3,lastDca:2,quantity:'1',averageEntry:'100',tpPrice:'103',collateral:'33.34'},{cycleId:'d',symbol:'ADAUSDT',leverage:2,lastDca:0,quantity:'10',averageEntry:'2',tpPrice:'2.06',collateral:'10'}],...o});
const op=(kind,revision,o={})=>({synthetic:true,manual:true,venue:'walt-test',accountId:'a',cycleId:'c',requestId:'r',opId:kind+'-'+revision,expectedRevision:revision,time:revision+2,kind,...o});
async function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(schema);const s=new IsolatedCollateralStore(port(db));await s.initialize(initial());return {db,s};}
test('file-backed restart preserves confirmed and uncertain partial topups',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dca-collateral-')),path=join(dir,'db.sqlite');let db=new DatabaseSync(path);
 try{db.exec(schema);let s=new IsolatedCollateralStore(port(db));await s.initialize(initial());await s.write(op('request',0,{amount:'20'}));await s.write(op('settle',1,{amount:'7',confirmed:true,evidence:'p1'}));await s.write(op('uncertain',2));const before=await s.snapshot('walt-test','a');db.close();db=new DatabaseSync(path);s=new IsolatedCollateralStore(port(db));assert.deepEqual(await s.snapshot('walt-test','a'),before);assert.equal(before.summary.pendingTopups,'13');assert.equal(before.state.positions[0].collateral,'40.34');await s.write(op('settle',3,{amount:'13',confirmed:true,evidence:'p2'}));assert.equal((await s.snapshot('walt-test','a')).summary.confirmedAdded,'20');
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('two writers compete atomically for one account revision',async t=>{
 const {db,s}=await fixture(t),other=new IsolatedCollateralStore(port(db));
 const results=await Promise.allSettled([s.write(op('request',0,{amount:'25'})),other.write(op('request',0,{opId:'r2',requestId:'r2',cycleId:'d',amount:'25'}))]);
 assert.equal(results.filter(x=>x.status==='fulfilled'&&x.value.status==='stored').length,1);assert.equal((await s.snapshot('walt-test','a')).summary.pendingTopups,'25');
});
test('duplicate concurrent operation is idempotent and conflict rejected',async t=>{
 const {db,s}=await fixture(t),other=new IsolatedCollateralStore(port(db)),raw=op('request',0,{amount:'20'});
 const results=await Promise.all([s.write(raw),other.write(raw)]);assert.deepEqual(results.map(x=>x.status).sort(),['duplicate','stored']);
 await assert.rejects(s.write({...raw,amount:'21'}),/Conflicting/);
 assert.equal((await s.snapshot('walt-test','a')).state.revision,1);
});
test('separate venues and accounts never share reserves or revisions',async t=>{
 const {s}=await fixture(t);await s.initialize(initial({venue:'exchange-test'}));await s.initialize(initial({accountId:'b'}));await s.write(op('request',0,{amount:'30'}));
 assert.equal((await s.snapshot('exchange-test','a')).summary.availableForTopup,'30');assert.equal((await s.snapshot('walt-test','b')).state.revision,0);
 await assert.rejects(s.write(op('request',0,{amount:'1',venue:'unknown'})),/Unknown collateral account/);
});
test('initial snapshot cannot reset confirmed ledger',async t=>{
 const {s}=await fixture(t);await s.write(op('request',0,{amount:'20'}));assert.equal((await s.initialize(initial())).status,'duplicate');
 await assert.rejects(s.initialize(initial({freeCollateral:'500'})),/Conflicting initial/);assert.equal((await s.snapshot('walt-test','a')).summary.pendingTopups,'20');
});
test('failed insert does not change persisted balance or reserve; audit immutable',async t=>{
 const {db,s}=await fixture(t);await s.write(op('request',0,{amount:'20'}));const before=await s.snapshot('walt-test','a');
 db.exec("CREATE TRIGGER injected BEFORE INSERT ON dev_collateral_audit BEGIN SELECT RAISE(ABORT,'Injected failure'); END;");
 await assert.rejects(s.write(op('settle',1,{amount:'5',confirmed:true,evidence:'p1'})),/Injected failure/);assert.deepEqual(await s.snapshot('walt-test','a'),before);
 db.exec('DROP TRIGGER injected');await s.write(op('settle',1,{amount:'5',confirmed:true,evidence:'p1'}));assert.throws(()=>db.exec('DELETE FROM dev_collateral_audit'),/append-only/);assert.throws(()=>db.exec("UPDATE dev_collateral_audit SET payload='{}'"),/append-only/);
});
test('verified cancel retains confirmed amount and releases only remaining reservation',async t=>{
 const {s}=await fixture(t);await s.write(op('request',0,{amount:'20'}));await s.write(op('settle',1,{amount:'7',confirmed:true,evidence:'p1'}));await s.write(op('cancel',2,{confirmed:true,remainderNotExecuted:true,evidence:'c1'}));const a=await s.snapshot('walt-test','a');assert.equal(a.summary.freeCollateral,'93');assert.equal(a.summary.pendingTopups,'0');assert.equal(a.summary.confirmedAdded,'7');assert.equal(a.summary.availableForTopup,'23');
});
test('corrupt persisted revision fails closed',async t=>{
 const {db,s}=await fixture(t);db.prepare("INSERT INTO dev_collateral_audit VALUES('walt-test','a',2,'bad','{}')").run();
 await assert.rejects(s.snapshot('walt-test','a'),/Corrupt collateral revision/);
});
