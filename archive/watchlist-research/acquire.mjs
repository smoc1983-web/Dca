import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';import {inflateRawSync} from 'node:zlib';
import https from 'node:https';
const here=path.dirname(fileURLToPath(import.meta.url));
const windowsPS=path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const STEP=300000;
export async function publicFetch(url,options){
  let error;
  for(let attempt=0;attempt<4;attempt++){
    try{
      const response=await new Promise((resolve,reject)=>{
        const request=https.get(url,{agent:false,headers:{'Accept-Encoding':'identity'}},response=>{
          const chunks=[];let size=0;
          response.on('data',chunk=>{size+=chunk.length;if(size>50000000){request.destroy(Error('Public response too large'));return;}chunks.push(chunk);});
          response.on('error',reject);response.on('aborted',()=>reject(Error('Response aborted')));
          response.on('end',()=>{const data=Buffer.concat(chunks),status=response.statusCode;resolve({status,ok:status>=200&&status<300,text:async()=>data.toString('utf8'),arrayBuffer:async()=>data});});
        });
        request.setTimeout(30000,()=>request.destroy(Error('Public request timeout')));request.on('error',reject);
      });
      if(response.status===429||response.status>=500)throw Error('Retryable HTTP '+response.status);return response;
    }
    catch(e){error=e;await new Promise(r=>setTimeout(r,500*(attempt+1)));}
  }
  throw error;
}
function extractCsv(zip,name){
  let end=zip.length-22;for(;end>=Math.max(0,zip.length-65557);end--)if(zip.readUInt32LE(end)===0x06054b50)break;
  if(end<0)throw Error('ZIP directory missing');
  let at=zip.readUInt32LE(end+16);const count=zip.readUInt16LE(end+10);
  for(let i=0;i<count;i++){
    if(zip.readUInt32LE(at)!==0x02014b50)throw Error('Invalid ZIP directory');
    const length=zip.readUInt16LE(at+28),extra=zip.readUInt16LE(at+30),comment=zip.readUInt16LE(at+32);
    const file=zip.toString('utf8',at+46,at+46+length);
    if(file===name){
      const size=zip.readUInt32LE(at+24),compressed=zip.readUInt32LE(at+20),offset=zip.readUInt32LE(at+42),method=zip.readUInt16LE(at+10);
      if(size>50000000||zip.readUInt32LE(offset)!==0x04034b50)throw Error('Invalid ZIP entry');
      const start=offset+30+zip.readUInt16LE(offset+26)+zip.readUInt16LE(offset+28),data=zip.subarray(start,start+compressed);
      const result=method===8?inflateRawSync(data,{maxOutputLength:50000000}):method===0?data:null;
      if(!result||result.length!==size)throw Error('ZIP size/compression mismatch');return result;
    }
    at+=46+length+extra+comment;
  }
  throw Error('Expected CSV missing from ZIP');
}
export const watchlist=['BTCUSDT','SOLUSDT','UNIUSDT','ETHUSDT','XRPUSDT','ADAUSDT','NEARUSDT','ZECUSDT','LTCUSDT','LDOUSDT'];
export const extra=['BNBUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT','DOTUSDT','ATOMUSDT','TRXUSDT','BCHUSDT','AAVEUSDT','SUIUSDT'];
async function helper(request,cache){
  // Authoring-time downloader: public, credential-free endpoints only.
  // Runtime alerts continue to use the tested Windows PowerShell transport.
  if(request.operation==='archive'){
    const name=`${request.symbol}-5m-${request.month}.zip`,url=`https://data.binance.vision/data/spot/monthly/klines/${request.symbol}/5m/${name}`;
    const response=await publicFetch(url,{signal:AbortSignal.timeout(45000)});if(response.status===404)return {ok:true,notFound:true};if(!response.ok)throw Error('Archive HTTP '+response.status);
    const zip=Buffer.from(await response.arrayBuffer()),check=await publicFetch(url+'.CHECKSUM',{signal:AbortSignal.timeout(30000)});if(!check.ok)throw Error('Checksum HTTP '+check.status);
    const expected=(await check.text()).trim().split(/\s+/)[0];if(createHash('sha256').update(zip).digest('hex')!==expected)throw Error('Archive checksum mismatch');
    const csv=extractCsv(zip,name.replace(/\.zip$/,'.csv'));fs.writeFileSync(request.csvPath+'.tmp',csv);fs.renameSync(request.csvPath+'.tmp',request.csvPath);return {ok:true,verified:true};
  }
  if(request.operation==='rest'&&process.env.DCA_RESEARCH_NODE_REST==='1'){
    const url=new URL('https://data-api.binance.vision/api/v3/'+request.endpoint);for(const [key,value] of Object.entries(request.parameters))url.searchParams.set(key,value);
    const response=await publicFetch(url,{signal:AbortSignal.timeout(35000)});if(!response.ok)throw Error('Market HTTP '+response.status);fs.writeFileSync(request.output,await response.text());return {ok:true};
  }
  const id=crypto.randomUUID(),requestFile=path.join(cache,id+'.request.json');fs.writeFileSync(requestFile,JSON.stringify(request));
  try{return await new Promise((resolve,reject)=>{
    const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
    const child=spawn(windowsPS,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'public-data.ps1'),'-RequestFile',requestFile],{windowsHide:true,stdio:['ignore','pipe','ignore'],env});
    let out='';child.stdout.on('data',b=>out+=b.toString('utf8'));child.on('error',reject);
    child.on('close',()=>{try{const result=JSON.parse(out);if(!result.ok)throw Error('Public data: '+result.error);resolve(result);}catch(e){reject(e);}});
  });}finally{fs.rmSync(requestFile,{force:true});}
}
export async function rest(endpoint,parameters,cache){
  const output=path.join(cache,crypto.randomUUID()+'.response.json');
  try{await helper({operation:'rest',endpoint,parameters,output},cache);return JSON.parse(fs.readFileSync(output,'utf8'));}finally{fs.rmSync(output,{force:true});}
}
export function parseRows(text){
  const result=[];
  for(const line of text.trim().split(/\r?\n/)){
    const row=line.split(',');if(!/^\d+$/.test(row[0]))continue;
    let time=Number(row[0]);if(time>1e14)time=Math.floor(time/1000);
    result.push([time,...row.slice(1,5).map(Number)]);
  }
  return result;
}
async function month(symbol,ym,cache){
  const csvPath=path.join(cache,`${symbol}-5m-${ym}.csv`);
  if(fs.existsSync(csvPath))return parseRows(fs.readFileSync(csvPath,'utf8'));
  const zipPath=path.join(cache,`${symbol}-5m-${ym}.zip`);
  const answer=await helper({operation:'archive',symbol,month:ym,zipPath,csvPath},cache);
  if(!answer.notFound)return parseRows(fs.readFileSync(csvPath,'utf8'));
  const begin=Date.parse(ym+'-01T00:00:00Z'),date=new Date(begin);date.setUTCMonth(date.getUTCMonth()+1);
  const finish=Math.min(date.getTime(),Date.parse('2026-11-01T00:00:00Z'));
  let cursor=begin;const rows=[];
  while(cursor<finish){
    const batch=await rest('klines',{symbol,interval:'5m',startTime:cursor,endTime:Math.min(finish,cursor+1000*STEP)-1,limit:1000},cache);
    if(!Array.isArray(batch)||!batch.length)break;
    rows.push(...batch.map(r=>r.slice(0,5).map(Number)));cursor=Number(batch.at(-1)[0])+STEP;
  }
  if(rows.length)fs.writeFileSync(csvPath,rows.map(r=>r.join(',')).join('\n'));
  return rows;
}
export async function acquire(cache){
  fs.mkdirSync(cache,{recursive:true});
  const info=await rest('exchangeInfo',{},cache);fs.writeFileSync(path.join(cache,'exchange-info.json'),JSON.stringify(info));
  const symbols=[...watchlist,...extra],months=[];
  for(let t=Date.parse('2025-01-01T00:00:00Z');t<Date.parse('2026-11-01T00:00:00Z');){const d=new Date(t);months.push(d.toISOString().slice(0,7));d.setUTCMonth(d.getUTCMonth()+1);t=d.getTime();}
  const tasks=symbols.flatMap(symbol=>months.map(ym=>({symbol,ym}))),collected=new Map(symbols.map(s=>[s,[]]));let next=0,done=0;
  async function worker(){while(next<tasks.length){const {symbol,ym}=tasks[next++];try{collected.get(symbol).push(...await month(symbol,ym,cache));}catch(e){throw Error(symbol+' '+ym+': '+e.message);}done++;if(done%20===0)console.log(`Historical files ${done}/${tasks.length}`);}}
  await Promise.all(Array.from({length:12},worker));
  for(const symbol of symbols){
    const rows=collected.get(symbol).sort((a,b)=>a[0]-b[0]);
    const unique=rows.filter((r,i)=>!i||r[0]!==rows[i-1][0]);
    fs.writeFileSync(path.join(cache,symbol+'-5m.json'),JSON.stringify(unique));console.log(symbol,unique.length,'5m candles');
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))acquire(path.resolve(process.argv[2]??'cache')).catch(e=>{console.error(e.message);process.exitCode=1;});
