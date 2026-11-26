// Offline illustrative long-only collateral arithmetic. No exchange integration.
import {dcaPlan} from './portfolio-budget.mjs';
import {units,decimalString,SCALE,add,sub,mul,div} from './ledger-decimal.mjs';
const Q=10n**16n;
const txt=decimalString;
const ceil=(n,d)=>(n+d-1n)/d;
const margin=(n,l)=>ceil(n,l*Q)*Q;
const nonnegative=(v,name)=>{const n=units(v);if(n<0n)throw Error('Invalid '+name);return n;};
export function marginPlan({cycleBudget,feeRate,leverage,availableCollateral,entryPrice,stressDropPercent='0'}){
 if(!Number.isInteger(leverage)||leverage<1||leverage>3)throw Error('Leverage must be integer 1–3');
 const l=BigInt(leverage),cash=nonnegative(availableCollateral,'availableCollateral'),entry=units(entryPrice);
 const stress=nonnegative(stressDropPercent,'stressDropPercent');
 if(entry<=0n||stress>units(100))throw Error('Invalid price or stress');
 const plan=dcaPlan({cycleBudget,feeRate});
 if(!plan.valid)throw Error('Invalid ladder');
 let price=entry,qty=0n,nominal=0n,fees=0n,initial=0n;
 const orders=plan.orders.map(o=>{
  price=mul(price,units(String(100-o.dropPercent)));price=div(price,units(100));
  if(price<=0n)throw Error('Price below precision');
  const n=units(o.nominal),m=margin(n,l),f=units(o.feeReserve);
  qty=add(qty,div(n,price));nominal=add(nominal,n);fees=add(fees,f);initial=add(initial,m);
  return {...o,price:txt(price),initialMargin:txt(m),cumulativeQuantity:txt(qty),cumulativeNominal:txt(nominal),cumulativeMargin:txt(initial),unrealizedPnl:txt(sub(mul(qty,price),nominal))};
 });
 const total=add(initial,fees);
 const stages=orders.map(o=>{
  const used=units(o.cumulativeMargin),pnl=units(o.unrealizedPnl);
  return {...o,remainingInitialMargin:txt(sub(initial,used)),illustrativeHeadroom:txt(sub(add(cash,pnl),total))};
 });
 const mark=mul(price,div(sub(units(100),stress),units(100)));
 const pnl=sub(mul(qty,mark),nominal);
 const headroom=sub(add(cash,pnl),total);
 const deficit=cash<total||headroom<0n||stages.some(s=>units(s.illustrativeHeadroom)<0n);
 return {mode:'illustrative-only',leverage,nominal:plan.nominal,initialMargin:txt(initial),entryFeeReserve:plan.fees,minimumArithmeticReserve:txt(total),availableCollateral:txt(cash),orders:stages,stress:{markPrice:txt(mark),unrealizedPnl:txt(pnl),illustrativeHeadroom:txt(headroom)},arithmeticDeficit:deficit,recommendationAllowed:false,liquidationPrice:null,maintenanceMargin:null,funding:null,flags:[...(deficit?['ARITHMETIC_DEFICIT']:[]),'ACCOUNT_MODE_UNCONFIRMED','MAINTENANCE_TIERS_MISSING','FUNDING_AND_EXIT_COSTS_MISSING','NOT_EXCHANGE_VALIDATED']};
}
