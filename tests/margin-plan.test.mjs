import test from 'node:test';
import assert from 'node:assert/strict';
import {marginPlan} from '../cloudflare/margin-plan.mjs';
import {dcaPlan} from '../cloudflare/portfolio-budget.mjs';
const p={cycleBudget:'800',feeRate:'0.001',availableCollateral:'800',entryPrice:'100',leverage:1};
test('leverage does not increase nominal or change spot ladder',()=>{
 const spot=dcaPlan(p);
 for(const leverage of [1,2,3]){const r=marginPlan({...p,leverage});assert.equal(r.nominal,spot.nominal);assert.deepEqual(r.orders.map(x=>x.nominal),spot.orders.map(x=>x.nominal));assert.equal(r.recommendationAllowed,false);}
 assert.equal(marginPlan(p).initialMargin,'519.53125');
 assert.equal(marginPlan({...p,leverage:2}).initialMargin,'259.765625');
 assert.ok(Number(marginPlan({...p,leverage:3}).initialMargin)>=519.53125/3);
});
test('hard maximum and strict integer leverage',()=>{for(const leverage of [0,4,-1,1.5,'3',NaN,Infinity,undefined])assert.throws(()=>marginPlan({...p,leverage}),/Leverage/);});
test('deposit changes future nominal independently of leverage',()=>{assert.equal(marginPlan({...p,cycleBudget:'400',leverage:3}).nominal,'259.765625');});
test('fees reserved independently of leverage and insufficient collateral flagged',()=>{const r=marginPlan({...p,leverage:3,availableCollateral:'100'});assert.equal(r.entryFeeReserve,dcaPlan(p).fees);assert.equal(r.arithmeticDeficit,true);});
test('sequential DCA price drops and future reserve',()=>{const r=marginPlan(p);assert.equal(r.orders[1].price,'95');assert.equal(r.orders[2].price,'89.3');assert.equal(r.orders[5].remainingInitialMargin,'0');assert.ok(Number(r.orders[5].unrealizedPnl)<0);});
test('stress beyond DCA5 exposes collateral deficit',()=>{const r=marginPlan({...p,leverage:3,availableCollateral:'200',stressDropPercent:'100'});assert.equal(r.stress.markPrice,'0');assert.equal(r.stress.unrealizedPnl,'-519.53125');assert.equal(r.arithmeticDeficit,true);});
test('missing exchange details never imply liquidation safety',()=>{const r=marginPlan({...p,leverage:3});assert.equal(r.liquidationPrice,null);assert.equal(r.maintenanceMargin,null);assert.equal(r.funding,null);assert.equal(r.recommendationAllowed,false);});
test('invalid collateral price and stress rejected',()=>{for(const x of [{availableCollateral:'-1'},{entryPrice:'0'},{stressDropPercent:'101'},{stressDropPercent:'-1'}])assert.throws(()=>marginPlan({...p,...x}),/Invalid/);});
