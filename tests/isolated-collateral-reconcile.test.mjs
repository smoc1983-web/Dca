import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {IsolatedCollateralStore} from '../cloudflare/isolated-collateral-store.mjs';
import {createCollateralAccount,recordCollateralOperation} from '../cloudflare/isolated-collateral.mjs';
const initial={synthetic:true,mode:'isolated',venue:'test',accountId:'a',observedAt:10,freeCollateral:'100',dcaReserve:'60',protectionCap:'30',positions:[{cycleId:'c',symbol:'BTCUSDT',leverage:3,lastDca:2,quantity:'1',averageEntry:'100',tpPrice:'103',collateral:'33.34'}]};
const observation=(over={})=>({synthetic:true,confirmed:true,complete:true,mode:'isolated',venue:'test',accountId:'a',observedAt:20,freeCollateral:'100.00',positions:initial.positions,...over});
const event=(revision,over={})=>({synthetic:true,manual:true,venue:'test',accountId:'a',opId:'obs'+revision,expectedRevision:revision,time:20+revision,kind:'reconcile',maxAgeMs:10,observation:observation(),...over});
const request=(revision,over={})=>({synthetic:true,manual:true,venue:'test',accountId:'a',opId:'req'+revision,requestId:'r',cycleId:'c',expectedRevision:revision,time:21+revision,kind:'request',amount:'10',...over});
const apply=(s,e)=>recordCollateralOperation(s,e).state;
test('exact complete observation preserves funds and position and permits synthetic request',()=>{
 const s=createCollateralAccount(initial),r=apply(s,event(0));
 assert.equal(r.reconciliation.status,'matched');assert.deepEqual(r.positions,s.positions);assert.equal(r.freeCollateral,s.freeCollateral);
 assert.equal(apply(r,request(1)).requests[0].amount,'10');
});
test('mismatch persists and blocks new request without overwriting balances',()=>{
 const s=apply(createCollateralAccount(initial),event(0,{observation:observation({freeCollateral:'99'})}));
 assert.deepEqual(s.reconciliation.reasons,['free-collateral-mismatch']);assert.equal(s.freeCollateral,'100');
 assert.throws(()=>apply(s,request(1)),/reconciliation required/);
 const r=apply(s,event(1,{observation:observation({observedAt:21})}));assert.equal(r.reconciliation.status,'matched');
});
test('missing, unexpected, and changed positions block',()=>{
 for(const [positions,expected] of [[[],'missing-position:c'],[[{...initial.positions[0],cycleId:'extra'}],'unexpected-position:extra'],[[{...initial.positions[0],collateral:'34'}],'position-mismatch:c:collateral']]){
  const s=apply(createCollateralAccount(initial),event(0,{observation:observation({positions})}));
  assert.ok(s.reconciliation.reasons.includes(expected));
 }
});
test('invalid scope or incomplete, duplicate or unconfirmed evidence fails closed',()=>{
 for(const o of [{venue:'other'},{complete:false},{confirmed:false},{positions:[initial.positions[0],initial.positions[0]]}]){
  assert.throws(()=>apply(createCollateralAccount(initial),event(0,{observation:observation(o)})));
 }
});
test('stale future and expired observations block',()=>{
 for(const observedAt of [9,21]){
  const s=apply(createCollateralAccount(initial),event(0,{observation:observation({observedAt})}));assert.equal(s.reconciliation.status,'blocked');
 }
 const r=apply(createCollateralAccount(initial),event(0));assert.throws(()=>apply(r,request(1,{time:31})),/reconciliation required/);
});
test('pending operation blocks observation but settlement remains possible; fresh revision required',()=>{
 let s=apply(createCollateralAccount(initial),event(0));s=apply(s,request(1));
 s=apply(s,event(2,{time:23,observation:observation({observedAt:23})}));assert.ok(s.reconciliation.reasons.includes('unsettled-operation'));
 s=apply(s,request(3,{opId:'settle',kind:'settle',time:24,confirmed:true,evidence:'proof',amount:'10'}));
 assert.equal(s.freeCollateral,'90');assert.equal(s.positions[0].collateral,'43.34');
 assert.throws(()=>apply(s,request(4,{requestId:'next'})),/reconciliation required/);
 s=apply(s,event(4,{time:25,observation:observation({observedAt:25,freeCollateral:'90',positions:s.positions})}));assert.equal(s.reconciliation.status,'matched');
});
test('reconciliation audit idempotent and conflicting evidence rejected',()=>{
 const e=event(0),s=apply(createCollateralAccount(initial),e);
 assert.equal(recordCollateralOperation(s,e).status,'duplicate');
 assert.throws(()=>apply(s,{...e,observation:observation({freeCollateral:'99'})}),/Conflicting operation ID/);
});
test('persistent replay preserves blocked observation and cannot bypass via request',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(readFileSync(new URL('../cloudflare/isolated-collateral-schema.sql',import.meta.url),'utf8'));
 const port={prepare(sql){let args=[];return {bind(...v){args=v;return this;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}};}};
 const a=new IsolatedCollateralStore(port);await a.initialize(initial);await a.write(event(0,{observation:observation({freeCollateral:'99'})}));
 const b=new IsolatedCollateralStore(port);assert.equal((await b.snapshot('test','a')).state.reconciliation.status,'blocked');await assert.rejects(b.write(request(1)),/reconciliation required/);
});
