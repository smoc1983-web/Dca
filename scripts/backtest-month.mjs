// Reproducible historical comparison for one fixed old month; NOT OOS or shared capital.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {backtestSpot,inspectSpotDataset} from './backtest-spot.mjs';
const MARKETS=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
const START=1735689600000,END=START+31*86400000,EVAL=START+7*86400000;
const SLIPS=[0,2,5,10];
const KEYS=['symbol','initialCapital','fee','slippageBps','tick','qtyStep','minQty','minNotional'];
export function evaluateMonth(datasets){
 if(!Array.isArray(datasets)||datasets.length!==19||MARKETS.length!==19)throw Error('All 19 markets required');
 const map=new Map(datasets.map(d=>[d?.params?.symbol,d]));
 if(map.size!==19)throw Error('Duplicate market');
 const reports=[],manifests=[];
 let kind=null;
 for(const m of MARKETS){
  const d=map.get(m.symbol);
  if(!d||d.tf!==m.tf||d.window?.warmupStart!==START||d.window.start!==EVAL||d.window.end!==END||
    !d.params||Object.keys(d.params).length!==KEYS.length||KEYS.some(k=>d.params[k]!==m.params[k]))throw Error('Frozen month or market mismatch: '+m.symbol);
  const verified=inspectSpotDataset(d);
  if(kind!==null&&kind!==verified.manifest.kind)throw Error('Mixed data kinds');
  kind=verified.manifest.kind;
  if(kind==='historical'){
   const a=d.archiveManifest?.archives;
   if(!Array.isArray(a)||a.length!==1||a[0].start!==START||a[0].end!==END||a[0].sha256!==d.download?.sha256||!d.archiveManifestSha256)throw Error('Missing monthly archive provenance');
  }
  manifests.push({symbol:m.symbol,tf:m.tf,dataSha256:verified.dataSha256,archiveManifest:d.archiveManifest??null,archiveManifestSha256:d.archiveManifestSha256??null,download:d.download??null});
  for(const slippageBps of SLIPS){
   const report=backtestSpot({...d,params:{...d.params,slippageBps}});
   reports.push({symbol:m.symbol,tf:m.tf,slippageBps,report});
  }
 }
 const summaries=SLIPS.map(slippageBps=>{
  const g=reports.filter(r=>r.slippageBps===slippageBps),capital=g.reduce((n,x)=>n+x.report.metrics.initialCapital,0),equity=g.reduce((n,x)=>n+x.report.metrics.finalMarkedEquity,0);
  return {slippageBps,markets:g.length,independentCapitalSum:capital,independentEquitySum:equity,independentMarkedReturnPercent:100*(equity/capital-1),closedCycles:g.reduce((n,x)=>n+x.report.metrics.closedCount,0),
    openPositions:g.filter(x=>x.report.openPosition!==null).length,negativeMarkets:g.filter(x=>x.report.metrics.netMarkedPnl<0).map(x=>x.symbol)};
 });
 return {version:'historical-month-comparison-v1',kind,mode:'independent-spot-accounts',period:'2025-01',window:{warmupStart:START,start:EVAL,end:END},manifests,reports,summaries,limitations:['SELECTION_OVERLAP_NOT_OOS','MODEL_FILTERS','NO_SHARED_CAPITAL','NO_INTRABAR_RISK','NO_REAL_ORDERS']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const dir=process.argv[2];
 if(!dir)throw Error('Dataset directory required');
 const datasets=MARKETS.map(m=>JSON.parse(readFileSync(resolve(dir,m.symbol+'.json'),'utf8')));
 const r=evaluateMonth(datasets);
 if(r.kind!=='historical')throw Error('Historical input required');
 writeFileSync(resolve(dir,'month-report.json'),JSON.stringify(r));
 for(const x of r.reports.filter(x=>x.slippageBps===0))console.log(JSON.stringify({symbol:x.symbol,tf:x.tf,dataStatus:x.report.dataStatus,bars:x.report.evaluationBars,metrics:x.report.metrics,open:x.report.openPosition!==null}));
 console.log('MONTH_SUMMARIES '+JSON.stringify(r.summaries));
}
