import test from 'node:test';
import assert from 'node:assert/strict';
import {backtestPortfolio} from '../scripts/backtest-portfolio.mjs';
const dt=300000,w=250;
function input(symbol,prices=[95,90,105],opts={}){
 const d=opts.dt??dt,start=w*dt,end=start+prices.length*dt;
 const warm=start-250*d;
 const candles=Array.from({length:(end-warm)/d},(_,i)=>{const t=warm+i*d,close=t<start?100:(prices[Math.floor((t-start)/dt)]??100);return {time:t,closeTime:t+d-1,open:close,high:close,low:close,close,volume:100};});
 return {tf:opts.tf??'5m',window:{warmupStart:warm,start,end},params:{symbol,initialCapital:800,fee:.001,slippageBps:0,tick:.001,qtyStep:.001,minQty:.001,minNotional:1},source:{kind:'synthetic',provider:'fixture',datasetId:symbol,retrievedAt:end,selectionCutoff:0,filterSource:'fixture'},candles};
}
const run=(datasets,o={})=>backtestPortfolio({datasets,capital:800,maxCycles:1,slippageBps:0,...o});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,String(a)+' != '+String(b));
test('simultaneous signals use one shared balance and deterministic priority',()=>{
 const r=run([input('BTCUSDT'),input('ADAUSDT')]);assert.equal(r.events[0].symbol,'ADAUSDT');
 assert.deepEqual(r.events.map(e=>e.kind),['START','DCA1','TP']);assert.equal(r.rejected[0].symbol,'BTCUSDT');assert.equal(r.rejected[0].reason,'MAX_ACTIVE_CYCLES');
 assert.equal(r.metrics.peakActive,1);assert.ok(r.metrics.minFree>=0);near(r.metrics.finalCash,r.metrics.finalMarkedEquity);near(r.metrics.netMarkedPnl,r.metrics.realizedClosedPnl);
});
test('three concurrent slots scale full ladder without multiplying capital',()=>{
 const r=run(['ADAUSDT','BTCUSDT','ETHUSDT','SOLUSDT'].map(s=>input(s,[95,90])),{maxCycles:3});
 assert.equal(r.metrics.peakActive,3);assert.equal(r.openPositions.length,3);assert.equal(r.rejected.length,1);assert.ok(r.metrics.remainingReserve>0);
 assert.ok(r.events.every(e=>e.cashAfter+1e-7>=e.reserveAfter));near(r.metrics.netMarkedPnl,r.metrics.openMarkedPnl);
 assert.equal(r.settings.cycleBudget,266.66666666);
});
test('permutation does not affect the result; future candles cannot alter prior events',()=>{
 const a=input('ADAUSDT'),b=input('BTCUSDT');assert.deepEqual(run([a,b]),run([b,a]));
 const short=run([input('ADAUSDT',[95,90])]);assert.deepEqual(short.events,run([a]).events.slice(0,short.events.length));
});
test('one slot agrees with independent engine on fees and equity',async()=>{
 const {backtestSpot}=await import('../scripts/backtest-spot.mjs');const a=input('ADAUSDT');
 const r=run([a]),s=backtestSpot(a);near(r.metrics.finalMarkedEquity,s.metrics.finalMarkedEquity);near(r.metrics.fees,s.metrics.paidFees);
});
test('exit at same timestamp frees slot before new START',()=>{
 const a=input('ADAUSDT',[95,105,105]),b=input('BTCUSDT',[100,95,105]);
 const r=run([b,a]);assert.deepEqual(r.events.map(e=>e.symbol+':'+e.kind),['ADAUSDT:START','ADAUSDT:TP','BTCUSDT:START','BTCUSDT:TP']);
 assert.equal(r.rejected.length,0);
});
test('reserve remains when cycle open and deposit is never duplicated',()=>{
 const r=run([input('ADAUSDT',[95])]);assert.ok(r.metrics.remainingReserve>490);assert.equal(r.metrics.closedCount,0);
 near(r.metrics.finalFreeCash,r.metrics.finalCash-r.metrics.remainingReserve);near(r.metrics.netMarkedPnl,r.metrics.openMarkedPnl);
});
test('wrong inputs and corrupted datasets fail closed',()=>{
 assert.throws(()=>run([input('ADAUSDT')],{maxCycles:20}),/settings/);
 assert.throws(()=>run([input('ADAUSDT'),input('ADAUSDT')]),/Duplicate/);
 assert.throws(()=>run([input('ADAUSDT'),input('BTCUSDT',[95])]),/unequal/);
 const x=input('ADAUSDT');x.candles[2].time++;assert.throws(()=>run([x]),/gap/);
});
test('fees and slippage are reflected in shared cash',()=>{
 const a=input('ADAUSDT');const r=run([a]),s=run([a],{slippageBps:10});assert.ok(s.metrics.netMarkedPnl<r.metrics.netMarkedPnl);
 near(s.metrics.finalCash,800+s.events.reduce((n,e)=>n+e.cashDelta,0));
});
