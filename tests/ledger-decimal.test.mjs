import test from 'node:test';
import assert from 'node:assert/strict';
import {units,decimalString,mul,portion,SCALE} from '../cloudflare/ledger-decimal.mjs';
import {replayLedger,normalizeExecution,unrealizedPnl} from '../cloudflare/trade-ledger.mjs';
const fill=(over={})=>({source:'manual',confirmed:true,id:'a',cycleId:'decimal',symbol:'ADAUSDT',tf:'5m',baseAsset:'ADA',quoteAsset:'USDT',side:'buy',price:.1,quantity:.2,time:1,fee:0,...over});
test('decimal multiplication and exponent notation avoid binary error',()=>{
  assert.equal(decimalString(mul(units(.1),units(.2))),'0.02');
  assert.equal(decimalString(units(1e-12)),'0.000000000001');
  assert.equal(normalizeExecution(fill()).notional,.02);
  assert.equal(decimalString(portion(SCALE,1n,3n)),'0.333333333333333333333333');
  assert.throws(()=>units(1e-30),/precision/);
  assert.throws(()=>units(1e24),/overflow/);
});
test('manual 0.1 + 0.2 quantity closes exactly; fees are decimal',()=>{
  const [c]=replayLedger([fill({quantity:.1,fee:.001,feeAsset:'USDT'}),fill({id:'b',time:2,fee:.002,feeAsset:'USDT'}),fill({id:'c',time:3,side:'sell',quantity:.3,price:.2,fee:.003,feeAsset:'USDT'})]);
  assert.equal(c.exact.quantity,'0');assert.equal(c.exact.realized,'0.024');assert.equal(c.exact.feesQuote,'0.006');
  assert.equal(c.realized,.024);assert.equal(c.closedAt,3);
});
test('partial exits conserve cost basis, including repeating fractions',()=>{
  const [c]=replayLedger([fill({price:.1,quantity:.3,fee:.01,feeAsset:'USDT'}),fill({id:'b',time:2,side:'sell',quantity:.1,price:.2}),fill({id:'c',time:3,side:'sell',quantity:.1,price:.2}),fill({id:'d',time:4,side:'sell',quantity:.1,price:.2})]);
  assert.equal(c.exact.realizedBasis,'0.04');assert.equal(c.exact.realized,'0.02');assert.equal(c.exact.cost,'0');
});
test('manual tiny oversell is rejected rather than rounded into closing',()=>{
  assert.throws(()=>replayLedger([fill({quantity:.3}),fill({id:'b',time:2,side:'sell',quantity:.30000000000000004})]),/exceeds/);
});
test('unrealized PnL uses decimal arithmetic',()=>{
  const [c]=replayLedger([fill({quantity:.3,price:.1})]);
  assert.equal(unrealizedPnl(c,.2,.1),.024);
});
