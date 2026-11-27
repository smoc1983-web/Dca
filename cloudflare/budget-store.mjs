// Test-only budget command log. No account access, trade placement or sender.
import {createBudget,changeBudget,reserveCycle,releaseUnfilled} from './portfolio-budget.mjs';
import {reconcileManualCycle} from './manual-cycle.mjs';
import {LedgerWriteConflict,TradeLedgerStore,normalizeLedgerOperation} from './trade-store.mjs';
import {normalizeExecution,replayLedger} from './trade-ledger.mjs';
import {units,decimalString,add} from './ledger-decimal.mjs';
import {readCashAudit} from './cash-audit-read.mjs';
import {historyOutsideCashInterval,reconcileCash} from './cash-reconcile.mjs';
const max=(a,b)=>a>b?a:b,min=(a,b)=>a<b?a:b;
const txt=decimalString;
function json(v){return JSON.stringify(v,(_,x)=>{
  if(typeof x==='number'&&!Number.isFinite(x))throw Error('Nonfinite request');
  if(x&&typeof x==='object'&&!Array.isArray(x))return Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]]));
  return x;
});}
function str(x,name){if(typeof x!=='string'||!x.trim()||x.length>128)throw Error('Invalid '+name);return x;}
function validateExecutionHistory(executions){
  try{replayLedger(executions);}catch(error){throw new LedgerWriteConflict(error.message);}
}
export function summarizeBudget(state,executions){
  const details=[],flags=[];
  for(const e of executions)if(e.source==='manual'&&!state.reservations.some(r=>r.id===e.cycleId))flags.push('UNLINKED_MANUAL_EXECUTION');
  let held=0n;
  for(const r of state.reservations){
    const fills=executions.filter(e=>e.source==='manual'&&e.cycleId===r.id);
    if(r.status==='released'){
      if(json(fills)!==r.releaseFingerprint)flags.push('RELEASED_HISTORY_CHANGED');
      continue;
    }
    const p=reconcileManualCycle({reservation:r,executions:fills,completedSteps:r.completedSteps??[],tickSize:r.tickSize,exitFeeRate:r.exitFeeRate});
    if(r.correctionPending){flags.push('CORRECTION_RECONCILIATION_REQUIRED');p.nextDca=null;}
    if(r.reopenedAfterCorrection){flags.push('REOPENED_AFTER_CORRECTION');p.nextDca=null;}
    const [cycle]=replayLedger(fills);
    // Do not automatically reuse proceeds or unspent portions until explicit reconciliation.
    const hold=max(units(r.plan.total),add(units(cycle?.exact.buyCost??0),units(p.remainingReserve)));
    held=add(held,hold);flags.push(...p.flags);
    details.push({...p,held:txt(hold)});
  }
  const ceiling=min(units(state.settings.capital),units(state.settings.freeCash));
  return {active:details.length,held:txt(held),available:txt(max(0n,ceiling-held)),deficit:txt(max(0n,held-ceiling)),flags:[...new Set(flags)],cycles:details};
}
export class BudgetStore{
  constructor(db,{clock=Date.now}={}){this.db=db;this.ledger=new TradeLedgerStore(db);this.clock=clock;}
  async rows(sql,...args){return (await this.db.prepare(sql).bind(...args).all()).results;}
  async load(){
    const [row]=await this.rows('SELECT seq,state FROM dev_budget_audit ORDER BY seq DESC LIMIT 1');
    return row?{seq:row.seq,state:JSON.parse(row.state)}:{seq:0,state:null};
  }
  async snapshot(){
    const {state}=await this.load(),ledger=await this.ledger.snapshot();
    return state?{state,summary:summarizeBudget(state,ledger.executions.map(x=>x.execution))}:null;
  }
  async apply(raw,{serverTimestamp=false}={}){
    const opId=str(raw.opId,'opId'),actor=str(raw.actor,'actor');
    if(!Number.isSafeInteger(raw.recordedAt)||raw.recordedAt<0)throw Error('Invalid recordedAt');
    const request=json(raw);
    for(let attempt=0;attempt<8;attempt++){
      const cur=await this.load(),ledger=await this.ledger.snapshot(),fills=ledger.executions.map(x=>x.execution);
      const [head]=await this.rows(`SELECT
        COALESCE((SELECT MAX(seq) FROM dev_budget_audit),0) AS budget,
        COALESCE((SELECT MAX(seq) FROM trade_ledger_audit),0) AS ledger,
        (SELECT request FROM dev_budget_audit WHERE op_id=?) AS request`,opId);
      // Observe the operation ID and heads together before rejecting a stale revision.
      if(head.budget!==cur.seq||head.ledger!==ledger.revision)continue;
      if(head.request!==null){
        const prior=serverTimestamp?json({...JSON.parse(head.request),recordedAt:raw.recordedAt}):head.request;
        if(prior!==request)throw new LedgerWriteConflict('Conflicting budget operation ID');
        return {status:'duplicate',state:cur.state,summary:summarizeBudget(cur.state,fills)};
      }
      let next,ledgerOp=null,cashRevision=null,projectedFills=fills;
      if(raw.kind==='init'){
        if(cur.state)throw Error('Budget already initialized');
        if(raw.expectedRevision!==null)throw Error('Initial revision must be null');
        next=createBudget(raw.settings);
        // Explicit opt-in for existing isolated fixtures; immutable once initialized.
        if(raw.cashGuardMaxAgeMs!==undefined){
          if(!Number.isSafeInteger(raw.cashGuardMaxAgeMs)||raw.cashGuardMaxAgeMs<1||raw.cashGuardMaxAgeMs>3600000)throw Error('Invalid cash guard max age');
          next.cashGuardMaxAgeMs=raw.cashGuardMaxAgeMs;
        }
      }else{
        if(!cur.state)throw new LedgerWriteConflict('Budget not initialized');
        const s=cur.state;
        if(raw.expectedRevision!==s.revision)throw new LedgerWriteConflict('Stale budget revision');
        if(raw.kind==='change'){
          if(raw.confirmed!==true)throw Error('Budget change must be confirmed');
          next=changeBudget(s,raw.settings,s.revision);
        }else if(raw.kind==='reserve'){
          const summary=summarizeBudget(s,fills);
          if(summary.flags.length||units(summary.deficit)>0n)return {status:'rejected',reason:'RECONCILIATION_REQUIRED'};
          const tickSize=txt(units(raw.tickSize)),exitFeeRate=txt(units(raw.exitFeeRate));
          if(units(tickSize)<=0n||units(exitFeeRate)<0n||units(exitFeeRate)>=units(1))throw Error('Invalid price/fee parameters');
          const r=reserveCycle(s,{id:raw.id,symbol:raw.symbol,expectedRevision:s.revision});
          if(r.status!=='reserved')return {status:r.status,reason:r.reason};
          if(units(r.reservation.plan.total)>units(summary.available))return {status:'rejected',reason:'INSUFFICIENT_ACTUAL_RESERVE'};
          if(s.cashGuardMaxAgeMs!==undefined){
            const cash=await readCashAudit(this.db);cashRevision=cash.revision;
            if(!cash.opening)return {status:'rejected',reason:'CASH_RECONCILIATION_REQUIRED',flags:['NO_CASH_OPENING']};
            const remaining=summary.cycles.reduce((n,c)=>add(n,units(c.remainingReserve)),0n);
            const report=reconcileCash({opening:cash.opening,flows:cash.flows,executions:fills,
              observation:cash.observation?{...cash.observation,revisionsMatch:cash.observation.ledgerRevision===ledger.revision}:null,
              now:this.clock(),maxAgeMs:s.cashGuardMaxAgeMs,remainingReserve:txt(remaining),budgetAvailable:summary.available});
            if(!report.reconciled)return {status:'rejected',reason:'CASH_RECONCILIATION_REQUIRED',flags:report.flags};
            if(units(r.reservation.plan.total)>units(report.conservativeNewCash))return {status:'rejected',reason:'INSUFFICIENT_RECONCILED_CASH'};
          }
          next={...r.state,reservations:r.state.reservations.map(x=>x.id===raw.id?{...x,tickSize,exitFeeRate,completedSteps:[]}:x)};
        }else{
          const r=s.reservations.find(x=>x.id===raw.id);
          if(!r||(r.status!=='reserved'&&!(r.status==='released'&&raw.kind==='correct')))throw new LedgerWriteConflict('Unknown active reservation');
          const own=fills.filter(e=>e.source==='manual'&&e.cycleId===r.id);
          const patch=extra=>({...s,revision:s.revision+1,reservations:s.reservations.map(x=>x.id===r.id?{...x,...extra}:x)});
          if(raw.kind==='fill'){
            if(raw.execution?.source!=='manual'||raw.execution.confirmed!==true||raw.execution.cycleId!==r.id||raw.execution.symbol!==r.symbol)throw new LedgerWriteConflict('Confirmed linked manual fill required');
            ledgerOp=normalizeLedgerOperation({kind:'fill',opId:'budget:'+opId,actor,recordedAt:raw.recordedAt,execution:raw.execution});
            const e=ledgerOp.execution,existing=fills.find(x=>x.source==='manual'&&x.id===e.id);
            if(existing){
              if(json(normalizeExecution(existing))!==json(normalizeExecution(e)))throw new LedgerWriteConflict('Conflicting execution ID');
              return {status:'duplicate',...(await this.snapshot())};
            }
            // A confirmed real fill may exceed the plan: record truth, then flag it.
            projectedFills=[...fills,e];validateExecutionHistory(projectedFills);
            next=patch({});
          }else if(raw.kind==='correct'){
            if(raw.confirmed!==true||raw.execution?.source!=='manual'||raw.execution.confirmed!==true||raw.execution.cycleId!==r.id||raw.execution.symbol!==r.symbol)throw new LedgerWriteConflict('Confirmed linked correction required');
            ledgerOp=normalizeLedgerOperation({kind:'correct',opId:'budget:'+opId,actor,recordedAt:raw.recordedAt,execution:raw.execution,expectedVersion:raw.expectedVersion,reason:raw.reason});
            const e=ledgerOp.execution,previous=ledger.executions.find(x=>x.execution.source==='manual'&&x.execution.id===e.id);
            if(!previous)throw new LedgerWriteConflict('Unknown execution');
            if(previous.version!==ledgerOp.expectedVersion)throw new LedgerWriteConflict('Stale correction version');
            for(const f of ['cycleId','symbol','tf','baseAsset','quoteAsset','side','dca']){
              if(previous.execution[f]!==e[f])throw new LedgerWriteConflict('Correction cannot change '+f);
            }
            // Replace in original append order; never append a second financial execution.
            projectedFills=fills.map(x=>x.source==='manual'&&x.id===e.id?e:x);
            validateExecutionHistory(projectedFills);
            // Conservative policy: even a still-closed released cycle is re-held until review.
            next=patch({status:'reserved',correctionPending:true,reopenedAfterCorrection:r.status==='released'||r.reopenedAfterCorrection===true});
          }else if(raw.kind==='reviewCorrection'){
            if(raw.confirmed!==true||raw.ordersReviewed!==true||r.correctionPending!==true)
              throw new LedgerWriteConflict('Confirm correction and outstanding orders review');
            // The user must acknowledge the exact effective journal revision.
            if(raw.expectedLedgerRevision!==ledger.revision)throw new LedgerWriteConflict('Stale ledger review');
            const cashPinned=Object.hasOwn(raw,'expectedCashRevision');
            if(cashPinned&&s.cashGuardMaxAgeMs===undefined)throw new LedgerWriteConflict('Cash reconciliation policy required');
            if(s.cashGuardMaxAgeMs!==undefined){
              const cash=await readCashAudit(this.db);cashRevision=cash.revision;
              if(cashPinned&&raw.expectedCashRevision!==cash.revision)throw new LedgerWriteConflict('Stale cash review');
              const now=this.clock();
              if(!cash.opening||historyOutsideCashInterval(cash,fills,now))throw new LedgerWriteConflict('Cash reconciliation required');
              const remaining=cashPinned?summarizeBudget(s,fills).cycles.reduce((n,c)=>add(n,units(c.remainingReserve)),0n):0n;
              const report=reconcileCash({opening:cash.opening,flows:cash.flows,executions:fills,
                observation:cash.observation?{...cash.observation,revisionsMatch:cash.observation.ledgerRevision===ledger.revision}:null,
                now,maxAgeMs:s.cashGuardMaxAgeMs,remainingReserve:txt(remaining)});
              if(!report.reconciled)throw new LedgerWriteConflict('Cash reconciliation required: '+report.flags.join(','));
            }
            next=patch({correctionPending:false,reopenedAfterCorrection:false});
          }else if(raw.kind==='complete'){
            if(r.correctionPending)throw Error('Correction review required');
            if(raw.confirmed!==true||raw.step!==r.completedSteps.length)throw Error('Explicit sequential step confirmation required');
            if(replayLedger(own)[0]?.closedAt!=null)throw Error('Cycle already closed');
            next=patch({completedSteps:[...r.completedSteps,raw.step]});summarizeBudget(next,fills);
          }else if(raw.kind==='release'){
            if(r.correctionPending)throw Error('Correction review required');
            if(raw.confirmed!==true||raw.ordersCancelled!==true)throw Error('Confirm cancellation of remaining orders');
            const c=replayLedger(own)[0];
            if(c&&c.closedAt===null)throw Error('Cannot release open position');
            // Releasing a filled cycle requires a newly reconciled pre-reservation pool.
            // No implicit credit of PnL; capital is not modified automatically.
            if(own.length&&raw.freeCash===undefined)throw Error('Reconciled freeCash required');
            if(s.cashGuardMaxAgeMs!==undefined&&own.length){
              const cash=await readCashAudit(this.db);cashRevision=cash.revision;
              if(!cash.opening)throw Error('Cash reconciliation required');
              const report=reconcileCash({opening:cash.opening,flows:cash.flows,executions:fills,
                observation:cash.observation?{...cash.observation,revisionsMatch:cash.observation.ledgerRevision===ledger.revision}:null,
                now:this.clock(),maxAgeMs:s.cashGuardMaxAgeMs});
              if(!report.reconciled)throw Error('Cash reconciliation required: '+report.flags.join(','));
              // The pre-reservation pool is not identical to cash when other positions exist.
              // Never derive or inflate it from PnL; new reservations still require cash guard.
            }
            next=releaseUnfilled(s,{id:r.id,expectedRevision:s.revision});
            if(raw.freeCash!==undefined)next={...changeBudget(next,{freeCash:raw.freeCash},next.revision),revision:s.revision+1};
            next={...next,reservations:next.reservations.map(x=>x.id===r.id?{...x,releaseFingerprint:json(own)}:x)};
          }else throw Error('Unknown budget operation');
        }
      }
      summarizeBudget(next,projectedFills);
      const guard=cashRevision===null?'':' AND COALESCE((SELECT MAX(seq) FROM dev_cash_audit),0)=?';
      const args=[opId,request,JSON.stringify(next),ledgerOp?JSON.stringify(ledgerOp):null,cur.seq,ledger.revision];
      if(cashRevision!==null)args.push(cashRevision);
      const out=await this.db.prepare(`INSERT INTO dev_budget_audit(op_id,request,state,ledger_op)
        SELECT ?,?,?,? WHERE COALESCE((SELECT MAX(seq) FROM dev_budget_audit),0)=?
        AND COALESCE((SELECT MAX(seq) FROM trade_ledger_audit),0)=?`+guard).bind(...args).run();
      // The conditional INSERT creates at most one budget row. D1 also counts the ledger trigger.
      if(Number.isSafeInteger(out.meta.changes)&&out.meta.changes>0)return {status:'stored',...(await this.snapshot())};
      if(out.meta.changes!==0)throw Error('Unexpected write result');
    }
    throw Error('Budget contention: retry');
  }
}
