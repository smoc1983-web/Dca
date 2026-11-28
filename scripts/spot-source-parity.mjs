// Offline source parity gate. No network, no credentials, no production writes.
// Exact OHLC comparison for Binance Spot, not generic BTC/USDT or futures.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const STEP=300000,DAY=86400000;
const registry=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
const symbols=registry.map(m=>m.symbol).sort();
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fields=['time','closeTime','open','high','low','close'];
export function compareSpotSources({start,end,reference,candidate,now}={}){
 if(![start,end,now].every(Number.isSafeInteger)||start<0||start%DAY||end%DAY||end-start!==7*DAY||end>now)throw Error('Require seven complete UTC days');
 const count=(end-start)/STEP;
 function validate(dataset){
  if(dataset?.venue!=='BINANCE'||dataset.market!=='SPOT'||dataset.interval!=='5m'||dataset.start!==start||dataset.end!==end||!Array.isArray(dataset.series)||dataset.series.length!==symbols.length)throw Error('Invalid source coverage or identity');
  const map=new Map();
  for(const s of dataset.series){
   if(!symbols.includes(s.symbol)||map.has(s.symbol)||!Array.isArray(s.rows)||s.rows.length!==count)throw Error('Missing, duplicate or incomplete symbol series');
   const rows=s.rows.map((r,i)=>{
    const time=start+i*STEP;
    if(r?.time!==time||r.closeTime!==time+STEP-1||!fields.slice(2).every(k=>typeof r[k]==='number'&&Number.isFinite(r[k])&&r[k]>0)||r.low>Math.min(r.open,r.close)||r.high<Math.max(r.open,r.close)||r.low>r.high)throw Error('Invalid, missing or noncontiguous candle '+s.symbol+' '+time);
    return fields.map(k=>r[k]);
   });
   map.set(s.symbol,rows);
  }
  return map;
 }
 const a=validate(reference),b=validate(candidate),rows=[];
 for(const symbol of symbols){
  const x=a.get(symbol),y=b.get(symbol);let mismatches=0,firstMismatch=null;
  for(let i=0;i<count;i++){
   const differences=fields.filter((_,j)=>x[i][j]!==y[i][j]);
   if(differences.length){mismatches++;if(!firstMismatch)firstMismatch={time:x[i][0],fields:differences};}
  }
  rows.push({symbol,compared:count,mismatches,firstMismatch,referenceSha256:digest(x),candidateSha256:digest(y)});
 }
 const mismatchCount=rows.reduce((n,r)=>n+r.mismatches,0);
 return {version:'spot-source-parity-v1',start,end,interval:'5m',venue:'BINANCE',market:'SPOT',symbols:rows.length,compared:count*rows.length,mismatchCount,status:mismatchCount?'mismatch':'exact-match-in-sample',rows,authorizationVerified:false,liveFreshnessVerified:false,productionAllowed:false};
}
