// Exact synthetic observations; no venue access or permission to trade.
import {units,decimalString} from './ledger-decimal.mjs';
const decimal=(v,positive=false)=>{
 if(typeof v!=='string')throw Error('Observation decimal string required');
 const n=units(v);if(n<0n||(positive&&n===0n))throw Error('Invalid observed amount');
 return decimalString(n);
};
const stamp=v=>{if(!Number.isSafeInteger(v)||v<0)throw Error('Invalid observation timestamp');return v;};
const identifier=v=>{if(typeof v!=='string'||!v.trim()||v.length>128)throw Error('Invalid observation identifier');return v;};
export function canonicalObservation(raw){
 if(raw?.synthetic!==true||raw.confirmed!==true||raw.complete!==true||raw.mode!=='isolated')throw Error('Confirmed complete synthetic isolated observation required');
 if(!Array.isArray(raw.positions)||raw.positions.length>19)throw Error('Invalid observed positions');
 const positions=raw.positions.map(p=>{
  if(!/^[A-Z0-9]+USDT$/.test(p.symbol)||!Number.isInteger(p.leverage)||p.leverage<1||p.leverage>3)throw Error('Invalid observed position');
  return {cycleId:identifier(p.cycleId),symbol:p.symbol,leverage:p.leverage,quantity:decimal(p.quantity,true),averageEntry:decimal(p.averageEntry,true),tpPrice:decimal(p.tpPrice,true),collateral:decimal(p.collateral,true)};
 }).sort((a,b)=>a.cycleId<b.cycleId?-1:a.cycleId>b.cycleId?1:0);
 if(new Set(positions.map(p=>p.cycleId)).size!==positions.length||new Set(positions.map(p=>p.symbol)).size!==positions.length)throw Error('Duplicate observed position');
 return {synthetic:true,confirmed:true,complete:true,mode:'isolated',venue:identifier(raw.venue),accountId:identifier(raw.accountId),observedAt:stamp(raw.observedAt),freeCollateral:decimal(raw.freeCollateral),positions};
}
export function reconcileCollateral(state,raw,time,maxAgeMs){
 const o=canonicalObservation(raw);stamp(time);
 if(!Number.isSafeInteger(maxAgeMs)||maxAgeMs<=0)throw Error('Explicit positive observation age required');
 if(o.venue!==state.venue||o.accountId!==state.accountId)throw Error('Observation account scope mismatch');
 const reasons=[];
 if(o.observedAt>time||o.observedAt<state.lastTime||time-o.observedAt>maxAgeMs)reasons.push('stale-or-future-observation');
 if(o.freeCollateral!==state.freeCollateral)reasons.push('free-collateral-mismatch');
 for(const p of state.positions){
  const actual=o.positions.find(x=>x.cycleId===p.cycleId);
  if(!actual){reasons.push('missing-position:'+p.cycleId);continue;}
  for(const field of ['symbol','leverage','quantity','averageEntry','tpPrice','collateral'])if(actual[field]!==p[field])reasons.push('position-mismatch:'+p.cycleId+':'+field);
 }
 for(const p of o.positions)if(!state.positions.some(x=>x.cycleId===p.cycleId))reasons.push('unexpected-position:'+p.cycleId);
 if(state.requests.some(r=>['pending','partial','uncertain'].includes(r.status)))reasons.push('unsettled-operation');
 return {status:reasons.length?'blocked':'matched',reasons,observedAt:o.observedAt,maxAgeMs,recommendationAllowed:false};
}
