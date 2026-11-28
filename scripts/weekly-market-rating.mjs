// Separate rolling-year research profile; no trading or production access.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {aggregate5m} from './backtest-timeframes.mjs';
import {inspectSpotDataset} from './backtest-spot.mjs';
import {rateVerifiedDataset} from './run-market-rating.mjs';
import {rankMarkets} from './market-rating.mjs';
export const DAY=86400000;
export const PROFILE='rolling-year-weekly-draft-v1';
const markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
const KEYS=['symbol','initialCapital','fee','slippageBps','tick','qtyStep','minQty','minNotional'];
const CUTOFF=Date.parse('2026-11-11T00:00:00Z');
const goodHash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const date=t=>new Date(t).toISOString().slice(0,10);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function weeklyWindow(end,now=Date.now()){
 if(!Number.isSafeInteger(end)||!Number.isSafeInteger(now)||end%DAY||new Date(end).getUTCDay()!==1||end>now-2*DAY||end<Date.UTC(2026,10,23))throw Error('Expected completed Monday UTC with two-day publication buffer');
 return {warmupStart:end-372*DAY,start:end-365*DAY,end};
}
export function latestWeeklyEnd(now){
 if(!Number.isSafeInteger(now))throw Error('Invalid current time');
 const day=Math.floor((now-2*DAY)/DAY)*DAY,d=new Date(day).getUTCDay();
 return day-((d+6)%7)*DAY;
}
export function archivePlan(window){
 const out=[];
 let t=Date.UTC(new Date(window.warmupStart).getUTCFullYear(),new Date(window.warmupStart).getUTCMonth(),1);
 while(t<window.end){
  const d=new Date(t),next=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);
  if(next<=window.end){out.push({period:date(t).slice(0,7),start:t,end:next});t=next;}
  else{
   // Last partial month: only complete daily archives up to the exclusive end.
   for(;t<window.end;t+=DAY)out.push({period:date(t),start:t,end:t+DAY});
  }
 }
 return out;
}
const paramsFor=m=>Object.fromEntries(KEYS.map(k=>[k,m.params[k]]));
export function validateWeeklyDataset(d,window,now=Date.now()){
 const m=markets.find(m=>m.symbol===d?.params?.symbol);
 if(!m||d.tf!==m.tf||Object.keys(window).some(k=>d.window?.[k]!==window[k])||Object.keys(d.params).length!==KEYS.length||KEYS.some(k=>d.params[k]!==m.params[k])||d.source?.kind!=='historical'||d.source.provider!=='Binance Vision spot klines'||d.source.selectionCutoff!==CUTOFF||d.source.retrievedAt>now||!goodHash(d.source.expectedSha256)||!goodHash(d.archiveManifestSha256))throw Error('Weekly dataset identity mismatch');
 const plan=archivePlan(window),archives=d.archiveManifest?.archives;
 if(!Array.isArray(archives)||archives.length!==plan.length||archives.some((a,i)=>a.name!==m.symbol+'-5m-'+plan[i].period+'.zip'||a.start!==plan[i].start||a.end!==plan[i].end||a.rows!==(a.end-a.start)/300000||!goodHash(a.sha256)||!goodHash(a.csvSha256)))throw Error('Weekly archive provenance mismatch');
 return {market:m,verified:inspectSpotDataset(d)};
}
function python(script,...args){return execFileSync('python3',[fileURLToPath(new URL(script,import.meta.url)),...args],{encoding:'utf8',maxBuffer:64*1024*1024});}
export function prepareWeekly(symbol,window,out){
 const m=markets.find(m=>m.symbol===symbol);if(!m)throw Error('Unknown market');
 const root=mkdtempSync(join(tmpdir(),'dca-rating-'));
 try{
  const archives=archivePlan(window).map(a=>{
   const r=JSON.parse(python('./fetch-binance-archive.py',symbol,'5m',a.period,root));
   console.log('WEEKLY_ARCHIVE '+JSON.stringify({symbol,period:a.period,sha256:r.sha256}));return r;
  });
  const config=join(root,'spot.json');
  writeFileSync(config,JSON.stringify({symbol,tf:'5m',archives,window,retrievedAt:Math.max(...archives.map(a=>a.retrievedAt)),selectionCutoff:CUTOFF,filterSource:'repository model snapshot; historical filters unverified',params:paramsFor(m)}));
  const source=JSON.parse(python('./import-binance-spot.py',config)),candles=aggregate5m(source.candles,m.tf);
  const d={...source,tf:m.tf,candles,source:{...source.source,expectedSha256:hash(candles)}};
  const {market,verified}=validateWeeklyDataset(d,window);
  const observation=rateVerifiedDataset(d,market,verified);
  const result={version:PROFILE,window,observation,provenance:{symbol,tf:m.tf,dataSha256:verified.dataSha256,archiveManifestSha256:d.archiveManifestSha256,archives:d.archiveManifest.archives,retrievedAt:d.source.retrievedAt}};
  writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log('WEEKLY_OBSERVATION '+JSON.stringify(result));
 }finally{rmSync(root,{recursive:true,force:true});}
}
export function combineWeekly(inputs,window,now){
 if(!Array.isArray(inputs)||inputs.length!==19||markets.length!==19||markets.filter(m=>m.enabled).length!==11||new Set(inputs.map(x=>x.observation?.symbol)).size!==19)throw Error('Complete 19-pair weekly universe required');
 const plan=archivePlan(window);
 for(const x of inputs){
  const o=x.observation,p=x.provenance,m=markets.find(m=>m.symbol===o?.symbol);
  if(!m||x.version!==PROFILE||Object.keys(window).some(k=>x.window?.[k]!==window[k])||o.tf!==m.tf||p?.symbol!==o.symbol||p.tf!==o.tf||p.dataSha256!==o.dataSha256||!goodHash(p.dataSha256)||!goodHash(p.archiveManifestSha256)||!Number.isSafeInteger(p.retrievedAt)||p.retrievedAt<window.end||p.retrievedAt>now||!Array.isArray(p.archives)||p.archives.length!==plan.length||p.archives.some((a,i)=>a.name!==m.symbol+'-5m-'+plan[i].period+'.zip'||a.start!==plan[i].start||a.end!==plan[i].end||a.rows!==(a.end-a.start)/300000||!goodHash(a.sha256)||!goodHash(a.csvSha256)))throw Error('Weekly observation provenance mismatch');
 }
 const result=rankMarkets({markets:markets.map(({symbol,tf,enabled})=>({symbol,tf,enabled})),observations:inputs.map(x=>x.observation),window:{start:window.start,end:window.end},calculatedAt:now});
 if(result.rows.length!==19||result.rows.some(r=>r.status==='missing-data'))throw Error('Incomplete weekly result');
 const report={...result,profile:PROFILE,warmupStart:window.warmupStart,provenance:inputs.map(x=>x.provenance).sort((a,b)=>a.symbol<b.symbol?-1:1),limitations:[...result.limitations,'ROLLING_WINDOW_RESET_TO_CASH','NOT_DIRECTLY_COMPARABLE_TO_21_MONTH_REPORT','NO_AUTOMATIC_SELECTION'],recommendationAllowed:false};
 return {...report,reportSha256:hash(report)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [mode,arg,out,endArg]=process.argv.slice(2),now=Date.now(),end=endArg==='latest'?latestWeeklyEnd(now):Date.parse(endArg),window=weeklyWindow(end,now);
 if(mode==='prepare')prepareWeekly(arg,window,out);
 else if(mode==='combine'){
  const inputs=markets.map(m=>JSON.parse(readFileSync(join(arg,m.symbol+'.json'),'utf8')));
  const report=combineWeekly(inputs,window,now);writeFileSync(out,JSON.stringify(report,null,2)+'\n');
  for(const r of report.rows)console.log('WEEKLY_RATING '+JSON.stringify(r));
 }else throw Error('Expected prepare or combine');
}
