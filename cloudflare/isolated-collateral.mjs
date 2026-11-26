// Isolated collateral accounting, synthetic manual observation only. Never transfers money.
import {units,decimalString,add,sub} from './ledger-decimal.mjs';
import {canonicalObservation,reconcileCollateral} from './isolated-collateral-reconcile.mjs';
const txt=decimalString;
const min=(a,b)=>a<b?a:b;
const max=(a,b)=>a>b?a:b;
const id=(x,n)=>{if(typeof x!=='string'||!x.trim()||x.length>128)throw Error('Invalid '+n);return x;};
const amt=(x,n,positive=false)=>{const a=units(x);if(a<0n||positive&&a===0n)throw Error('Invalid '+n);return a;};
const timestamp=x=>{if(!Number.isSafeInteger(x)||x<0)throw Error('Invalid timestamp');return x;};
const live=o=>['pending','partial','uncertain'].includes(o.status);
export function createCollateralAccount(raw){
 if(raw?.synthetic!==true||raw.mode!=='isolated')throw Error('Synthetic isolated account required');
 const venue=id(raw.venue,'venue'),accountId=id(raw.accountId,'account'),at=timestamp(raw.observedAt);
 const free=amt(raw.freeCollateral,'free collateral'),dca=amt(raw.dcaReserve,'DCA reserve'),cap=amt(raw.protectionCap,'protection cap');
 if(dca>free)throw Error('Existing DCA reserve deficit');
 if(!Array.isArray(raw.positions)||!raw.positions.length||raw.positions.length>19)throw Error('Explicit open positions required');
 const positions=raw.positions.map(p=>{
  if(!/^[A-Z0-9]+USDT$/.test(p.symbol)||!Number.isInteger(p.leverage)||p.leverage<1||p.leverage>3||!Number.isInteger(p.lastDca)||p.lastDca<0||p.lastDca>5)throw Error('Invalid position');
  return {cycleId:id(p.cycleId,'cycle'),symbol:p.symbol,leverage:p.leverage,lastDca:p.lastDca,quantity:txt(amt(p.quantity,'quantity',true)),averageEntry:txt(amt(p.averageEntry,'average',true)),tpPrice:txt(amt(p.tpPrice,'TP',true)),collateral:txt(amt(p.collateral,'collateral',true))};
 });
 if(new Set(positions.map(p=>p.cycleId)).size!==positions.length||new Set(positions.map(p=>p.symbol)).size!==positions.length)throw Error('Duplicate isolated position');
 return {synthetic:true,mode:'isolated',venue,accountId,revision:0,observedAt:at,lastTime:at,freeCollateral:txt(free),dcaReserve:txt(dca),protectionCap:txt(cap),confirmedAdded:'0',positions,requests:[],audit:[]};
}
export function collateralSummary(s){
 const pending=s.requests.filter(live).reduce((a,o)=>add(a,sub(units(o.amount),units(o.confirmed))),0n);
 const free=units(s.freeCollateral),dca=units(s.dcaReserve),used=units(s.confirmedAdded),cap=units(s.protectionCap);
 const available=max(0n,min(sub(sub(free,dca),pending),sub(sub(cap,used),pending)));
 const held=s.positions.reduce((a,p)=>add(a,units(p.collateral)),0n);
 return {venue:s.venue,accountId:s.accountId,freeCollateral:txt(free),isolatedCollateral:txt(held),totalTrackedCollateral:txt(add(free,held)),dcaReserve:txt(dca),pendingTopups:txt(pending),confirmedAdded:txt(used),protectionCap:txt(cap),availableForTopup:txt(available),reserveDeficit:sub(free,add(dca,pending))<0n,recommendationAllowed:false};
}
function canonical(raw){
 if(raw?.synthetic!==true||raw.manual!==true)throw Error('Synthetic manual operation required');
 if(raw.kind==='reconcile'){
  if(!Number.isSafeInteger(raw.maxAgeMs)||raw.maxAgeMs<=0)throw Error('Explicit positive observation age required');
  return {opId:id(raw.opId,'operation'),venue:id(raw.venue,'venue'),accountId:id(raw.accountId,'account'),time:timestamp(raw.time),kind:'reconcile',maxAgeMs:raw.maxAgeMs,observation:canonicalObservation(raw.observation)};
 }
 const e={opId:id(raw.opId,'operation'),requestId:id(raw.requestId,'request'),venue:id(raw.venue,'venue'),accountId:id(raw.accountId,'account'),cycleId:id(raw.cycleId,'cycle'),time:timestamp(raw.time),kind:raw.kind};
 if(!['request','settle','uncertain','cancel'].includes(e.kind))throw Error('Unsupported collateral operation');
 if(['request','settle'].includes(e.kind))e.amount=txt(amt(raw.amount,'amount',true));
 if(e.kind==='settle'||e.kind==='cancel'){if(raw.confirmed!==true)throw Error('Confirmed observation required');e.evidence=id(raw.evidence,'evidence');}
 if(e.kind==='cancel'&&raw.remainderNotExecuted!==true)throw Error('Unexecuted remainder must be verified');
 return e;
}
export function recordCollateralOperation(state,raw){
 const e=canonical(raw);
 if(e.venue!==state.venue||e.accountId!==state.accountId)throw Error('Account scope mismatch');
 const previous=state.audit.find(x=>x.opId===e.opId);
 if(previous){if(JSON.stringify(previous)!==JSON.stringify(e))throw Error('Conflicting operation ID');return {status:'duplicate',state,summary:collateralSummary(state)};}
 if(raw.expectedRevision!==state.revision)throw Error('Stale collateral revision');
 if(e.time<state.lastTime)throw Error('Out-of-order collateral event');
 const s=structuredClone(state);
 if(e.kind==='reconcile'){
  const reconciliation=reconcileCollateral(s,e.observation,e.time,e.maxAgeMs);
  s.audit.push(e);s.revision++;s.lastTime=e.time;
  s.reconciliation={...reconciliation,revision:s.revision};
  return {status:'recorded',state:s,summary:collateralSummary(s)};
 }
 // Historical synthetic requests replay unchanged until a reconciliation is recorded.
 // Once activated, a fresh matching observation at the current revision is required.
 if(e.kind==='request'&&s.reconciliation){
  const r=s.reconciliation;
  if(r.status!=='matched'||r.revision!==s.revision||e.time-r.observedAt>r.maxAgeMs)throw Error('Collateral reconciliation required');
 }
 const p=s.positions.find(x=>x.cycleId===e.cycleId);
 if(!p)throw Error('Unknown open cycle');
 let o=s.requests.find(x=>x.id===e.requestId);
 if(e.kind==='request'){
  if(o||s.requests.some(x=>x.cycleId===e.cycleId&&live(x)))throw Error('Pending or duplicate request');
  if(units(e.amount)>units(collateralSummary(s).availableForTopup))throw Error('Protection reserve exceeded');
  s.requests.push({id:e.requestId,cycleId:e.cycleId,amount:e.amount,confirmed:'0',status:'pending'});
 }else{
  if(!o||o.cycleId!==e.cycleId||!live(o))throw Error('No unsettled request');
  if(e.kind==='uncertain'){o.status='uncertain';}
  else{
   if(s.audit.some(x=>x.evidence===e.evidence))throw Error('Duplicate settlement evidence');
   if(e.kind==='cancel')o.status='cancelled';
   else{
    const n=units(e.amount),remaining=sub(units(o.amount),units(o.confirmed));
    if(n>remaining)throw Error('Settlement exceeds request; reconcile outside ledger');
    if(n>units(s.freeCollateral))throw Error('Observed settlement exceeds tracked free balance; reconcile');
    s.freeCollateral=txt(sub(units(s.freeCollateral),n));p.collateral=txt(add(units(p.collateral),n));
    s.confirmedAdded=txt(add(units(s.confirmedAdded),n));o.confirmed=txt(add(units(o.confirmed),n));
    o.status=units(o.confirmed)===units(o.amount)?'confirmed':'partial';
   }
  }
 }
 s.audit.push(e);s.revision++;s.lastTime=e.time;
 const summary=collateralSummary(s);
 if(summary.reserveDeficit)throw Error('DCA reserve invariant violated');
 return {status:'recorded',state:s,summary};
}
