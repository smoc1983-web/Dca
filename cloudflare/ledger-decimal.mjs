// Decimal arithmetic for journal accounting, not order sizing or exchange filters.
// 24 fractional digits; round half away from zero at multiplication/division.
export const SCALE=10n**24n;
const LIMIT=10n**48n;
function checked(n){if(n>=LIMIT||n<=-LIMIT)throw Error('Decimal overflow');return n;}
export function quotient(n,d){
  if(d===0n)throw Error('Decimal division by zero');
  const negative=(n<0n)!==(d<0n);n=n<0n?-n:n;d=d<0n?-d:d;
  const q=n/d,r=n%d;
  return negative?-(q+(2n*r>=d?1n:0n)):q+(2n*r>=d?1n:0n);
}
export function units(value){
  if(typeof value!=='number'||!Number.isFinite(value))throw Error('Invalid decimal number');
  const m=/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if(!m)throw Error('Invalid decimal number');
  const digits=m[2]+(m[3]??'');
  const shift=24+Number(m[4]??0)-(m[3]?.length??0);
  const n=BigInt(digits)*(m[1]? -1n:1n);
  const result=checked(shift>=0?n*10n**BigInt(shift):quotient(n,10n**BigInt(-shift)));
  if(value!==0&&result===0n)throw Error('Decimal below supported precision');
  return result;
}
export const add=(a,b)=>checked(a+b);
export const sub=(a,b)=>checked(a-b);
export const mul=(a,b)=>checked(quotient(a*b,SCALE));
export const div=(a,b)=>checked(quotient(a*SCALE,b));
export const portion=(value,part,total)=>checked(quotient(value*part,total));
export function decimalString(n){
  const neg=n<0n,a=neg?-n:n;
  const fraction=String(a%SCALE).padStart(24,'0').replace(/0+$/,'');
  return (neg?'-':'')+String(a/SCALE)+(fraction?'.'+fraction:'');
}
export const number=n=>Number(decimalString(n));
