import test from 'node:test';
import assert from 'node:assert/strict';
import {backtestSpot} from '../scripts/backtest-spot.mjs';
const dt=300000,warm=250;
const params={symbol:'ADAUSDT',initialCapital:800,fee:.001,slippageBps:0,tick:.001,qtyStep:.001,minQty:.001,minNotional:1};
function input(prices=[95,90,105],extra={}){
 const candles=[...Array(warm).fill(100),...prices].map((close,i)=>({time:i*dt,closeTime:(i+1)*dt-1,open:close,high:close,low:close,close,volume:100}));
 const end=candles.length*dt;
 return {candles,tf:'5m',params:{...params},window:{warmupStart:0,start:warm*dt,end},source:{kind:'synthetic',provider:'test fixture',datasetId:'constant-drop-rise',retrievedAt:end,selectionCutoff:0,filterSource:'synthetic'},...extra};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,String(a)+' != '+String(b));
test('warmup without orders, known START DCA TP and reconciled cash',()=>{
 const r=backtestSpot(input());assert.deepEqual(r.events.map(e=>e.kind),['START','DCA1','TP']);
 assert.equal(r.warmupBars,250);assert.equal(r.metrics.closedCount,1);assert.equal(r.openPosition,null);
 near(r.metrics.realizedClosedPnl,r.metrics.netMarkedPnl);
 near(r.metrics.finalCash,800+r.events.reduce((s,e)=>s+e.cashDelta,0));
 assert.equal(r.metrics.winRatePercent,100);assert.equal(r.metrics.profitFactor,null);
});
test('open position marked separately, not counted as realized closed profit',()=>{
 const r=backtestSpot(input([95,90]));assert.equal(r.metrics.closedCount,0);assert.equal(r.metrics.realizedClosedPnl,0);
 assert.ok(r.openPosition.quantity>0);near(r.openPosition.netMarkedPnl,r.metrics.netMarkedPnl);
 assert.ok(r.openPosition.estimatedNetExitPnl<r.openPosition.netMarkedPnl);assert.equal(r.metrics.winRatePercent,null);
});
test('same data and parameters produce byte-identical report and verified hash',()=>{
 const x=input(),a=backtestSpot(x),b=backtestSpot({...x,source:{...x.source,expectedSha256:a.dataSha256}});
 assert.deepEqual(a,b);assert.match(a.dataSha256,/^[0-9a-f]{64}$/);
 assert.throws(()=>backtestSpot({...x,source:{...x.source,expectedSha256:'wrong'}}),/checksum/);
});
test('future candles cannot change past executions',()=>{
 const a=backtestSpot(input([95,90])),b=backtestSpot(input([95,90,105]));
 assert.deepEqual(a.events,b.events.slice(0,a.events.length));assert.notEqual(a.dataSha256,b.dataSha256);
});
test('fees and slippage affect fill prices and profit without changing strategy parameters',()=>{
 const a=backtestSpot(input()),x=input();x.params.slippageBps=10;const b=backtestSpot(x);
 assert.ok(b.events[0].fillPrice>a.events[0].fillPrice);assert.ok(b.metrics.netMarkedPnl<a.metrics.netMarkedPnl);assert.notEqual(a.paramsSha256,b.paramsSha256);
 assert.equal(a.dataSha256,b.dataSha256);
});
test('reject missing duplicate malformed and unclosed bars',()=>{
 const x=input();assert.throws(()=>backtestSpot({...x,candles:x.candles.slice(1)}),/coverage/);
 const bad=x.candles.map(c=>({...c}));bad[1]=bad[0];assert.throws(()=>backtestSpot({...x,candles:bad}),/gap/);
 const malformed=x.candles.map(c=>({...c}));malformed[0].high=99;assert.throws(()=>backtestSpot({...x,candles:malformed}),/OHLC/);
 assert.throws(()=>backtestSpot({...x,source:{...x.source,retrievedAt:x.window.end-1}}),/future/);
});
test('strict parameters and warmup; historical label is not verified independence',()=>{
 const x=input();assert.throws(()=>backtestSpot({...x,params:{...params,rsiLevel:40}}),/Unsupported/);
 assert.throws(()=>backtestSpot({...x,window:{...x.window,start:100*dt}}),/warmup/);
 assert.equal(backtestSpot({...x,source:{...x.source,kind:'historical',selectionCutoff:x.window.start}}).dataStatus,'selection-overlap');
 assert.equal(backtestSpot({...x,source:{...x.source,kind:'historical'}}).dataStatus,'post-declared-selection-cutoff-unverified');
});
test('flat market no fabricated trades and fixed capital scaling',()=>{
 const x=input([100,100,100]);x.params.initialCapital=400;const r=backtestSpot(x);
 assert.equal(r.events.length,0);assert.equal(r.metrics.finalMarkedEquity,400);assert.equal(r.params.baseCash,12.5);assert.equal(r.metrics.maxCloseDrawdownPercent,0);
});
