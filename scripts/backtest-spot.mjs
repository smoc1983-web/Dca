// Node-only offline research runner. No network, Worker, orders or Telegram.
import {createHash} from 'node:crypto';
import {DEFAULTS,newState,advance,intervalMs} from '../cloudflare/watchlist-engine.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const finite=(x,name,min=0,max=Infinity)=>{if(typeof x!=='number'||!Number.isFinite(x)||x<min||x>max)throw Error('Invalid '+name);return x;};
const time=(x,name)=>{if(!Number.isSafeInteger(x)||x<0)throw Error('Invalid '+name);return x;};
const str=(x,name)=>{if(typeof x!=='string'||!x.trim()||x.length>512)throw Error('Invalid '+name);return x;};
function parameters(raw){
 // Preserve strategy thresholds; only explicit research cost/capital/filter inputs allowed.
 const keys=['symbol','initialCapital','fee','slippageBps','tick','qtyStep','minQty','minNotional'];
 if(!raw||Object.keys(raw).some(k=>!keys.includes(k)))throw Error('Unsupported research parameter');
 if(typeof raw.symbol!=='string'||! /^[A-Z0-9]+USDT$/.test(raw.symbol)||raw.symbol==='USDT')throw Error('Explicit USDT symbol required');
 const p={...DEFAULTS,drops:[...DEFAULTS.drops],symbol:raw.symbol};
 for(const key of keys.slice(1))p[key]=finite(raw[key],key);
 if(p.initialCapital<=0||p.tick<=0||p.qtyStep<=0||p.fee>=1||p.slippageBps>=10000)throw Error('Invalid research parameters');
 p.baseCash=DEFAULTS.baseCash*p.initialCapital/DEFAULTS.initialCapital;
 return p;
}
function dataset({candles,tf,source,window,params}){
 if(typeof tf!=='string'||! /^(?:[1-9][0-9]*)(m|h|d)$/.test(tf))throw Error('Invalid timeframe');
 const duration=intervalMs(tf);
 if(!Number.isSafeInteger(duration)||duration<=0)throw Error('Invalid timeframe duration');
 const {warmupStart,start,end}=window??{};
 for(const [k,v] of Object.entries({warmupStart,start,end}))time(v,k);
 if(!(warmupStart<start&&start<end)||[warmupStart,start,end].some(v=>v%duration!==0))throw Error('Invalid aligned window');
 const warmupBars=(start-warmupStart)/duration;
 if(warmupBars<Math.max(params.emaLength,params.rsiLength+1,params.crashBars,params.slopeBars+1))throw Error('Insufficient indicator warmup');
 if(!source||!['synthetic','historical'].includes(source.kind))throw Error('Explicit data kind required');
 const manifest={kind:source.kind,provider:str(source.provider,'provider'),datasetId:str(source.datasetId,'datasetId'),retrievedAt:time(source.retrievedAt,'retrievedAt'),selectionCutoff:time(source.selectionCutoff,'selectionCutoff'),filterSource:str(source.filterSource,'filterSource')};
 if(end>manifest.retrievedAt)throw Error('Unclosed or future evaluation window');
 if(!Array.isArray(candles)||candles.length!==(end-warmupStart)/duration)throw Error('Incomplete candle coverage');
 const rows=candles.map((c,i)=>{
  const t=warmupStart+i*duration;
  if(c.time!==t||c.closeTime!==t+duration-1)throw Error('Candle gap, duplicate or invalid close time');
  const {open,high,low,close,volume}=c;
  for(const [k,v] of Object.entries({open,high,low,close}))if(finite(v,k)<=0)throw Error('Nonpositive candle price');
  finite(volume,'volume');
  if(low>Math.min(open,close)||high<Math.max(open,close)||high<low)throw Error('Invalid OHLC envelope');
  return {time:t,closeTime:c.closeTime,open,high,low,close,volume};
 });
 const dataSha256=hash(rows);
 if(source.expectedSha256!==undefined&&source.expectedSha256!==dataSha256)throw Error('Candle checksum mismatch');
 return {rows,duration,warmupBars,manifest,dataSha256};
}
export function backtestSpot(input){
 const p=parameters(input.params),{rows,duration,warmupBars,manifest,dataSha256}=dataset({...input,params:p});
 const s=newState(p),events=[],closed=[];
 let peak=p.initialCapital,drawdown=0,peakExposure=0,fees=0,positionBars=0,cycle=null;
 let realized=0,positive=0,negative=0,wins=0,durationSum=0;
 for(let i=0;i<rows.length;i++){
  const c=rows[i];
  if(i<warmupBars){advance(s,c,{...p,exitOnly:true},input.tf);continue;}
  const beforeCash=s.cash,beforeQty=s.qty;
  const e=advance(s,c,p,input.tf)?.event;
  if(e){
   const selling=e.kind==='TP'||e.kind==='STOP';
   const fillPrice=selling?e.price*(1-p.slippageBps/10000):e.fillPrice;
   const notional=e.quantity*fillPrice,fee=notional*p.fee;fees+=fee;
   const cashDelta=s.cash-beforeCash;
   if(e.kind==='START'){if(cycle)throw Error('Unexpected cycle overlap');cycle={startedAt:c.closeTime,startCash:beforeCash,entryFees:0,buys:0};}
   if(!cycle)throw Error('Missing cycle');
   if(!selling){cycle.entryFees+=fee;cycle.buys++;}
   events.push({id:e.id,kind:e.kind,time:c.closeTime,signalPrice:e.price,fillPrice,quantity:e.quantity,notional,fee,cashDelta,quantityAfter:s.qty});
   if(selling){
    const pnl=s.cash-cycle.startCash,heldMs=c.closeTime-cycle.startedAt;
    closed.push({startedAt:cycle.startedAt,closedAt:c.closeTime,durationMs:heldMs,exit:e.kind,buys:cycle.buys,fees:cycle.entryFees+fee,netPnl:pnl});
    realized+=pnl;durationSum+=heldMs;if(pnl>0){wins++;positive+=pnl;}else if(pnl<0)negative-=pnl;
    cycle=null;
   }
  }
  // Exposure between closes: preceding held position, not a retroactive new fill.
  if(beforeQty>0)positionBars++;
  const equity=s.cash+s.qty*c.close;
  if(!Number.isFinite(equity)||equity< -1e-8)throw Error('Invalid equity');
  peak=Math.max(peak,equity);drawdown=Math.max(drawdown,(peak-equity)/peak);
  peakExposure=Math.max(peakExposure,s.qty*c.close);
 }
 const last=rows.at(-1),equity=s.cash+s.qty*last.close;
 const open=cycle?{startedAt:cycle.startedAt,quantity:s.qty,averageEntry:s.average,markPrice:last.close,markValue:s.qty*last.close,entryFees:cycle.entryFees,
   netMarkedPnl:equity-cycle.startCash,estimatedNetExitPnl:s.cash+s.qty*last.close*(1-p.slippageBps/10000)*(1-p.fee)-cycle.startCash}:null;
 return {version:'spot-close-v1',mode:'independent-spot',source:manifest,tf:input.tf,window:{...input.window},dataSha256,paramsSha256:hash(p),params:p,
  dataStatus:manifest.kind==='synthetic'?'synthetic':input.window.start>manifest.selectionCutoff?'post-declared-selection-cutoff-unverified':'selection-overlap',
  warmupBars,evaluationBars:rows.length-warmupBars,events,closedCycles:closed,openPosition:open,
  metrics:{initialCapital:p.initialCapital,finalCash:s.cash,finalMarkedEquity:equity,netMarkedPnl:equity-p.initialCapital,netMarkedReturnPercent:100*(equity/p.initialCapital-1),
   realizedClosedPnl:realized,openMarkedPnl:open?.netMarkedPnl??0,paidFees:fees,maxCloseDrawdownPercent:100*drawdown,peakMarkedExposure:peakExposure,
   closedCount:closed.length,winRatePercent:closed.length?100*wins/closed.length:null,profitFactor:negative>0?positive/negative:null,
   meanClosedDurationMs:closed.length?durationSum/closed.length:null,timeInPositionPercent:100*positionBars/(rows.length-warmupBars)},
  limitations:['CLOSE_PRICE_MODEL','NO_INTRABAR_RISK','NO_LATENCY_OR_LIQUIDITY_MODEL','NO_SHARED_CAPITAL','NO_ACTUAL_EXECUTIONS','SOURCE_PROVENANCE_NOT_VERIFIED','NOT_FUTURES']};
}
