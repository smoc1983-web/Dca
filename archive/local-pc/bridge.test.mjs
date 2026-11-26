import test from 'node:test';import assert from 'node:assert/strict';import {resilientBridge} from './resilient-bridge.mjs';
test('temporary market failure is retried and a successful response is returned',async()=>{
  let calls=0;const bridge=resilientBridge(async()=>{if(++calls<3)throw Error('temporary read failure');return {ok:true};},{sleep:async()=>{}});
  assert.deepEqual(await bridge({operation:'market',endpoint:'time'}),{ok:true});assert.equal(calls,3);
});
test('Telegram send is never retried after an ambiguous failure',async()=>{
  let calls=0;const bridge=resilientBridge(async()=>{calls++;throw Error('timeout after acceptance');},{sleep:async()=>{}});
  await assert.rejects(()=>bridge({operation:'telegram',method:'sendMessage'}),/timeout/);assert.equal(calls,1);
});
