import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {backtestSpot} from '../scripts/backtest-spot.mjs';
const script=fileURLToPath(new URL('../scripts/import-binance-spot.py',import.meta.url));
const day=86400000;
const zipCode=`import sys,zipfile
from pathlib import Path
p=Path(sys.argv[1])
with zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr(sys.argv[2],sys.stdin.read())
`;
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'dca-import-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function archive(dir,date,{tf='5m',unit=undefined,drop=-1,wrongMember=false}={}){
 const name='ADAUSDT-'+tf+'-'+date+'.zip',path=join(dir,name),start=Date.parse(date+'T00:00:00Z'),d=tf==='15m'?900000:300000,factor=unit??(date>='2025-01-01'?1000:1);
 const csv=Array.from({length:day/d},(_,i)=>{const t=start+i*d,v=100+i%4;return [t*factor,v,v+2,v-2,v+1,10,(t+d)*factor-1,0,1,0,0,0].join(',');}).filter((_,i)=>i!==drop).join('\n')+'\n';
 const z=spawnSync('python3',['-c',zipCode,path,wrongMember?'wrong.csv':name.slice(0,-4)+'.csv'],{input:csv,encoding:'utf8'});assert.equal(z.status,0,z.stderr);
 return {file:name,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};
}
function conf(archives,a,c,tf='5m'){return {symbol:'ADAUSDT',tf,archives,window:{warmupStart:a,start:a+200*(tf==='45m'?2700000:300000),end:c},retrievedAt:c,selectionCutoff:a,filterSource:'synthetic fixture',params:{symbol:'ADAUSDT',initialCapital:800,fee:.001,slippageBps:0,tick:.001,qtyStep:.001,minQty:.001,minNotional:1}};}
function run(dir,c){const path=join(dir,'config.json');writeFileSync(path,JSON.stringify(c));return spawnSync('python3',[script,path],{encoding:'utf8',maxBuffer:16*1024*1024});}
function success(dir,c){const r=run(dir,c);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function fail(dir,c,pattern){const r=run(dir,c);assert.notEqual(r.status,0);assert.match(r.stderr,pattern);}
test('mixed historical timestamp units normalize exactly and import into spot backtest',t=>{
 const d=fixture(t),a=Date.parse('2024-12-31T00:00:00Z'),c=a+2*day;
 const x=conf([archive(d,'2024-12-31'),archive(d,'2025-01-01')],a,c),r=success(d,x);
 assert.equal(r.candles.length,576);assert.equal(r.candles[288].time,a+day);assert.equal(r.candles[288].closeTime,a+day+299999);
 assert.deepEqual(r.archiveManifest.archives.map(m=>m.timestampUnit),['ms','us']);
 assert.match(r.archiveManifestSha256,/^[a-f0-9]{64}$/);
 assert.equal(backtestSpot(r).evaluationBars,376);assert.deepEqual(success(d,x),r);
});
test('pinned ZIP checksum required and mismatches fail closed',t=>{
 const d=fixture(t),a=Date.parse('2025-01-01T00:00:00Z'),x=conf([archive(d,'2025-01-01')],a,a+day);
 x.archives[0].sha256='0'.repeat(64);fail(d,x,/checksum mismatch/);delete x.archives[0].sha256;fail(d,x,/sha256/);
});
test('incorrect timestamp unit and missing candle rejected',t=>{
 const d=fixture(t),a=Date.parse('2025-01-01T00:00:00Z');
 fail(d,conf([archive(d,'2025-01-01',{unit:1})],a,a+day),/timestamp unit/);
 fail(d,conf([archive(d,'2025-01-01',{drop:12})],a,a+day),/gap/);
});
test('archive gap and overlap are rejected rather than sorted or filled',t=>{
 const d=fixture(t),a=Date.parse('2025-01-01T00:00:00Z'),f=archive(d,'2025-01-01'),g=archive(d,'2025-01-03');
 fail(d,conf([f,g],a,a+3*day),/gap or overlap/);
 fail(d,conf([f,f],a,a+day),/gap or overlap/);
});
test('45m aggregates exactly three contiguous 15m candles',t=>{
 const d=fixture(t),a=Date.parse('2025-01-01T00:00:00Z'),files=Array.from({length:7},(_,i)=>archive(d,'2025-01-0'+(i+1),{tf:'15m'}));
 const x=conf(files,a,a+7*day,'45m'),r=success(d,x);
 assert.equal(r.candles.length,224);assert.deepEqual(r.candles[0],{time:a,closeTime:a+2700000-1,open:100,high:104,low:98,close:103,volume:30});
 assert.equal(backtestSpot(r).evaluationBars,24);
});
test('unexpected ZIP members, future archive and invalid windows rejected',t=>{
 const d=fixture(t),a=Date.parse('2025-01-01T00:00:00Z');
 fail(d,conf([archive(d,'2025-01-01',{wrongMember:true})],a,a+day),/Unexpected ZIP member/);
 const f=archive(d,'2025-01-01'),x=conf([f],a,a+day);
 fail(d,{...x,retrievedAt:a+day-1},/closed window/);
 fail(d,{...x,window:{...x.window,end:a+day-300000},retrievedAt:a+day-1},/beyond retrieval/);
});
test('missing requested coverage and parameter mismatch fail',t=>{
 const d=fixture(t),a=Date.parse('2025-01-01T00:00:00Z'),f=archive(d,'2025-01-01'),x=conf([f],a,a+day);
 fail(d,conf([f],a,a+2*day),/requested coverage/);
 fail(d,{...x,params:{...x.params,symbol:'BTCUSDT'}},/symbol mismatch/);
});
