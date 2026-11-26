import test from 'node:test';
import assert from 'node:assert/strict';
import {createBudget,reserveCycle} from '../cloudflare/portfolio-budget.mjs';
import {reconcileManualCycle} from '../cloudflare/manual-cycle.mjs';
const s=createBudget({policy:'equal-slots-v1',capital:'800',freeCash:'800',maxCycles:1,feeRate:'0.001'});
const reservation=reserveCycle(s,{id:'cycle',symbol:'ADAUSDT',expectedRevision:0}).reservation;
const fill=(o={})=>({source:'manual',confirmed:true,id:'b1',cycleId:'cycle',symbol:'ADAUSDT',tf:'5m',baseAsset:'ADA',quoteAsset:'USDT',time:1,side:'buy',price:'105',quantity:'0.2',fee:'0.021',feeAsset:'USDT',dca:0,...o});
const calc=(executions=[],completedSteps=[],extra={})=>reconcileManualCycle({reservation,executions,completedSteps,signalPrices:{0:'100'},tickSize:'0.01',exitFeeRate:'0.001',...extra});
test('model signal never opens manual position or spends reserve',()=>{
  const x=calc([fill({source:'model'})]);
  assert.equal(x.status,'awaiting_fill');assert.equal(x.confirmedExecutions,0);assert.equal(x.remainingReserve,reservation.plan.total);assert.equal(x.tp,null);assert.equal(x.nextDca,null);
});
test('manual fill differs from signal; actual DCA and TP follow execution',()=>{
  const x=calc([fill()],[0]);
  assert.equal(x.steps[0].signalPrice,'100');assert.equal(x.steps[0].actualAverage,'105');assert.equal(x.steps[0].priceDeviation,'5');
  assert.equal(x.averageEntry,'105');assert.equal(x.averageCost,'105.105');assert.equal(x.nextDca.price,'99.75');assert.equal(x.tp.price,'108.15');
  assert.equal(x.tp.estimatedNetPnl,'0.58737');assert.equal(x.cost,'21.021');
});
test('partial fills use weighted actual price and require completion',()=>{
  const a=fill({price:'100',quantity:'0.1',fee:'0.01'}),b=fill({id:'b2',time:2,price:'110',quantity:'0.1',fee:'0.011'});
  const partial=calc([a,b]);assert.equal(partial.steps[0].status,'partial');assert.equal(partial.nextDca,null);
  const complete=calc([a,b,b],[0]);assert.equal(complete.confirmedExecutions,2);assert.equal(complete.steps[0].actualAverage,'105');assert.equal(complete.nextDca.price,'99.75');
  assert.throws(()=>calc([a],[0,1]),/without confirmed fill/);
});
test('unexpected manual spend is recorded not silently rejected; recommendations blocked',()=>{
  const x=calc([fill({quantity:'1',fee:'0.105'})],[0]);
  assert.equal(x.quantity,'1');assert.ok(x.flags.includes('STEP_BUDGET_EXCEEDED'));assert.ok(x.flags.includes('PLAN_RESERVE_EXCEEDED'));assert.equal(x.nextDca,null);
});
test('manual sale realizes actual profit and leaves cancellation warning',()=>{
  const x=calc([fill(),fill({id:'s',time:2,side:'sell',price:'110',quantity:'0.2',fee:'0.022',dca:null})],[0]);
  assert.equal(x.status,'closed');assert.equal(x.realizedPnl,'0.957');assert.equal(x.tp,null);assert.equal(x.nextDca,null);assert.ok(x.flags.includes('CONFIRM_REMAINING_ORDERS_CANCELLED'));
});
test('unconfirmed and unrelated executions do not create a fictitious cycle',()=>{
  assert.throws(()=>calc([fill({confirmed:false})]),/confirmed/);
  assert.equal(calc([fill({cycleId:'other'})]).confirmedExecutions,0);
  assert.throws(()=>calc([fill({symbol:'BTCUSDT',baseAsset:'BTC'})]),/symbol mismatch/);
  const x=calc([fill({dca:null})]);assert.ok(x.flags.includes('UNASSIGNED_BUY'));assert.equal(x.nextDca,null);
});
