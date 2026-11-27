// Test-only immutable cash event log. Reconciliation is advisory, not a reserve authorization.
import {cashFlow,reconcileCash,nonnegative,timestamp} from './cash-reconcile.mjs';
import {decimalString,units,add} from './ledger-decimal.mjs';
import {TradeLedgerStore} from './trade-store.mjs';
import {BudgetStore} from './budget-store.mjs';
import {readCashAudit} from './cash-audit-read.mjs';
const txt=decimalString;
export function projectCashAudit({cash,ledger,budget,now,maxAgeMs}){
  const flags=[...(budget?.flags??['BUDGET_NOT_INITIALIZED'])];
  if(budget&&units(budget.deficit)>0n)flags.push('BUDGET_DEFICIT');
  const remaining=budget?.cycles.reduce((n,c)=>add(n,units(c.remainingReserve)),0n)??0n;
  return reconcileCash({opening:cash.opening,flows:cash.flows,executions:ledger.executions.map(x=>x.execution),
    observation:cash.observation?{...cash.observation,revisionsMatch:cash.observation.ledgerRevision===ledger.revision}:null,
    now,maxAgeMs,remainingReserve:txt(remaining),budgetAvailable:budget?.available??'0',budgetFlags:flags});
}
function id(v,name){if(typeof v!=='string'||!v.trim()||v.length>128)throw Error('Invalid '+name);return v;}
function canonical(raw){
  const opId=id(raw.opId,'opId'),actor=id(raw.actor,'actor'),recordedAt=timestamp(raw.recordedAt,'recordedAt');
  if(raw.confirmed!==true)throw Error('Confirmation required');
  const common={opId,actor,recordedAt,kind:raw.kind,confirmed:true};
  if(raw.kind==='opening'){
    if(raw.noOpeningPositions!==true)throw Error('Opening positions require separate reconciliation');
    return {...common,opening:{time:timestamp(raw.time,'opening time'),cash:txt(nonnegative(raw.cash,'opening cash')),confirmed:true,noOpeningPositions:true}};
  }
  if(raw.kind==='flow')return {...common,flow:cashFlow(raw.flow)};
  if(raw.kind==='observe'){
    if(raw.completeHistory!==true)throw Error('Confirm complete history');
    return {...common,observation:{time:timestamp(raw.time,'observation time'),free:txt(nonnegative(raw.free,'observed free')),locked:txt(nonnegative(raw.locked,'observed locked')),completeHistory:true,confirmed:true}};
  }
  throw Error('Unknown cash command');
}
export class CashStore{
  constructor(db){this.db=db;this.ledger=new TradeLedgerStore(db);this.budget=new BudgetStore(db);}
  async rows(sql,...args){return (await this.db.prepare(sql).bind(...args).all()).results;}
  async load(){return readCashAudit(this.db);}
  async write(raw){
    const request=canonical(raw);
    for(let i=0;i<8;i++){
      const s=await this.load();
      if(s.ops.has(request.opId)){
        if(JSON.stringify(s.ops.get(request.opId))!==JSON.stringify(request))throw Error('Conflicting cash operation ID');
        return {status:'duplicate',revision:s.revision};
      }
      if(raw.expectedRevision!==s.revision)throw Error('Stale cash revision');
      const ledger=await this.ledger.snapshot();
      if(request.kind==='opening'){
        if(s.opening)throw Error('Cash opening already set');
        if(ledger.executions.some(x=>x.execution.source==='manual'&&x.execution.time<request.opening.time))throw Error('Existing manual history precedes opening');
        if(request.opening.time>request.recordedAt)throw Error('Future opening');
      }else{
        if(!s.opening)throw Error('Cash opening missing');
        if(request.kind==='flow'){
          const f=request.flow;
          if(f.time<s.opening.time||f.time>request.recordedAt)throw Error('Flow outside interval');
          const old=s.flows.find(x=>x.id===f.id);
          if(old){if(JSON.stringify(old)!==JSON.stringify(f))throw Error('Conflicting cash flow ID');return {status:'duplicate',revision:s.revision};}
        }else{
          const o=request.observation;
          if(o.time<s.opening.time||o.time>request.recordedAt)throw Error('Observation outside interval');
          if(s.flows.some(f=>f.time>o.time)||ledger.executions.some(x=>x.execution.source==='manual'&&x.execution.time>o.time))throw Error('Observation predates known events');
        }
      }
      const payload={request,ledgerRevision:ledger.revision};
      const out=await this.db.prepare(`INSERT INTO dev_cash_audit(op_id,payload) SELECT ?,?
        WHERE COALESCE((SELECT MAX(seq) FROM dev_cash_audit),0)=?
        AND COALESCE((SELECT MAX(seq) FROM trade_ledger_audit),0)=?`)
        .bind(request.opId,JSON.stringify(payload),s.revision,ledger.revision).run();
      if(out.meta.changes===1)return {status:'stored',revision:Number(out.meta.last_row_id)};
      if(out.meta.changes!==0)throw Error('Unexpected cash write result');
    }
    throw Error('Cash contention: retry');
  }
  async report({now,maxAgeMs}){
    // Verify revisions after reading all three append-only streams. No external balance API.
    for(let i=0;i<8;i++){
      const cash=await this.load(),ledger=await this.ledger.snapshot(),before=await this.budget.load(),budget=await this.budget.snapshot();
      if(!cash.opening)throw Error('Cash opening missing');
      const [rev]=await this.rows(`SELECT
        COALESCE((SELECT MAX(seq) FROM dev_cash_audit),0) AS cash,
        COALESCE((SELECT MAX(seq) FROM trade_ledger_audit),0) AS ledger,
        COALESCE((SELECT MAX(seq) FROM dev_budget_audit),0) AS budget`);
      if(rev.cash!==cash.revision||rev.ledger!==ledger.revision||rev.budget!==before.seq)continue;
      return {...projectCashAudit({cash,ledger,budget:budget?.summary,now,maxAgeMs}),
        cashRevision:cash.revision,ledgerRevision:ledger.revision,budgetRevision:before.seq};
    }
    throw Error('Concurrent reconciliation: retry');
  }
}
