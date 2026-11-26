import {readFileSync,writeFileSync} from 'node:fs';
import {auditSnapshot} from './spot-filter-audit.mjs';
const requested=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8')).filter(m=>m.enabled).map(m=>m.symbol).sort();
const base='https://data-api.binance.vision/api/v3/';
async function get(path){
 const url=new URL(path,base);url.searchParams.set('symbols',JSON.stringify(requested));
 const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error(path+' HTTP '+r.status);
 return r.json();
}
try{
 const info=await get('exchangeInfo'),prices=await get('ticker/price'),capturedAt=Date.now();
 const report=auditSnapshot({symbols:info.symbols,prices,requested,capturedAt});
 writeFileSync('spot-filter-audit.json',JSON.stringify({report,raw:{info,prices}},null,2));
 for(const row of report.rows)console.log('SPOT_FILTER '+JSON.stringify(row));
 console.log('SNAPSHOT_TIME '+capturedAt);
}catch(e){console.error('Public snapshot unavailable: '+e.message);process.exitCode=2;}
