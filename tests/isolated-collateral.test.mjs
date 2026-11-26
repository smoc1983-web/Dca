import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollateralAccount,collateralSummary,recordCollateralOperation} from '../cloudflare/isolated-collateral.mjs';
const account=(over={})=>createCollateralAccount({synthetic:true,mode:'isolated',venue:'walt-test',accountId:'a',observedAt:1,freeCollateral:'100',dcaReserve:'60',protectionCap:'30',positions:[{cycleId:'c',symbol:'BTCUSDT',leverage:3,lastDca:2,quantity:'1',averageEntry:'100',tpPrice:'103',collateral:'33.34'},{cycleId:'d',symbol:'ADAUSDT',leverage:2,lastDca:0,quantity:'10',averageEntry:'2',tpPrice:'2.06',collateral:'10'}],...over});
const op=(s,kind,more={})=>recordCollateralOperation(s,{synthetic:true,manual:true,expectedRevision:s.revision,opId:kind+'-'+s.revision,requestId:'r',venue:'walt-test',accountId:'a',cycleId:'c',time:s.lastTime+1,kind,...more});
test('confirmed margin addition is a transfer, never a DCA or PnL',()=>{
 const a=account(),b=op(a,'request',{amount:'20'}),c=op(b.state,'settle',{amount:'20',confirmed:true,evidence:'receipt-1'});
 assert.equal(b.summary.freeCollateral,'100');assert.equal(b.summary.pendingTopups,'20');assert.equal(c.summary.freeCollateral,'80');assert.equal(c.summary.pendingTopups,'0');assert.equal(c.summary.availableForTopup,'10');
 assert.equal(c.summary.totalTrackedCollateral,collateralSummary(a).totalTrackedCollateral);
 assert.deepEqual(c.state.positions[0],{...a.positions[0],collateral:'53.34'});assert.deepEqual(c.state.positions[1],a.positions[1]);assert.equal(a.revision,0);
});
test('protection cap and DCA reserve independently bound requested money',()=>{
 assert.throws(()=>op(account(),'request',{amount:'31'}),/reserve exceeded/);
 assert.throws(()=>op(account({protectionCap:'90'}),'request',{amount:'41'}),/reserve exceeded/);
 const s=op(account(),'request',{amount:'25'}).state;
 assert.throws(()=>op(s,'request',{requestId:'r2',cycleId:'d',amount:'6'}),/reserve exceeded/);
});
test('partial settlement retains remaining reservation; uncertain keeps it locked',()=>{
 let s=op(account(),'request',{amount:'20'}).state;
 s=op(s,'settle',{amount:'7',confirmed:true,evidence:'p1'}).state;
 assert.equal(collateralSummary(s).pendingTopups,'13');
 s=op(s,'uncertain').state;assert.equal(collateralSummary(s).pendingTopups,'13');
 assert.throws(()=>op(s,'request',{requestId:'r2',amount:'1'}),/Pending/);
 s=op(s,'settle',{amount:'13',confirmed:true,evidence:'p2'}).state;
 assert.equal(collateralSummary(s).pendingTopups,'0');assert.equal(s.confirmedAdded,'20');
});
test('verified cancellation releases only unfilled part; unverified cancellation rejected',()=>{
 let s=op(account(),'request',{amount:'20'}).state;
 s=op(s,'settle',{amount:'7',confirmed:true,evidence:'p1'}).state;
 assert.throws(()=>op(s,'cancel',{confirmed:true,evidence:'c1'}),/remainder/);
 s=op(s,'cancel',{confirmed:true,evidence:'c1',remainderNotExecuted:true}).state;
 assert.equal(s.freeCollateral,'93');assert.equal(s.confirmedAdded,'7');assert.equal(collateralSummary(s).availableForTopup,'23');
});
test('scope, revision and duplicate evidence prevent double spending',()=>{
 let s=op(account(),'request',{amount:'20'}).state;
 assert.throws(()=>op(s,'settle',{amount:'1',confirmed:true,evidence:'a',venue:'other'}),/scope/);
 assert.throws(()=>op(s,'settle',{amount:'1',confirmed:true,evidence:'a',expectedRevision:0}),/Stale/);
 s=op(s,'settle',{amount:'1',confirmed:true,evidence:'a'}).state;
 assert.throws(()=>op(s,'settle',{amount:'1',confirmed:true,evidence:'a'}),/Duplicate/);
 assert.throws(()=>op(s,'settle',{amount:'20',confirmed:true,evidence:'b'}),/exceeds request/);
});
test('same operation retries idempotently even with stale revision',()=>{
 const a=account(),raw={synthetic:true,manual:true,expectedRevision:0,opId:'x',requestId:'r',venue:'walt-test',accountId:'a',cycleId:'c',time:2,kind:'request',amount:'10'};
 const b=recordCollateralOperation(a,raw).state;
 assert.equal(recordCollateralOperation(b,raw).status,'duplicate');
 assert.throws(()=>recordCollateralOperation(b,{...raw,amount:'11'}),/Conflicting/);
});
test('cross, excess leverage, automatic transfer and reduction rejected',()=>{
 assert.throws(()=>account({mode:'cross'}),/isolated/);
 const a=account();assert.throws(()=>account({positions:[{...a.positions[0],leverage:4}]}),/Invalid position/);
 assert.throws(()=>op(a,'request',{amount:'1',manual:false}),/manual/);
 assert.throws(()=>op(a,'reduce',{amount:'1'}),/Unsupported/);
});
