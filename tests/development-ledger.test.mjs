import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/development-ledger.mjs';

const token='A'.repeat(43),other='B'.repeat(43);
const alice={id:'account-a',token,binding:'DEV_LEDGER_DB_A'};
const active={DEV_LEDGER_MODE:'synthetic',DEV_LEDGER_ACCOUNTS:[alice]};
const req=(path='/ledger',key=token,method='GET')=>
 new Request('https://ledger.fixture'+path,{method,headers:key?{Authorization:'Bearer '+key}:{}});
const forbiddenDb={prepare(){assert.fail('ledger DB must not be read');}};

test('only a valid token for the exact read-only synthetic route can reach an account DB',async()=>{
 const env={...active,get DEV_LEDGER_DB_A(){assert.fail('account DB accessed');}};
 for(const [request,settings,status] of [
  [req(),{...envSafe(),DEV_LEDGER_MODE:'live'},404],
  [req('/ledger/account-a'),env,404],
  [req('/ledger?account=account-b'),env,404],
  [req('/ledger?token='+token),env,404],
  [req('/ledger',null),env,401],
  [req('/ledger',other),env,401],
  [req('/ledger',token,'POST'),env,405]
 ])assert.equal((await worker.fetch(request,settings)).status,status);
});
function envSafe(){return {...active,DEV_LEDGER_DB_A:forbiddenDb};}

test('misconfigured accounts fail closed, including duplicate tokens, bindings and IDs',async()=>{
 const bob={id:'account-b',token:other,binding:'DEV_LEDGER_DB_B'};
 const bad=[[],[alice,{...bob,token}],[alice,{...bob,binding:alice.binding}],[alice,{...bob,id:alice.id}],
  [{...alice,binding:'DB'}],[{...alice,token:token+'\n'}]];
 for(const accounts of bad){
  const res=await worker.fetch(req(),{...envSafe(),DEV_LEDGER_ACCOUNTS:accounts});
  assert.equal(res.status,503);
  assert.deepEqual(await res.json(),{status:'unavailable'});
 }
});
test('a mismatched or missing immutable marker blocks the snapshot query',async()=>{
 for(const marker of [null,{account_id:'account-b'}]){
  const queries=[];
  const db={prepare(sql){queries.push(sql);return {async first(){return marker;}};}};
  const res=await worker.fetch(req(),{...active,DEV_LEDGER_DB_A:db});
  assert.equal(res.status,503);
  assert.equal(queries.length,1);
  assert.match(queries[0],/dev_ledger_account/);
 }
 const db={prepare(){throw Error('private table name');}};
 const res=await worker.fetch(req(),{...active,DEV_LEDGER_DB_A:db});
 assert.deepEqual(await res.json(),{status:'unavailable'});
 assert.equal(res.headers.get('Cache-Control'),'no-store');
});
