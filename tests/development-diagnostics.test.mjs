import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.mjs';
import diagnostics, {developmentPolicy} from '../cloudflare/development-diagnostics.mjs';

const token='A'.repeat(43);
const configured={DEV_WORKER_MODE:'synthetic',DEV_DIAGNOSTICS_TOKEN:token};
const request=(path='/diagnostics',authorization='Bearer '+token,method='GET')=>
 new Request('https://fixture.invalid'+path,{method,headers:{Authorization:authorization}});

test('diagnostics is separate from the standard Worker and requires explicit synthetic configuration',async()=>{
 assert.equal(worker.fetch,undefined);
 for(const env of [{},{DEV_WORKER_MODE:'live',DEV_DIAGNOSTICS_TOKEN:token},{DEV_WORKER_MODE:'synthetic'},
  {...configured,DEV_DIAGNOSTICS_TOKEN:'small'}]){
  const response=await diagnostics.fetch(request(),env);
  assert.equal(response.status,404);
  assert.equal(response.headers.get('cache-control'),'no-store');
 }
 assert.equal((await diagnostics.fetch(request('/__fixture_tick'),configured)).status,404);
 diagnostics.scheduled({}, {DEV_MOCK_NETWORK:{fetch(){assert.fail('outbound invoked');}}},{waitUntil(){assert.fail('tick started');}});
});
test('only authenticated GET reaches storage',async()=>{
 let calls=0;
 const env={...configured,DEV_DB:{
  batch(){calls++;throw Error('private binding error');},
  prepare(){calls++;throw Error('private table error');}
 }};
 assert.equal((await diagnostics.fetch(request('/diagnostics','Bearer '+'B'.repeat(43)),env)).status,401);
 assert.equal((await diagnostics.fetch(request('/diagnostics?token='+token),env)).status,404);
 assert.equal((await diagnostics.fetch(request('/diagnostics','Bearer '+token,'POST'),env)).status,405);
 assert.equal(calls,0);
 const response=await diagnostics.fetch(request(),env);
 assert.equal(response.status,503);
 const output=await response.text();
 assert.ok(!output.includes('private'));
 assert.match(output,/storage-unavailable/);
 assert.ok(calls>0);
});
test('synthetic tick refuses missing mock transport before reading or sending',async()=>{
 let scheduled;
 diagnostics.scheduled({}, {...configured,DEV_DB:{prepare(){assert.fail('DB accessed');}}},
  {waitUntil(promise){scheduled=promise;}});
 await assert.rejects(scheduled,/Missing isolated Worker bindings/);
});

test('local monitoring policy validates known thresholds and preserves defaults',()=>{
 const policy=developmentPolicy({sourceWindowMs:15_000,incidentCooldownMs:100,candleGraceMs:0,dailyEnabled:true});
 assert.equal(policy.sourceWindowMs,15_000);
 assert.equal(policy.incidentCooldownMs,100);
 assert.equal(policy.candleGraceMs,0);
 assert.equal(policy.dailyEnabled,true);
 assert.equal(policy.maxTickAgeMs,120_000);
 assert.equal(developmentPolicy().dailyEnabled,false);
});
test('bad local thresholds reject unknown keys, strings, missing minima and oversized windows',()=>{
 for(const overrides of [null,[],{unknownMs:100},{dailyEnabled:1},{sourceWindowMs:'2000'},
  {sourceWindowMs:0},{sourceWindowMs:7*86_400_000+1},{candleGraceMs:-1},{dailyGraceMs:18*3_600_000},{incidentCooldownMs:0}]){
  assert.throws(()=>developmentPolicy(overrides),/Invalid synthetic monitoring policy/);
 }
});
test('invalid policy disables both the synthetic tick and authorised diagnostics without reading storage',async()=>{
 let scheduled;
 const env={...configured,DEV_MONITORING_POLICY:{sourceWindowMs:-1},
  DEV_DB:{prepare(){assert.fail('DB accessed');},batch(){assert.fail('DB accessed');}},
  DEV_MOCK_NETWORK:{fetch(){assert.fail('network accessed');}}};
 const response=await diagnostics.fetch(request(),env);
 assert.equal(response.status,503);
 assert.deepEqual(await response.json(),{status:'configuration-unavailable'});
 diagnostics.scheduled({},env,{waitUntil(promise){scheduled=promise;}});
 await assert.rejects(scheduled,/Invalid synthetic monitoring policy/);
});
