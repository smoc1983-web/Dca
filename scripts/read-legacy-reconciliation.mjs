import {BudgetStore,summarizeBudget} from '../cloudflare/budget-store.mjs';
import {readCashAudit} from '../cloudflare/cash-audit-read.mjs';
import {historyOutsideCashInterval,timestamp} from '../cloudflare/cash-reconcile.mjs';
import {projectCashAudit} from '../cloudflare/cash-store.mjs';
import {units} from '../cloudflare/ledger-decimal.mjs';
import {TradeLedgerStore} from '../cloudflare/trade-store.mjs';

function modelFinding(row,cycles){
 const result={key:row.key,revision:row.rev};
 let entry;
 try{entry=JSON.parse(row.model);}catch{return {...result,status:'INVALID_MODEL_SNAPSHOT'};}
 const s=entry?.s;
 if(!Number.isFinite(s?.qty)||s.qty<0)return {...result,status:'INVALID_MODEL_SNAPSHOT'};
 if(s.qty===0)return null;
 const {symbol,tf}=entry;
 if(typeof symbol!=='string'||!symbol||typeof tf!=='string'||!tf||!Number.isFinite(s.average)||s.average<=0)
  return {...result,status:'INVALID_MODEL_SNAPSHOT'};
 if(!Number.isSafeInteger(s.cycleStartedAt)||s.cycleStartedAt<0)
  return {...result,symbol,tf,status:'MODEL_ORIGIN_MISSING'};
 const cycle=cycles.get(JSON.stringify([row.key,symbol,tf,s.cycleStartedAt]));
 if(!cycle)return {...result,symbol,tf,status:'MODEL_HISTORY_MISSING'};
 // Same tolerance as the model ledger adapter for engine quantities and prices.
 const near=(a,b)=>Number.isFinite(a)&&Math.abs(a-b)<=1e-9+Number.EPSILON*64*Math.max(Math.abs(a),Math.abs(b));
 const matches=cycle.closedAt===null&&cycle.symbol===symbol&&cycle.tf===tf&&
  near(cycle.quantity,s.qty)&&near(cycle.averageEntry,s.average);
 return {...result,symbol,tf,status:matches?'matched':'MODEL_POSITION_MISMATCH'};
}

// Dry run against an isolated snapshot. Only SELECTs, with no import or assignment of legacy history.
export async function readLegacyReconciliation(db,{now,maxAgeMs}){
 timestamp(now,'now');timestamp(maxAgeMs,'maxAgeMs');
 const ledgerStore=new TradeLedgerStore(db),budgetStore=new BudgetStore(db);
 let ledger,budget,cash,models;
 for(let attempt=0;attempt<8;attempt++){
  [ledger,budget,cash]=await Promise.all([ledgerStore.snapshot(),budgetStore.load(),readCashAudit(db)]);
  models=(await db.prepare('SELECT key,rev,model FROM models ORDER BY key').all()).results;
  // Append-only heads must still match after the model read, so the report uses a consistent view.
  const {results:[heads]}=await db.prepare(`SELECT
   COALESCE((SELECT MAX(seq) FROM trade_ledger_audit),0) AS ledger,
   COALESCE((SELECT MAX(seq) FROM dev_budget_audit),0) AS budget,
   COALESCE((SELECT MAX(seq) FROM dev_cash_audit),0) AS cash`).all();
  if(heads.ledger===ledger.revision&&heads.budget===budget.seq&&heads.cash===cash.revision)break;
  if(attempt===7)throw Error('Concurrent reconciliation: retry');
 }
 const modelCycles=new Map(ledger.cycles.filter(c=>c.source==='model').map(c=>[c.cycleId,c]));
 const legacyModels=models.map(row=>modelFinding(row,modelCycles)).filter(Boolean);
 const reservations=new Map((budget.state?.reservations??[]).map(r=>[r.id,r]));
 const manualCycles=ledger.cycles.filter(c=>c.source==='manual').map(c=>{
  const reservation=reservations.get(c.cycleId);
  const status=!reservation?'UNLINKED_MANUAL_EXECUTION':reservation.symbol!==c.symbol?'RESERVATION_SYMBOL_MISMATCH':reservation.status;
  return {cycleId:c.cycleId,symbol:c.symbol,position:c.closedAt===null?'open':'closed',reservation:status};
 });
 const flags=new Set(legacyModels.filter(m=>m.status!=='matched').map(m=>m.status));
 for(const cycle of manualCycles){
  if(!['reserved','released'].includes(cycle.reservation))flags.add(cycle.reservation);
 }
 const mismatched=flags.has('RESERVATION_SYMBOL_MISMATCH');
 const executions=ledger.executions.map(entry=>entry.execution);
 const summary=budget.state&&!mismatched?summarizeBudget(budget.state,executions):null;
 const budgetReport=summary?{held:summary.held,available:summary.available,deficit:summary.deficit}:null;
 if(!budget.state)flags.add('BUDGET_NOT_INITIALIZED');
 if(summary){
  for(const flag of summary.flags)flags.add(flag);
  if(units(summary.deficit)>0n)flags.add('BUDGET_DEFICIT');
 }
 let cashReport=null;
 if(!cash.opening)flags.add('NO_CASH_OPENING');
 else if(historyOutsideCashInterval(cash,executions,now))flags.add('HISTORY_OUTSIDE_CASH_INTERVAL');
 else if(!mismatched){
  cashReport=projectCashAudit({cash,ledger,budget:summary,now,maxAgeMs});
  for(const flag of cashReport.flags)flags.add(flag);
 }
 return {status:flags.size?'review-needed':'consistent',revisions:{ledger:ledger.revision,budget:budget.seq,cash:cash.revision},
  legacyModels,manualCycles,budget:budgetReport,cash:cashReport,flags:[...flags]};
}
