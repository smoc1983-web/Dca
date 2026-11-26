import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluatePortfolioMonth} from '../scripts/backtest-portfolio-month.mjs';
import {intervalMs} from '../cloudflare/watchlist-engine.mjs';
const markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
const a=1735689600000,b=a+7*86400000,c=a+31*86400000;
const fixture=()=>markets.map(m=>{
 const d=intervalMs(m.tf),p=m.params;
 return {tf:m.tf,window:{warmupStart:a,start:b,end:c},source:{kind:'synthetic',provider:'fixture',datasetId:m.symbol,retrievedAt:c,selectionCutoff:1794355200000,filterSource:'fixture'},params:Object.fromEntries(['symbol','initialCapital','fee','slippageBps','tick','qtyStep','minQty','minNotional'].map(k=>[k,p[k]])),candles:Array.from({length:(c-a)/d},(_,i)=>{const t=a+i*d,close=t===b?95:t===b+d?90:t===b+2*d?105:100;return {time:t,closeTime:t+d-1,open:close,high:close,low:close,close,volume:1};})};
});
test('portfolio matrix uses 800 shared across mixed timeframes, 12 scenarios',()=>{
 const r=evaluatePortfolioMonth(fixture(),{synthetic:true});
 assert.equal(r.reports.length,12);assert.equal(r.summaries.length,12);
 for(const s of r.summaries){assert.equal(s.initialCapital,800);assert.ok(s.peakActive<=s.maxCycles);assert.ok(s.minFree>=-1e-7);assert.ok(Math.abs(s.netMarkedPnl-s.realizedClosedPnl-s.openMarkedPnl)<1e-6);}
 assert.ok(r.limitations.includes('SELECTION_OVERLAP_NOT_OOS'));
});
test('reject missing markets, unexpected source and archive hash mismatch',()=>{
 const d=fixture();assert.throws(()=>evaluatePortfolioMonth(d.slice(1),{synthetic:true}),/All 19/);
 assert.throws(()=>evaluatePortfolioMonth(d),/Unexpected data kind/);
 d[0].source.kind='historical';assert.throws(()=>evaluatePortfolioMonth(d),/Pinned archive mismatch/);
});
