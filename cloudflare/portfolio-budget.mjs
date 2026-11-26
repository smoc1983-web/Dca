// Offline spot planning and pre-fill reservations. No orders, balance API, or production state.
import {units,decimalString,SCALE} from './ledger-decimal.mjs';
const QUANTUM=10n**16n; // 8 decimal USDT places, floor allocations / ceil fee reserve.
const text=n=>decimalString(n);
const amount=(v,name,zero=false)=>{
  const n=units(v);
  if(zero?n<0n:n<=0n)throw Error('Invalid '+name);
  return n;
};
const floor=n=>n/QUANTUM*QUANTUM;
const ceil=n=>(n+QUANTUM-1n)/QUANTUM*QUANTUM;
const min=(a,b)=>a<b?a:b;
const max=(a,b)=>a>b?a:b;
function config(raw){
  if(raw.policy!=='equal-slots-v1')throw Error('Explicit test allocation policy required');
  if(!Number.isSafeInteger(raw.maxCycles)||raw.maxCycles<1||raw.maxCycles>19)throw Error('Invalid maxCycles');
  const capital=amount(raw.capital,'capital',true),freeCash=amount(raw.freeCash,'freeCash',true);
  const feeRate=amount(raw.feeRate,'feeRate',true);
  if(feeRate>=SCALE)throw Error('Invalid feeRate');
  return {policy:raw.policy,capital:text(capital),freeCash:text(freeCash),feeRate:text(feeRate),maxCycles:raw.maxCycles};
}
export function dcaPlan({cycleBudget,feeRate}){
  const b=amount(cycleBudget,'cycleBudget'),f=amount(feeRate,'feeRate',true);
  if(f>=SCALE)throw Error('Invalid feeRate');
  let nominal=0n,fees=0n;
  const orders=Array.from({length:6},(_,i)=>{
    const n=floor(b*25n*3n**BigInt(i)/(800n*2n**BigInt(i)));
    // Fee reserve rounded up from the unrounded fee, never down.
    const fee=((n*f+SCALE*QUANTUM-1n)/(SCALE*QUANTUM))*QUANTUM;
    nominal+=n;fees+=fee;
    return {number:i,kind:i?'DCA'+i:'START',dropPercent:[0,5,6,8,10,12][i],nominal:text(n),feeReserve:text(fee)};
  });
  const total=nominal+fees;
  return {cycleBudget:text(b),feeRate:text(f),orders,nominal:text(nominal),fees:text(fees),total:text(total),
    valid:orders.every(o=>units(o.nominal)>0n)&&nominal*100n<=b*70n&&total<=b};
}
export function createBudget(raw){
  return {revision:0,settingsVersion:1,settings:config(raw),reservations:[]};
}
function active(s){return s.reservations.filter(x=>x.status==='reserved');}
export function budgetSummary(s){
  const a=active(s),reserved=a.reduce((n,x)=>n+units(x.plan.total),0n);
  // freeCash is a supplied pre-reservation pool, NOT exchange available balance.
  const ceiling=min(units(s.settings.capital),units(s.settings.freeCash));
  return {active:a.length,reserved:text(reserved),available:text(max(0n,ceiling-reserved)),deficit:text(max(0n,reserved-ceiling)),
    overCycleLimit:a.length>s.settings.maxCycles};
}
function revision(s,expected){
  if(!Number.isSafeInteger(expected)||expected!==s.revision)throw Error('Stale budget revision');
}
export function changeBudget(s,raw,expected){
  revision(s,expected);
  const settings=config({...s.settings,...raw});
  return {...s,revision:s.revision+1,settingsVersion:s.settingsVersion+1,settings};
}
export function reserveCycle(s,{id,symbol,expectedRevision}){
  revision(s,expectedRevision);
  if(typeof id!=='string'||!id.trim()||id.length>128)throw Error('Invalid reservation ID');
  if(typeof symbol!=='string'||! /^[A-Z0-9]+USDT$/.test(symbol)||symbol==='USDT')throw Error('Invalid symbol');
  const existing=s.reservations.find(x=>x.id===id);
  if(existing){
    if(existing.symbol!==symbol)throw Error('Conflicting reservation ID');
    if(existing.status!=='reserved')throw Error('Released reservation ID cannot be reused');
    return {status:'duplicate',state:s,reservation:existing};
  }
  const a=active(s),summary=budgetSummary(s);
  const reject=reason=>({status:'rejected',reason,state:s});
  if(a.some(x=>x.symbol===symbol))return reject('SYMBOL_ALREADY_RESERVED');
  if(a.length>=s.settings.maxCycles)return reject('MAX_ACTIVE_CYCLES');
  if(units(summary.deficit)>0n)return reject('EXISTING_RESERVE_DEFICIT');
  const b=floor(units(s.settings.capital)/BigInt(s.settings.maxCycles));
  if(b<=0n)return reject('NO_CYCLE_BUDGET');
  const plan=dcaPlan({cycleBudget:text(b),feeRate:s.settings.feeRate});
  if(!plan.valid)return reject('INVALID_LADDER');
  if(units(plan.total)>units(summary.available))return reject('INSUFFICIENT_FULL_LADDER_RESERVE');
  const reservation={id,symbol,status:'reserved',settingsVersion:s.settingsVersion,plan};
  return {status:'reserved',state:{...s,revision:s.revision+1,reservations:[...s.reservations,reservation]},reservation};
}
// Only reservations with no fills exist in this module. Never use this to close a position.
export function releaseUnfilled(s,{id,expectedRevision}){
  revision(s,expectedRevision);
  const x=s.reservations.find(r=>r.id===id);
  if(!x)throw Error('Unknown reservation');
  if(x.status==='released')return s;
  if(x.status!=='reserved')throw Error('Not an unfilled reservation');
  return {...s,revision:s.revision+1,reservations:s.reservations.map(r=>r.id===id?{...r,status:'released'}:r)};
}
