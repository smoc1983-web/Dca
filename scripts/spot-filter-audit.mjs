// Public spot LIMIT filter arithmetic only; no account access or order authorization.
import {units,decimalString,SCALE} from '../cloudflare/ledger-decimal.mjs';
import {planLimitBuy} from '../cloudflare/order-filters.mjs';
const max=(a,b)=>a>b?a:b,ceil=(a,b)=>(a+b-1n)/b;
const positive=(v)=>{const n=units(v);if(n<=0n)throw Error('Positive filter required');return n;};
export function extractSpotFilters(s){
 if(s.status!=='TRADING'||s.quoteAsset!=='USDT'||s.isSpotTradingAllowed!==true||!s.orderTypes?.includes('LIMIT'))throw Error('Spot LIMIT unavailable');
 if(!Array.isArray(s.filters)||new Set(s.filters.map(f=>f.filterType)).size!==s.filters.length)throw Error('Invalid filter set');
 const f=Object.fromEntries(s.filters.map(x=>[x.filterType,x])),p=f.PRICE_FILTER,q=f.LOT_SIZE;
 if(!p||!q||(!f.MIN_NOTIONAL&&!f.NOTIONAL))throw Error('Missing explicit price/lot/notional filter');
 const min= max(units(f.MIN_NOTIONAL?.minNotional??'0'),units(f.NOTIONAL?.minNotional??'0'));
 if(min<=0n)throw Error('Missing positive minimum notional');
 return {tickSize:p.tickSize,minPrice:p.minPrice,maxPrice:p.maxPrice,stepSize:q.stepSize,minQty:q.minQty,maxQty:q.maxQty,minNotional:decimalString(min),maxNotional:f.NOTIONAL?.maxNotional??'0'};
}
export function auditLimitStart({price,budget,filters}){
 const p=positive(price),tick=positive(filters.tickSize),step=positive(filters.stepSize),b=positive(budget),rounded=p/tick*tick;
 if(rounded<=0n)throw Error('Price below tick');
 const minQty=units(filters.minQty),minN=positive(filters.minNotional);
 const qtySteps=max(ceil(minQty,step),ceil(minN*SCALE,rounded*step));
 const minQtyRounded=qtySteps*step, minBudget=ceil(rounded*minQtyRounded,SCALE);
 const plan=planLimitBuy({targetPrice:price,budget,filters});
 return {budget:decimalString(b),roundedPrice:decimalString(rounded),minimumQuantity:decimalString(minQtyRounded),minimumBudgetAtPrice:decimalString(minBudget),plannedQuantity:plan.quantity,
  plannedNotional:decimalString(rounded*units(plan.quantity)/SCALE),passesStaticLimitFilters:plan.valid,failures:plan.failures,recommendationAllowed:false};
}
export function auditSnapshot({symbols,prices,requested,capturedAt}){
 if(!Number.isSafeInteger(capturedAt)||capturedAt<=0||!Array.isArray(symbols)||!Array.isArray(prices)||!Array.isArray(requested)||requested.length!==11||new Set(requested).size!==11)throw Error('Invalid snapshot');
 const rows=requested.map(symbol=>{
  const ss=symbols.filter(s=>s.symbol===symbol),pp=prices.filter(p=>p.symbol===symbol);
  if(ss.length!==1||pp.length!==1)throw Error('Missing or duplicate market '+symbol);
  try{const filters=extractSpotFilters(ss[0]);return {symbol,price:pp[0].price,filters,scenarios:['5','10','15'].map(budget=>auditLimitStart({price:pp[0].price,budget,filters}))};}
  catch(e){return {symbol,unavailable:String(e.message),scenarios:[]};}
 });
 return {version:'spot-static-limit-audit-v1',capturedAt,rows,recommendationAllowed:false,limitations:['SPOT_ONLY','STATIC_LIMIT_FILTERS_ONLY','NOT_MARKET_ORDER','NO_DYNAMIC_PRICE_BANDS','NO_ACCOUNT_FILTERS','NO_HISTORICAL_FILTERS','NO_ORDER_AUTHORIZATION']};
}
