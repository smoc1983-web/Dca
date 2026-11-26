import test from 'node:test';
import assert from 'node:assert/strict';
import {marginStress} from '../cloudflare/margin-stress.mjs';
const p=(o={})=>({id:'a',symbol:'ADAUSDT',leverage:3,quantity:'2',averageEntry:'100',markPrice:'100',lastPrice:'105',maintenanceTiers:[{upTo:'200',rate:'0.005'},{upTo:'1000',rate:'0.01'}],exitFeeRate:'0.001',adverseFundingRate:'0.001',fundingPeriods:2,futureEntryFeeRate:'0.001',futureOrderNominals:['30'],...o});
const cross=(o={})=>marginStress({synthetic:true,mode:'cross',collateralWallet:'200',positions:[p()],scenarios:[{id:'down',markPrices:{a:'50'}}],...o});
test('mark not last drives PnL and charges; initial and maintenance are separate',()=>{
 const r=cross({positions:[p({markPrice:'90'})]});const a=r.current.accounts[0];
 assert.equal(a.unrealizedPnl,'-20');assert.equal(a.equity,'180');assert.equal(a.initialMarginEstimate,'60');
 assert.equal(a.maintenanceEstimate,'0.9');assert.equal(a.exitFeeReserve,'0.18');assert.equal(a.adverseFundingReserve,'0.36');assert.equal(a.futureDcaReserve,'10.03');
 assert.equal(a.maintenanceHeadroom,'178.56');assert.equal(a.reserveHeadroom,'109.43');
});
test('correlated drop across multiple positions stresses shared collateral',()=>{
 const r=cross({collateralWallet:'150',positions:[p(),p({id:'b',symbol:'BTCUSDT'})],scenarios:[{id:'joint',markPrices:{a:'50',b:'50'}}]});
 assert.equal(r.current.accounts[0].maintenanceBreach,false);assert.equal(r.scenarios[0].accounts[0].unrealizedPnl,'-200');
 assert.equal(r.scenarios[0].accounts[0].maintenanceBreach,true);assert.equal(r.scenarios[0].accounts[0].reserveDeficit,true);
});
test('isolated positions do not borrow surplus from each other',()=>{
 const r=marginStress({synthetic:true,mode:'isolated',positions:[p({isolatedCollateral:'70'}),p({id:'b',symbol:'BTCUSDT',isolatedCollateral:'300'})],scenarios:[{id:'gap',markPrices:{a:'50',b:'50'}}]});
 assert.equal(r.scenarios[0].accounts[0].maintenanceBreach,true);assert.equal(r.scenarios[0].accounts[1].maintenanceBreach,false);
});
test('tier boundaries and missing tier coverage are explicit',()=>{
 const r=cross({scenarios:[{id:'tier2',markPrices:{a:'101'}},{id:'unknown',markPrices:{a:'501'}}]});
 assert.equal(r.current.positions[0].maintenanceTier,1);assert.equal(r.scenarios[0].positions[0].maintenanceTier,2);assert.equal(r.scenarios[0].positions[0].maintenanceEstimate,'2.02');
 assert.equal(r.scenarios[1].accounts[0].maintenanceHeadroom,null);assert.ok(r.flags.includes('MAINTENANCE_TIER_NOT_COVERED'));
});
test('gap risk before next DCA never assumes future orders filled',()=>{
 const r=cross({collateralWallet:'70',scenarios:[{id:'gap-before-fill',markPrices:{a:'60'}}]});
 assert.equal(r.scenarios[0].positions[0].notional,'120');assert.equal(r.scenarios[0].accounts[0].unrealizedPnl,'-80');assert.ok(r.flags.includes('SYNTHETIC_MAINTENANCE_BREACH'));
});
test('leverage cap, explicit funding/tiers, no mixed collateral or incomplete scenarios',()=>{
 for(const leverage of [0,4,1.5,'3'])assert.throws(()=>cross({positions:[p({leverage})]}),/Leverage/);
 assert.throws(()=>cross({positions:[p({adverseFundingRate:undefined})]}),/Invalid/);
 assert.throws(()=>cross({positions:[p({maintenanceTiers:[]})]}),/tiers required/);
 assert.throws(()=>cross({positions:[p({isolatedCollateral:'100'})]}),/mix/);
 assert.throws(()=>cross({scenarios:[{id:'bad',markPrices:{}}]}),/every position/);
 assert.throws(()=>cross({synthetic:false}),/synthetic/);
});
test('no automatic trading or liquidation price even for ample collateral',()=>{
 const r=cross({collateralWallet:'10000'});assert.equal(r.recommendationAllowed,false);assert.equal(r.liquidationPrice,null);
 assert.ok(r.flags.includes('EXCHANGE_RULES_UNVERIFIED'));
});
test('funding costs and fees can exhaust maintenance headroom without further price move',()=>{
 const r=cross({collateralWallet:'2',positions:[p({fundingPeriods:10})],scenarios:[{id:'flat',markPrices:{a:'100'}}]});
 assert.equal(r.current.accounts[0].adverseFundingReserve,'2');assert.equal(r.current.accounts[0].maintenanceBreach,true);
});
