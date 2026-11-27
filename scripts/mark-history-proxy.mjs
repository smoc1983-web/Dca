// Preserve the historical spot fills; use independently verified mark for risk only.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {validateLongInput} from './prepare-long-target.mjs';
import {validateMarkDataset} from './prepare-mark-history.mjs';
import {replayProtectionProxy} from './protection-history-proxy.mjs';
const [spotDir,markDir,baselinePath,out]=process.argv.slice(2);
const markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8')).filter(m=>m.enabled);
const baseline=JSON.parse(readFileSync(baselinePath,'utf8'));
if(markets.length!==11||baseline.version!=='long-universe-comparison-v1'||baseline.maxCycles!==5||baseline.slippageBps!==2)throw Error('Unexpected baseline');
const report=baseline.reports[1];
if(report.datasets.length!==11||report.events.length!==1443||Math.abs(report.metrics.netMarkedReturnPercent-29.263166610282365)>1e-8)throw Error('Prior baseline mismatch');
const datasets=markets.map(m=>JSON.parse(readFileSync(resolve(spotDir,m.symbol+'.json'),'utf8')));
for(const d of datasets){
 const v=validateLongInput(d).verified;
 if(report.datasets.find(x=>x.symbol===d.params.symbol)?.dataSha256!==v.dataSha256)throw Error('Spot provenance mismatch');
}
const marks=markets.map(m=>validateMarkDataset(JSON.parse(readFileSync(resolve(markDir,m.symbol+'.json'),'utf8')),m));
const provenance=marks.map(({symbol,tf,start,end,dataSha256,archives,rows})=>({symbol,tf,start,end,dataSha256,bars:rows.length,archives}));
const rows=[];
for(const policy of ['fixed-notional','scaled-notional'])for(const leverage of [1,2,3])for(const responseMode of ['none','next-close','two-closes','reject']){
 const r=replayProtectionProxy({datasets,markDatasets:marks,report,leverage,policy,fundingRate:.0001,responseMode});
 rows.push(r);console.log('MARK_PROXY '+JSON.stringify(r));
}
writeFileSync(out,JSON.stringify({version:'spot-fill-mark-risk-proxy-v1',baselineRun:45875049345,baselineArtifact:15144743521,period:report.window,provenance,rows,limitations:['FIXED_SPOT_FILLS_NOT_FUTURES_EXECUTION','MARK_OHLC_AGGREGATED_TO_NATIVE_SIGNAL_TF','SYNTHETIC_FUNDING_AND_FEES','SYNTHETIC_COLLATERAL_AND_TIERS','NOT_ACTUAL_LIQUIDATION','NOT_WALT','NOT_OOS']},null,2));
