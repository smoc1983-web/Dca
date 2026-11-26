// Offline LIMIT order recommendation only. No placement, no current exchange metadata.
import {units,decimalString,SCALE} from './ledger-decimal.mjs';
const value=(x,name,zero=false)=>{const n=units(x);if(zero?n<0n:n<=0n)throw Error('Invalid '+name);return n;};
function filterSet(f){
  if(!f||typeof f!=='object')throw Error('Missing filters');
  const p={tick:value(f.tickSize,'tickSize'),step:value(f.stepSize,'stepSize'),
    minPrice:value(f.minPrice,'minPrice',true),maxPrice:value(f.maxPrice,'maxPrice',true),
    minQty:value(f.minQty,'minQty',true),maxQty:value(f.maxQty,'maxQty',true),
    minNotional:value(f.minNotional,'minNotional',true),maxNotional:value(f.maxNotional,'maxNotional',true)};
  for(const [a,b] of [['minPrice','maxPrice'],['minQty','maxQty'],['minNotional','maxNotional']])if(p[b]&&p[b]<p[a])throw Error('Invalid filter range');
  return p;
}
function validate(p,q,f){
  const failures=[];
  if(p<=0n||p%f.tick!==0n||(f.minPrice&&p<f.minPrice)||(f.maxPrice&&p>f.maxPrice))failures.push('PRICE_FILTER');
  if(q<=0n||q%f.step!==0n||(f.minQty&&q<f.minQty)||(f.maxQty&&q>f.maxQty))failures.push('LOT_SIZE');
  const product=p*q;
  if(product<f.minNotional*SCALE||(f.maxNotional&&product>f.maxNotional*SCALE))failures.push('NOTIONAL');
  return failures;
}
export function validateLimit({price,quantity,filters}){
  const p=value(price,'price'),q=value(quantity,'quantity');
  const failures=validate(p,q,filterSet(filters));
  return {valid:failures.length===0,failures};
}
export function planLimitBuy({targetPrice,budget,filters}){
  const f=filterSet(filters),target=value(targetPrice,'targetPrice'),b=value(budget,'budget');
  const p=target/f.tick*f.tick;
  if(p===0n)return {valid:false,failures:['PRICE_FILTER'],price:'0',quantity:'0'};
  const q=(b*SCALE/(p*f.step))*f.step;
  const failures=validate(p,q,f);
  return {valid:failures.length===0,failures,price:decimalString(p),quantity:decimalString(q)};
}
