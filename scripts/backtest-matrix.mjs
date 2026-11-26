// Offline fixed-universe comparison, no optimization, network or order placement.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {backtestSpot,inspectSpotDataset} from './backtest-spot.mjs';
import {intervalMs,DEFAULTS} from '../cloudflare/watchlist-engine.mjs';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const marketFile=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
const MARKETS=marketFile.map(m=>({symbol:m.symbol,tf:m.tf,params:{symbol:m.symbol,initialCapital:m.params.initialCapital,fee:m.params.fee,slippageBps:0,tick:m.params.tick,qtyStep:m.params.qtyStep,minQty:m.params.minQty,minNotional:m.params.minNotional}}));
const names=['train','validation','oos'];
const slips=[0,2,5,10];
// Last known source/strategy changes in the imported project date to Nov 10.
// This lower bound is not proof of prospective or untouched data.
export const EARLIEST_DECLARED_CUTOFF=Date.parse('2026-11-11T00:00:00Z');
const isTime=t=>Number.isSafeInteger(t)&&t>=0;
function validatePeriods(periods,cutoff){
 if(!isTime(cutoff)||cutoff<EARLIEST_DECLARED_CUTOFF)throw Error('Selection cutoff predates known strategy history');
 if(!Array.isArray(periods)||periods.length!==3)throw Error('Explicit train validation oos periods required');
 const result=periods.map((p,i)=>{
  if(p?.id!==names[i]||!isTime(p.start)||!isTime(p.end)||p.start>=p.end)throw Error('Invalid period');
  if(MARKETS.some(m=>p.start%intervalMs(m.tf)!==0||p.end%intervalMs(m.tf)!==0))throw Error('Period must align with every market timeframe');
  return {id:p.id,start:p.start,end:p.end};
 });
 if(result[0].end>result[1].start||result[1].end>result[2].start)throw Error('Overlapping evaluation periods');
 if(result[1].end>cutoff||result[2].start<=cutoff)throw Error('OOS must start after declared cutoff; training and validation must end by cutoff');
 return result;
}
function sameParams(raw,frozen){
 return raw&&Object.keys(raw).length===Object.keys(frozen).length&&Object.keys(frozen).every(k=>raw[k]===frozen[k]);
}
export function backtestMatrix({datasets,periods,selectionCutoff,warmupBars=200}){
 const windows=validatePeriods(periods,selectionCutoff);
 if(!Number.isSafeInteger(warmupBars)||warmupBars<DEFAULTS.emaLength||warmupBars>100000)throw Error('Invalid warmup bars');
 if(MARKETS.length!==19||new Set(MARKETS.map(m=>m.symbol)).size!==19||MARKETS.some(m=>m.symbol==='NEARUSDT'))throw Error('Unexpected frozen market universe');
 if(!Array.isArray(datasets)||datasets.length!==MARKETS.length)throw Error('All 19 datasets required');
 const map=new Map();
 for(const input of datasets){
  const symbol=input?.params?.symbol;
  if(!MARKETS.some(m=>m.symbol===symbol)||map.has(symbol))throw Error('Unknown or duplicate market dataset');
  map.set(symbol,input);
 }
 const results=[],manifests=[];
 let kind=null;
 for(const market of MARKETS){
  const input=map.get(market.symbol);
  if(!input||input.tf!==market.tf||!sameParams(input.params,market.params))throw Error('Frozen market parameters mismatch: '+market.symbol);
  if(input.source?.selectionCutoff!==selectionCutoff)throw Error('Dataset cutoff mismatch');
  const full=inspectSpotDataset(input),d=full.duration;
  if(kind!==null&&kind!==full.manifest.kind)throw Error('Mixed synthetic and historical datasets');
  kind=full.manifest.kind;
  manifests.push({symbol:market.symbol,tf:market.tf,source:full.manifest,fullWindow:{...input.window},fullDataSha256:full.dataSha256});
  for(const period of windows){
   const warmupStart=period.start-warmupBars*d;
   if(warmupStart<input.window.warmupStart||period.end>input.window.end)throw Error('Insufficient period coverage: '+market.symbol+'/'+period.id);
   const startIndex=(warmupStart-input.window.warmupStart)/d,endIndex=(period.end-input.window.warmupStart)/d;
   if(!Number.isInteger(startIndex)||!Number.isInteger(endIndex))throw Error('Unaligned slice');
   const candles=full.rows.slice(startIndex,endIndex);
   for(const slippageBps of slips){
    // The full dataset hash has already been checked, so do not reuse it for slices.
    const report=backtestSpot({candles,tf:market.tf,params:{...market.params,slippageBps},
      window:{warmupStart,start:period.start,end:period.end},source:full.manifest});
    results.push({symbol:market.symbol,period:period.id,slippageBps,report});
   }
  }
 }
 const summaries=windows.flatMap(period=>slips.map(slippageBps=>{
  const group=results.filter(x=>x.period===period.id&&x.slippageBps===slippageBps);
  const capital=group.reduce((n,x)=>n+x.report.metrics.initialCapital,0);
  const equity=group.reduce((n,x)=>n+x.report.metrics.finalMarkedEquity,0);
  return {period:period.id,slippageBps,markets:group.length,independentCapitalSum:capital,independentMarkedEquitySum:equity,
    independentMarkedReturnPercent:100*(equity/capital-1),closedCycles:group.reduce((n,x)=>n+x.report.metrics.closedCount,0),
    openPositions:group.filter(x=>x.report.openPosition!==null).length,
    negativeMarkets:group.filter(x=>x.report.metrics.netMarkedPnl<0).map(x=>x.symbol)};
 }));
 return {version:'fixed-universe-matrix-v1',kind,mode:'independent-spot-accounts',selectionCutoff,periods:windows,warmupBars,slippageBps:[...slips],
   frozenMarkets:structuredClone(MARKETS),frozenMarketsSha256:sha(MARKETS),manifests,results,summaries,
   limitations:['NO_OPTIMIZATION','OOS_CHRONOLOGY_NOT_INDEPENDENCE_PROOF','PERIODS_RESET_TO_CASH','WARMUP_MAY_OVERLAP_EARLIER_EVALUATION','NO_SHARED_CAPITAL','NO_PORTFOLIO_DRAWDOWN','NO_REAL_EXECUTION','NO_FUTURES']};
}
