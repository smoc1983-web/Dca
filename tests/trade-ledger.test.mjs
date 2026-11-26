import test from 'node:test';
import assert from 'node:assert/strict';
import {replayLedger,unrealizedPnl} from '../cloudflare/trade-ledger.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const fill=(o={})=>({source:'model',id:'1',cycleId:'c1',symbol:'ADAUSDT',baseAsset:'ADA',quoteAsset:'USDT',tf:'5m',time:1000,side:'buy',price:100,quantity:1,fee:0,...o});
test('weighted cost, partial exit, net realized PnL and duration',()=>{
  const records=[fill({fee:1,feeAsset:'USDT'}),fill({id:'2',time:2000,price:80,fee:.8,feeAsset:'USDT'}),fill({id:'3',time:3000,side:'sell',price:100,quantity:.5,fee:.5,feeAsset:'USDT'})];
  const [c]=replayLedger(records);
  near(c.quantity,1.5);near(c.averageEntry,90);near(c.averageCost,90.9);near(c.realized,4.05);near(unrealizedPnl(c,100,.01),12.15);
  const [closed]=replayLedger([...records,fill({id:'4',time:4000,side:'sell',price:100,quantity:1.5,fee:1.5,feeAsset:'USDT'})]);
  near(closed.realized,16.2);near(closed.feesQuote,3.8);near(closed.quantity,0);assert.equal(closed.durationMs,3000);near(closed.realizedPercent,100*16.2/181.8);
});
test('replay survives JSON roundtrip and deduplicates exact fills',()=>{
  const e=fill();assert.deepEqual(replayLedger([e,e]),replayLedger(JSON.parse(JSON.stringify([e]))));
  assert.throws(()=>replayLedger([e,fill({price:99})]),/Conflicting/);
});
test('manual and model streams remain separate; unconfirmed manual rejected',()=>{
  const manual=fill({source:'manual',confirmed:true});assert.equal(replayLedger([fill(),manual]).length,2);
  assert.throws(()=>replayLedger([fill({source:'manual'})]),/confirmed/);
});
test('base asset commission reduces inventory and is not double counted',()=>{
  const [c]=replayLedger([fill({fee:.01,feeAsset:'ADA'}),fill({id:'2',side:'sell',time:2000,price:110,quantity:.98,fee:.01,feeAsset:'ADA'})]);
  near(c.quantity,0);near(c.realized,7.8);near(c.feesQuote,2.1);
});
test('third asset commission requires quote conversion',()=>{
  assert.throws(()=>replayLedger([fill({fee:.01,feeAsset:'BNB'})]),/feeQuoteRate/);
  const [c]=replayLedger([fill({fee:.01,feeAsset:'BNB',feeQuoteRate:500})]);near(c.averageCost,105);near(c.feesQuote,5);
});
test('reject invalid or out of order fills, excessive sell and reopening closed cycle',()=>{
  assert.throws(()=>replayLedger([fill({quantity:0})]),/quantity/);
  assert.throws(()=>replayLedger([fill({side:'sell'})]),/start/);
  assert.throws(()=>replayLedger([fill(),fill({id:'2',time:999})]),/Out-of-order/);
  assert.throws(()=>replayLedger([fill(),fill({id:'2',side:'sell',quantity:2})]),/exceeds/);
  assert.throws(()=>replayLedger([fill(),fill({id:'2',side:'sell'}),fill({id:'3'})]),/closed/);
});
