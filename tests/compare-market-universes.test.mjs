import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compareMarketUniverses} from '../scripts/compare-market-universes.mjs';
import {intervalMs} from '../cloudflare/watchlist-engine.mjs';
const markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
const a=1735689600000,b=a+7*86400000,c=a+31*86400000;
const fixture=()=>markets.map(m=>{
 const d=intervalMs(m.tf),p=m.params;
 return {tf:m.tf,window:{warmupStart:a,start:b,end:c},source:{kind:'synthetic',provider:'fixture',datasetId:m.symbol,retrievedAt:c,selectionCutoff:1794355200000,filterSource:'fixture'},params:Object.fromEntries(['symbol','initialCapital','fee','slippageBps','tick','qtyStep','minQty','minNotional'].map(k=>[k,p[k]])),candles:Array.from({length:(c-a)/d},(_,i)=>{const t=a+i*d,close=t===b?95:t===b+d?90:t===b+2*d?105:100;return {time:t,closeTime:t+d-1,open:close,high:close,low:close,close,volume:1};})};
});
test('same 800 deposit, 12 paired scenarios and shared candle hashes',()=>{
 const r=compareMarketUniverses(fixture(),{synthetic:true});
 assert.equal(r.comparisons.length,12);assert.equal(r.reports.length,24);assert.equal(r.selected.length,11);assert.equal(r.excluded.length,8);
 for(let i=0;i<24;i+=2){const a=r.reports[i].report,b=r.reports[i+1].report;
  assert.deepEqual(a.settings,b.settings);assert.deepEqual(a.window,b.window);
  assert.equal(a.datasets.length,19);assert.equal(b.datasets.length,11);
  for(const d of b.datasets)assert.equal(d.dataSha256,a.datasets.find(x=>x.symbol===d.symbol).dataSha256);
  assert.ok(b.events.every(e=>r.selected.includes(e.symbol)));
  assert.ok(a.metrics.minFree>=-1e-7&&b.metrics.minFree>=-1e-7);
 }
 for(const c of r.comparisons){assert.equal(c.delta.finalEquity,c.reduced.finalMarkedEquity-c.original.finalMarkedEquity);assert.equal(c.original.initialCapital,800);assert.equal(c.reduced.initialCapital,800);}
});
test('missing excluded dataset or mismatched data kind still rejects comparison',()=>{
 const d=fixture();assert.throws(()=>compareMarketUniverses(d.slice(1),{synthetic:true}),/All 19/);assert.throws(()=>compareMarketUniverses(d),/Unexpected data kind/);
});
