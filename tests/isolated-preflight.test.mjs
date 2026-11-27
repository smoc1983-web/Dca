import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollateralAccount,recordCollateralOperation} from '../cloudflare/isolated-collateral.mjs';
import {replayFutures} from '../cloudflare/futures-ledger.mjs';
import {isolatedPreflight} from '../cloudflare/isolated-preflight.mjs';
const account={mode:'isolated',venue:'walt-test',accountId:'a'};
const initial={...account,synthetic:true,observedAt:10,freeCollateral:'100',dcaReserve:'60',protectionCap:'30',positions:[{cycleId:'c',symbol:'BTCUSDT',leverage:3,lastDca:0,quantity:'1',averageEntry:'100',tpPrice:'103',collateral:'33.34'}]};
const buy={id:'b',cycleId:'c',symbol:'BTCUSDT',source:'manual-futures',confirmed:true,synthetic:true,time:10,kind:'buy',leverage:3,price:'100',quantity:'1',fee:'0.1',feeAsset:'USDT',dca:0};
function fixture(){
 const s=createCollateralAccount(initial);
 const state=recordCollateralOperation(s,{...account,synthetic:true,manual:true,opId:'obs',expectedRevision:0,time:20,kind:'reconcile',maxAgeMs:10,observation:{...initial,confirmed:true,complete:true,observedAt:20}}).state;
 return {synthetic:true,account,collateral:{state},futures:{...account,synthetic:true,singleAccount:true,revision:1,cycles:replayFutures([buy])},expected:{collateralRevision:1,futuresRevision:1},action:{kind:'START',cycleId:'new',symbol:'ADAUSDT',leverage:2,step:0},now:21,maxAgeMs:10};
}
const check=(f,reason)=>{const r=isolatedPreflight(f);assert.equal(r.status,'blocked');assert.ok(r.reasons.includes(reason),JSON.stringify(r));assert.equal(r.recommendationAllowed,false);};
test('matching journals admit only synthetic risk check, not trade',()=>{const f=fixture(),r=isolatedPreflight(f);assert.equal(r.status,'matched-for-risk-check');assert.equal(r.recommendationAllowed,false);assert.equal(r.collateralRevision,1);});
test('scope is explicit and cross-account or global futures blocked',()=>{for(const o of [{accountId:'b'},{venue:'other'},{singleAccount:false}]){const f=fixture();Object.assign(f.futures,o);check(f,'account-scope-unverified');}});
test('both revisions mandatory and stale versions blocked',()=>{const f=fixture();f.expected.futuresRevision=0;check(f,'revision-mismatch');delete f.expected.collateralRevision;check(f,'missing-revisions');});
test('missing blocked expired or changed reconciliation fails closed',()=>{for(const r of [undefined,{status:'blocked',revision:1,observedAt:20,maxAgeMs:10},{status:'matched',revision:0,observedAt:20,maxAgeMs:10}]){const f=fixture();f.collateral.state.reconciliation=r;check(f,'fresh-reconciliation-required');}const f=fixture();f.now=31;check(f,'fresh-reconciliation-required');});
test('unsettled request and reserve deficit cannot pass',()=>{const f=fixture();f.collateral.state.requests.push({status:'pending',amount:'50',confirmed:'0'});check(f,'unsettled-collateral');check(f,'reserve-deficit');});
test('missing, extra, changed or newer executions block',()=>{let f=fixture();f.futures.cycles=[];check(f,'missing-futures-cycle:c');f=fixture();f.futures.cycles.push({...f.futures.cycles[0],cycleId:'other',symbol:'ADAUSDT'});check(f,'unexpected-futures-cycle:other');f=fixture();f.futures.cycles[0].quantity='2';check(f,'cycle-mismatch:c');f=fixture();f.futures.cycles[0].lastTime=21;check(f,'execution-after-observation:c');});
test('START rejects active symbol or reused cycle and invalid leverage',()=>{const f=fixture();f.action.symbol='BTCUSDT';check(f,'cycle-or-symbol-already-used');f.action.symbol='ADAUSDT';f.action.cycleId='c';check(f,'cycle-or-symbol-already-used');f.action.leverage=4;check(f,'invalid-action');});
test('DCA requires expected next step and explicit completion',()=>{const f=fixture();f.action={kind:'DCA',cycleId:'c',symbol:'BTCUSDT',leverage:3,step:1};check(f,'previous-step-unconfirmed');f.action.previousStepConfirmed=true;assert.equal(isolatedPreflight(f).status,'matched-for-risk-check');f.action.step=2;check(f,'invalid-dca-sequence');});
