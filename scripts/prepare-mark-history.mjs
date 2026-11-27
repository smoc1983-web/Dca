// Research-only Binance USD-M mark OHLC. Never use spot as fallback.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {aggregate5m} from './backtest-timeframes.mjs';
const dt=300000;
export const START=Date.parse('2025-02-01T00:00:00Z'),END=Date.parse('2026-11-01T00:00:00Z');
const markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8')).filter(m=>m.enabled);
const audit=JSON.parse(readFileSync(new URL('../research/price-series-audit-2026-11-27-summary.json',import.meta.url),'utf8'));
export const hashRows=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
export function months(start=START,end=END){
 const out=[];
 for(let t=start;t<end;){const d=new Date(t),next=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);
  if(t!==Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)||next>end)throw Error('Monthly aligned window required');
  out.push({month:d.toISOString().slice(0,7),start:t,end:next});t=next;
 }
 return out;
}
export function parseMarkMonth(csv,start,end){
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start%dt||end%dt||end<=start)throw Error('Invalid mark window');
 const lines=csv.trim().split(/\r?\n/);
 if(/^(open_time|open time|opentime),/i.test(lines[0]))lines.shift();
 if(lines.length!==(end-start)/dt)throw Error('Incomplete mark coverage');
 return lines.map((line,i)=>{
  const a=line.split(','),time=start+i*dt,closeTime=time+dt-1;
  if(a.length!==12||Number(a[0])!==time||Number(a[6])!==closeTime)throw Error('Mark gap, duplicate or timestamp units');
  const [open,high,low,close]=a.slice(1,5).map(Number);
  if([open,high,low,close].some(x=>!Number.isFinite(x)||x<=0)||low>Math.min(open,close)||high<Math.max(open,close)||low>high)throw Error('Invalid mark OHLC');
  return {time,closeTime,open,high,low,close,volume:0};
 });
}
function urlFor(symbol,month){return 'https://data.binance.vision/data/futures/um/monthly/markPriceKlines/'+symbol+'/5m/'+symbol+'-5m-'+month+'.zip';}
export function validateMarkDataset(d,market,start=START,end=END){
 if(d?.version!=='binance-um-mark-v1'||d.symbol!==market.symbol||d.tf!==market.tf||d.start!==start||d.end!==end)throw Error('Unexpected mark identity/window');
 const step=Number(market.tf.slice(0,-1))*({m:60000,h:3600000,d:86400000}[market.tf.at(-1)]);
 if(!Number.isSafeInteger(step)||step<=0||step%dt||!Array.isArray(d.rows)||d.rows.length!==(end-start)/step)throw Error('Incomplete target mark coverage');
 const ms=months(start,end);
 if(!Array.isArray(d.archives)||d.archives.length!==ms.length||d.archives.some((a,i)=>a.month!==ms[i].month||a.url!==urlFor(market.symbol,ms[i].month)||! /^[a-f0-9]{64}$/.test(a.sha256)))throw Error('Incomplete mark provenance');
 for(let i=0;i<d.rows.length;i++){
  const r=d.rows[i],t=start+i*step;
  if(r.time!==t||r.closeTime!==t+step-1||[r.open,r.high,r.low,r.close].some(x=>!Number.isFinite(x)||x<=0)||r.low>Math.min(r.open,r.close)||r.high<Math.max(r.open,r.close)||r.low>r.high||r.volume!==0)throw Error('Invalid target mark row');
 }
 if(hashRows(d.rows)!==d.dataSha256)throw Error('Mark dataset checksum mismatch');
 return d;
}
async function bytes(url){
 let error;
 for(let i=0;i<3;i++){
  try{const r=await fetch(url,{signal:AbortSignal.timeout(60000),redirect:'error'});if(!r.ok)throw Error('HTTP '+r.status+' '+url);return Buffer.from(await r.arrayBuffer());}
  catch(e){error=e;if(i<2)await new Promise(r=>setTimeout(r,1000*(i+1)));}
 }
 throw error;
}
async function loadMonth(symbol,m,dir){
 const url=urlFor(symbol,m.month),name=url.split('/').at(-1);
 const [zip,checksum]=await Promise.all([bytes(url),bytes(url+'.CHECKSUM')]);
 const sha256=createHash('sha256').update(zip).digest('hex'),expected=checksum.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
 if(!/^[a-f0-9]{64}$/.test(expected)||expected!==sha256)throw Error('Mark ZIP checksum mismatch '+url);
 const path=join(dir,name);writeFileSync(path,zip);
 const csvName=name.replace(/\.zip$/,'.csv'),entries=execFileSync('unzip',['-Z1',path],{encoding:'utf8'}).trim().split(/\r?\n/);
 if(entries.length!==1||entries[0]!==csvName)throw Error('Unexpected mark ZIP contents');
 const rows=parseMarkMonth(execFileSync('unzip',['-p',path,csvName],{encoding:'utf8',maxBuffer:8*1024*1024}),m.start,m.end);
 return {rows,archive:{month:m.month,url,sha256}};
}
async function main(){
 const symbol=process.argv[2],market=markets.find(m=>m.symbol===symbol);if(!market)throw Error('Unknown enabled market');
 const dir=mkdtempSync(join(tmpdir(),'dca-mark-'));
 try{
  const rows=[],archives=[];
  for(const m of months()){
   const a=await loadMonth(symbol,m,dir);rows.push(...a.rows);archives.push(a.archive);
  }
  for(const a of audit.reports.filter(r=>r.symbol===symbol)){
   const row=rows[(a.time-START)/dt];
   if(!row||['time','closeTime','open','high','low','close'].some(k=>row[k]!==a.rows.mark[k]))throw Error('Monthly mark differs from checked daily archive');
  }
  const target=aggregate5m(rows,market.tf),data={version:'binance-um-mark-v1',symbol,tf:market.tf,start:START,end:END,archives,rows:target,dataSha256:hashRows(target)};
  validateMarkDataset(data,market);
  writeFileSync(process.argv[3],JSON.stringify(data));
  console.log('MARK_PREPARED '+JSON.stringify({symbol,tf:market.tf,bars:target.length,dataSha256:data.dataSha256,archives}));
 }finally{rmSync(dir,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
