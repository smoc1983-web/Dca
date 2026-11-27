// Public historical price audit only; preserve original spot candles, separate risk series.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {validateLongInput} from './prepare-long-target.mjs';
const dt=300000;
export const cases=[{symbol:'ATOMUSDT',time:Date.parse('2025-10-10T21:20:00Z')},{symbol:'ADAUSDT',time:Date.parse('2025-02-03T02:05:00Z')}];
export function parseDay(csv,day,kind){
 if(!['spot','trade','mark','index'].includes(kind))throw Error('Unknown series');
 const start=Date.parse(day+'T00:00:00Z');
 if(!Number.isSafeInteger(start)||new Date(start).toISOString().slice(0,10)!==day)throw Error('Invalid day');
 const lines=csv.trim().split(/\r?\n/);
 if(/^(open_time|open time|opentime),/i.test(lines[0]))lines.shift();
 if(lines.length!==288)throw Error('Incomplete daily coverage');
 return lines.map((line,i)=>{
  const a=line.split(',');
  const t=Number(a[0]),end=Number(a[6]),scale=kind==='spot'&&t>=1e15?1000:1;
  const time=start+i*dt,closeTime=time+dt-1;
  if(a.length!==12||!Number.isSafeInteger(t)||!Number.isSafeInteger(end)||t!==time*scale||end!==(time+dt)*scale-1)throw Error('Invalid or misaligned candle time');
  const [open,high,low,close]=a.slice(1,5).map(Number);
  if([open,high,low,close].some(x=>!Number.isFinite(x)||x<=0)||low>Math.min(open,close)||high<Math.max(open,close)||high<low)throw Error('Invalid candle OHLC');
  return {time,closeTime,open,high,low,close};
 });
}
export function compareCase(c,pinned,series){
 if(!Number.isSafeInteger(c.time)||c.time%dt!==0)throw Error('Unaligned case');
 const fields=['time','closeTime','open','high','low','close'];
 const rows={};
 for(const k of ['spot','trade','mark','index']){
  const hits=series[k]?.filter(r=>r.time===c.time);
  if(hits?.length!==1)throw Error('Missing or duplicated target '+k);
  rows[k]=hits[0];
 }
 if(!pinned||fields.some(k=>pinned[k]!==rows.spot[k]))throw Error('Pinned spot differs from daily archive');
 return {symbol:c.symbol,time:c.time,utc:new Date(c.time).toISOString(),rows,spotToMarkLowRatio:rows.spot.low/rows.mark.low,tradeToMarkLowRatio:rows.trade.low/rows.mark.low,liquidationPrice:null,recommendationAllowed:false};
}
async function bytes(url){
 const r=await fetch(url,{signal:AbortSignal.timeout(60000),redirect:'error'});
 if(!r.ok)throw Error('Public archive unavailable '+r.status+' '+url);
 return Buffer.from(await r.arrayBuffer());
}
async function archive(kind,symbol,day,dir){
 const type={spot:'spot/daily/klines',trade:'futures/um/daily/klines',mark:'futures/um/daily/markPriceKlines',index:'futures/um/daily/indexPriceKlines'}[kind];
 const name=symbol+'-5m-'+day+'.zip',url='https://data.binance.vision/data/'+type+'/'+symbol+'/5m/'+name;
 const [data,checksum]=await Promise.all([bytes(url),bytes(url+'.CHECKSUM')]);
 const hash=createHash('sha256').update(data).digest('hex'),expected=checksum.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
 if(!/^[a-f0-9]{64}$/.test(expected)||hash!==expected)throw Error('Archive checksum mismatch '+url);
 const path=join(dir,kind+'-'+name);writeFileSync(path,data);
 const entries=execFileSync('unzip',['-Z1',path],{encoding:'utf8'}).trim().split(/\r?\n/);
 const csvName=name.replace(/\.zip$/,'.csv');
 if(entries.length!==1||entries[0]!==csvName)throw Error('Unexpected archive contents '+url);
 const csv=execFileSync('unzip',['-p',path,csvName],{encoding:'utf8',maxBuffer:2*1024*1024});
 return {rows:parseDay(csv,day,kind),manifest:{kind,url,sha256:hash}};
}
async function main(){
 const dir=mkdtempSync(join(tmpdir(),'dca-price-audit-'));
 try{
  const reports=[];
  for(const c of cases){
   const input=JSON.parse(readFileSync(resolve(process.argv[2],c.symbol+'.json'),'utf8'));
   const {verified}=validateLongInput(input),pinned=verified.rows.find(r=>r.time===c.time);
   const day=new Date(c.time).toISOString().slice(0,10);
   const kinds=['spot','trade','mark','index'],results=await Promise.all(kinds.map(k=>archive(k,c.symbol,day,dir)));
   const result={...compareCase(c,pinned,Object.fromEntries(kinds.map((k,i)=>[k,results[i].rows]))),pinnedSha256:verified.dataSha256,archives:results.map(r=>r.manifest)};
   reports.push(result);console.log('PRICE_AUDIT '+JSON.stringify(result));
  }
  writeFileSync(process.argv[3],JSON.stringify({version:'price-audit-v1',reports,limitations:['DAILY_5M_OHLC_NOT_TICK_SEQUENCE','BINANCE_NOT_OTHER_VENUE','NO_EXCHANGE_LIQUIDATION_REPLAY']},null,2)+'\n');
 }finally{rmSync(dir,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
