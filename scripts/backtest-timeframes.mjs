import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {backtestSpot,inspectSpotDataset} from './backtest-spot.mjs';
import {intervalMs} from '../cloudflare/watchlist-engine.mjs';
const markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
export const FRAMES=['5m','15m','30m','45m','1h','2h','3h','4h','6h','12h','1d'];
const W=Date.parse('2024-07-01T00:00:00Z'),A=Date.parse('2025-02-01T00:00:00Z'),B=Date.parse('2026-01-01T00:00:00Z'),C=Date.parse('2026-11-01T00:00:00Z');
export function aggregate5m(rows,tf){
 if(!FRAMES.includes(tf)||!Array.isArray(rows)||!rows.length)throw Error('Invalid aggregation input');
 const d=intervalMs(tf),n=d/300000;
 if(rows[0].time%d||rows.length%n)throw Error('Partial aggregate');
 const out=[];
 for(let i=0;i<rows.length;i+=n){
  const t=rows[i].time;let high=-Infinity,low=Infinity,volume=0;
  for(let j=0;j<n;j++){const r=rows[i+j];if(r.time!==t+j*300000||r.closeTime!==r.time+299999)throw Error('Gap inside aggregate');high=Math.max(high,r.high);low=Math.min(low,r.low);volume+=r.volume;}
  out.push({time:t,closeTime:t+d-1,open:rows[i].open,high,low,close:rows[i+n-1].close,volume});
 }
 return out;
}
function metrics(r){
 const m=r.metrics,open=r.openPosition;
 const exitAdjustedPnl=m.realizedClosedPnl+(open?.estimatedNetExitPnl??0);
 return {returnPct:100*exitAdjustedPnl/m.initialCapital,markedReturnPct:m.netMarkedReturnPercent,drawdownPct:m.maxCloseDrawdownPercent,cycles:m.closedCount,stopCount:r.closedCycles.filter(x=>x.exit==='STOP').length,winRate:m.winRatePercent,open:!!open,realizedPnl:m.realizedClosedPnl,openMarkedPnl:m.openMarkedPnl,fees:m.paidFees,dataSha256:r.dataSha256};
}
export function rankFrames(grid,field){
 return [...grid].sort((a,b)=>b[field].returnPct-a[field].returnPct||a[field].drawdownPct-b[field].drawdownPct||FRAMES.indexOf(a.tf)-FRAMES.indexOf(b.tf));
}
export function evaluateSweep(input){
 const m=markets.find(x=>x.symbol===input.params?.symbol);
 if(!m||input.tf!=='5m'||input.window?.warmupStart!==W||input.window.start!==A||input.window.end!==C||input.source?.kind!=='historical'||Object.keys(input.params).length!==8||Object.keys(input.params).some(k=>input.params[k]!==m.params[k]))throw Error('Frozen sweep inputs mismatch');
 const v=inspectSpotDataset(input),source=v.manifest;
 if(input.archiveManifest?.archives?.length!==28)throw Error('28 complete archives required');
 const grid=FRAMES.map(tf=>{
  const bars=aggregate5m(v.rows,tf),d=intervalMs(tf);
  const run=(start,end,slippageBps)=>metrics(backtestSpot({candles:bars.slice(0,(end-W)/d),tf,params:{...input.params,slippageBps},window:{warmupStart:W,start,end},source}));
  return {tf,warmupBars:(A-W)/d,full:run(A,C,2),train:run(A,B,2),validation:run(B,C,2),costs:[0,5,10].map(bps=>({bps,...run(A,C,bps)}))};
 });
 return {symbol:m.symbol,currentTf:m.tf,source,archiveManifest:input.archiveManifest,baseDataSha256:v.dataSha256,grid,fullWinner:rankFrames(grid,'full')[0].tf,trainWinner:rankFrames(grid,'train')[0].tf,limitations:['RESEARCH_OVERLAP_NOT_OOS','DIFFERENT_WARMUP_FROM_ARCHIVE','MODEL_FILTERS','SPOT_ONLY','NO_SHARED_CAPITAL']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const result=evaluateSweep(JSON.parse(readFileSync(process.argv[2],'utf8')));
 writeFileSync(process.argv[3],JSON.stringify(result));
 console.log('SWEEP '+JSON.stringify({symbol:result.symbol,currentTf:result.currentTf,fullWinner:result.fullWinner,trainWinner:result.trainWinner,grid:result.grid}));
}
