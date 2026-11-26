// Compare frozen original and owner-selected universes on identical pinned history.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {activeMarkets} from '../cloudflare/market-selection.mjs';
import {backtestPortfolio} from './backtest-portfolio.mjs';
import {validatePortfolioMonth} from './backtest-portfolio-month.mjs';
const markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
const selected=activeMarkets(markets).map(m=>m.symbol).sort();
const expected=['ADAUSDT','ATOMUSDT','BTCUSDT','DOGEUSDT','DOTUSDT','LDOUSDT','LINKUSDT','TRXUSDT','UNIUSDT','XRPUSDT','ZECUSDT'];
if(JSON.stringify(selected)!==JSON.stringify(expected))throw Error('Unexpected owner-selected universe');
function summary(r,universe){
 const durations=r.closed.map(c=>c.closedAt-c.startedAt);
 return {universe,maxCycles:r.settings.maxCycles,slippageBps:r.settings.slippageBps,...r.metrics,
  starts:r.events.filter(e=>e.kind==='START').length,openCount:r.openPositions.length,
  openSymbols:r.openPositions.map(p=>p.symbol),meanClosedDurationHours:durations.length?durations.reduce((a,b)=>a+b,0)/durations.length/3600000:null,
  rejectedReasons:r.rejected.reduce((o,x)=>(o[x.reason]=(o[x.reason]??0)+1,o),{})};
}
export function compareMarketUniverses(datasets,{synthetic=false}={}){
 const full=validatePortfolioMonth(datasets,{synthetic});
 const subset=full.filter(d=>selected.includes(d.params.symbol));
 if(subset.length!==11)throw Error('Incomplete selected universe');
 const reports=[],comparisons=[];
 for(const maxCycles of [1,3,5])for(const slippageBps of [0,2,5,10]){
  const settings={capital:800,maxCycles,slippageBps};
  const a=backtestPortfolio({...settings,datasets:full}),b=backtestPortfolio({...settings,datasets:subset});
  const original=summary(a,19),reduced=summary(b,11);
  const delta={returnPercentagePoints:reduced.netMarkedReturnPercent-original.netMarkedReturnPercent,
   drawdownPercentagePoints:reduced.maxCloseDrawdownPercent-original.maxCloseDrawdownPercent,
   closedCycles:reduced.closedCount-original.closedCount,rejectedStarts:reduced.rejectedCount-original.rejectedCount,
   finalEquity:reduced.finalMarkedEquity-original.finalMarkedEquity};
  reports.push({universe:19,report:a},{universe:11,report:b});
  comparisons.push({maxCycles,slippageBps,original,reduced,delta});
 }
 return {version:'universe-comparison-v1',kind:synthetic?'synthetic':'historical',selected,excluded:markets.filter(m=>!m.enabled).map(m=>m.symbol).sort(),
  window:reports[0].report.window,manifests:full.map(d=>({symbol:d.params.symbol,archiveManifest:d.archiveManifest??null,download:d.download??null})),
  comparisons,reports,limitations:['SELECTION_OVERLAP_NOT_OOS','FIXED_EQUAL_SLOTS','MODEL_FILTERS','NO_INTRABAR_RISK','NO_REAL_ORDERS','NO_FUTURES']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const dir=process.argv[2];if(!dir)throw Error('Dataset directory required');
 const r=compareMarketUniverses(markets.map(m=>JSON.parse(readFileSync(resolve(dir,m.symbol+'.json'),'utf8'))));
 writeFileSync(resolve(dir,'universe-comparison.json'),JSON.stringify(r));
 for(const c of r.comparisons)console.log('UNIVERSE_COMPARISON '+JSON.stringify(c));
}
