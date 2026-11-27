import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {IsolatedPreflightStore} from '../cloudflare/isolated-preflight-store.mjs';

const account={venue:'venue-test',accountId:'account-a',mode:'isolated',synthetic:true};
const initial={...account,observedAt:10,freeCollateral:'100',dcaReserve:'60',protectionCap:'30',positions:[]};
const reconciliation={...account,manual:true,expectedRevision:0,opId:'obs',time:20,kind:'reconcile',
 maxAgeMs:10,observation:{...initial,confirmed:true,complete:true,observedAt:20}};
const order={opId:'fill',expectedRevision:0,actor:'test',recordedAt:22,confirmed:true,kind:'append',event:{
 id:'fill',cycleId:'cycle',symbol:'BTCUSDT',source:'manual-futures',confirmed:true,synthetic:true,
 time:22,kind:'buy',leverage:2,price:'100',quantity:'1',fee:'0.1',feeAsset:'USDT',dca:0}};
const intent={decisionId:'check-1',synthetic:true,account,expected:{futuresRevision:0,collateralRevision:1},
 action:{kind:'START',step:0,cycleId:'cycle',symbol:'BTCUSDT',leverage:2},now:21,maxAgeMs:10};
function fixture(t){
 const db=new DatabaseSync(':memory:');
 t.after(()=>db.close());
 for(const name of ['futures-store','isolated-collateral','isolated-preflight']){
  db.exec(readFileSync(new URL('../cloudflare/'+name+'-schema.sql',import.meta.url),'utf8'));
 }
 const hooks={beforeRun:null};
 const port={prepare(sql){
  let args=[];
  return {bind(...v){args=v;return this;},
   async all(){return {results:db.prepare(sql).all(...args)};},
   async run(){
    if(hooks.beforeRun)await hooks.beforeRun(sql);
    const r=db.prepare(sql).run(...args);
    return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};
   }};
 }};
 const store=new IsolatedPreflightStore(port);
 return {db,hooks,port,store};
}
async function setup(store){
 await store.futures.bindAccount(account);
 await store.collateral.initialize(initial);
 await store.collateral.write(reconciliation);
}
const counts=db=>db.prepare('SELECT COUNT(*) AS n FROM dev_isolated_preflight_audit').get().n;

test('binds an empty journal immutably, enforces scope on writes and rejects binding existing legacy fills',async t=>{
 const {store,db,port}=fixture(t);
 assert.deepEqual(await store.futures.bindAccount(account),account);
 assert.deepEqual(await new IsolatedPreflightStore(port).futures.bindAccount(account),account);
 await assert.rejects(store.futures.bindAccount({...account,accountId:'wrong'}),/binding mismatch/);
 await assert.rejects(store.futures.write(order),/binding mismatch/);
 await assert.rejects(store.futures.write({...order,account:{...account,accountId:'wrong'}}),/binding mismatch/);
 assert.throws(()=>db.exec("INSERT INTO dev_futures_audit(op_id,payload) VALUES ('raw','{}')"),/account mismatch/);
 assert.equal((await store.futures.write({...order,account})).status,'stored');
 assert.equal((await store.futures.boundSnapshot(account)).cycles[0].symbol,'BTCUSDT');
 assert.throws(()=>db.exec('DELETE FROM dev_futures_account'),/immutable/);

 const legacy=fixture(t);
 await legacy.store.futures.write(order);
 await assert.rejects(legacy.store.futures.bindAccount(account),/existing futures history/);
 assert.equal((await legacy.store.futures.snapshot()).revision,1);
});
test('a concurrent legacy write cannot cross a new account binding',async t=>{
 const {store,hooks}=fixture(t);
 hooks.beforeRun=async sql=>{
  if(!sql.includes('INSERT INTO dev_futures_audit'))return;
  hooks.beforeRun=null;
  await store.futures.bindAccount(account);
 };
 await assert.rejects(store.futures.write(order),/binding mismatch/);
 assert.equal((await store.futures.boundSnapshot(account)).revision,0);
});
test('records the verified revisions once, without changing balances or granting permission',async t=>{
 const {store,port,db}=fixture(t);
 await setup(store);
 const other=new IsolatedPreflightStore(port);
 const before=await store.collateral.snapshot(account.venue,account.accountId);
 const results=await Promise.all([store.record(intent),other.record(intent)]);
 assert.equal(results.filter(x=>x.audit==='stored').length,1);
 assert.equal(results.filter(x=>x.reasons.includes('decision-already-recorded')).length,1);
 assert.ok(results.every(x=>x.recommendationAllowed===false));
 assert.deepEqual(await other.collateral.snapshot(account.venue,account.accountId),before);
 assert.deepEqual({...db.prepare('SELECT futures_revision,collateral_revision FROM dev_isolated_preflight_audit').get()},
  {futures_revision:0,collateral_revision:1});
 assert.throws(()=>db.exec('DELETE FROM dev_isolated_preflight_audit'),/append-only/);
 await assert.rejects(other.record({...intent,action:{...intent.action,symbol:'ADAUSDT'}}),/Conflicting preflight/);
});
test('changes in either ledger invalidate an otherwise matched diagnostic before it can be saved',async t=>{
 for(const side of ['futures','collateral']){
  const {store,db,hooks}=fixture(t);
  await setup(store);
  hooks.beforeRun=async sql=>{
   if(!sql.includes('INSERT INTO dev_isolated_preflight_audit'))return;
   hooks.beforeRun=null;
   if(side==='futures')await store.futures.write({...order,account});
   else await store.collateral.write({...reconciliation,opId:'obs-2',expectedRevision:1,time:21,
    observation:{...reconciliation.observation,observedAt:21}});
  };
  const result=await store.record(intent);
  assert.deepEqual(result.reasons,['revision-changed-during-preflight']);
  assert.equal(counts(db),0);
 }
});
test('stale revisions and an unbound or foreign account never create audit rows',async t=>{
 const {store,db}=fixture(t);
 await store.collateral.initialize(initial);
 await assert.rejects(store.record(intent),/binding mismatch/);
 await store.futures.bindAccount(account);
 assert.equal((await store.record(intent)).status,'blocked');
 const other={...account,accountId:'wrong'};
 await store.collateral.initialize({...initial,...other});
 await assert.rejects(store.record({...intent,account:other}),/binding mismatch/);
 assert.equal(counts(db),0);
});
