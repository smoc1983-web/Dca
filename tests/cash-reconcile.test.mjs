import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {reconcileCash} from '../cloudflare/cash-reconcile.mjs';
import {CashStore} from '../cloudflare/cash-store.mjs';
const opening={time:0,cash:'800',confirmed:true,noOpeningPositions:true};
const flow=(o={})=>({id:'d',kind:'deposit',time:1,amount:'200',confirmed:true,...o});
const fill=(o={})=>({source:'manual',confirmed:true,id:'b',cycleId:'c',symbol:'ADAUSDT',tf:'5m',baseAsset:'ADA',quoteAsset:'USDT',time:2,side:'buy',price:'100',quantity:'1',fee:'0.1',feeAsset:'USDT',dca:0,...o});
const sale=fill({id:'s',time:3,side:'sell',price:'110',fee:'0.11',dca:null});
const observe=(o={})=>({time:5,free:'959.79',locked:'0',confirmed:true,completeHistory:true,revisionsMatch:true,...o});
const calc=(o={})=>reconcileCash({opening,flows:[flow(),flow({id:'w',kind:'withdrawal',amount:'50',time:4})],executions:[fill(),sale],observation:observe(),now:5,maxAgeMs:10,budgetAvailable:'800',...o});
test('external flows are separate from realized trading PnL',()=>{
 const x=calc();assert.equal(x.netExternalFlows,'150');assert.equal(x.realizedTradingPnl,'9.79');assert.equal(x.expectedQuoteCash,'959.79');assert.equal(x.reconciled,true);
});
test('nonquote fees reduce PnL but not USDT wallet cash',()=>{
 const x=calc({flows:[],executions:[fill({fee:'0.01',feeAsset:'BNB',feeQuoteRate:'10'}),sale],observation:observe({free:'809.89'})});
 assert.equal(x.quoteFees,'0.11');assert.equal(x.nonQuoteFeesEquivalent,'0.1');assert.equal(x.expectedQuoteCash,'809.89');assert.equal(x.realizedTradingPnl,'9.79');
});
test('manual-only, duplicate fills/flows, and partial exit',()=>{
 const f=fill(),s=fill({id:'s',time:3,side:'sell',quantity:'0.5',price:'110',fee:'0.055'});
 const x=calc({flows:[flow(),flow()],executions:[f,f,s,fill({source:'model',id:'model'})],observation:observe({free:'954.845'})});
 assert.equal(x.expectedQuoteCash,'954.845');assert.equal(x.realizedTradingPnl,'4.895');assert.equal(x.remainingPositionCost,'50.05');
 assert.throws(()=>calc({flows:[flow(),flow({amount:'201'})]}),/Conflicting cash flow/);
});
test('cash mismatch, stale data, history changes and absent observations fail closed',()=>{
 for(const o of [observe({free:'959'}),observe({time:3}),observe({revisionsMatch:false}),null,observe({completeHistory:false})]){
   const x=calc({observation:o});assert.equal(x.reconciled,false);assert.equal(x.conservativeNewCash,'0');
 }
 assert.throws(()=>calc({opening:{...opening,noOpeningPositions:false}}),/opening cash/);
});
test('locked cash is not available; reserve is conservative and cap is separate',()=>{
 const x=calc({observation:observe({free:'659.79',locked:'300'}),remainingReserve:'500',budgetAvailable:'100'});
 assert.equal(x.reconciled,true);assert.equal(x.conservativeNewCash,'100');
 const y=calc({observation:observe({free:'59.79',locked:'900'}),remainingReserve:'100'});
 assert.equal(y.reserveCashDeficit,'40.21');assert.equal(y.conservativeNewCash,'0');
});
const schema=['trade-ledger-schema.sql','budget-store-schema.sql','cash-store-schema.sql'].map(f=>readFileSync(new URL('../cloudflare/'+f,import.meta.url),'utf8')).join('\n');
function port(db){return {prepare(sql){let args=[];return {bind(...v){args=v;return this;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}};}
const command=(kind,opId,expectedRevision,o={})=>({kind,opId,expectedRevision,actor:'test',recordedAt:10,confirmed:true,...o});
async function fixture(t,cashGuardMaxAgeMs){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(schema);const s=new CashStore(port(db));
 await s.budget.apply({kind:'init',opId:'budget-init',actor:'test',recordedAt:0,expectedRevision:null,
  ...(cashGuardMaxAgeMs===undefined?{}:{cashGuardMaxAgeMs}),settings:{policy:'equal-slots-v1',capital:'800',freeCash:'800',maxCycles:1,feeRate:'0.001'}});
 await s.write(command('opening','open',0,opening));return {s,db};}
test('persistent confirmed flows, duplicate and stale CAS',async t=>{
 const {s,db}=await fixture(t);const c=command('flow','deposit',1,{flow:flow()});
 const r=await s.write(c);assert.equal(r.revision,2);assert.equal((await s.write(c)).status,'duplicate');
 await assert.rejects(s.write(command('flow','stale',1,{flow:flow({id:'new'})})),/Stale/);
 await assert.rejects(s.write(command('flow','conflict',2,{flow:flow({amount:'201'})})),/Conflicting/);
 const again=new CashStore(port(db));assert.equal((await again.report({now:10,maxAgeMs:10})).expectedQuoteCash,'1000');
 await s.write(command('observe','balance',2,{time:5,free:'1000',locked:'0',completeHistory:true}));
 const x=await again.report({now:10,maxAgeMs:10});assert.equal(x.reconciled,true);assert.equal(x.conservativeNewCash,'800');
});
test('new confirmed flow invalidates observation and ledger correction invalidates revision',async t=>{
 const {s}=await fixture(t);
 await s.write(command('observe','obs',1,{time:5,free:'800',locked:'0',completeHistory:true}));
 await s.write(command('flow','d',2,{flow:flow()}));
 assert.ok((await s.report({now:10,maxAgeMs:10})).flags.includes('NO_BALANCE_OBSERVATION'));
 await s.write(command('observe','obs2',3,{time:5,free:'1000',locked:'0',completeHistory:true}));
 await s.ledger.write({kind:'fill',opId:'trade',actor:'test',recordedAt:6,execution:fill()});
 const x=await s.report({now:10,maxAgeMs:10});assert.ok(x.flags.includes('HISTORY_CHANGED'));assert.equal(x.conservativeNewCash,'0');
});
test('concurrent commands with same cash revision only one commits',async t=>{
 const {s,db}=await fixture(t),b=new CashStore(port(db));
 const a=await Promise.allSettled([s.write(command('flow','a',1,{flow:flow()})),b.write(command('flow','b',1,{flow:flow({id:'b'})}))]);
 assert.equal(a.filter(x=>x.status==='fulfilled'&&x.value.status==='stored').length,1);
 assert.equal((await s.load()).flows.length,1);
});
test('budget status distinguishes absent policy, stale observations and an uncovered history interval',async t=>{
 const noPolicy=(await fixture(t)).s;
 assert.deepEqual(await noPolicy.reconciliationStatus({now:10}),{budgetRevision:0,ledgerRevision:0,cashRevision:1,
  reconciliation:{reconciled:false,flags:['CASH_RECONCILIATION_POLICY_MISSING']}});
 const {s}=await fixture(t,3);
 await s.write(command('observe','obs',1,{time:5,free:'800',locked:'0',completeHistory:true}));
 assert.deepEqual(await s.reconciliationStatus({now:8}),{budgetRevision:0,ledgerRevision:0,cashRevision:2,reconciliation:{reconciled:true,flags:[]}});
 assert.deepEqual((await s.reconciliationStatus({now:9})).reconciliation,{reconciled:false,flags:['STALE_OBSERVATION']});
 await s.ledger.write({kind:'fill',opId:'trade',actor:'test',recordedAt:12,execution:fill({time:12})});
 assert.deepEqual((await s.reconciliationStatus({now:10})).reconciliation,
  {reconciled:false,flags:['UNLINKED_MANUAL_EXECUTION','HISTORY_OUTSIDE_CASH_INTERVAL']});
});
test('budget status retries if the revision changes after reading the budget row',async t=>{
 const {s,db}=await fixture(t,10);
 await s.write(command('observe','obs',1,{time:5,free:'800',locked:'0',completeHistory:true}));
 const base=port(db);
 let reads=0;
 const concurrent={prepare(sql){
  const statement=base.prepare(sql);
  if(!sql.startsWith('SELECT seq,state FROM dev_budget_audit'))return statement;
  return {...statement,async all(){
   const result=await statement.all();
   if(++reads===1)await s.budget.apply(command('change','budget-change',0,{settings:{capital:'900'}}));
   return result;
  }};
 }};
 assert.deepEqual(await new CashStore(concurrent).reconciliationStatus({now:10}),
  {budgetRevision:1,ledgerRevision:0,cashRevision:2,reconciliation:{reconciled:true,flags:[]}});
 assert.equal(reads,2);
});
