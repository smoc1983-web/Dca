// Offline long-only spot execution ledger. No exchange, Telegram or DB side effects.
// Model fills and confirmed manual fills are separate streams.
import {units,add,sub,mul,div,portion,decimalString,number,SCALE} from './ledger-decimal.mjs';
const positive=(v,name)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<=0)throw Error('Invalid '+name);return v;};
const nonnegative=(v,name)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0)throw Error('Invalid '+name);return v;};
const str=(v,name)=>{if(typeof v!=='string'||!v.trim())throw Error('Invalid '+name);return v;};
const finite=(v,name)=>{if(!Number.isFinite(v))throw Error('Overflow '+name);return v;};
const key=(...parts)=>JSON.stringify(parts);
export function normalizeExecution(raw){
  if(!raw||typeof raw!=='object')throw Error('Invalid execution');
  const {source,side}=raw;
  if(!['model','manual'].includes(source))throw Error('Invalid source');
  if(source==='manual'&&raw.confirmed!==true)throw Error('Manual execution must be confirmed');
  if(!['buy','sell'].includes(side))throw Error('Invalid side');
  const id=str(raw.id,'id'),cycleId=str(raw.cycleId,'cycleId'),symbol=str(raw.symbol,'symbol'),tf=str(raw.tf,'tf');
  const baseAsset=str(raw.baseAsset,'baseAsset'),quoteAsset=str(raw.quoteAsset,'quoteAsset');
  if(baseAsset===quoteAsset||quoteAsset!=='USDT'||symbol!==baseAsset+quoteAsset)throw Error('Unsupported spot pair');
  const time=nonnegative(raw.time,'time');
  if(!Number.isSafeInteger(time))throw Error('Invalid time');
  const price=positive(raw.price,'price'),quantity=positive(raw.quantity,'quantity');
  const notional=positive(number(mul(units(price),units(quantity))),'notional');
  const fee=nonnegative(raw.fee??0,'fee'),feeAsset=fee?str(raw.feeAsset,'feeAsset'):quoteAsset;
  // A third-asset fee needs an explicit contemporaneous quote conversion.
  const rate=fee===0?1:feeAsset===quoteAsset?1:feeAsset===baseAsset?price:positive(raw.feeQuoteRate,'feeQuoteRate');
  const feeQuote=finite(number(mul(units(fee),units(rate))),'feeQuote');
  const dca=raw.dca??null;
  if(dca!==null&&(!Number.isInteger(dca)||dca<0||dca>5))throw Error('Invalid DCA');
  return {source,id,cycleId,symbol,tf,baseAsset,quoteAsset,time,side,price,quantity,notional,fee,feeAsset,feeQuote,dca};
}
function empty(e){return {source:e.source,cycleId:e.cycleId,symbol:e.symbol,tf:e.tf,baseAsset:e.baseAsset,quoteAsset:e.quoteAsset,
  startedAt:e.time,lastTime:e.time,closedAt:null,quantity:0n,cost:0n,priceCost:0n,buyCost:0n,realized:0n,realizedBasis:0n,
  feesQuote:0n,feesByAsset:Object.create(null),executions:0};}
function apply(c,e,raw){
  if(c.symbol!==e.symbol||c.tf!==e.tf||c.baseAsset!==e.baseAsset||c.quoteAsset!==e.quoteAsset)throw Error('Cycle metadata mismatch');
  if(c.closedAt!==null)throw Error('Cycle already closed');
  if(e.time<c.lastTime)throw Error('Out-of-order execution');
  const qty=units(e.quantity),price=units(e.price),fee=units(e.fee),notional=mul(qty,price);
  const feeQuote=mul(fee,units(e.fee===0||e.feeAsset===e.quoteAsset?1:e.feeAsset===e.baseAsset?e.price:raw.feeQuoteRate));
  const baseFee=e.feeAsset===e.baseAsset?fee:0n;
  const otherFee=e.feeAsset===e.baseAsset?0n:feeQuote;
  if(e.side==='buy'){
    const received=sub(qty,baseFee);
    if(received<=0n)throw Error('Invalid net buy quantity');
    const cost=add(notional,otherFee);
    c.quantity=add(c.quantity,received);c.cost=add(c.cost,cost);c.priceCost=add(c.priceCost,notional);c.buyCost=add(c.buyCost,cost);
  }else{
    if(c.quantity<=0n)throw Error('Sell without position');
    const removed=add(qty,baseFee);
    // Engine positions arrive as JS numbers; retain only the legacy model tolerance.
    // Manual executions have exact decimal quantity checks, never silently oversell.
    const tolerance=e.source==='model'?Number.EPSILON*16*Math.max(number(removed),number(c.quantity)):0;
    const difference=sub(removed,c.quantity);
    const closing=difference===0n||(e.source==='model'&&Math.abs(number(difference))<=tolerance);
    if(difference>0n&&!closing)throw Error('Sell exceeds quantity');
    const basis=closing?c.cost:portion(c.cost,removed,c.quantity);
    const priceBasis=closing?c.priceCost:portion(c.priceCost,removed,c.quantity);
    c.realized=add(c.realized,sub(sub(notional,otherFee),basis));c.realizedBasis=add(c.realizedBasis,basis);
    c.quantity=closing?0n:sub(c.quantity,removed);c.cost=sub(c.cost,basis);c.priceCost=sub(c.priceCost,priceBasis);
    if(closing)c.closedAt=e.time;
  }
  c.feesQuote=add(c.feesQuote,feeQuote);
  if(fee)c.feesByAsset[e.feeAsset]=add(c.feesByAsset[e.feeAsset]??0n,fee);
  c.lastTime=e.time;c.executions++;
}
const monetary=['quantity','cost','priceCost','buyCost','realized','realizedBasis','feesQuote'];
function report(c){
  const exact=Object.fromEntries(monetary.map(k=>[k,decimalString(c[k])]));
  const values=Object.fromEntries(monetary.map(k=>[k,number(c[k])]));
  const averageEntry=c.quantity?number(div(c.priceCost,c.quantity)):null;
  const averageCost=c.quantity?number(div(c.cost,c.quantity)):null;
  const realizedPercent=c.realizedBasis?number(portion(c.realized,100n*SCALE,c.realizedBasis)):null;
  return {...c,...values,feesByAsset:Object.fromEntries(Object.entries(c.feesByAsset).map(([k,v])=>[k,number(v)])),
    exact,averageEntry,averageCost,realizedPercent,durationMs:c.closedAt===null?null:c.closedAt-c.startedAt};
}
// Replay append order. Duplicate execution IDs are idempotent only when all normalized fields match.
export function replayLedger(executions){
  if(!Array.isArray(executions))throw Error('Invalid ledger');
  const seen=new Map(),cycles=new Map();
  for(const raw of executions){
    const e=normalizeExecution(raw),eventKey=key(e.source,e.id),encoded=JSON.stringify(e);
    if(seen.has(eventKey)){if(seen.get(eventKey)!==encoded)throw Error('Conflicting execution ID');continue;}
    const cycleKey=key(e.source,e.cycleId);
    if(!cycles.has(cycleKey)){if(e.side!=='buy')throw Error('Cycle must start with buy');cycles.set(cycleKey,empty(e));}
    apply(cycles.get(cycleKey),e,raw);seen.set(eventKey,encoded);
  }
  return [...cycles.values()].map(report);
}
export function unrealizedPnl(c,markPrice,exitFeeRate=0){
  positive(markPrice,'markPrice');nonnegative(exitFeeRate,'exitFeeRate');
  if(exitFeeRate>=1)throw Error('Invalid exitFeeRate');
  return number(sub(mul(mul(units(c.quantity),units(markPrice)),sub(SCALE,units(exitFeeRate))),units(c.cost)));
}
