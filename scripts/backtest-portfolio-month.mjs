// Fixed research scenarios; same historical archives as prior independent comparison.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {backtestPortfolio} from './backtest-portfolio.mjs';
import {inspectSpotDataset} from './backtest-spot.mjs';
const markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
const pins=JSON.parse(readFileSync(new URL('./history-2025-01-pins.json',import.meta.url),'utf8'));
const START=1735689600000, EVAL=START+7*86400000, END=START+31*86400000;
const KEYS=['symbol','initialCapital','fee','slippageBps','tick','qtyStep','minQty','minNotional'];
export function evaluatePortfolioMonth(datasets,{synthetic=false}={}){
 if(!Array.isArray(datasets)||datasets.length!==19||markets.length!==19)throw Error('All 19 markets required');
 const map=new Map(datasets.map(d=>[d?.params?.symbol,d]));
 if(map.size!==19)throw Error('Duplicate market');
 const ordered=markets.map(m=>{
  const d=map.get(m.symbol),native=m.tf==='45m'?'15m':m.tf==='3h'?'1h':m.tf;
  if(!d||d.tf!==m.tf||d.window?.warmupStart!==START||d.window.start!==EVAL||d.window.end!==END||
    Object.keys(d.params).length!==KEYS.length||KEYS.some(k=>d.params[k]!==m.params[k]))throw Error('Frozen market or window mismatch');
  const v=inspectSpotDataset(d);
  if(v.manifest.kind!==(synthetic?'synthetic':'historical'))throw Error('Unexpected data kind');
  if(!synthetic){
   const name=m.symbol+'-'+native+'-2025-01.zip',a=d.archiveManifest?.archives;
   if(!Array.isArray(a)||a.length!==1||a[0].name!==name||a[0].sha256!==pins[name]||d.download?.sha256!==pins[name]||a[0].start!==START||a[0].end!==END)throw Error('Pinned archive mismatch: '+m.symbol);
  }
  return d;
 });
 const reports=[];
 for(const maxCycles of [1,3,5])for(const slippageBps of [0,2,5,10]){
  const report=backtestPortfolio({datasets:ordered,capital:800,maxCycles,slippageBps});
  reports.push(report);
 }
 const summaries=reports.map(r=>({maxCycles:r.settings.maxCycles,slippageBps:r.settings.slippageBps,cycleBudget:r.settings.cycleBudget,...r.metrics,
  openCount:r.openPositions.length,openSymbols:r.openPositions.map(p=>p.symbol),
  rejectedReasons:r.rejected.reduce((o,x)=>(o[x.reason]=(o[x.reason]??0)+1,o),{}),
  starts:r.events.filter(e=>e.kind==='START').length}));
 return {version:'portfolio-month-v1',kind:synthetic?'synthetic':'historical',period:'2025-01',window:{warmupStart:START,start:EVAL,end:END},
  archivePins:synthetic?null:pins,manifests:ordered.map(d=>({symbol:d.params.symbol,archiveManifest:d.archiveManifest??null,download:d.download??null})),
  reports,summaries,limitations:['SELECTION_OVERLAP_NOT_OOS','MODEL_FILTERS','HYPOTHETICAL_ALLOCATION','NO_FUTURES','NO_REAL_ORDERS']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const dir=process.argv[2];if(!dir)throw Error('Dataset directory required');
 const r=evaluatePortfolioMonth(markets.map(m=>JSON.parse(readFileSync(resolve(dir,m.symbol+'.json'),'utf8'))));
 writeFileSync(resolve(dir,'portfolio-report.json'),JSON.stringify(r));
 for(const s of r.summaries)console.log('PORTFOLIO_SUMMARY '+JSON.stringify(s));
}
