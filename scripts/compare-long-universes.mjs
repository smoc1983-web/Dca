import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {activeMarkets} from '../cloudflare/market-selection.mjs';
import {backtestPortfolio} from './backtest-portfolio.mjs';
import {validateLongInput} from './prepare-long-target.mjs';
const markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
const selected=activeMarkets(markets).map(m=>m.symbol).sort();
const expected=['ADAUSDT','ATOMUSDT','BTCUSDT','DOGEUSDT','DOTUSDT','LDOUSDT','LINKUSDT','TRXUSDT','UNIUSDT','XRPUSDT','ZECUSDT'];
if(JSON.stringify(selected)!==JSON.stringify(expected))throw Error('Frozen universe mismatch');
export function summarizeLong(r,universe){
 const durations=r.closed.map(c=>c.closedAt-c.startedAt);
 const open=r.openPositions.map(p=>{const lastStart=r.events.findLast(e=>e.symbol===p.symbol&&e.kind==='START');return {...p,ageHours:lastStart?(r.window.end-1-lastStart.time)/3600000:null};});
 const starts=r.events.filter(e=>e.kind==='START').length;
 return {universe,maxCycles:r.settings.maxCycles,slippageBps:r.settings.slippageBps,...r.metrics,starts,openCount:open.length,openPositions:open,
  stops:r.closed.filter(c=>c.exit==='STOP').length,meanClosedDurationHours:durations.length?durations.reduce((a,b)=>a+b,0)/durations.length/3600000:null,
  longestClosedDurationHours:durations.length?Math.max(...durations)/3600000:null,
  rejectedReasons:r.rejected.reduce((o,x)=>(o[x.reason]=(o[x.reason]??0)+1,o),{}),admittedStartPercent:starts+r.rejected.length?100*starts/(starts+r.rejected.length):null};
}
export function compareLongScenario(datasets,maxCycles,slippageBps){
 if(![1,3,5].includes(maxCycles)||![0,2,5,10].includes(slippageBps))throw Error('Frozen scenario mismatch');
 if(!Array.isArray(datasets)||datasets.length!==19||new Set(datasets.map(d=>d.params?.symbol)).size!==19)throw Error('All 19 markets required');
 for(const d of datasets)validateLongInput(d);
 const subset=datasets.filter(d=>selected.includes(d.params.symbol));
 if(subset.length!==11)throw Error('All 11 selected markets required');
 const settings={capital:800,maxCycles,slippageBps};
 const a=backtestPortfolio({...settings,datasets}),b=backtestPortfolio({...settings,datasets:subset});
 const original=summarizeLong(a,19),reduced=summarizeLong(b,11);
 return {version:'long-universe-comparison-v1',kind:'historical',window:a.window,selected,maxCycles,slippageBps,original,reduced,
  delta:{returnPercentagePoints:reduced.netMarkedReturnPercent-original.netMarkedReturnPercent,drawdownPercentagePoints:reduced.maxCloseDrawdownPercent-original.maxCloseDrawdownPercent},
  manifests:datasets.map(d=>({symbol:d.params.symbol,tf:d.tf,dataSha256:d.source.expectedSha256,archiveManifest:d.archiveManifest})),
  reports:[a,b],limitations:['SELECTION_OVERLAP_NOT_OOS','MODEL_FILTERS','NO_INTRABAR_RISK','NO_REAL_ORDERS','NO_FUTURES']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const dir=process.argv[2],slots=Number(process.argv[3]),bps=Number(process.argv[4]);
 const r=compareLongScenario(markets.map(m=>JSON.parse(readFileSync(resolve(dir,m.symbol+'.json'),'utf8'))),slots,bps);
 writeFileSync(process.argv[5],JSON.stringify(r));
 console.log('LONG_COMPARISON '+JSON.stringify({maxCycles:slots,slippageBps:bps,original:r.original,reduced:r.reduced,delta:r.delta}));
}
