// Synthetic long-only linear USDT futures stress model. NOT an exchange risk engine.
import {units,decimalString,SCALE,add,sub,mul} from './ledger-decimal.mjs';
const Q=10n**16n;
const txt=decimalString;
const sum=xs=>xs.reduce((a,b)=>add(a,b),0n);
const max=(a,b)=>a>b?a:b;
const ceil=(n,d)=>(n+d-1n)/d;
const amount=(v,name,positive=false)=>{const n=units(v);if(n<0n||(positive&&n===0n))throw Error('Invalid '+name);return n;};
const rate=(v,name)=>{const n=amount(v,name);if(n>=SCALE)throw Error('Invalid '+name);return n;};
const roundedCharge=(n,r)=>ceil(n*r,SCALE*Q)*Q;
const initialMargin=(n,l)=>ceil(n,BigInt(l)*Q)*Q;
function tiers(raw){
 if(!Array.isArray(raw)||!raw.length)throw Error('Explicit synthetic maintenance tiers required');
 let previous=0n,previousRate=-1n;
 return raw.map(t=>{
  const upper=amount(t.upTo,'tier upper',true),r=rate(t.rate,'maintenance rate');
  if(upper<=previous||r<previousRate)throw Error('Invalid tier order');
  previous=upper;previousRate=r;return {upper,r};
 });
}
function position(p,mode){
 if(typeof p.id!=='string'||!p.id.trim()||typeof p.symbol!=='string'||! /^[A-Z0-9]+USDT$/.test(p.symbol)||p.symbol==='USDT')throw Error('Invalid position identity');
 if(!Number.isInteger(p.leverage)||p.leverage<1||p.leverage>3)throw Error('Leverage must be integer 1–3');
 const quantity=amount(p.quantity,'quantity',true),entry=amount(p.averageEntry,'averageEntry',true);
 const mark=amount(p.markPrice,'markPrice',true),last=amount(p.lastPrice,'lastPrice',true);
 const maintenance=tiers(p.maintenanceTiers);
 const exitRate=rate(p.exitFeeRate,'exitFeeRate'),fundingRate=rate(p.adverseFundingRate,'adverseFundingRate');
 const entryRate=rate(p.futureEntryFeeRate,'futureEntryFeeRate');
 if(!Number.isSafeInteger(p.fundingPeriods)||p.fundingPeriods<0||p.fundingPeriods>1000)throw Error('Invalid fundingPeriods');
 if(!Array.isArray(p.futureOrderNominals)||p.futureOrderNominals.length>5)throw Error('Explicit future orders required');
 const future=p.futureOrderNominals.map(v=>amount(v,'future nominal',true));
 const futureReserve=sum(future.map(n=>add(initialMargin(n,p.leverage),roundedCharge(n,entryRate))));
 const collateral=mode==='isolated'?amount(p.isolatedCollateral,'isolatedCollateral'):null;
 if(mode==='cross'&&p.isolatedCollateral!==undefined)throw Error('Do not mix cross and isolated collateral');
 return {id:p.id,symbol:p.symbol,leverage:p.leverage,quantity,entry,mark,last,maintenance,exitRate,fundingRate,fundingPeriods:p.fundingPeriods,futureReserve,collateral};
}
function evaluate(p,mark){
 const n=mul(p.quantity,mark),pnl=mul(p.quantity,sub(mark,p.entry));
 const tier=p.maintenance.findIndex(t=>n<=t.upper);
 // Whole-notional tier rate: intentionally simplified, no exchange deductions.
 const mm=tier<0?null:roundedCharge(n,p.maintenance[tier].r);
 const exit=roundedCharge(n,p.exitRate);
 const funding=roundedCharge(n,p.fundingRate)*BigInt(p.fundingPeriods);
 const im=initialMargin(n,p.leverage);
 return {id:p.id,symbol:p.symbol,mark,notional:n,pnl,tier,mm,exit,funding,im,futureReserve:p.futureReserve,collateral:p.collateral};
}
function assess(rows,collateral){
 const pnl=sum(rows.map(r=>r.pnl)),equity=add(collateral,pnl);
 const exit=sum(rows.map(r=>r.exit)),funding=sum(rows.map(r=>r.funding));
 const future=sum(rows.map(r=>r.futureReserve)),im=sum(rows.map(r=>r.im));
 const mm=rows.some(r=>r.mm===null)?null:sum(rows.map(r=>r.mm));
 const afterCosts=sub(sub(equity,exit),funding);
 const maintenanceHeadroom=mm===null?null:sub(afterCosts,mm);
 const reserveHeadroom=mm===null?null:sub(sub(afterCosts,max(im,mm)),future);
 return {collateral:txt(collateral),unrealizedPnl:txt(pnl),equity:txt(equity),initialMarginEstimate:txt(im),maintenanceEstimate:mm===null?null:txt(mm),
  exitFeeReserve:txt(exit),adverseFundingReserve:txt(funding),futureDcaReserve:txt(future),maintenanceHeadroom:maintenanceHeadroom===null?null:txt(maintenanceHeadroom),
  reserveHeadroom:reserveHeadroom===null?null:txt(reserveHeadroom),maintenanceBreach:maintenanceHeadroom===null?null:maintenanceHeadroom<=0n,
  reserveDeficit:reserveHeadroom===null?null:reserveHeadroom<0n};
}
function evaluateScenario(positions,mode,wallet,marks,id){
 const rows=positions.map((p,i)=>evaluate(p,marks[i]));
 const accounts=mode==='cross'?[{id:'shared',...assess(rows,wallet)}]:rows.map(r=>({id:r.id,...assess([r],r.collateral)}));
 const details=rows.map(r=>({id:r.id,symbol:r.symbol,markPrice:txt(r.mark),notional:txt(r.notional),unrealizedPnl:txt(r.pnl),maintenanceTier:r.tier<0?null:r.tier+1,
  maintenanceEstimate:r.mm===null?null:txt(r.mm),exitFeeReserve:txt(r.exit),adverseFundingReserve:txt(r.funding),initialMarginEstimate:txt(r.im),futureDcaReserve:txt(r.futureReserve)}));
 const flags=[];
 if(rows.some(r=>r.mm===null))flags.push('MAINTENANCE_TIER_NOT_COVERED');
 if(accounts.some(a=>a.maintenanceBreach===true))flags.push('SYNTHETIC_MAINTENANCE_BREACH');
 if(accounts.some(a=>a.reserveDeficit===true))flags.push('SYNTHETIC_RESERVE_DEFICIT');
 return {id,accounts,positions:details,flags};
}
export function marginStress({mode,collateralWallet,positions,scenarios,synthetic}){
 if(synthetic!==true)throw Error('Only explicit synthetic scenarios supported');
 if(!['cross','isolated'].includes(mode))throw Error('Explicit synthetic account mode required');
 if(!Array.isArray(positions)||!positions.length||positions.length>19)throw Error('Invalid positions');
 if(!Array.isArray(scenarios)||!scenarios.length||scenarios.length>100)throw Error('Invalid scenarios');
 const wallet=mode==='cross'?amount(collateralWallet,'collateralWallet'):null;
 if(mode==='isolated'&&collateralWallet!==undefined)throw Error('Do not pool isolated collateral');
 const ps=positions.map(p=>position(p,mode));
 if(new Set(ps.map(p=>p.id)).size!==ps.length||new Set(ps.map(p=>p.symbol)).size!==ps.length)throw Error('Duplicate position');
 const ids=new Set();
 const stressed=scenarios.map(s=>{
  if(typeof s.id!=='string'||!s.id.trim()||s.id==='current'||ids.has(s.id))throw Error('Invalid scenario ID');
  ids.add(s.id);
  if(!s.markPrices||Object.keys(s.markPrices).length!==ps.length||ps.some(p=>!Object.hasOwn(s.markPrices,p.id)))throw Error('Explicit mark price for every position required');
  return evaluateScenario(ps,mode,wallet,ps.map(p=>amount(s.markPrices[p.id],'scenario mark',true)),s.id);
 });
 const current=evaluateScenario(ps,mode,wallet,ps.map(p=>p.mark),'current');
 return {mode:'synthetic-'+mode,positions:ps.map(p=>({id:p.id,symbol:p.symbol,leverage:p.leverage,quantity:txt(p.quantity),averageEntry:txt(p.entry),lastPrice:txt(p.last),markPrice:txt(p.mark)})),
  current,scenarios:stressed,flags:[...new Set(['SYNTHETIC_ONLY','EXCHANGE_RULES_UNVERIFIED','ACCOUNT_MODE_UNCONFIRMED',...current.flags,...stressed.flatMap(s=>s.flags)])],
  liquidationPrice:null,recommendationAllowed:false};
}
