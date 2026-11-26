// Offline long-only spot execution ledger. No exchange, Telegram or DB side effects.
// Model fills and confirmed manual fills are separate streams.
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
  const notional=positive(price*quantity,'notional');
  const fee=nonnegative(raw.fee??0,'fee'),feeAsset=fee?str(raw.feeAsset,'feeAsset'):quoteAsset;
  // A third-asset fee needs an explicit contemporaneous quote conversion.
  const rate=fee===0?1:feeAsset===quoteAsset?1:feeAsset===baseAsset?price:positive(raw.feeQuoteRate,'feeQuoteRate');
  const feeQuote=finite(fee*rate,'feeQuote');
  const dca=raw.dca??null;
  if(dca!==null&&(!Number.isInteger(dca)||dca<0||dca>5))throw Error('Invalid DCA');
  return {source,id,cycleId,symbol,tf,baseAsset,quoteAsset,time,side,price,quantity,notional,fee,feeAsset,feeQuote,dca};
}
function empty(e){return {source:e.source,cycleId:e.cycleId,symbol:e.symbol,tf:e.tf,baseAsset:e.baseAsset,quoteAsset:e.quoteAsset,
  startedAt:e.time,lastTime:e.time,closedAt:null,quantity:0,cost:0,priceCost:0,buyCost:0,realized:0,realizedBasis:0,
  feesQuote:0,feesByAsset:{},executions:0};}
function apply(c,e){
  if(c.symbol!==e.symbol||c.tf!==e.tf||c.baseAsset!==e.baseAsset||c.quoteAsset!==e.quoteAsset)throw Error('Cycle metadata mismatch');
  if(c.closedAt!==null)throw Error('Cycle already closed');
  if(e.time<c.lastTime)throw Error('Out-of-order execution');
  const baseFee=e.feeAsset===e.baseAsset?e.fee:0;
  const otherFee=e.feeAsset===e.baseAsset?0:e.feeQuote;
  if(e.side==='buy'){
    const received=positive(e.quantity-baseFee,'net buy quantity');
    const cost=finite(e.notional+otherFee,'buy cost');
    c.quantity+=received;c.cost+=cost;c.priceCost+=e.notional;c.buyCost+=cost;
  }else{
    if(c.quantity<=0)throw Error('Sell without position');
    const removed=e.quantity+baseFee;
    // Relative tolerance is only for binary floating point arithmetic, not exchange lot rounding.
    const tolerance=Number.EPSILON*16*Math.max(removed,c.quantity);
    if(removed-c.quantity>tolerance)throw Error('Sell exceeds quantity');
    const closing=Math.abs(c.quantity-removed)<=tolerance;
    const fraction=closing?1:removed/c.quantity,basis=c.cost*fraction;
    c.realized+=e.notional-otherFee-basis;c.realizedBasis+=basis;
    c.quantity=closing?0:c.quantity-removed;c.cost=closing?0:c.cost-basis;c.priceCost=closing?0:c.priceCost*(1-fraction);
    if(closing)c.closedAt=e.time;
  }
  c.feesQuote+=e.feeQuote;
  if(e.fee)c.feesByAsset[e.feeAsset]=(Object.hasOwn(c.feesByAsset,e.feeAsset)?c.feesByAsset[e.feeAsset]:0)+e.fee;
  c.lastTime=e.time;c.executions++;
  for(const k of ['quantity','cost','priceCost','buyCost','realized','realizedBasis','feesQuote'])finite(c[k],k);
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
    apply(cycles.get(cycleKey),e);seen.set(eventKey,encoded);
  }
  return [...cycles.values()].map(c=>({...c,averageEntry:c.quantity?c.priceCost/c.quantity:null,
    averageCost:c.quantity?c.cost/c.quantity:null,realizedPercent:c.realizedBasis?100*c.realized/c.realizedBasis:null,
    durationMs:c.closedAt===null?null:c.closedAt-c.startedAt}));
}
export function unrealizedPnl(c,markPrice,exitFeeRate=0){
  positive(markPrice,'markPrice');nonnegative(exitFeeRate,'exitFeeRate');
  if(exitFeeRate>=1)throw Error('Invalid exitFeeRate');
  return finite(c.quantity*markPrice*(1-exitFeeRate)-c.cost,'unrealized PnL');
}
