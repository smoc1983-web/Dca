import test from 'node:test';
import assert from 'node:assert/strict';
import {createBudget,dcaPlan,budgetSummary,changeBudget,reserveCycle,releaseUnfilled} from '../cloudflare/portfolio-budget.mjs';
const settings=(o={})=>({policy:'equal-slots-v1',capital:'800',freeCash:'800',maxCycles:1,feeRate:'0.001',...o});
const reserve=(s,id='one',symbol='ADAUSDT')=>reserveCycle(s,{id,symbol,expectedRevision:s.revision});
test('DCA plan scales 400/800/1600 and reserves fees',()=>{
  for(const [budget,start,total] of [['400','12.5','259.765625'],['800','25','519.53125'],['1600','50','1039.0625']]){
    const p=dcaPlan({cycleBudget:budget,feeRate:'0.001'});assert.equal(p.orders[0].nominal,start);assert.equal(p.nominal,total);assert.equal(p.valid,true);
    assert.ok(Number(p.total)>Number(p.nominal));assert.deepEqual(p.orders.map(x=>x.dropPercent),[0,5,6,8,10,12]);
  }
  assert.equal(dcaPlan({cycleBudget:'800',feeRate:'0.001'}).total,'520.05078125');
});
test('three equal slots share one deposit; 19 signals cannot allocate 19 budgets',()=>{
  let s=createBudget(settings({maxCycles:3}));
  const symbols=['BTC','SOL','UNI','ETH','XRP','ADA','ZEC','LTC','LDO','BNB','DOGE','LINK','AVAX','DOT','ATOM','TRX','BCH','AAVE','SUI'];
  for(let i=0;i<symbols.length;i++){const r=reserve(s,'r'+i,symbols[i]+'USDT');assert.equal(r.status,i<3?'reserved':'rejected');s=r.state;}
  const a=budgetSummary(s);assert.equal(a.active,3);assert.ok(Number(a.reserved)<800);assert.ok(Number(a.available)>0);
  assert.equal(s.reservations[0].plan.orders[0].nominal,'8.33333333');
});
test('full ladder including fees must fit supplied pre-reservation cash',()=>{
  const s=createBudget(settings({freeCash:'520'}));const r=reserve(s);
  assert.equal(r.reason,'INSUFFICIENT_FULL_LADDER_RESERVE');assert.deepEqual(r.state,s);
  assert.equal(reserve(createBudget(settings({freeCash:'520.05078125'}))).status,'reserved');
});
test('resize preserves old plan and exposes deficit; new entries blocked',()=>{
  let s=reserve(createBudget(settings({maxCycles:2}))).state;
  const old=structuredClone(s.reservations[0]);
  s=changeBudget(s,{capital:'200',freeCash:'200'},s.revision);
  assert.deepEqual(s.reservations[0],old);assert.equal(s.settingsVersion,2);
  assert.equal(budgetSummary(s).available,'0');assert.ok(Number(budgetSummary(s).deficit)>0);
  assert.equal(reserve(s,'two','BTCUSDT').reason,'EXISTING_RESERVE_DEFICIT');
  s=changeBudget(s,{capital:'1600',freeCash:'1600'},s.revision);
  const r=reserve(s,'two','BTCUSDT');assert.equal(r.status,'reserved');assert.equal(r.reservation.plan.orders[0].nominal,'25');
  assert.deepEqual(r.state.reservations[0],old);
});
test('revision guard, duplicate ID, symbol conflict and release are explicit',()=>{
  let s=createBudget(settings({maxCycles:2}));const old=s;
  s=reserve(s).state;
  assert.throws(()=>reserveCycle(s,{id:'two',symbol:'BTCUSDT',expectedRevision:old.revision}),/Stale/);
  assert.equal(reserve(s).status,'duplicate');assert.equal(reserve(s,'two').reason,'SYMBOL_ALREADY_RESERVED');
  assert.throws(()=>reserve(s,'one','BTCUSDT'),/Conflicting/);
  s=releaseUnfilled(s,{id:'one',expectedRevision:s.revision});assert.equal(budgetSummary(s).reserved,'0');
  assert.throws(()=>reserve(s),/cannot be reused/);assert.equal(reserve(s,'new').status,'reserved');
});
test('invalid configuration, zero capital and unsupported fee fail safely',()=>{
  assert.throws(()=>createBudget(settings({maxCycles:0})),/maxCycles/);
  assert.throws(()=>createBudget(settings({capital:'-1'})),/capital/);
  assert.throws(()=>createBudget(settings({feeRate:'1'})),/feeRate/);
  assert.throws(()=>createBudget(settings({policy:undefined})),/policy/);
  assert.equal(reserve(createBudget(settings({capital:'0'}))).reason,'NO_CYCLE_BUDGET');
  assert.equal(dcaPlan({cycleBudget:'0.00000001',feeRate:'0'}).valid,false);
});
test('JSON recovery retains reservation and settings version; lower max does not delete reservations',()=>{
  let s=createBudget(settings({maxCycles:3}));s=reserve(s).state;s=reserve(s,'two','BTCUSDT').state;
  s=changeBudget(s,{maxCycles:1},s.revision);const restored=JSON.parse(JSON.stringify(s));
  assert.deepEqual(budgetSummary(restored),budgetSummary(s));assert.equal(budgetSummary(restored).overCycleLimit,true);
  assert.equal(reserve(restored,'three','ETHUSDT').reason,'MAX_ACTIVE_CYCLES');
  assert.equal(restored.reservations.length,2);
});
