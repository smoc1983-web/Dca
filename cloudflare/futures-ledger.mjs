// Separate synthetic/manual linear USDT long futures journal. Never a spot fill or order.
import {units,decimalString,add,sub,mul,div,portion} from './ledger-decimal.mjs';
import {marginStress} from './margin-stress.mjs';
const txt=decimalString;
function id(x,name){if(typeof x!=='string'||!x.trim()||x.length>128)throw Error('Invalid '+name);return x;}
function amount(v,name,positive=false){const n=units(v);if(n<0n||(positive&&n===0n))throw Error('Invalid '+name);return n;}
function normalize(raw){
 if(raw?.confirmed!==true||raw.source!=='manual-futures'||raw.synthetic!==true)throw Error('Confirmed synthetic manual futures event required');
 const eventId=id(raw.id,'event ID'),cycleId=id(raw.cycleId,'cycle ID'),symbol=id(raw.symbol,'symbol');
 if(!/^[A-Z0-9]+USDT$/.test(symbol)||symbol==='USDT')throw Error('Invalid USDT symbol');
 if(!Number.isSafeInteger(raw.time)||raw.time<0)throw Error('Invalid time');
 if(!Number.isInteger(raw.leverage)||raw.leverage<1||raw.leverage>3)throw Error('Leverage must be integer 1–3');
 const base={id:eventId,cycleId,symbol,time:raw.time,leverage:raw.leverage,kind:raw.kind};
 if(raw.kind==='funding'){
  // Signed USDT cash flow: positive received, negative paid.
  return {...base,amount:txt(units(raw.amount))};
 }
 if(!['buy','sell'].includes(raw.kind)||raw.feeAsset!=='USDT')throw Error('Only USDT fee buy/sell supported');
 const price=amount(raw.price,'price',true),quantity=amount(raw.quantity,'quantity',true),fee=amount(raw.fee,'fee');
 if(mul(price,quantity)<=0n)throw Error('Invalid execution notional');
 const dca=raw.dca??null;
 if(raw.kind==='buy'&&(!Number.isInteger(dca)||dca<0||dca>5))throw Error('Explicit DCA step required');
 if(raw.kind==='sell'&&dca!==null)throw Error('Sell cannot have DCA step');
 return {...base,price:txt(price),quantity:txt(quantity),fee:txt(fee),dca};
}
export function replayFutures(events){
 if(!Array.isArray(events))throw Error('Invalid futures history');
 const seen=new Map(),cycles=new Map();
 for(const raw of events){
  const e=normalize(raw),encoded=JSON.stringify(e);
  if(seen.has(e.id)){if(seen.get(e.id)!==encoded)throw Error('Conflicting futures event ID');continue;}
  let c=cycles.get(e.cycleId);
  if(!c){
   if(e.kind!=='buy'||e.dca!==0)throw Error('Cycle must start with manual START buy');
   c={cycleId:e.cycleId,symbol:e.symbol,leverage:e.leverage,quantity:0n,basis:0n,grossRealized:0n,fees:0n,funding:0n,steps:Array(6).fill(0n),lastDca:0,lastTime:e.time,closed:false,events:0};cycles.set(e.cycleId,c);
  }
  if(c.symbol!==e.symbol||c.leverage!==e.leverage)throw Error('Immutable cycle symbol and leverage');
  if(c.closed||e.time<c.lastTime)throw Error('Closed cycle or out-of-order event');
  if(e.kind==='funding'){
   if(c.quantity<=0n)throw Error('Funding without position');
   c.funding=add(c.funding,units(e.amount));
  }else{
   const q=units(e.quantity),n=mul(q,units(e.price));
   if(e.kind==='buy'){
    if(e.dca<c.lastDca||e.dca>c.lastDca+1)throw Error('Out-of-order DCA step');
    c.lastDca=e.dca;c.steps[e.dca]=add(c.steps[e.dca],n);
    c.quantity=add(c.quantity,q);c.basis=add(c.basis,n);
   }else{
    if(q>c.quantity)throw Error('Sell exceeds futures quantity');
    const removed=q===c.quantity?c.basis:portion(c.basis,q,c.quantity);
    c.grossRealized=add(c.grossRealized,sub(n,removed));
    c.quantity=sub(c.quantity,q);c.basis=sub(c.basis,removed);c.closed=c.quantity===0n;
   }
   c.fees=add(c.fees,units(e.fee));
  }
  c.lastTime=e.time;c.events++;seen.set(e.id,encoded);
 }
 return [...cycles.values()].map(c=>({cycleId:c.cycleId,symbol:c.symbol,leverage:c.leverage,quantity:txt(c.quantity),entryNotional:txt(c.basis),
  averageEntry:c.quantity?txt(div(c.basis,c.quantity)):null,grossRealizedPnl:txt(c.grossRealized),paidFees:txt(c.fees),settledFunding:txt(c.funding),
  netRealizedCashEffect:txt(add(sub(c.grossRealized,c.fees),c.funding)),stepNominals:c.steps.map(txt),lastDca:c.lastDca,lastTime:c.lastTime,closed:c.closed,events:c.events}));
}
// Only active positions enter stress. Collateral is explicit observed/synthetic post-settlement wallet,
// not inferred by adding PnL or subtracting fees a second time. Plan remains fixed.
export function stressManualFutures({events,plans,risk,mode,collateralWallet,scenarios,synthetic}){
 if(synthetic!==true)throw Error('Synthetic only');
 const cycles=replayFutures(events),active=cycles.filter(c=>!c.closed);
 if(!active.length)return {cycles,stress:null,recommendationAllowed:false,flags:['NO_OPEN_POSITION','SYNTHETIC_ONLY']};
 if(!Array.isArray(plans)||!Array.isArray(risk))throw Error('Explicit plan and risk snapshots required');
 const unique=(a,name)=>{const m=new Map();for(const x of a){const k=id(x.cycleId,name);if(m.has(k))throw Error('Duplicate '+name);m.set(k,x);}return m;};
 const pm=unique(plans,'plan'),rm=unique(risk,'risk snapshot');
 const flags=[],positions=active.map(c=>{
  const plan=pm.get(c.cycleId),r=rm.get(c.cycleId);
  if(!plan||!r||!Array.isArray(plan.nominals)||plan.nominals.length!==6||!Array.isArray(plan.completedSteps))throw Error('Missing frozen plan or risk snapshot');
  if(plan.leverage!==c.leverage||plan.symbol!==c.symbol)throw Error('Frozen plan identity mismatch');
  const complete=plan.completedSteps;
  if(complete.some((n,i)=>n!==i)||complete.length>6||complete.some(i=>units(c.stepNominals[i])<=0n))throw Error('Invalid completed steps');
  const remaining=[];
  for(let i=0;i<6;i++){
   const n=amount(plan.nominals[i],'planned nominal',true),actual=units(c.stepNominals[i]);
   if(actual>n)flags.push('ACTUAL_NOMINAL_EXCEEDS_PLAN');
   if(i>=complete.length&&i<c.lastDca)flags.push('UNCONFIRMED_PREVIOUS_DCA');
   if(i>=complete.length&&n>actual)remaining.push(txt(sub(n,actual)));
  }
  // marginStress supports up to five future orders, including remaining partial START.
  // Aggregate only when all six slots remain; preserve total plus conservative rounding
  // by refusing rather than silently dropping one slot.
  if(remaining.length>5)throw Error('Complete START or reconcile partial START before stress');
  const {cycleId,...parameters}=r;
  return {...parameters,id:c.cycleId,symbol:c.symbol,leverage:c.leverage,quantity:c.quantity,averageEntry:c.averageEntry,futureOrderNominals:remaining};
 });
 const stress=marginStress({mode,collateralWallet,positions,scenarios,synthetic:true});
 return {cycles,stress,recommendationAllowed:false,flags:[...new Set([...flags,...stress.flags])]};
}
