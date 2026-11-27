// Controlled synthetic path comparison. Not a historical replay or exchange liquidation engine.
import {units,decimalString,mul,sub,SCALE} from './ledger-decimal.mjs';
import {createCollateralAccount,recordCollateralOperation,collateralSummary} from './isolated-collateral.mjs';
import {isolatedProtectionDiagnostic} from './isolated-protection.mjs';
import {marginStress} from './margin-stress.mjs';
const txt=decimalString;
const positive=v=>{if(typeof v!=='string'||units(v)<=0n)throw Error('Positive decimal string required');return units(v);};
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const pending=s=>s.requests.find(r=>['pending','partial','uncertain'].includes(r.status));
export function compareProtectionPaths({synthetic,initial,rules,policy,frames}={}){
 if(synthetic!==true||policy?.synthetic!==true)throw Error('Synthetic path required');
 const seed=createCollateralAccount(initial),ids=seed.positions.map(p=>p.cycleId);
 const drop=positive(policy.adverseDropFraction);
 if(drop>=SCALE||!Number.isSafeInteger(policy.maxAgeMs)||policy.maxAgeMs<=0)throw Error('Explicit valid stress policy required');
 positive(policy.targetHeadroom);positive(policy.minimumTopup);positive(policy.topupStep);
 if(!Array.isArray(rules)||rules.length!==ids.length||new Set(rules.map(r=>r.cycleId)).size!==ids.length||ids.some(id=>!rules.some(r=>r.cycleId===id)))throw Error('Explicit rules for every cycle required');
 for(const r of rules){if(typeof r.maxAdditionalCollateral!=='string'||units(r.maxAdditionalCollateral)<0n)throw Error('Explicit venue cap required');}
 if(!Array.isArray(frames)||!frames.length||frames.length>10000)throw Error('Invalid frames');
 let prev=seed.lastTime-1;
 for(const f of frames){
  if(!integer(f.time)||f.time<=prev||!['none','confirm','reject','uncertain'].includes(f.response))throw Error('Invalid frame ordering or response');
  if(!f.marks||Object.keys(f.marks).length!==ids.length||ids.some(id=>!Object.hasOwn(f.marks,id)))throw Error('Complete marks required');
  ids.forEach(id=>positive(f.marks[id]));prev=f.time;
 }
 function run(enabled){
  let state=structuredClone(seed),seq=0,stop=null;const trace=[];
  const apply=(kind,time,extra)=>{state=recordCollateralOperation(state,{synthetic:true,manual:true,venue:state.venue,accountId:state.accountId,expectedRevision:state.revision,opId:'sim-'+(++seq),kind,time,...extra}).state;};
  function evaluate(f){
   const positions=state.positions.map(p=>{
    const r=rules.find(x=>x.cycleId===p.cycleId);
    return {id:p.cycleId,symbol:p.symbol,leverage:p.leverage,quantity:p.quantity,averageEntry:p.averageEntry,isolatedCollateral:p.collateral,markPrice:f.marks[p.cycleId],lastPrice:f.marks[p.cycleId],maintenanceTiers:r.maintenanceTiers,exitFeeRate:r.exitFeeRate,adverseFundingRate:r.adverseFundingRate,fundingPeriods:r.fundingPeriods,futureEntryFeeRate:'0',futureOrderNominals:[]};
   });
   const report=marginStress({synthetic:true,mode:'isolated',positions,scenarios:[{id:'same-mark',markPrices:f.marks}]});
   return report.current.accounts.map(a=>({cycleId:a.id,headroom:a.maintenanceHeadroom}));
  }
  for(const f of frames){
   const before=evaluate(f),events=[];
   // The mark is checked BEFORE any response at this timestamp. No assumed rescue after a breach.
   const bad=before.find(x=>x.headroom===null||units(x.headroom)<=0n);
   if(bad){stop={time:f.time,cycleId:bad.cycleId,reason:bad.headroom===null?'unknown-maintenance-tier':'model-maintenance-breach'};trace.push({time:f.time,before,after:before,events,summary:collateralSummary(state)});break;}
   if(enabled){
    const p=pending(state);
    if(p&&f.response!=='none'){
     const extra={cycleId:p.cycleId,requestId:p.id};
     if(f.response==='confirm'){apply('settle',f.time,{...extra,amount:p.amount,confirmed:true,evidence:'confirm-'+seq});events.push({kind:'confirmed',cycleId:p.cycleId,amount:p.amount});}
     else if(f.response==='reject'){apply('cancel',f.time,{...extra,confirmed:true,remainderNotExecuted:true,evidence:'reject-'+seq});events.push({kind:'rejected',cycleId:p.cycleId,amount:p.amount});}
     else{apply('uncertain',f.time,extra);events.push({kind:'uncertain',cycleId:p.cycleId,amount:p.amount});}
    }
    // One outstanding request per account; no new request on a response frame.
    if(!pending(state)&&!events.length){
     apply('reconcile',f.time,{maxAgeMs:policy.maxAgeMs,observation:{synthetic:true,confirmed:true,complete:true,mode:'isolated',venue:state.venue,accountId:state.accountId,observedAt:f.time,freeCollateral:state.freeCollateral,positions:state.positions}});
     const candidates=before.slice().sort((a,b)=>units(a.headroom)<units(b.headroom)?-1:units(a.headroom)>units(b.headroom)?1:a.cycleId<b.cycleId?-1:1);
     for(const p of candidates){
      const r=rules.find(x=>x.cycleId===p.cycleId),mark=f.marks[p.cycleId];
      const stress=txt(mul(units(mark),sub(SCALE,drop)));
      const d=isolatedProtectionDiagnostic({synthetic:true,state,now:f.time,risk:{...r,synthetic:true,venue:state.venue,accountId:state.accountId,expectedRevision:state.revision,observedAt:f.time,markPrice:mark,lastPrice:mark,stressMarkPrice:stress},policy:{...policy,maxAdditionalCollateral:r.maxAdditionalCollateral}});
      if(d.status==='hypothetical-buffer-feasible'){
       const amount=d.feasibleTopup;apply('request',f.time,{cycleId:p.cycleId,requestId:'req-'+(seq+1),amount});events.push({kind:'requested',cycleId:p.cycleId,amount});break;
      }
      if(d.status==='insufficient-protection-reserve'||d.status==='blocked')events.push({kind:d.status,cycleId:p.cycleId,reason:d.reasons,shortfall:d.shortfall??null});
     }
    }
   }
   trace.push({time:f.time,before,after:evaluate(f),events,summary:collateralSummary(state)});
  }
  return {status:stop?'stopped':'path-complete',stop,trace,final:collateralSummary(state),positions:state.positions,requestPending:pending(state)?.id??null};
 }
 return {synthetic:true,baseline:run(false),bounded:run(true),recommendationAllowed:false,liquidationPrice:null};
}
