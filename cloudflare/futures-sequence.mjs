// Sequential hypothetical stress of already-open synthetic futures positions.
// Explicit marks and hypothetical fills only; no actual order authorization or execution.
import {normalizeFuturesEvent,replayFutures,stressManualFutures} from './futures-ledger.mjs';
import {units,decimalString,sub} from './ledger-decimal.mjs';
const txt=decimalString;
const copy=x=>JSON.parse(JSON.stringify(x));
function checkTime(x,n){if(!Number.isSafeInteger(x)||x<0)throw Error('Invalid '+n);return x;}
function explicitSnapshot(s,mode,ids){
 if(!s||!Array.isArray(s.risk)||s.risk.length!==ids.length)throw Error('Complete risk snapshot required');
 if(new Set(s.risk.map(x=>x.cycleId)).size!==ids.length||ids.some(id=>!s.risk.some(x=>x.cycleId===id)))throw Error('Complete risk snapshot required');
 if(mode==='cross'&&units(s.collateralWallet)<0n)throw Error('Invalid wallet');
 if(mode==='isolated'&&s.collateralWallet!==undefined)throw Error('Mixed collateral');
 return copy(s);
}
export function sequentialFuturesStress({synthetic,mode,events,plans,initial,steps}){
 if(synthetic!==true)throw Error('Synthetic only');
 if(!['cross','isolated'].includes(mode))throw Error('Explicit account mode required');
 if(!Array.isArray(events)||!Array.isArray(plans)||!Array.isArray(steps)||steps.length<1||steps.length>100)throw Error('Invalid sequential stress inputs');
 let history=events.map(normalizeFuturesEvent);
 const initialCycles=replayFutures(history);
 if(!initialCycles.length||initialCycles.some(c=>c.closed))throw Error('Only active initial cycles supported');
 const ids=initialCycles.map(c=>c.cycleId),frozen=copy(plans);
 if(frozen.length!==ids.length||new Set(frozen.map(p=>p.cycleId)).size!==ids.length||ids.some(id=>!frozen.some(p=>p.cycleId===id)))throw Error('Complete frozen plans required');
 let now=checkTime(initial?.time,'initial time');
 if(history.some(e=>e.time>now))throw Error('Initial snapshot predates executions');
 let snapshot=explicitSnapshot(initial,mode,ids);
 // Freeze the risk model parameters; only mark, last and collateral can vary at each step.
 const models=new Map(snapshot.risk.map(r=>{const {markPrice,lastPrice,isolatedCollateral,...model}=r;return [r.cycleId,JSON.stringify(model)];}));
 const eventIds=new Set(history.map(e=>e.id));
 function report(s){
  const marks=Object.fromEntries(s.risk.map(r=>[r.cycleId,r.markPrice]));
  const result=stressManualFutures({events:history,plans:frozen,risk:s.risk,mode,collateralWallet:s.collateralWallet,scenarios:[{id:'snapshot',markPrices:marks}],synthetic:true});
  return {flags:result.flags,accounts:result.stress.current.accounts,positions:result.stress.current.positions,cycles:result.cycles};
 }
 function validateModel(s){
  for(const r of s.risk){const {markPrice,lastPrice,isolatedCollateral,...model}=r;if(models.get(r.cycleId)!==JSON.stringify(model))throw Error('Risk model changed within scenario');}
 }
 function stopReason(r){
  if(r.accounts.some(a=>a.maintenanceBreach===null))return 'UNKNOWN_MAINTENANCE';
  if(r.accounts.some(a=>a.maintenanceBreach===true))return 'MAINTENANCE_BREACH';
  if(r.accounts.some(a=>a.reserveDeficit===true))return 'RESERVE_DEFICIT';
  if(r.flags.includes('ACTUAL_NOMINAL_EXCEEDS_PLAN')||r.flags.includes('UNCONFIRMED_PREVIOUS_DCA'))return 'PLAN_RECONCILIATION_REQUIRED';
  return null;
 }
 const start=report(snapshot),results=[];
 let halted=stopReason(start);
 for(let i=0;i<steps.length;i++){
  if(halted)break;
  const step=steps[i],time=checkTime(step.time,'step time');
  if(time<=now)throw Error('Non-increasing scenario time');
  const before=explicitSnapshot(step.before,mode,ids);validateModel(before);
  const pre=report(before),blocked=stopReason(pre);
  if(blocked){results.push({index:i,time,before:pre,after:null,fillApplied:false,reason:blocked});halted=blocked;break;}
  if(!step.fill){
   if(step.complete===true||step.after!==undefined)throw Error('No fill to complete');
   results.push({index:i,time,before:pre,after:null,fillApplied:false,reason:null});now=time;snapshot=before;continue;
  }
  const fill=normalizeFuturesEvent(step.fill);
  if(fill.kind!=='buy'||fill.time!==time||eventIds.has(fill.id)||!ids.includes(fill.cycleId))throw Error('Invalid hypothetical DCA fill');
  const plan=frozen.find(p=>p.cycleId===fill.cycleId);
  if(fill.dca!==plan.completedSteps.length)throw Error('Only next incomplete step can fill');
  const after=explicitSnapshot(step.after,mode,ids);validateModel(after);
  // No deposits, transfers or settlements in an individual hypothetical buy.
  // Post-fill wallet is before-wallet less the explicit USDT fee; do not deduct notional.
  if(mode==='cross'){
   if(units(after.collateralWallet)!==sub(units(before.collateralWallet),units(fill.fee)))throw Error('Post-fill collateral mismatch');
  }else{
   for(const r of after.risk){
    const old=before.risk.find(x=>x.cycleId===r.cycleId);
    const expected=sub(units(old.isolatedCollateral),r.cycleId===fill.cycleId?units(fill.fee):0n);
    if(units(r.isolatedCollateral)!==expected)throw Error('Post-fill collateral mismatch');
   }
  }
  for(const r of after.risk){const old=before.risk.find(x=>x.cycleId===r.cycleId);if(units(r.markPrice)!==units(old.markPrice)||units(r.lastPrice)!==units(old.lastPrice))throw Error('Prices must match across fill snapshot');}
  history=[...history,fill];eventIds.add(fill.id);
  if(step.complete===true)plan.completedSteps.push(fill.dca);
  const post=report(after);halted=stopReason(post);
  results.push({index:i,time,before:pre,after:post,fillApplied:true,reason:halted});
  now=time;snapshot=after;
 }
 return {initial:start,steps:results,halted:halted!==null,haltReason:halted,unprocessedSteps:steps.length-results.length,
  finalCycles:replayFutures(history),finalPlans:frozen,recommendationAllowed:false,liquidationPrice:null,synthetic:true};
}
