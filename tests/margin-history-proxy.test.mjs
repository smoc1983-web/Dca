import test from 'node:test';
import assert from 'node:assert/strict';
import {replayMarginProxy} from '../scripts/margin-history-proxy.mjs';
const dt=300000,start=dt,bar=(i,close,low=close)=>({time:i*dt,closeTime:(i+1)*dt-1,close,low});
const fixture=(low=100)=>{
 const datasets=[{params:{symbol:'BTCUSDT'},window:{warmupStart:0,start,end:4*dt},candles:[bar(0,100),bar(1,100),bar(2,100,low),bar(3,104)]}];
 const report={settings:{capital:800,maxCycles:5,cycleBudget:160,slippageBps:2},window:{start,end:4*dt},events:[{symbol:'BTCUSDT',kind:'START',time:2*dt-1,price:100,fillPrice:100,quantity:.05},{symbol:'BTCUSDT',kind:'TP',time:4*dt-1,price:104,fillPrice:104,quantity:.05}]};
 return {datasets,report};
};
test('fixed notional independent of leverage; scaled nominal distinct, fees and PnL reconcile',()=>{
 const run=(leverage,policy)=>replayMarginProxy({...fixture(),leverage,policy,fundingRate:0});
 const a=run(1,'fixed-notional'),b=run(3,'fixed-notional'),c=run(3,'scaled-notional');
 assert.equal(a.status,'completed-fixed-schedule');assert.equal(a.finalProxyEquity,b.finalProxyEquity);
 assert.equal(c.plannedStartNotional,15);assert.ok(Math.abs(c.finalProxyEquity-800-3*(a.finalProxyEquity-800))<1e-8);
 assert.equal(c.recommendationAllowed,false);assert.equal(c.liquidationPrice,null);
});
test('pre-fill low does not stress a position that has not been entered',()=>{
 const f=fixture();f.datasets[0].candles[1].low=1;
 const r=replayMarginProxy({...f,leverage:3,policy:'scaled-notional',fundingRate:0});assert.equal(r.status,'completed-fixed-schedule');
});
test('deep adverse low after full ladder stops before next scheduled fill',()=>{
 const f=fixture();f.datasets[0].candles=Array.from({length:9},(_,i)=>bar(i,i===8?1:100));f.report.window.end=9*dt;
 f.report.events=[{symbol:'BTCUSDT',kind:'START',time:2*dt-1,price:100,fillPrice:100,quantity:.05},...Array.from({length:5},(_,i)=>({symbol:'BTCUSDT',kind:'DCA'+(i+1),time:(i+3)*dt-1,price:100,fillPrice:100,quantity:5*1.5**(i+1)/100}))];
 const r=replayMarginProxy({...f,leverage:3,policy:'scaled-notional',fundingRate:0});
 assert.equal(r.status,'stopped-at-proxy-risk');assert.equal(r.finalProxyEquity,null);assert.equal(r.firstRisk.phase,'pre-fill-candle-low');
});
test('reject leverage above three and arbitrary assumptions',()=>{assert.throws(()=>replayMarginProxy({...fixture(),leverage:4,policy:'fixed-notional',fundingRate:0}),/Invalid proxy/);});
