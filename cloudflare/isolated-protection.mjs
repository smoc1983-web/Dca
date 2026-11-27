// Synthetic isolated long risk diagnostic. No real liquidation estimate or transfer instruction.
import {units,decimalString,add,sub} from './ledger-decimal.mjs';
import {collateralSummary} from './isolated-collateral.mjs';
import {marginStress} from './margin-stress.mjs';
const txt=decimalString;
const min=(a,b)=>a<b?a:b;
const max=(a,b)=>a>b?a:b;
const integer=x=>Number.isSafeInteger(x)&&x>=0;
function amount(v,positive=false){
 if(typeof v!=='string')throw Error('Explicit decimal string required');
 const n=units(v);if(n<0n||positive&&n===0n)throw Error('Invalid risk amount');return n;
}
export function isolatedProtectionDiagnostic({synthetic,state,risk,policy,now}={}){
 const blocked=reason=>({status:'blocked',reasons:[reason],requiredTopup:null,feasibleTopup:null,liquidationPrice:null,recommendationAllowed:false});
 if(synthetic!==true||state?.synthetic!==true||state.mode!=='isolated'||risk?.synthetic!==true||policy?.synthetic!==true)return blocked('synthetic-isolated-only');
 if(!integer(now)||!Number.isSafeInteger(policy.maxAgeMs)||policy.maxAgeMs<=0)return blocked('explicit-time-policy-required');
 if(risk.venue!==state.venue||risk.accountId!==state.accountId||risk.expectedRevision!==state.revision)return blocked('scope-or-revision-mismatch');
 const r=state.reconciliation;
 if(!r||r.status!=='matched'||r.revision!==state.revision||!integer(r.observedAt)||r.observedAt>now||!integer(state.lastTime)||state.lastTime>now||!Number.isSafeInteger(r.maxAgeMs)||r.maxAgeMs<=0||now-r.observedAt>Math.min(r.maxAgeMs,policy.maxAgeMs))return blocked('fresh-reconciliation-required');
 if(!integer(risk.observedAt)||risk.observedAt<r.observedAt||risk.observedAt>now||now-risk.observedAt>policy.maxAgeMs)return blocked('stale-risk-snapshot');
 try{
  const p=state.positions.find(x=>x.cycleId===risk.cycleId);
  if(!p)return blocked('unknown-cycle');
  const summary=collateralSummary(state);
  if(summary.reserveDeficit||units(summary.pendingTopups)>0n||state.requests.some(x=>['pending','partial','uncertain'].includes(x.status)))return blocked('unsettled-or-deficit');
  const buffer=amount(policy.targetHeadroom,true),minimum=amount(policy.minimumTopup,true),step=amount(policy.topupStep,true),venueMax=amount(policy.maxAdditionalCollateral);
  const mark=amount(risk.markPrice,true),stressMark=amount(risk.stressMarkPrice,true);
  if(stressMark>mark)return blocked('adverse-mark-required');
  // Same pinned position and collateral for current and stress; do not include future DCA in maintenance headroom.
  // Account DCA funds stay reserved in collateralSummary; this is not an order-budget calculation.
  const report=marginStress({synthetic:true,mode:'isolated',positions:[{id:p.cycleId,symbol:p.symbol,leverage:p.leverage,quantity:p.quantity,averageEntry:p.averageEntry,isolatedCollateral:p.collateral,markPrice:risk.markPrice,lastPrice:risk.lastPrice,maintenanceTiers:risk.maintenanceTiers,exitFeeRate:risk.exitFeeRate,adverseFundingRate:risk.adverseFundingRate,fundingPeriods:risk.fundingPeriods,futureEntryFeeRate:'0',futureOrderNominals:[]}],scenarios:[{id:'adverse',markPrices:{[p.cycleId]:risk.stressMarkPrice}}]});
  const current=report.current.accounts[0],stress=report.scenarios[0].accounts[0];
  if(current.maintenanceHeadroom===null||stress.maintenanceHeadroom===null)return blocked('maintenance-tier-unknown');
  const c=units(current.maintenanceHeadroom),s=units(stress.maintenanceHeadroom);
  const needed=max(0n,sub(buffer,min(c,s)));
  const rounded=needed===0n?0n:((max(needed,minimum)+step-1n)/step)*step;
  const available=units(summary.availableForTopup);
  const limit=min(available,venueMax)/step*step;
  const breached=c<=0n;
  const status=breached?'current-model-breach':rounded===0n?'buffer-met':rounded<=limit?'hypothetical-buffer-feasible':'insufficient-protection-reserve';
  return {status,reasons:breached?['current-maintenance-breach-no-rescue-assumed']:[],cycleId:p.cycleId,revision:state.revision,quantity:p.quantity,averageEntry:p.averageEntry,tpPrice:p.tpPrice,dcaStep:p.lastDca,currentHeadroom:txt(c),stressHeadroom:txt(s),targetHeadroom:txt(buffer),requiredTopup:txt(rounded),availableProtectionReserve:txt(available),maxPermittedHypothetical:txt(limit),shortfall:txt(max(0n,rounded-limit)),feasibleTopup:!breached&&rounded>0n&&rounded<=limit?txt(rounded):null,liquidationPrice:null,recommendationAllowed:false};
 }catch{return blocked('invalid-risk-input');}
}
