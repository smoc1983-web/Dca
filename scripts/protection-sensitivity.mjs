// Preserve the historical spot fills; use independently verified mark for risk only.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {validateLongInput} from './prepare-long-target.mjs';
import {validateMarkDataset} from './prepare-mark-history.mjs';
import {replayProtectionProxy} from './protection-history-proxy.mjs';
import {sensitivityGrid} from './protection-sensitivity-grid.mjs';
const [spotDir,markDir,baselinePath,out,poolArg]=process.argv.slice(2);
const pool=Number(poolArg),grid=sensitivityGrid(pool);
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
const prior=JSON.parse(readFileSync(new URL('../research/mark-risk-proxy-2026-11-27-summary.json',import.meta.url),'utf8'));
if(prior.provenance.length!==11||provenance.some(p=>{
 const q=prior.provenance.find(x=>x.symbol===p.symbol);
 return !q||q.tf!==p.tf||q.bars!==p.bars||q.dataSha256!==p.dataSha256||JSON.stringify(q.archives)!==JSON.stringify(p.archives);
}))throw Error('Mark provenance differs from prior verified run');
const rows=[];
for(const scenario of grid){
 const r=replayProtectionProxy({datasets,markDatasets:marks,report,fundingRate:.0001,...scenario});
 if(r.slotCollateral*5+r.protectionPool!==800||r.peakProtectionHeld>pool+1e-7||r.finalProtectionHeld+r.pendingAmount>pool+1e-7)throw Error('Protection allocation invariant');
 rows.push(r);
 console.log('SENSITIVITY '+JSON.stringify({pool:r.protectionPool,cap:r.cycleProtectionCap,policy:r.policy,leverage:r.leverage,response:r.responseMode,status:r.status,firstRisk:r.firstRisk,processed:r.processedEvents,closed:r.closedCycles,ret:r.finalProxyReturnPercent,dd:r.observedCloseDrawdownPercent,minMaintenance:r.minMaintenanceHeadroom,minReserve:r.minReserveHeadroom,confirmed:r.confirmed,spent:r.cumulativeTopups,peakHeld:r.peakProtectionHeld,denied:r.denied,pending:r.pendingAmount}));
}
if(rows.length!==54)throw Error('Incomplete sensitivity grid');
writeFileSync(out,JSON.stringify({version:'mark-protection-sensitivity-v1',pool,markRun:45958961984,baselineRun:45875049345,baselineArtifact:15144743521,period:report.window,provenance,rows,limitations:['FIXED_SPOT_FILLS_NOT_FUTURES_EXECUTION','MARK_OHLC_AGGREGATED_TO_NATIVE_SIGNAL_TF','SYNTHETIC_FUNDING_AND_FEES','SYNTHETIC_COLLATERAL_AND_TIERS','NOT_ACTUAL_LIQUIDATION','NOT_WALT','NOT_OOS']},null,2));
