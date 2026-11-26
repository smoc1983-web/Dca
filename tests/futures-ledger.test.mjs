import test from 'node:test';
import assert from 'node:assert/strict';
import {replayFutures,stressManualFutures} from '../cloudflare/futures-ledger.mjs';
const buy=(o={})=>({id:'b',cycleId:'c',symbol:'ADAUSDT',source:'manual-futures',confirmed:true,synthetic:true,time:1,kind:'buy',leverage:3,price:'105',quantity:'2',fee:'0.21',feeAsset:'USDT',dca:0,...o});
const dca=buy({id:'d',time:2,price:'95',quantity:'2',fee:'0.19',dca:1});
const sell=buy({id:'s',time:3,kind:'sell',price:'110',quantity:'1',fee:'0.11',dca:null});
const funding={...buy({id:'f',time:4,kind:'funding'}),amount:'-0.5'};
test('actual purchase prices determine weighted futures average independently of leverage',()=>{
 const c=replayFutures([buy(),dca])[0];assert.equal(c.quantity,'4');assert.equal(c.averageEntry,'100');assert.equal(c.entryNotional,'400');assert.equal(c.paidFees,'0.4');
});
test('partial sale reduces basis and funding/fees are separate',()=>{
 const c=replayFutures([buy(),dca,sell,funding])[0];assert.equal(c.quantity,'3');assert.equal(c.averageEntry,'100');assert.equal(c.entryNotional,'300');assert.equal(c.grossRealizedPnl,'10');assert.equal(c.paidFees,'0.51');assert.equal(c.settledFunding,'-0.5');assert.equal(c.netRealizedCashEffect,'8.99');
});
test('full close clears basis without changing historical gross profit',()=>{
 const c=replayFutures([buy(),dca,sell,buy({id:'s2',time:4,kind:'sell',price:'90',quantity:'3',fee:'0.27',dca:null})])[0];
 assert.equal(c.closed,true);assert.equal(c.quantity,'0');assert.equal(c.averageEntry,null);assert.equal(c.grossRealizedPnl,'-20');assert.equal(c.netRealizedCashEffect,'-20.78');
});
test('duplicates idempotent, conflicting execution rejected',()=>{
 assert.equal(replayFutures([buy(),buy()])[0].events,1);
 assert.throws(()=>replayFutures([buy(),buy({price:'106'})]),/Conflicting/);
});
test('spot, signals, unknown fees and leverage changes rejected',()=>{
 for(const p of [{source:'manual'},{source:'model'},{confirmed:false},{synthetic:false},{feeAsset:'BNB'},{leverage:4}])assert.throws(()=>replayFutures([buy(p)]));
 assert.throws(()=>replayFutures([buy(),{...dca,leverage:2}]),/Immutable/);
 assert.throws(()=>replayFutures([buy(),{...sell,quantity:'3'}]),/exceeds/);
});
const plan={cycleId:'c',symbol:'ADAUSDT',leverage:3,nominals:['210','200','250','300','350','400'],completedSteps:[0,1]};
const risk={cycleId:'c',markPrice:'90',lastPrice:'100',maintenanceTiers:[{upTo:'10000',rate:'0.005'}],exitFeeRate:'0.001',adverseFundingRate:'0.001',fundingPeriods:1,futureEntryFeeRate:'0.001'};
const stress=(o={})=>stressManualFutures({events:[buy(),dca,sell],plans:[plan],risk:[risk],mode:'cross',collateralWallet:'800',scenarios:[{id:'gap',markPrices:{c:'50'}}],synthetic:true,...o});
test('stress follows remaining real quantity and post-settlement collateral without double charging',()=>{
 const r=stress();assert.equal(r.stress.current.accounts[0].collateral,'800');assert.equal(r.stress.current.accounts[0].unrealizedPnl,'-30');assert.equal(r.stress.current.accounts[0].equity,'770');
 assert.equal(r.stress.scenarios[0].accounts[0].unrealizedPnl,'-150');assert.equal(r.recommendationAllowed,false);assert.equal(r.stress.liquidationPrice,null);
});
test('partial DCA reserves unspent nominal and overrun flagged rather than deleting fill',()=>{
 const r=stress({plans:[{...plan,nominals:['200','200','250','300','350','400'],completedSteps:[0]}]});
 assert.ok(r.flags.includes('ACTUAL_NOMINAL_EXCEEDS_PLAN'));assert.equal(r.cycles[0].stepNominals[1],'190');
 assert.equal(r.stress.current.accounts[0].futureDcaReserve,'437.97666669');
});
test('missing frozen plan blocks stress; partial START reserves all six remainders',()=>{
 assert.throws(()=>stress({plans:[]}),/Missing/);
 const partial=stress({events:[buy({quantity:'1'})],plans:[{...plan,completedSteps:[]}]});assert.equal(partial.cycles[0].quantity,'1');assert.equal(partial.stress.current.accounts[0].futureDcaReserve,'536.60500002');
 const r=stress({events:[buy(),buy({id:'s',time:2,kind:'sell',quantity:'2',dca:null})]});
 assert.equal(r.stress,null);assert.equal(r.cycles[0].closed,true);
});
