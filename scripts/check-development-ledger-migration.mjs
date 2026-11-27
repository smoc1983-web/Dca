// Rehearse an additive schema upgrade only on a disposable local D1.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AtomicModelStore} from '../cloudflare/atomic-model-store.mjs';
import {BudgetStore} from '../cloudflare/budget-store.mjs';
import {CashStore} from '../cloudflare/cash-store.mjs';
import {TradeLedgerStore} from '../cloudflare/trade-store.mjs';
import {DEFAULTS,intervalMs,newState} from '../cloudflare/watchlist-engine.mjs';
import {readLegacyReconciliation} from './read-legacy-reconciliation.mjs';

const {Miniflare}=createRequire(import.meta.url)('miniflare');
const dir=mkdtempSync(join(tmpdir(),'dca-ledger-upgrade-'));
const tables=['control','models','alerts','runs'];
const upgrades=['trade-ledger-schema','atomic-model-schema','budget-store-schema','cash-store-schema'];
const stateTables=['trade_ledger_audit','dev_model_registry','dev_model_steps','dev_model_outbox','dev_budget_audit','dev_cash_audit'];
const tf='5m',step=intervalMs(tf),modelId='new-paper-model';
const params={...DEFAULTS,symbol:'BTCUSDT',qtyStep:.000001,tick:.0001,slippageBps:2};
const time=10,clock=()=>time;
const candle=(i,price)=>({time:i*step,closeTime:(i+1)*step-1,open:price,high:price,low:price,close:price});
const command=(kind,opId,expectedRevision,extra={})=>({kind,opId,expectedRevision,actor:'synthetic-migration',recordedAt:time,confirmed:true,...extra});
const buy={source:'manual',confirmed:true,id:'receipt-1',cycleId:'manual-cycle',symbol:'ADAUSDT',
 baseAsset:'ADA',quoteAsset:'USDT',tf,time:1,side:'buy',price:'105',quantity:'0.2',fee:'0.021',feeAsset:'USDT',dca:0};

let mf;
function open(){
 mf=new Miniflare({host:'127.0.0.1',port:0,logRequests:false,modules:true,script:'export default {}',
  d1Persist:dir,d1Databases:{DB:'synthetic-ledger-upgrade'}});
 return mf.getD1Database('DB');
}
async function restart(){
 await mf.dispose();
 mf=undefined;
 return open();
}
function statements(file){
 // These repository schemas consist of top-level CREATE statements. Keep each trigger body intact.
 return readFileSync(new URL('../cloudflare/'+file+'.sql',import.meta.url),'utf8')
  .split(/(?=^CREATE )/m).filter(s=>s.startsWith('CREATE ')).map(s=>s.trim());
}
function apply(db,files,...extra){
 return db.batch([...files.flatMap(statements),...extra].map(sql=>db.prepare(sql)));
}
async function snapshotLegacy(db){
 const queries=['SELECT * FROM control ORDER BY id','SELECT * FROM models ORDER BY key',
  'SELECT * FROM alerts ORDER BY id','SELECT * FROM runs ORDER BY minute'];
 const results=await db.batch(queries.map(sql=>db.prepare(sql)));
 return Object.fromEntries(tables.map((table,i)=>[table,results[i].results]));
}
function stores(db){
 return {model:new AtomicModelStore(db),budget:new BudgetStore(db,{clock}),cash:new CashStore(db),ledger:new TradeLedgerStore(db)};
}

try{
 let db=await open();
 await apply(db,['schema']);
 const active={symbol:'ADAUSDT',tf,entryEnabled:true,params:{...DEFAULTS,symbol:'ADAUSDT'},
  s:{...newState(),lastTime:300_000,qty:.5,average:97.5,invested:48.75,lastEntry:95,
   cash:751.20125,cycleEquity:800,cycleStart:0,dca:1}};
 await db.batch([
  db.prepare("INSERT INTO control VALUES(1,'shadow','before-upgrade')"),
  db.prepare('INSERT INTO models(key,model,next_close,rev) VALUES(?,?,?,7)').bind('ADAUSDT:5m',JSON.stringify(active),900_000),
  ...['pending','sending','uncertain','delivered'].map((status,i)=>db.prepare(
   'INSERT INTO alerts(id,closed,body,status,next_try,receipt) VALUES(?,?,?,?,?,?)'
  ).bind('old-'+i,300_000+i,'synthetic legacy signal '+i,status,i===0?600_000:0,status==='delivered'?8:null)),
  db.prepare('INSERT INTO runs VALUES(5,1,0,?)').bind(360_000)
 ]);
 const legacy=await snapshotLegacy(db);
 db=await restart();

 // Force a constraint failure after all schema statements in the same D1 batch.
 await assert.rejects(apply(db,upgrades,"INSERT INTO trade_ledger_audit(op_id,payload) VALUES('invalid','not-json')"),/CHECK constraint|json_valid/);
 const defined=(await db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).results.map(x=>x.name);
 assert.ok(stateTables.every(name=>!defined.includes(name)),'DDL must roll back too');
 assert.deepEqual(await snapshotLegacy(db),legacy);
 await apply(db,upgrades);
 await apply(db,upgrades);
 assert.deepEqual(await snapshotLegacy(db),legacy);
 let {model,budget,cash,ledger}=stores(db);
 assert.equal((await ledger.snapshot()).revision,0);
 assert.equal(await budget.snapshot(),null);
 assert.equal((await cash.load()).opening,null);
 const emptyReview=await readLegacyReconciliation(db,{now:time,maxAgeMs:100});
 assert.deepEqual(emptyReview.revisions,{ledger:0,budget:0,cash:0});
 assert.deepEqual(emptyReview.flags,['MODEL_ORIGIN_MISSING','BUDGET_NOT_INITIALIZED','NO_CASH_OPENING']);
 assert.deepEqual(emptyReview.manualCycles,[]);
 console.log('Ledger upgrade: failed D1 batch rolls back schemas; repeat upgrade preserves all legacy tables and imports no model as a fill');

 await model.register(modelId,tf,params);
 for(let i=0;i<20;i++)await model.step(modelId,candle(i,100+i*.1));
 const beforeSignal=await model.load(modelId);
 await db.prepare(`CREATE TRIGGER migration_fail_outbox BEFORE INSERT ON dev_model_outbox
  BEGIN SELECT RAISE(ABORT,'fixture outbox write failed'); END`).run();
 await assert.rejects(model.step(modelId,candle(20,95)),/fixture outbox write failed/);
 assert.deepEqual(await model.load(modelId),beforeSignal);
 assert.equal((await ledger.snapshot()).revision,0);
 assert.deepEqual(await model.outbox(modelId),[]);
 await db.prepare('DROP TRIGGER migration_fail_outbox').run();
 const started=await model.step(modelId,candle(20,95));
 assert.equal(started.event.kind,'START');
 assert.equal(started.revision,(await model.load(modelId)).revision);

 await budget.apply(command('init','budget-init',null,{cashGuardMaxAgeMs:100,
  settings:{policy:'equal-slots-v1',capital:'800',freeCash:'800',maxCycles:1,feeRate:'0.001'}}));
 await cash.write(command('opening','opening',0,{time:0,cash:'800',noOpeningPositions:true}));
 await cash.write(command('observe','before-fill',1,{time:0,free:'800',locked:'0',completeHistory:true}));
 const reserve=command('reserve','reserve',0,{id:buy.cycleId,symbol:buy.symbol,tickSize:'0.01',exitFeeRate:'0.001'});
 assert.equal((await budget.apply(reserve)).status,'stored');
 const fill=command('fill','fill',1,{id:buy.cycleId,execution:buy});
 const beforeFill=await budget.snapshot();
 await db.prepare(`CREATE TRIGGER migration_fail_fill BEFORE INSERT ON trade_ledger_audit
  WHEN NEW.op_id='budget:fill' BEGIN SELECT RAISE(ABORT,'fixture ledger write failed'); END`).run();
 await assert.rejects(budget.apply(fill),/fixture ledger write failed/);
 assert.deepEqual(await budget.snapshot(),beforeFill);
 assert.equal((await ledger.snapshot()).executions.length,1);
 await db.prepare('DROP TRIGGER migration_fail_fill').run();
 assert.equal((await budget.apply(fill)).status,'stored');
 const fix=command('correct','correct',2,{id:buy.cycleId,execution:{...buy,price:'100',fee:'0.02'},
  expectedVersion:1,reason:'Synthetic receipt correction'});
 const afterCorrection=await budget.apply(fix);
 assert.ok(afterCorrection.summary.flags.includes('CORRECTION_RECONCILIATION_REQUIRED'));
 const review=command('reviewCorrection','review',3,{id:buy.cycleId,
  expectedLedgerRevision:(await ledger.snapshot()).revision,ordersReviewed:true});
 await assert.rejects(budget.apply(review),/Cash reconciliation required/);
 await cash.write(command('observe','after-correction',2,{time:5,free:'779.98',locked:'0',completeHistory:true}));
 assert.equal((await budget.apply(review)).state.reservations[0].correctionPending,false);
 assert.equal((await cash.report({now:time,maxAgeMs:100})).reconciled,true);
 const audit=await ledger.audit();
 assert.equal(audit.find(x=>x.opId==='budget:fill').execution.price,105);
 assert.equal(audit.find(x=>x.opId==='budget:correct').execution.price,100);
 console.log('Ledger upgrade: D1 rolls back partially failing model and budget writes; guarded corrections require fresh cash reconciliation');

 const recent=async()=>({
  model:await model.load(modelId),outbox:await model.outbox(modelId),budget:await budget.snapshot(),
  cash:await cash.report({now:time,maxAgeMs:100}),ledger:await ledger.snapshot()
 });
 const beforeClose=await recent();
 const dryRun=await readLegacyReconciliation(db,{now:time,maxAgeMs:100});
 assert.equal(dryRun.status,'review-needed');
 assert.deepEqual(dryRun.flags,['MODEL_ORIGIN_MISSING']);
 assert.equal(dryRun.cash.expectedQuoteCash,'779.98');
 assert.equal(dryRun.cash.reconciled,true);
 assert.equal(dryRun.manualCycles[0].reservation,'reserved');
 assert.deepEqual(await recent(),beforeClose);
 assert.deepEqual(await snapshotLegacy(db),legacy);
 db=await restart();
 await apply(db,upgrades);
 ({model,budget,cash,ledger}=stores(db));
 assert.deepEqual(await snapshotLegacy(db),legacy);
 assert.deepEqual(await recent(),beforeClose);
 assert.equal((await budget.apply(fix)).status,'duplicate');
 assert.equal((await model.step(modelId,candle(20,95))).status,'duplicate');
 assert.deepEqual(await recent(),beforeClose);
 assert.deepEqual(await readLegacyReconciliation(db,{now:time,maxAgeMs:100}),dryRun);
 console.log('Ledger upgrade: persistent D1 preserves model cursor, outbox, fills, revisions and cash across restart and repeated upgrade');
 console.log('Legacy reconciliation: old model needs its origin reviewed; confirmed manual cycle and synthetic cash match before and after restart');
}finally{
 try{if(mf)await mf.dispose();}
 finally{rmSync(dir,{recursive:true,force:true});}
}
