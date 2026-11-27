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
export function parseMarkMonth(csv,start,end,{allowMissing=false}={}){
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start%dt||end%dt||end<=start)throw Error('Invalid mark window');
 const lines=csv.trim().split(/\r?\n/);
 if(/^(open_time|open time|opentime),/i.test(lines[0]))lines.shift();
 if(!allowMissing&&lines.length!==(end-start)/dt)throw Error('Incomplete mark coverage: '+lines.length+' of '+(end-start)/dt);
 let previous=start-dt;
 return lines.map(line=>{
  const a=line.split(','),time=Number(a[0]),closeTime=time+dt-1;
  if(a.length!==12||!Number.isSafeInteger(time)||time<start||time>=end||time%dt||time<=previous||Number(a[6])!==closeTime||!allowMissing&&time!==previous+dt)throw Error('Mark gap, duplicate or timestamp units');
  previous=time;
  const [open,high,low,close]=a.slice(1,5).map(Number);
  if([open,high,low,close].some(x=>!Number.isFinite(x)||x<=0)||low>Math.min(open,close)||high<Math.max(open,close)||low>high)throw Error('Invalid mark OHLC');
  return {time,closeTime,open,high,low,close,volume:0};
 });
}
const dayMs=86400000;
export function urlFor(symbol,period,daily=false){return 'https://data.binance.vision/data/futures/um/'+(daily?'daily':'monthly')+'/markPriceKlines/'+symbol+'/5m/'+symbol+'-5m-'+period+'.zip';}
export function missingDays(rows,start,end){
 const seen=new Set(rows.map(r=>r.time)),days=[];
 for(let t=start;t<end;t+=dt)if(!seen.has(t)){
  const day=new Date(t).toISOString().slice(0,10);
  if(days.at(-1)!==day)days.push(day);
 }
 return days;
}
export function mergeMarkDay(map,rows,start,end){
 if(rows.length!==(end-start)/dt)throw Error('Incomplete daily repair');
 for(let i=0;i<rows.length;i++){
  const r=rows[i],t=start+i*dt;
  if(r.time!==t||r.closeTime!==t+dt-1)throw Error('Misaligned daily repair');
  const prev=map.get(t);
  if(prev&&['time','closeTime','open','high','low','close'].some(k=>prev[k]!==r[k]))throw Error('Monthly/daily mark conflict '+new Date(t).toISOString());
 }
 for(const r of rows)map.set(r.time,r);
}
function validArchive(a,m,symbol){
 if(a.month!==m.month||a.url!==urlFor(symbol,m.month)||! /^[a-f0-9]{64}$/.test(a.sha256))return false;
 if(a.missingRows===undefined)return a.dailyRepairs===undefined; // complete legacy manifest
 if(!Number.isSafeInteger(a.missingRows)||a.missingRows<0||a.missingRows>(m.end-m.start)/dt||!Array.isArray(a.dailyRepairs))return false;
 const days=a.dailyRepairs.map(x=>x.day);
 if((a.missingRows===0)!==(days.length===0)||days.length>a.missingRows||a.missingRows>days.length*288||new Set(days).size!==days.length)return false;
 return a.dailyRepairs.every((r,i)=>typeof r.day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(r.day)&&Date.parse(r.day+'T00:00:00Z')>=m.start&&Date.parse(r.day+'T00:00:00Z')<m.end&&(!i||days[i-1]<r.day)&&r.url===urlFor(symbol,r.day,true)&&/^[a-f0-9]{64}$/.test(r.sha256));
}
export function validateMarkDataset(d,market,start=START,end=END){
 if(d?.version!=='binance-um-mark-v1'||d.symbol!==market.symbol||d.tf!==market.tf||d.start!==start||d.end!==end)throw Error('Unexpected mark identity/window');
 const step=Number(market.tf.slice(0,-1))*({m:60000,h:3600000,d:86400000}[market.tf.at(-1)]);
 if(!Number.isSafeInteger(step)||step<=0||step%dt||!Array.isArray(d.rows)||d.rows.length!==(end-start)/step)throw Error('Incomplete target mark coverage');
 const ms=months(start,end);
 if(!Array.isArray(d.archives)||d.archives.length!==ms.length||d.archives.some((a,i)=>!validArchive(a,ms[i],market.symbol)))throw Error('Incomplete mark provenance');
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
export async function loadArchive(url,dir){
 const name=url.split('/').at(-1);
 const [zip,checksum]=await Promise.all([bytes(url),bytes(url+'.CHECKSUM')]);
 const sha256=createHash('sha256').update(zip).digest('hex');
 const entry=/^([a-fA-F0-9]{64})[ \t]+\*?([^\s]+)$/.exec(checksum.toString('utf8').trim());
 if(!entry||entry[1].toLowerCase()!==sha256||entry[2]!==name)throw Error('Mark ZIP checksum mismatch '+url);
 const path=join(dir,name);writeFileSync(path,zip);
 const csvName=name.replace(/\.zip$/,'.csv'),entries=execFileSync('unzip',['-Z1',path],{encoding:'utf8'}).trim().split(/\r?\n/);
 if(entries.length!==1||entries[0]!==csvName)throw Error('Unexpected mark ZIP contents');
 const csv=execFileSync('unzip',['-p',path,csvName],{encoding:'utf8',maxBuffer:8*1024*1024});
 return {csv,url,sha256};
}
async function loadMonth(symbol,m,dir){
 const a=await loadArchive(urlFor(symbol,m.month),dir);
 const rows=parseMarkMonth(a.csv,m.start,m.end,{allowMissing:true});
 const missingRows=(m.end-m.start)/dt-rows.length,days=missingDays(rows,m.start,m.end),dailyRepairs=[];
 console.log('MARK_MONTH '+JSON.stringify({symbol,month:m.month,actual:rows.length,expected:(m.end-m.start)/dt,missingRows,days,sha256:a.sha256}));
 if(missingRows){
  const map=new Map(rows.map(r=>[r.time,r]));
  for(const day of days){
   const start=Date.parse(day+'T00:00:00Z'),d=await loadArchive(urlFor(symbol,day,true),dir);
   try{mergeMarkDay(map,parseMarkMonth(d.csv,start,start+dayMs),start,start+dayMs);}
   catch(e){throw Error('Daily repair failed '+symbol+' '+day+': '+e.message);}
   dailyRepairs.push({day,url:d.url,sha256:d.sha256});
  }
  rows.length=0;for(let t=m.start;t<m.end;t+=dt){if(!map.has(t))throw Error('Unrepaired mark gap '+symbol+' '+new Date(t).toISOString());rows.push(map.get(t));}
 }
 return {rows,archive:{month:m.month,url:a.url,sha256:a.sha256,missingRows,dailyRepairs}};
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
