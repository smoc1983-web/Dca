// Offline USDT cash reconciliation, not an exchange wallet or equity calculation.
import {units,decimalString,add,sub} from './ledger-decimal.mjs';
import {normalizeExecution,replayLedger} from './trade-ledger.mjs';
const txt=decimalString;
const sum=a=>a.reduce((n,x)=>add(n,x),0n);
const max=(a,b)=>a>b?a:b;
const min=(a,b)=>a<b?a:b;
export function nonnegative(v,name,positive=false){
  const n=units(v);if(n<0n||(positive&&n===0n))throw Error('Invalid '+name);return n;
}
export function timestamp(v,name){if(!Number.isSafeInteger(v)||v<0)throw Error('Invalid '+name);return v;}
export function cashFlow(raw){
  if(!raw||raw.confirmed!==true||!['deposit','withdrawal'].includes(raw.kind))throw Error('Confirmed deposit/withdrawal required');
  if(typeof raw.id!=='string'||!raw.id.trim()||raw.id.length>128)throw Error('Invalid flow ID');
  return {id:raw.id,kind:raw.kind,time:timestamp(raw.time,'flow time'),amount:txt(nonnegative(raw.amount,'flow amount',true)),confirmed:true};
}
export function historyOutsideCashInterval(cash,executions,now){
  const start=cash.opening.time;
  const outside=event=>event.time<start||event.time>now;
  return start>now||cash.observation?.time>now||cash.flows.some(outside)||
    executions.some(execution=>execution.source==='manual'&&outside(execution));
}
export function reconcileCash({opening,flows,executions,observation=null,now,maxAgeMs,remainingReserve='0',budgetAvailable='0',budgetFlags=[]}){
  if(!opening||opening.confirmed!==true||opening.noOpeningPositions!==true)throw Error('Confirmed opening cash without positions required');
  const start=timestamp(opening.time,'opening time'),initial=nonnegative(opening.cash,'opening cash');
  timestamp(now,'now');timestamp(maxAgeMs,'maxAgeMs');
  if(now<start||!Array.isArray(flows)||!Array.isArray(executions)||!Array.isArray(budgetFlags))throw Error('Invalid reconciliation inputs');
  const flowMap=new Map(),fillMap=new Map();
  let deposits=0n,withdrawals=0n,buys=0n,sells=0n,quoteFees=0n,otherFees=0n,latest=start;
  const timeCheck=t=>{if(t<start||t>now)throw Error('Event outside reconciliation interval');latest=Math.max(latest,t);};
  for(const raw of flows){
    const f=cashFlow(raw),encoded=JSON.stringify(f);timeCheck(f.time);
    if(flowMap.has(f.id)){if(flowMap.get(f.id)!==encoded)throw Error('Conflicting cash flow ID');continue;}
    flowMap.set(f.id,encoded);
    if(f.kind==='deposit')deposits=add(deposits,units(f.amount));else withdrawals=add(withdrawals,units(f.amount));
  }
  const manual=executions.filter(e=>e.source==='manual');
  const cycles=replayLedger(manual);
  for(const raw of manual){
    const e=normalizeExecution(raw),encoded=JSON.stringify(e);timeCheck(e.time);
    if(fillMap.has(e.id)){if(fillMap.get(e.id)!==encoded)throw Error('Conflicting execution ID');continue;}
    fillMap.set(e.id,encoded);
    if(e.side==='buy')buys=add(buys,units(e.exact.notional));else sells=add(sells,units(e.exact.notional));
    if(e.feeAsset==='USDT')quoteFees=add(quoteFees,units(e.exact.feeQuote));else otherFees=add(otherFees,units(e.exact.feeQuote));
  }
  const netFlows=sub(deposits,withdrawals);
  const expected=sub(add(add(initial,netFlows),sells),add(buys,quoteFees));
  const realized=sum(cycles.map(c=>units(c.exact.realized)));
  const flags=[...budgetFlags],reserve=nonnegative(remainingReserve,'remaining reserve'),budget=nonnegative(budgetAvailable,'budget available');
  let observed=null,delta=null,available=0n,deficit=null;
  if(expected<0n)flags.push('NEGATIVE_EXPECTED_CASH');
  if(!observation)flags.push('NO_BALANCE_OBSERVATION');
  else{
    const at=timestamp(observation.time,'observation time');
    if(at>now)throw Error('Future observation');
    const free=nonnegative(observation.free,'observed free'),locked=nonnegative(observation.locked,'observed locked');
    observed=add(free,locked);delta=sub(observed,expected);
    if(observation.confirmed!==true||observation.completeHistory!==true)flags.push('INCOMPLETE_RECONCILIATION');
    if(at<latest||now-at>maxAgeMs)flags.push('STALE_OBSERVATION');
    if(observation.revisionsMatch!==true)flags.push('HISTORY_CHANGED');
    if(delta!==0n)flags.push('CASH_MISMATCH');
    // Conservatively subtract all remaining internal reservations even if exchange cash is locked.
    // No double-counting of already executed buy costs: they are already absent from free cash.
    deficit=max(0n,sub(reserve,free));
    if(deficit>0n)flags.push('RESERVE_CASH_DEFICIT');
    if(!flags.length)available=min(budget,max(0n,sub(free,reserve)));
  }
  return {openingCash:txt(initial),deposits:txt(deposits),withdrawals:txt(withdrawals),netExternalFlows:txt(netFlows),
    buyNotional:txt(buys),sellNotional:txt(sells),quoteFees:txt(quoteFees),nonQuoteFeesEquivalent:txt(otherFees),
    expectedQuoteCash:txt(expected),observedQuoteCash:observed===null?null:txt(observed),cashDifference:delta===null?null:txt(delta),
    realizedTradingPnl:txt(realized),remainingPositionCost:txt(sum(cycles.map(c=>units(c.exact.cost)))),
    remainingReserve:txt(reserve),reserveCashDeficit:deficit===null?null:txt(deficit),conservativeNewCash:txt(available),
    reconciled:flags.length===0,flags:[...new Set(flags)]};
}
