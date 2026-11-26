// Offline shared-cash spot simulation. Existing strategy engine unchanged.
// Fixed allocation per cycle, close-price execution, no actual orders.
import {DEFAULTS,newState,advance} from '../cloudflare/watchlist-engine.mjs';
import {dcaPlan} from '../cloudflare/portfolio-budget.mjs';
import {inspectSpotDataset} from './backtest-spot.mjs';
const EPS=1e-7;
const isExit=e=>e&&(e.kind==='TP'||e.kind==='STOP');
const sum=a=>a.reduce((s,x)=>s+x,0);
export function backtestPortfolio({datasets,capital,maxCycles,slippageBps,priority='symbol-asc'}){
 if(!Number.isFinite(capital)||capital<=0||!Number.isSafeInteger(maxCycles)||maxCycles<1||maxCycles>19||
    !Number.isFinite(slippageBps)||slippageBps<0||slippageBps>=10000||priority!=='symbol-asc')throw Error('Invalid portfolio settings');
 if(!Array.isArray(datasets)||!datasets.length||datasets.length>19)throw Error('Invalid datasets');
 const cycleBudget=Math.floor(capital/maxCycles*1e8)/1e8;
 const entries=datasets.map(d=>{
  const verified=inspectSpotDataset(d),p={...DEFAULTS,...d.params,drops:[...DEFAULTS.drops],initialCapital:cycleBudget,baseCash:25*cycleBudget/800,slippageBps};
  const plan=dcaPlan({cycleBudget:String(cycleBudget),feeRate:String(p.fee)});
  if(!plan.valid)throw Error('Invalid portfolio ladder');
  const state=newState(p);
  for(let i=0;i<verified.warmupBars;i++)advance(state,verified.rows[i],{...p,exitOnly:true},d.tf);
  return {symbol:p.symbol,tf:d.tf,p,plan,state,rows:verified.rows,index:verified.warmupBars,mark:verified.rows[verified.warmupBars-1].close,
    start:d.window.start,end:d.window.end,kind:verified.manifest.kind,dataSha256:verified.dataSha256,cycle:null};
 }).sort((a,b)=>a.symbol<b.symbol?-1:a.symbol>b.symbol?1:0);
 if(new Set(entries.map(e=>e.symbol)).size!==entries.length||entries.some(e=>e.start!==entries[0].start||e.end!==entries[0].end||e.kind!==entries[0].kind))throw Error('Duplicate market, mixed data kind or unequal evaluation windows');
 let cash=capital,peak=capital,maxDrawdown=0,peakReserved=0,peakActive=0,fees=0,realized=0,peakExposure=0,minFree=capital;
 const events=[],closed=[],rejected=[];
 const reserved=()=>sum(entries.map(e=>e.cycle?.remaining??0));
 const exposure=()=>sum(entries.map(e=>e.state.qty*e.mark));
 const active=()=>entries.filter(e=>e.cycle!==null).length;
 const check=()=>{
  const r=reserved(),free=cash-r;
  if(!Number.isFinite(cash)||!Number.isFinite(r)||cash< -EPS||r< -EPS||free< -EPS||active()>maxCycles)throw Error('Portfolio cash or reserve invariant violated');
  peakReserved=Math.max(peakReserved,r);peakActive=Math.max(peakActive,active());minFree=Math.min(minFree,free);
 };
 function execute(e,next,event,c){
  const before=e.state,delta=next.cash-before.cash;
  if(!e.cycle)throw Error('Missing reserved cycle');
  if(isExit(event)){
   if(delta<0)throw Error('Invalid exit');
   cash+=delta;const fee=event.quantity*event.price*(1-slippageBps/10000)*e.p.fee;
   fees+=fee;const pnl=delta-e.cycle.spent;realized+=pnl;
   closed.push({symbol:e.symbol,startedAt:e.cycle.startedAt,closedAt:c.closeTime,exit:event.kind,netPnl:pnl,fees:e.cycle.fees+fee});
   e.cycle=null;
  }else{
   const step=event.dca,order=e.plan.orders[step],cost=-delta,fee=event.notional*e.p.fee;
   if(!order||cost<0||cost>Number(order.nominal)+Number(order.feeReserve)+EPS||cost>e.cycle.remaining+EPS)throw Error('Fill exceeds reserved step');
   cash-=cost;e.cycle.spent+=cost;e.cycle.fees+=fee;fees+=fee;
   // Release that step's unused rounding allowance; preserve all future nominal + fee reserve.
   e.cycle.remaining=sum(e.plan.orders.slice(step+1).map(o=>Number(o.nominal)+Number(o.feeReserve)));
  }
  e.state=next;events.push({symbol:e.symbol,kind:event.kind,time:c.closeTime,price:event.price,fillPrice:isExit(event)?event.price*(1-slippageBps/10000):event.fillPrice,quantity:event.quantity,cashDelta:delta,cashAfter:cash,reserveAfter:reserved(),activeAfter:active()});check();
 }
 while(true){
  const t=Math.min(...entries.map(e=>e.rows[e.index]?.closeTime??Infinity));
  if(t===Infinity)break;
  const due=entries.filter(e=>e.rows[e.index]?.closeTime===t);
  // Update marks only from candles already closed at this timestamp.
  for(const e of due)e.mark=e.rows[e.index].close;
  // Evaluate each market exactly once from its own previous state. Exits before buys,
  // active DCA before new START; symbol order resolves simultaneous new signals.
  const candidates=due.map(e=>{
   const c=e.rows[e.index++],before=e.state,next=structuredClone(before);
   const event=advance(next,c,e.p,e.tf)?.event??null;
   return {e,c,next,event};
  });
  for(const x of candidates.filter(x=>isExit(x.event)))execute(x.e,x.next,x.event,x.c);
  for(const x of candidates.filter(x=>x.event&&!isExit(x.event)&&x.event.kind!=='START'))execute(x.e,x.next,x.event,x.c);
  for(const {e,c,next,event} of candidates.filter(x=>x.event?.kind==='START')){
   const total=Number(e.plan.total);
   const reason=active()>=maxCycles?'MAX_ACTIVE_CYCLES':cash-reserved()+EPS<total?'INSUFFICIENT_FULL_LADDER_RESERVE':null;
   if(reason){
    // Keep indicator progression but never mutate inventory/cash from rejected START.
    advance(e.state,c,{...e.p,exitOnly:true},e.tf);
    rejected.push({symbol:e.symbol,time:c.closeTime,reason});continue;
   }
   e.cycle={startedAt:c.closeTime,spent:0,fees:0,remaining:total};
   execute(e,next,event,c);
  }
  for(const x of candidates.filter(x=>!x.event))x.e.state=x.next;
  check();
  const marked=exposure(),equity=cash+marked;
  peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);peakExposure=Math.max(peakExposure,marked);
 }
 const marked=exposure(),equity=cash+marked,openPositions=entries.filter(e=>e.cycle).map(e=>({symbol:e.symbol,quantity:e.state.qty,averageEntry:e.state.average,markPrice:e.mark,spent:e.cycle.spent,remainingReserve:e.cycle.remaining,markedPnl:e.state.qty*e.mark-e.cycle.spent}));
 const openPnl=sum(openPositions.map(x=>x.markedPnl));
 if(Math.abs(equity-capital-realized-openPnl)>EPS*Math.max(1,capital))throw Error('Portfolio PnL reconciliation failed');
 return {version:'shared-spot-close-v1',mode:'shared-spot',kind:entries[0].kind,settings:{capital,maxCycles,cycleBudget,slippageBps,priority},
  window:{start:entries[0].start,end:entries[0].end},datasets:entries.map(e=>({symbol:e.symbol,tf:e.tf,dataSha256:e.dataSha256,plan:e.plan})),events,closed,rejected,openPositions,
  metrics:{initialCapital:capital,finalCash:cash,remainingReserve:reserved(),finalFreeCash:cash-reserved(),finalMarkedEquity:equity,netMarkedPnl:equity-capital,netMarkedReturnPercent:100*(equity/capital-1),realizedClosedPnl:realized,openMarkedPnl:openPnl,fees,maxCloseDrawdownPercent:100*maxDrawdown,peakExposure,peakReserved,peakActive,minFree,closedCount:closed.length,rejectedCount:rejected.length},
  limitations:['FIXED_EQUAL_SLOTS','ALPHABETICAL_TIE_BREAK_NOT_OPTIMIZED','LOCAL_CYCLE_STOP_BASED_ON_ALLOCATED_CAPITAL','MODEL_FILTERS','MARKS_AS_OF_LAST_CLOSED_BAR','NO_INTRABAR_RISK','NO_REAL_ORDERS','NO_FUTURES']};
}
