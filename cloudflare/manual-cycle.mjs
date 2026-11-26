// Offline manual spot reconciliation. Signals are reference prices, never fills.
import {normalizeExecution,replayLedger} from './trade-ledger.mjs';
import {units,decimalString,add,sub,mul,div,SCALE,portion} from './ledger-decimal.mjs';
const max=(a,b)=>a>b?a:b;
const txt=decimalString;
const total=a=>a.reduce((n,x)=>add(n,x),0n);
function positive(v,name){const n=units(v);if(n<=0n)throw Error('Invalid '+name);return n;}
export function reconcileManualCycle({reservation,executions,completedSteps=[],signalPrices={},tpRate='0.03',tickSize,exitFeeRate}){
  if(!reservation||reservation.status!=='reserved'||!Array.isArray(reservation.plan?.orders)||reservation.plan.orders.length!==6)throw Error('Invalid reservation');
  if(!Array.isArray(executions)||!Array.isArray(completedSteps))throw Error('Invalid history');
  const tp=positive(tpRate,'tpRate'),tick=positive(tickSize,'tickSize'),fee=units(exitFeeRate);
  if(fee<0n||fee>=SCALE)throw Error('Invalid exitFeeRate');
  const complete=new Set(completedSteps);
  if(complete.size!==completedSteps.length||completedSteps.some(i=>!Number.isInteger(i)||i<0||i>5))throw Error('Invalid completed steps');
  for(let i=0;i<complete.size;i++)if(!complete.has(i))throw Error('Completed steps must be a contiguous prefix');
  // Use only confirmed manual fills linked to the reservation ID, never model executions.
  const raw=executions.filter(e=>e.source==='manual'&&e.cycleId===reservation.id);
  if(raw.some(e=>e.symbol!==reservation.symbol))throw Error('Reservation symbol mismatch');
  const cycles=replayLedger(raw);
  const c=cycles[0]??null,seen=new Set();
  const fills=raw.map(normalizeExecution).filter(e=>{if(seen.has(e.id))return false;seen.add(e.id);return true;});
  const buys=fills.filter(e=>e.side==='buy');
  const flags=[];
  const unassigned=buys.some(e=>e.dca===null);
  if(unassigned)flags.push('UNASSIGNED_BUY');
  let lastStep=-1;
  for(const e of buys){if(e.dca===null)continue;if(e.dca<lastStep)flags.push('OUT_OF_ORDER_STEP');lastStep=Math.max(lastStep,e.dca);}
  const steps=reservation.plan.orders.map((o,i)=>{
    if(o.number!==i)throw Error('Invalid plan step');
    const b=buys.filter(e=>e.dca===i),qty=total(b.map(e=>units(e.exact.quantity))),notional=total(b.map(e=>units(e.exact.notional)));
    const paid=total(b.map(e=>e.feeAsset===e.baseAsset?0n:units(e.exact.feeQuote)));
    if(complete.has(i)&&!b.length)throw Error('Cannot complete step without confirmed fill');
    if(b.length&&i>complete.size)flags.push('UNCONFIRMED_PREVIOUS_STEP');
    const nominal=units(o.nominal),feeReserve=units(o.feeReserve);
    if(notional>nominal||paid>feeReserve)flags.push('STEP_BUDGET_EXCEEDED');
    const remaining=complete.has(i)?0n:add(max(0n,sub(nominal,notional)),max(0n,sub(feeReserve,paid)));
    const avg=qty?div(notional,qty):null;
    const signal=Object.hasOwn(signalPrices,i)?positive(signalPrices[i],'signalPrice'):null;
    return {number:i,status:complete.has(i)?'complete':b.length?'partial':'unfilled',actualNotional:txt(notional),
      actualAverage:avg===null?null:txt(avg),signalPrice:signal===null?null:txt(signal),
      priceDeviation:avg===null||signal===null?null:txt(sub(avg,signal)),remaining:txt(remaining)};
  });
  const remaining=total(steps.map(s=>units(s.remaining)));
  const cost=units(c?.exact.cost??0),committed=add(cost,remaining);
  const cap=units(reservation.plan.cycleBudget);
  const spent=units(c?.exact.buyCost??0),planned=units(reservation.plan.total);
  if(add(spent,remaining)>planned)flags.push('PLAN_RESERVE_EXCEEDED');
  if(committed>cap)flags.push('CYCLE_BUDGET_EXCEEDED');
  const closed=c?.closedAt!=null;
  // Partial exit does not authorize release of any outstanding order/reservation.
  if(closed&&remaining>0n)flags.push('CONFIRM_REMAINING_ORDERS_CANCELLED');
  let next=null;
  if(!closed&&!flags.length&&complete.size>0&&complete.size<6){
    const step=complete.size;
    if(steps[step].status==='unfilled'){
      // Proposed anchor: weighted actual execution price of previous completed step.
      const anchor=units(steps[step-1].actualAverage);
      const drop=units(reservation.plan.orders[step].dropPercent);
      const target=portion(anchor,100n*SCALE-drop,100n*SCALE);
      const rounded=target/tick*tick;
      if(rounded>0n)next={number:step,anchor:txt(anchor),price:txt(rounded),nominal:reservation.plan.orders[step].nominal};
    }
  }
  let target=null;
  if(c&&!closed&&units(c.exact.quantity)>0n){
    const gross=mul(units(c.exact.averageEntry),add(SCALE,tp));
    const rounded=(gross+tick-1n)/tick*tick;
    const proceeds=mul(mul(rounded,units(c.exact.quantity)),sub(SCALE,fee));
    target={price:txt(rounded),estimatedNetPnl:txt(sub(proceeds,cost)),estimatedExitFeeRate:txt(fee)};
  }
  return {source:'manual',cycleId:reservation.id,symbol:reservation.symbol,confirmedExecutions:fills.length,
    status:closed?'closed':c?'open':'awaiting_fill',quantity:c?.exact.quantity??'0',
    averageEntry:c?.exact.averageEntry??null,averageCost:c?.exact.averageCost??null,
    lastBuyPrice:buys.length?buys.at(-1).exact.price:null,realizedPnl:c?.exact.realized??'0',
    cost:txt(cost),remainingReserve:txt(remaining),committed:txt(committed),steps,flags:[...new Set(flags)],nextDca:next,tp:target};
}
