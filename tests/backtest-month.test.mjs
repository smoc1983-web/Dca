import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluateMonth} from '../scripts/backtest-month.mjs';
import {intervalMs} from '../cloudflare/watchlist-engine.mjs';
const markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
const a=1735689600000,b=a+7*86400000,c=a+31*86400000;
function fixture(){return markets.map(m=>{
 const d=intervalMs(m.tf),p=m.params;
 return {tf:m.tf,window:{warmupStart:a,start:b,end:c},source:{kind:'synthetic',provider:'fixture',datasetId:m.symbol,retrievedAt:c,selectionCutoff:1794355200000,filterSource:'fixture'},params:Object.fromEntries(['symbol','initialCapital','fee','slippageBps','tick','qtyStep','minQty','minNotional'].map(k=>[k,p[k]])),candles:Array.from({length:(c-a)/d},(_,i)=>{const t=a+i*d,close=t===b?95:t===b+d?90:t===b+2*d?105:100;return {time:t,closeTime:t+d-1,open:close,high:close,low:close,close,volume:1};})};
});}
test('fixed full month covers all pairs and four scenarios without OOS claims',()=>{
 const r=evaluateMonth(fixture());assert.equal(r.reports.length,76);assert.equal(r.summaries.length,4);assert.equal(r.manifests.length,19);
 assert.ok(r.summaries.every(s=>s.independentCapitalSum===15200&&s.markets===19));assert.ok(r.limitations.includes('SELECTION_OVERLAP_NOT_OOS'));
 assert.equal(r.kind,'synthetic');
});
test('incomplete universe, wrong timeframes and missing provenance fail closed',()=>{
 const d=fixture();assert.throws(()=>evaluateMonth(d.slice(1)),/All 19/);
 d[0].tf='30m';assert.throws(()=>evaluateMonth(d),/mismatch/);d[0].tf=markets[0].tf;
 d[0].source.kind='historical';assert.throws(()=>evaluateMonth(d),/provenance/);
});
