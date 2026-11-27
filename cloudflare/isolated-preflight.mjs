// Synthetic read-only preflight. A matched snapshot is NOT a trading authorization.
import {units} from './ledger-decimal.mjs';
import {collateralSummary} from './isolated-collateral.mjs';
const revision=n=>Number.isSafeInteger(n)&&n>=0;
const ident=v=>typeof v==='string'&&v.trim().length>0&&v.length<=128;
const symbol=v=>typeof v==='string'&&/^[A-Z0-9]+USDT$/.test(v)&&v!=='USDT';
const amountEqual=(a,b)=>units(a)===units(b);
export function isolatedPreflight({synthetic,account,collateral,futures,expected,action,now,maxAgeMs}={}){
 const reasons=[];
 const blocked=()=>({status:'blocked',reasons:[...new Set(reasons)],recommendationAllowed:false});
 if(synthetic!==true||account?.mode!=='isolated'||!ident(account.venue)||!ident(account.accountId)){reasons.push('invalid-account');return blocked();}
 if(!revision(now)||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<=0){reasons.push('invalid-time-policy');return blocked();}
 if(!revision(expected?.collateralRevision)||!revision(expected?.futuresRevision)){reasons.push('missing-revisions');return blocked();}
 const c=collateral?.state;
 // Existing futures store is global; only an explicitly single-account synthetic binding can be used.
 if(c?.synthetic!==true||c.mode!=='isolated'||c.venue!==account.venue||c.accountId!==account.accountId||
    futures?.synthetic!==true||futures.singleAccount!==true||futures.venue!==account.venue||futures.accountId!==account.accountId){
  reasons.push('account-scope-unverified');return blocked();
 }
 if(c.revision!==expected.collateralRevision||futures.revision!==expected.futuresRevision)reasons.push('revision-mismatch');
 const r=c.reconciliation;
 if(!r||r.status!=='matched'||r.revision!==c.revision||!revision(r.observedAt)||r.observedAt>now||c.lastTime>now||!Number.isSafeInteger(r.maxAgeMs)||r.maxAgeMs<=0||now-r.observedAt>Math.min(maxAgeMs,r.maxAgeMs))reasons.push('fresh-reconciliation-required');
 if(!Array.isArray(c.positions)||!Array.isArray(c.requests)||!Array.isArray(futures.cycles)){reasons.push('invalid-snapshot');return blocked();}
 try{
  const summary=collateralSummary(c);
  if(summary.reserveDeficit)reasons.push('reserve-deficit');
  if(units(summary.pendingTopups)>0n||c.requests.some(x=>['pending','partial','uncertain'].includes(x.status)))reasons.push('unsettled-collateral');
  const active=futures.cycles.filter(p=>p.closed===false);
  if(futures.cycles.some(p=>typeof p.closed!=='boolean'||!ident(p.cycleId)))reasons.push('invalid-futures-cycle');
  if(new Set(futures.cycles.map(p=>p.cycleId)).size!==futures.cycles.length||new Set(active.map(p=>p.symbol)).size!==active.length||new Set(c.positions.map(p=>p.cycleId)).size!==c.positions.length)reasons.push('duplicate-cycle');
  for(const p of c.positions){
   const f=active.find(x=>x.cycleId===p.cycleId);
   if(!f){reasons.push('missing-futures-cycle:'+p.cycleId);continue;}
   if(f.symbol!==p.symbol||f.leverage!==p.leverage||f.lastDca!==p.lastDca||!amountEqual(f.quantity,p.quantity)||!amountEqual(f.averageEntry,p.averageEntry))reasons.push('cycle-mismatch:'+p.cycleId);
   if(!revision(f.lastTime)||!r||f.lastTime>r.observedAt)reasons.push('execution-after-observation:'+p.cycleId);
  }
  for(const f of active)if(!c.positions.some(p=>p.cycleId===f.cycleId))reasons.push('unexpected-futures-cycle:'+f.cycleId);
  if(!action||!ident(action.cycleId)||!symbol(action.symbol)||!['START','DCA'].includes(action.kind)||!Number.isInteger(action.leverage)||action.leverage<1||action.leverage>3)reasons.push('invalid-action');
  else if(action.kind==='START'){
   if(action.step!==0)reasons.push('invalid-start-step');
   if(futures.cycles.some(p=>p.cycleId===action.cycleId)||active.some(p=>p.symbol===action.symbol))reasons.push('cycle-or-symbol-already-used');
  }else{
   const p=active.find(x=>x.cycleId===action.cycleId);
   if(!p||p.symbol!==action.symbol||p.leverage!==action.leverage||!Number.isInteger(action.step)||action.step<1||action.step>5||action.step!==p.lastDca+1)reasons.push('invalid-dca-sequence');
   // Completion is not represented in the futures replay. Never infer it from a fill.
   if(action.previousStepConfirmed!==true)reasons.push('previous-step-unconfirmed');
  }
 }catch{reasons.push('invalid-accounting-data');}
 if(reasons.length)return blocked();
 return {status:'matched-for-risk-check',reasons:[],collateralRevision:c.revision,futuresRevision:futures.revision,recommendationAllowed:false};
}
