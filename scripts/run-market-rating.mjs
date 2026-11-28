// Pinned historical data only. Run once against all 19 selected-timeframe inputs.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateLongInput} from './prepare-long-target.mjs';
import {backtestSpot} from './backtest-spot.mjs';
import {rankMarkets,POLICY} from './market-rating.mjs';
const read=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const markets=read('../strategy/markets.json');
const DAY=86400000;
export function rateDataset(d){
 const {market,verified}=validateLongInput(d);
 if(d.params.initialCapital!==800||d.params.fee!==.001)throw Error('Unexpected capital/fee');
 const costs=POLICY.costBps.map(bps=>{
  const r=backtestSpot({...d,params:{...d.params,slippageBps:bps}});
  if(r.dataSha256!==verified.dataSha256)throw Error('Unexpected rating data hash');
  const m=r.metrics,open=r.openPosition;
  const realizedPnl=m.realizedClosedPnl,openExitPnl=open?.estimatedNetExitPnl??0;
  const longestExposureDays=Math.max(0,...r.closedCycles.map(c=>c.durationMs),open?d.window.end-1-open.startedAt:0)/DAY;
  return {bps,netReturn:100*(realizedPnl+openExitPnl)/m.initialCapital,drawdown:m.maxCloseDrawdownPercent,cycles:m.closedCount,stops:r.closedCycles.filter(c=>c.exit==='STOP').length,longestExposureDays,realizedPnl,openExitPnl,fees:m.paidFees,open:!!open,paramsSha256:r.paramsSha256};
 });
 return {symbol:market.symbol,tf:d.tf,start:d.window.start,end:d.window.end,dataSha256:verified.dataSha256,costs};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [dir,out]=process.argv.slice(2);
 if(markets.length!==19||markets.filter(m=>m.enabled).length!==11)throw Error('Frozen universe mismatch');
 const observations=[];
 for(const m of markets){const o=rateDataset(JSON.parse(readFileSync(resolve(dir,m.symbol+'.json'),'utf8')));observations.push(o);console.log('RATING_INPUT '+JSON.stringify(o));}
 const result=rankMarkets({markets:markets.map(m=>({symbol:m.symbol,tf:m.tf,enabled:m.enabled})),observations,window:{start:observations[0].start,end:observations[0].end},calculatedAt:Date.now()});
 if(result.rows.length!==19||result.rows.some(r=>r.status==='missing-data'))throw Error('Incomplete historical rating');
 const report={...result,sourceRun:45875049345,source:'pinned Binance Spot long target series',fee:.001,capitalPerPair:800};
 writeFileSync(out,JSON.stringify(report,null,2)+'\n');
 for(const r of result.rows)console.log('RATING_RESULT '+JSON.stringify(r));
}
