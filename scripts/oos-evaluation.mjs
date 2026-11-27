// Prospective research only: fixed parameters, verified public spot and mark archives.
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {aggregate5m} from './backtest-timeframes.mjs';
import {inspectSpotDataset} from './backtest-spot.mjs';
import {backtestPortfolio} from './backtest-portfolio.mjs';
import {hashRows,loadArchive,parseMarkMonth,urlFor,missingDays,mergeMarkDay} from './prepare-mark-history.mjs';
import {replayProtectionProxy} from './protection-history-proxy.mjs';

const protocolFile=readFileSync(new URL('../research/oos-protocol-2026-12.json',import.meta.url));
const protocol=JSON.parse(protocolFile);
const hash=data=>createHash('sha256').update(data).digest('hex');
const marketBytes=readFileSync(new URL('../strategy/markets.json',import.meta.url));
if(hash(marketBytes)!==protocol.marketsSha256)throw Error('Frozen OOS markets changed');
const markets=JSON.parse(marketBytes).filter(m=>m.enabled);
const window={warmupStart:Date.parse(protocol.warmupStart),start:Date.parse(protocol.start),end:Date.parse(protocol.end)};
const cutoff=Date.parse(protocol.selectionCutoff);
const dayMs=86_400_000;
const marketBySymbol=new Map(markets.map(m=>[m.symbol,m]));
const compactDates=(start,end)=>Array.from({length:(end-start)/dayMs},(_,i)=>new Date(start+i*dayMs).toISOString().slice(0,10));
const spotDays=compactDates(window.warmupStart,window.end);
const evaluationMonth=protocol.start.slice(0,7);
const warmupDays=spotDays.filter(day=>day<protocol.start.slice(0,10));
const paramsFor=m=>Object.fromEntries(['symbol','initialCapital','fee','slippageBps','tick','qtyStep','minQty','minNotional'].map(k=>[k,m.params[k]]));
const goodHash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);

export function requireClosedOos(now=Date.now()){
 if(!Number.isSafeInteger(now)||now<window.end)throw Error('OOS evaluation window is still open');
}
function validateInput(input){
 const {spot,mark}=input??{};
 const market=marketBySymbol.get(spot?.params?.symbol);
 if(!market||spot.tf!==market.tf||Object.keys(window).some(k=>spot.window?.[k]!==window[k])||
    spot.source?.kind!=='historical'||spot.source.selectionCutoff!==cutoff||
    !goodHash(spot.source.expectedSha256)||Object.entries(paramsFor(market)).some(([k,v])=>spot.params[k]!==v))
  throw Error('OOS spot data do not match the preregistered market and window');
 const archives=spot.archiveManifest?.archives;
 const expectedArchives=[...warmupDays,evaluationMonth];
 if(!Array.isArray(archives)||archives.length!==expectedArchives.length||archives.some((a,i)=>{
  const start=window.warmupStart+i*dayMs,end=i===warmupDays.length?window.end:start+dayMs;
  return a.name!==market.symbol+'-5m-'+expectedArchives[i]+'.zip'||!goodHash(a.sha256)||
    a.start!==start||a.end!==end||a.rows!==(end-start)/300_000;
 }))throw Error('Incomplete or invalid spot provenance');
 const verified=inspectSpotDataset(spot);
 const markArchives=mark?.archives;
 if(mark?.symbol!==market.symbol||mark.tf!==market.tf||mark.start!==window.start||mark.end!==window.end||
    !Array.isArray(markArchives)||markArchives.length<1||markArchives.length>32||
    markArchives[0].month!==evaluationMonth||markArchives[0].url!==urlFor(market.symbol,evaluationMonth)||
    new Set(markArchives.map(a=>a.url)).size!==markArchives.length||
    markArchives.some((a,i)=>!goodHash(a.sha256)||(i>0&&(
     !/^\d{4}-\d{2}-\d{2}$/.test(a.day)||!spotDays.includes(a.day)||a.day.slice(0,7)!==evaluationMonth||
     a.url!==urlFor(market.symbol,a.day,true))))||
    !Array.isArray(mark.rows)||mark.rows.length!==verified.rows.length-verified.warmupBars||
    hashRows(mark.rows)!==mark.dataSha256)
  throw Error('Incomplete or invalid mark provenance');
 for(let i=0;i<mark.rows.length;i++){
  const r=mark.rows[i],s=verified.rows[verified.warmupBars+i];
  if(r.time!==s.time||r.closeTime!==s.closeTime||
     ![r.open,r.high,r.low,r.close].every(x=>Number.isFinite(x)&&x>0)||
     r.low>Math.min(r.open,r.close)||r.high<Math.max(r.open,r.close))
   throw Error('Invalid or misaligned OOS mark candle');
 }
 return {spot,mark};
}
export function evaluateOos(inputs,now){
 requireClosedOos(now);
 if(!Array.isArray(inputs)||inputs.length!==markets.length||
    new Set(inputs.map(x=>x?.spot?.params?.symbol)).size!==markets.length)throw Error('Complete frozen OOS universe required');
 const checked=inputs.map(validateInput),datasets=checked.map(x=>x.spot),markDatasets=checked.map(x=>x.mark);
 const portfolios=protocol.slippageBps.map(slippageBps=>backtestPortfolio({
  datasets,slippageBps,capital:protocol.capital,maxCycles:protocol.maxCycles
 }));
 const report=portfolios.find(p=>p.settings.slippageBps===2);
 const {pool,cycleCap,fundingRate,maintenanceRate}=protocol.protection;
 const overlays=[];
 for(const policy of protocol.policies)for(const leverage of protocol.leverage)for(const responseMode of protocol.responses){
  overlays.push(replayProtectionProxy({datasets,markDatasets,report,policy,leverage,responseMode,
   fundingRate,maintenanceRate,researchAllocation:{pool,cycleCap}}));
 }
 return {protocolVersion:protocol.version,protocolSha256:hash(protocolFile),window,
  provenance:checked.map(({spot,mark})=>({symbol:mark.symbol,tf:mark.tf,spotSha256:spot.source.expectedSha256,
   spotArchives:spot.archiveManifest.archives,markSha256:mark.dataSha256,markArchives:mark.archives})),
  portfolios,overlays,limitations:['RESET_TO_CASH','MODEL_SPOT_FILTERS','FIXED_SPOT_FILLS_FOR_RISK_OVERLAY',
   'SYNTHETIC_FUNDING_AND_MAINTENANCE','NO_REAL_LIQUIDATION_OR_WALT_EXECUTION']};
}
async function prepare(symbol,output){
 requireClosedOos();
 const market=marketBySymbol.get(symbol);
 if(!market)throw Error('Unknown frozen OOS market');
 const root=mkdtempSync(join(tmpdir(),'dca-oos-'));
 const python=(script,...args)=>execFileSync('python3',[fileURLToPath(new URL(script,import.meta.url)),...args],
  {encoding:'utf8',maxBuffer:16*1024*1024});
 try{
  // Use one completed monthly archive for December and seven daily warmup archives.
  const archives=[...warmupDays,evaluationMonth].map(date=>JSON.parse(python('./fetch-binance-archive.py',symbol,'5m',date,root)));
  const config=join(root,'spot.json');
  writeFileSync(config,JSON.stringify({symbol,tf:'5m',archives,window,
   retrievedAt:Math.max(...archives.map(x=>x.retrievedAt)),selectionCutoff:cutoff,
   filterSource:'frozen repository model snapshot; historical filters unverified',params:paramsFor(market)}));
  const source=JSON.parse(python('./import-binance-spot.py',config));
  const candles=aggregate5m(source.candles,market.tf);
  const spot={...source,tf:market.tf,candles,source:{...source.source,expectedSha256:hashRows(candles)}};
  // Record original archive boundaries, including the one complete evaluation month.
  const markSource=await loadArchive(urlFor(symbol,evaluationMonth),root);
  const monthRows=parseMarkMonth(markSource.csv,window.start,window.end,{allowMissing:true});
  const rowsByTime=new Map(monthRows.map(r=>[r.time,r]));
  const markArchives=[{month:evaluationMonth,url:markSource.url,sha256:markSource.sha256}];
  for(const day of missingDays(monthRows,window.start,window.end)){
   const a=await loadArchive(urlFor(symbol,day,true),root),start=Date.parse(day+'T00:00:00Z');
   mergeMarkDay(rowsByTime,parseMarkMonth(a.csv,start,start+dayMs),start,start+dayMs);
   markArchives.push({day,url:a.url,sha256:a.sha256});
  }
  const rows=aggregate5m([...rowsByTime.values()].sort((a,b)=>a.time-b.time),market.tf);
  const mark={symbol,tf:market.tf,start:window.start,end:window.end,archives:markArchives,rows,dataSha256:hashRows(rows)};
  validateInput({spot,mark});
  writeFileSync(output,JSON.stringify({spot,mark}));
 }finally{rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [mode,arg,out]=process.argv.slice(2);
 if(mode==='prepare')await prepare(arg,out);
 else if(mode==='evaluate'){
  requireClosedOos();
  const inputs=markets.map(m=>JSON.parse(readFileSync(join(arg,m.symbol+'.json'),'utf8')));
  const result=evaluateOos(inputs);
  writeFileSync(out,JSON.stringify(result));
  console.log('OOS_EVALUATED',JSON.stringify({window,spotCases:result.portfolios.length,riskCases:result.overlays.length}));
 }else throw Error('Expected prepare or evaluate');
}
