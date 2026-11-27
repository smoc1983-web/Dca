import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {BudgetStore} from '../cloudflare/budget-store.mjs';
import {CashStore} from '../cloudflare/cash-store.mjs';
import {TradeLedgerStore} from '../cloudflare/trade-store.mjs';
import {readLegacyReconciliation} from '../scripts/read-legacy-reconciliation.mjs';

const schema=['schema','trade-ledger-schema','budget-store-schema','cash-store-schema']
 .map(name=>readFileSync(new URL('../cloudflare/'+name+'.sql',import.meta.url),'utf8')).join('\n');
const key='ADAUSDT:5m',symbol='ADAUSDT',tf='5m';
const options={now:10,maxAgeMs:10};
const execution={source:'manual',confirmed:true,id:'receipt',cycleId:'manual-cycle',symbol,tf,baseAsset:'ADA',
 quoteAsset:'USDT',time:2,side:'buy',price:'100',quantity:'0.2',fee:'0.02',feeAsset:'USDT',dca:0};
const op=(kind,opId,expectedRevision,extra)=>({kind,opId,expectedRevision,actor:'synthetic',recordedAt:10,confirmed:true,...extra});

function fixture(t){
 const db=new DatabaseSync(':memory:');
 t.after(()=>db.close());
 db.exec(schema);
 const port={prepare(sql){
  let args=[];
  return {bind(...v){args=v;return this;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){
   const r=db.prepare(sql).run(...args);
   return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};
  }};
 }};
 const readOnly={prepare(sql){
  assert.match(sql,/^SELECT\b/);
  const statement=port.prepare(sql);
  return {bind(...args){statement.bind(...args);return this;},all:()=>statement.all()};
 }};
 return {db,readOnly,ledger:new TradeLedgerStore(port),budget:new BudgetStore(port),cash:new CashStore(port),
  seedModel(s){db.prepare('INSERT INTO models(key,model,next_close,rev) VALUES(?,?,?,?)').run(key,JSON.stringify({symbol,tf,s}),300_000,7);}};
}
const init=op('init','budget',null,{settings:{policy:'equal-slots-v1',capital:'800',freeCash:'800',maxCycles:1,feeRate:'0.001'}});
const reserve=op('reserve','reserve',0,{id:'manual-cycle',symbol,tickSize:'0.01',exitFeeRate:'0.001'});
const opening=op('opening','opening',0,{cash:'800',time:0,noOpeningPositions:true});
const observation=(free)=>op('observe','observation',1,{time:5,free,locked:'0',completeHistory:true});

test('an old open model with no origin produces a finding and no manual execution or cash balance',async t=>{
 const {readOnly,seedModel}=fixture(t);
 seedModel({qty:0.2,average:100});
 const result=await readLegacyReconciliation(readOnly,options);
 assert.deepEqual(result.revisions,{ledger:0,budget:0,cash:0});
 assert.deepEqual(result.legacyModels,[{key,revision:7,symbol,tf,status:'MODEL_ORIGIN_MISSING'}]);
 assert.deepEqual(result.manualCycles,[]);
 assert.deepEqual(result.flags,['MODEL_ORIGIN_MISSING','BUDGET_NOT_INITIALIZED','NO_CASH_OPENING']);
 assert.equal(result.cash,null);
 assert.equal(result.status,'review-needed');
});

test('matched model and confirmed manual inventory stay separate when reconciling cash and reserves',async t=>{
 const {readOnly,seedModel,ledger,budget,cash}=fixture(t);
 seedModel({qty:0.4,average:100,cycleStartedAt:0});
 await ledger.write(op('fill','model',null,{execution:{...execution,source:'model',quantity:'0.4',
  cycleId:JSON.stringify([key,symbol,tf,0])}}));
 await budget.apply(init);
 await budget.apply(reserve);
 await budget.apply(op('fill','trade',1,{id:'manual-cycle',execution}));
 await cash.write(opening);
 await cash.write(observation('779.98'));
 const result=await readLegacyReconciliation(readOnly,options);
 assert.equal(result.status,'consistent');
 assert.equal(result.legacyModels[0].status,'matched');
 assert.deepEqual(result.manualCycles,[{cycleId:'manual-cycle',symbol,position:'open',reservation:'reserved'}]);
 assert.equal(result.cash.expectedQuoteCash,'779.98');
 assert.equal(result.cash.remainingPositionCost,'20.02');
 assert.equal(result.cash.cashDifference,'0');
 assert.equal(result.cash.reconciled,true);
});

test('same-symbol history is not auto-linked and a balance mismatch remains visible',async t=>{
 const {readOnly,seedModel,ledger,budget,cash}=fixture(t);
 seedModel({qty:0.2,average:100,cycleStartedAt:0});
 await budget.apply(init);
 await budget.apply(reserve);
 await ledger.write(op('fill','outside',null,{execution:{...execution,cycleId:'different-id'}}));
 await cash.write(opening);
 await cash.write(observation('779'));
 const result=await readLegacyReconciliation(readOnly,options);
 assert.equal(result.status,'review-needed');
 assert.equal(result.cash.cashDifference,'-0.98');
 assert.equal(result.cash.conservativeNewCash,'0');
 assert.deepEqual(result.flags,['MODEL_HISTORY_MISSING','UNLINKED_MANUAL_EXECUTION','CASH_MISMATCH']);
 assert.equal(result.manualCycles[0].reservation,'UNLINKED_MANUAL_EXECUTION');
});

test('a changing audit head triggers another read before any reconciliation is reported',async t=>{
 const {readOnly,cash}=fixture(t);
 await cash.write(opening);
 let attempts=0;
 const concurrent={prepare(sql){
  if(!sql.startsWith('SELECT key,rev,model'))return readOnly.prepare(sql);
  return {async all(){
   if(++attempts===1)await cash.write(observation('800'));
   return readOnly.prepare(sql).all();
  }};
 }};
 const result=await readLegacyReconciliation(concurrent,options);
 assert.equal(attempts,2);
 assert.equal(result.revisions.cash,2);
 assert.equal(result.cash.cashDifference,'0');
});

test('a mismatched old model and a reservation for a different pair both require review',async t=>{
 const {readOnly,seedModel,ledger,budget,cash}=fixture(t);
 seedModel({qty:0.4,average:100,cycleStartedAt:0});
 await ledger.write(op('fill','model',null,{execution:{...execution,source:'model',
  cycleId:JSON.stringify([key,symbol,tf,0])}}));
 await budget.apply(init);
 await budget.apply({...reserve,symbol:'BTCUSDT'});
 await ledger.write(op('fill','wrong-pair',null,{execution}));
 await cash.write(opening);
 assert.deepEqual((await readLegacyReconciliation(readOnly,options)),{
  status:'review-needed',revisions:{ledger:2,budget:2,cash:1},
  legacyModels:[{key,revision:7,symbol,tf,status:'MODEL_POSITION_MISMATCH'}],
  manualCycles:[{cycleId:'manual-cycle',symbol,position:'open',reservation:'RESERVATION_SYMBOL_MISMATCH'}],
  budget:null,cash:null,flags:['MODEL_POSITION_MISMATCH','RESERVATION_SYMBOL_MISMATCH']
 });
});
