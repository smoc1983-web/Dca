import test from 'node:test';import assert from 'node:assert/strict';import {reconcileFlat} from './reconcile-flat.mjs';
const fixture=()=>({version:2,activatedAt:1,portfolio:{cash:470},entries:{'UNIUSDT:15m':{params:{initialCapital:800,qtyStep:.001},selectedParams:{initialCapital:800,qtyStep:.01},legacy:true,s:{qty:45.194,average:7.29,invested:329.6875,dca:4,lastTime:100,rsi:28,ema:7.1,cash:510,orders:70}}},outbox:[{id:'delivered',status:'delivered'},{id:'unknown',status:'uncertain'},{id:'old-pending',status:'pending'}]});
test('manual flat reconciliation removes phantom position, retains indicators and delivery history',()=>{
  const before=fixture(),result=reconcileFlat(before,{totalBudget:800},{at:1000,reason:'User confirmed no exchange positions'}),entry=result.state.entries['UNIUSDT:15m'];
  assert.equal(before.entries['UNIUSDT:15m'].s.qty,45.194);assert.equal(entry.s.qty,0);assert.equal(entry.s.rsi,28);assert.equal(entry.s.lastTime,100);assert.equal(entry.legacy,false);assert.equal(entry.params.qtyStep,.01);assert.equal(result.state.portfolio.cash,800);
  assert.deepEqual(result.state.outbox.slice(0,2),before.outbox.slice(0,2));assert.equal(result.state.outbox[2].status,'cancelled_manual_reconciliation');assert.equal(result.state.manualAdjustments[0].ordersSentToExchange,0);
});
test('repeating the adjustment when already flat does not reset budget or activation time',()=>{
  const first=reconcileFlat(fixture(),{totalBudget:800},{at:1000,reason:'confirmed'}).state;first.portfolio.cash=810;
  const next=reconcileFlat(first,{totalBudget:800},{at:2000,reason:'confirmed'});assert.equal(next.changed,false);assert.equal(next.state.portfolio.cash,810);assert.equal(next.state.activatedAt,1000);
});
