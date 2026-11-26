import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {backtestMatrix,EARLIEST_DECLARED_CUTOFF} from '../scripts/backtest-matrix.mjs';
import {intervalMs} from '../cloudflare/watchlist-engine.mjs';
const markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
const day=86400000,cutoff=EARLIEST_DECLARED_CUTOFF;
const periods=[{id:'train',start:cutoff-3*day,end:cutoff-2*day},{id:'validation',start:cutoff-2*day,end:cutoff-day},{id:'oos',start:cutoff+day,end:cutoff+2*day}];
function fixture(){
 const datasets=markets.map(m=>{
  const d=intervalMs(m.tf),start=periods[0].start-200*d,end=periods[2].end;
  const candles=Array.from({length:(end-start)/d},(_,i)=>{
   const t=start+i*d;let close=100;
   for(const p of periods){if(t===p.start)close=95;else if(t===p.start+d)close=90;else if(t===p.start+2*d)close=105;}
   return {time:t,closeTime:t+d-1,open:close,high:close,low:close,close,volume:100};
  });
  const p=m.params;
  return {tf:m.tf,params:{symbol:m.symbol,initialCapital:p.initialCapital,fee:p.fee,slippageBps:0,tick:p.tick,qtyStep:p.qtyStep,minQty:p.minQty,minNotional:p.minNotional},window:{warmupStart:start,start:periods[0].start,end},
   source:{kind:'synthetic',provider:'fixture',datasetId:m.symbol,retrievedAt:end,selectionCutoff:cutoff,filterSource:'frozen fixture'},candles};
 });
 return {datasets,periods:structuredClone(periods),selectionCutoff:cutoff,warmupBars:200};
}
test('all 19 pairs, three periods and four slippage cases, no hidden losses',()=>{
 const r=backtestMatrix(fixture());
 assert.equal(r.results.length,228);assert.equal(r.summaries.length,12);
 assert.deepEqual(r.slippageBps,[0,2,5,10]);assert.equal(r.frozenMarkets.length,19);
 for(const s of r.summaries){assert.equal(s.markets,19);assert.equal(s.independentCapitalSum,15200);}
 assert.equal(r.mode,'independent-spot-accounts');assert.equal(r.kind,'synthetic');
 assert.ok(r.limitations.includes('NO_SHARED_CAPITAL'));
});
test('deterministic result regardless of input order',()=>{
 const f=fixture(),a=backtestMatrix(f);f.datasets.reverse();assert.deepEqual(backtestMatrix(f),a);
});
test('missing, duplicate, unknown markets and parameter changes rejected',()=>{
 const f=fixture();assert.throws(()=>backtestMatrix({...f,datasets:f.datasets.slice(1)}),/All 19/);
 const dup=[...f.datasets.slice(1),f.datasets[1]];assert.throws(()=>backtestMatrix({...f,datasets:dup}),/duplicate/);
 f.datasets[0].tf='15m';assert.throws(()=>backtestMatrix(f),/parameters mismatch/);
 f.datasets[0].tf=markets[0].tf;f.datasets[0].params.fee=.002;assert.throws(()=>backtestMatrix(f),/parameters mismatch/);
});
test('chronology, alignment, overlap and known selection cutoff are enforced',()=>{
 const f=fixture();assert.throws(()=>backtestMatrix({...f,selectionCutoff:cutoff-day}),/predates/);
 const p=structuredClone(periods);p[1].start=p[0].start;assert.throws(()=>backtestMatrix({...f,periods:p}),/Overlapping/);
 const q=structuredClone(periods);q[2].start=cutoff;assert.throws(()=>backtestMatrix({...f,periods:q}),/OOS/);
 const a=structuredClone(periods);a[2].start+=300000;assert.throws(()=>backtestMatrix({...f,periods:a}),/align/);
});
test('full data checksum and gaps outside selected periods are checked',()=>{
 const f=fixture();f.datasets[0].source.expectedSha256='bad';assert.throws(()=>backtestMatrix(f),/checksum/);
 delete f.datasets[0].source.expectedSha256;const c=f.datasets[0].candles.find(x=>x.time===cutoff);c.time+=1;assert.throws(()=>backtestMatrix(f),/gap/);
});
test('future data changes cannot change earlier evaluation reports',()=>{
 const f=fixture(),a=backtestMatrix(f),c=f.datasets[0].candles.at(-1);Object.assign(c,{open:70,high:70,low:70,close:70});
 const b=backtestMatrix(f);
 assert.notEqual(a.manifests[0].fullDataSha256,b.manifests[0].fullDataSha256);
 assert.deepEqual(a.results.filter(x=>x.period==='train'),b.results.filter(x=>x.period==='train'));
});
test('each period starts flat; same data for cost scenarios and explicit historical caveat',()=>{
 const f=fixture(),r=backtestMatrix(f),group=r.results.filter(x=>x.symbol==='ADAUSDT'&&x.period==='train');
 assert.equal(new Set(group.map(x=>x.report.dataSha256)).size,1);
 assert.equal(new Set(group.map(x=>x.report.paramsSha256)).size,4);
 assert.ok(r.results.every(x=>x.report.metrics.initialCapital===800&&x.report.warmupBars===200));
 f.datasets[0].source.kind='historical';assert.throws(()=>backtestMatrix(f),/Mixed/);
});
test('insufficient coverage fails instead of silently dropping a period or market',()=>{
 const f=fixture();const d=f.datasets[0];d.candles.pop();d.window.end-=intervalMs(d.tf);
 assert.throws(()=>backtestMatrix(f),/Insufficient period coverage/);
});
