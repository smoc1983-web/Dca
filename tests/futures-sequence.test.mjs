import test from 'node:test';
import assert from 'node:assert/strict';
import {sequentialFuturesStress} from '../cloudflare/futures-sequence.mjs';
const buy=(o={})=>({id:'b',cycleId:'c',symbol:'ADAUSDT',source:'manual-futures',confirmed:true,synthetic:true,time:1,kind:'buy',leverage:3,price:'100',quantity:'1',fee:'0.1',feeAsset:'USDT',dca:0,...o});
const plan={cycleId:'c',symbol:'ADAUSDT',leverage:3,nominals:['100','150','225','337.5','506.25','759.375'],completedSteps:[0]};
const risk=(mark='100',o={})=>({cycleId:'c',markPrice:mark,lastPrice:mark,maintenanceTiers:[{upTo:'100000',rate:'0.005'}],exitFeeRate:'0.001',adverseFundingRate:'0',fundingPeriods:0,futureEntryFeeRate:'0.001',...o});
const snap=(mark='100',wallet='2000')=>({risk:[risk(mark)],collateralWallet:wallet});
const step=(o={})=>({time:2,before:snap('95'),fill:buy({id:'d',time:2,price:'95',quantity:'1',fee:'0.095',dca:1}),after:snap('95','1999.905'),complete:false,...o});
const run=(o={})=>sequentialFuturesStress({synthetic:true,mode:'cross',events:[buy()],plans:[plan],initial:{time:1,...snap()},steps:[step()],...o});
test('before and after DCA use actual hypothetical quantities and fee-only collateral reduction',()=>{
 const r=run(),s=r.steps[0];assert.equal(s.before.cycles[0].quantity,'1');assert.equal(s.after.cycles[0].quantity,'2');assert.equal(s.after.cycles[0].averageEntry,'97.5');assert.equal(s.after.accounts[0].collateral,'1999.905');assert.equal(s.after.accounts[0].unrealizedPnl,'-5');assert.equal(r.recommendationAllowed,false);
});
test('partial execution retains unspent reserve; next partial completion preserves original plan',()=>{
 const r=run({steps:[step(),step({time:3,before:snap('95','1999.905'),fill:buy({id:'d2',time:3,price:'55',quantity:'1',fee:'0.055',dca:1}),after:snap('95','1999.85'),complete:true})]});
 assert.equal(r.steps[0].after.cycles[0].stepNominals[1],'95');assert.deepEqual(r.finalPlans[0].completedSteps,[0,1]);assert.deepEqual(plan.completedSteps,[0]);assert.equal(r.finalCycles[0].quantity,'3');
});
test('partial START retains six unspent slots and can finish',()=>{
 const r=run({events:[buy({quantity:'0.5',fee:'0.05'})],plans:[{...plan,completedSteps:[]}],steps:[step({fill:buy({id:'b2',time:2,price:'100',quantity:'0.5',fee:'0.05'}),after:snap('95','1999.95'),complete:true})]});
 assert.equal(r.initial.cycles[0].quantity,'0.5');assert.equal(r.finalCycles[0].quantity,'1');assert.deepEqual(r.finalPlans[0].completedSteps,[0]);
});
test('gap before DCA halts before fill even if later steps could recover',()=>{
 const small={...plan,nominals:['100','1','1','1','1','1']};
 const r=run({plans:[small],initial:{time:1,...snap('100','40')},steps:[step({before:snap('50','40'),after:snap('50','39.905')}),step({time:3})]});
 assert.equal(r.haltReason,'MAINTENANCE_BREACH');assert.equal(r.steps[0].fillApplied,false);assert.equal(r.steps[0].after,null);assert.equal(r.unprocessedSteps,1);assert.equal(r.finalCycles[0].quantity,'1');
});
test('reserve deficit stops future hypothetical execution separately from maintenance',()=>{
 const r=run({initial:{time:1,...snap('100','100')}});assert.equal(r.haltReason,'RESERVE_DEFICIT');assert.equal(r.steps.length,0);
});
test('unknown tier stops path and no liquidation price is invented',()=>{
 const smallRisk=risk('100',{maintenanceTiers:[{upTo:'100',rate:'0.005'}]});
 const r=run({initial:{time:1,risk:[smallRisk],collateralWallet:'2000'},steps:[step({before:{risk:[{...smallRisk,markPrice:'101',lastPrice:'101'}],collateralWallet:'2000'}})]});assert.equal(r.haltReason,'UNKNOWN_MAINTENANCE');assert.equal(r.liquidationPrice,null);
});
test('post-fill deficit halts path; overrun recorded rather than ignored',()=>{
 const p={...plan,nominals:['100','1','1','1','1','1']};
 const r=run({plans:[p],initial:{time:1,...snap('100','100')},steps:[step({before:snap('95','100'),fill:buy({id:'huge',time:2,price:'95',quantity:'10',fee:'0.95',dca:1}),after:snap('95','99.05')})]});
 assert.equal(r.steps[0].fillApplied,true);assert.equal(r.haltReason,'RESERVE_DEFICIT');assert.equal(r.finalCycles[0].quantity,'11');
});
test('rejects changed risk model, invalid sequence, wallet inflation and skipped DCA',()=>{
 assert.throws(()=>run({steps:[step({after:snap('95','2000')})]}),/collateral mismatch/);
 assert.throws(()=>run({steps:[step({time:1})]}),/Non-increasing/);
 assert.throws(()=>run({steps:[step({fill:buy({id:'skip',time:2,dca:2})})]}),/next incomplete/);
 assert.throws(()=>run({steps:[step({before:{risk:[risk('95',{exitFeeRate:'0.02'})],collateralWallet:'2000'}})]}),/Risk model changed/);
});
test('isolated collateral cannot subsidize another position during hypothetical fill',()=>{
 const before={risk:[risk('95',{isolatedCollateral:'2000'})]},after={risk:[risk('95',{isolatedCollateral:'1999.905'})]};
 const r=run({mode:'isolated',initial:{time:1,risk:[risk('100',{isolatedCollateral:'2000'})]},steps:[step({before,after})]});assert.equal(r.steps[0].after.accounts[0].collateral,'1999.905');
});
