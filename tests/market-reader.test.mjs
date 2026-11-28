import test from 'node:test';import assert from 'node:assert/strict';
import {createMarketReader,readMarketClock} from '../cloudflare/market-reader.mjs';
import {tick} from '../cloudflare/worker.mjs';
const opts={endpoint:'time',parameters:{}};
function fixture(responses){
 const calls=[],logs=[],read=createMarketReader({log:x=>logs.push(x)});
 const request=async(url,options)=>{calls.push(url.hostname);assert.equal(options.redirect,'manual');const r=responses.shift();if(r instanceof Error)throw r;if(!r)throw Error('unexpected call');return r;};
 return {calls,logs,read:o=>read(o,request)};
}
const response=(status,body)=>new Response(typeof body==='string'?body:JSON.stringify(body),{status});
test('403 then explicit 451 stops without further requests and redacts body',async()=>{
 const f=fixture([response(403,'Forbidden'),response(451,'restricted location private text')]);
 await assert.rejects(f.read(opts),e=>e.code==='REGION_RESTRICTED'&&e.status===451&&e.endpoint==='time');
 assert.deepEqual(f.calls,['data-api.binance.vision','api.binance.com']);assert.ok(f.logs.every(x=>!x.includes('private text')));
});
test('explicit region denial in 403 stops immediately',async()=>{const f=fixture([response(403,'Service unavailable from a restricted location')]);await assert.rejects(f.read(opts),e=>e.code==='REGION_RESTRICTED');assert.equal(f.calls.length,1);});
test('generic forbidden and upstream failure retain bounded existing fallback and preferred source',async()=>{const f=fixture([response(403,'Forbidden'),response(503,'temporary'),response(200,{serverTime:1000}),response(200,{serverTime:1001})]);assert.equal((await f.read(opts)).serverTime,1000);assert.equal((await f.read(opts)).serverTime,1001);assert.deepEqual(f.calls,['data-api.binance.vision','api.binance.com','api-gcp.binance.com','api-gcp.binance.com']);});
test('rate limit does not switch hosts or retry',async()=>{for(const status of [418,429]){const f=fixture([response(status,'rate limit')]);await assert.rejects(f.read(opts),e=>e.code==='RATE_LIMITED');assert.equal(f.calls.length,1);}});
test('malformed data and transport timeout remain distinct and do not return fabricated prices',async()=>{const f=fixture([response(200,'not-json')]);await assert.rejects(f.read(opts),e=>e.code==='INVALID_JSON');const g=fixture([new DOMException('private detail','TimeoutError')]);await assert.rejects(g.read(opts),e=>e.code==='TIMEOUT'&&!e.message.includes('private detail'));assert.equal(g.calls.length,1);});
test('clock rejects stale, malformed, missing or nonpositive exchange timestamps',async()=>{const n=1795870000000;assert.equal(await readMarketClock(async()=>({serverTime:n}),()=>n),n);for(const x of [null,{}, {serverTime:n-120001},{serverTime:String(n)},{serverTime:0}])await assert.rejects(readMarketClock(async()=>x,()=>n),e=>e.code==='INVALID_CLOCK');});
test('failed clock leaves models and alert writes untouched and records truthful failed run',async()=>{const writes=[],requests=[];const db={prepare(sql){let args=[];return {bind(...v){args=v;return this;},async first(){assert.match(sql,/SELECT \* FROM control/);return {mode:'shadow',epoch:'test'};},async all(){assert.match(sql,/SELECT \* FROM models/);return {results:[{key:'BTCUSDT:5m'},{key:'ADAUSDT:5m'}]};},async run(){writes.push({sql,args});}}},batch(){assert.fail('unexpected model update');}};await assert.rejects(tick({DB:db},{request:async url=>{requests.push(url.pathname);return response(451,'restricted location');}}),e=>e.code==='REGION_RESTRICTED');assert.deepEqual(requests,['/api/v3/time']);assert.equal(writes.length,1);assert.match(writes[0].sql,/INSERT OR REPLACE INTO runs/);assert.deepEqual(writes[0].args.slice(1),[0,2,null]);});
