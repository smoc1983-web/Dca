import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {SourceMetrics,observeSourceRequest} from '../cloudflare/source-metrics.mjs';
import {DeliveryAudit} from '../cloudflare/delivery-audit.mjs';
import {HealthNotices} from '../cloudflare/health-notices.mjs';

function fixture(t){
 const db=new DatabaseSync(':memory:');
 t.after(()=>db.close());
 db.exec(readFileSync(new URL('../cloudflare/operational-telemetry-schema.sql',import.meta.url),'utf8'));
 const port={prepare(sql){
  let args=[];
  return {bind(...values){args=values;return this;},
   async all(){return {results:db.prepare(sql).all(...args)};},
   async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}};
 }};
 return {db,port,metrics:new SourceMetrics(port),delivery:new DeliveryAudit(port)};
}
const sample={synthetic:true,id:'a',source:'binance-vision',operation:'klines',startedAt:100,endedAt:115,httpStatus:200};
const event=(kind,expectedRevision,at,extra={})=>({
 synthetic:true,signalId:'signal-a',eventId:'ev-'+expectedRevision+'-'+kind,kind,expectedRevision,at,...extra
});

test('groups source timings by outcome, excludes future and old samples and returns no raw input',async t=>{
 const {db,metrics}=fixture(t);
 await metrics.record({...sample,url:'https://secret.invalid',body:'private'});
 await metrics.record({...sample,id:'b',endedAt:125});
 for(const [id,httpStatus] of [['c',429],['d',451],['e',503]])
  await metrics.record({...sample,id,httpStatus});
 await metrics.record({...sample,id:'f',error:'candle-gap'});
 await metrics.record({...sample,id:'old',startedAt:0,endedAt:5});
 await metrics.record({...sample,id:'future',endedAt:600});
 const state=await metrics.read({now:130,windowMs:30});
 const outcomes=Object.fromEntries(state.samples.map(r=>[r.outcome,r]));
 assert.equal(state.status,'available');
 assert.deepEqual(Object.keys(outcomes),['candle-gap','ok','rate-limited','region-restricted','server-error']);
 assert.deepEqual({...outcomes.ok},{source:'binance-vision',operation:'klines',outcome:'ok',count:2,fastestMs:15,meanMs:20,slowestMs:25,lastAt:125});
 assert.ok(!JSON.stringify(db.prepare('SELECT * FROM dev_source_samples').all()).includes('private'));
 assert.ok(!JSON.stringify(state).includes('secret.invalid'));
});
test('source samples deduplicate and reject contradictory observations',async t=>{
 const {metrics}=fixture(t);
 const r=await Promise.all([metrics.record(sample),metrics.record(sample)]);
 assert.deepEqual(r.map(x=>x.status).sort(),['duplicate','stored']);
 await assert.rejects(metrics.record({...sample,endedAt:116}),/Conflicting source/);
 await assert.rejects(metrics.record({...sample,source:'https://invalid.example'}),/Invalid synthetic source/);
 for(const x of [{httpStatus:503,error:'candle-gap'},{error:'timeout'},{httpStatus:null,error:'private'}])
  await assert.rejects(metrics.record({...sample,...x}),/Invalid source outcome/);
 assert.deepEqual(await metrics.read({now:80,windowMs:20}),{status:'no-samples',samples:[]});
});
test('mock request observers keep timeout, cancellation and HTTP 451 distinct and never retry',async t=>{
 const {metrics}=fixture(t);
 let clock=100,calls=0;
 const use=(id,request)=>observeSourceRequest(metrics,{...sample,id},async()=>{
  calls++;clock+=7;return request();
 },()=>clock);
 const response={status:451};
 assert.equal((await use('http',()=>response)).response,response);
 for(const name of ['TimeoutError','AbortError','TypeError']){
  const error=new Error('private path');error.name=name;
  await assert.rejects(use(name,()=>{throw error;}),e=>e===error);
 }
 assert.equal(calls,4);
 const snapshot=await metrics.read({now:200,windowMs:200});
 assert.deepEqual(snapshot.samples.map(x=>x.outcome),['cancelled','region-restricted','timeout','transport-error']);
 assert.ok(snapshot.samples.every(x=>x.count===1&&x.meanMs===7));
});
test('observation SQL failure does not mask request result and read failure is reported without details',async t=>{
 const {metrics,db}=fixture(t);
 db.exec('DROP TABLE dev_source_samples');
 const response={status:200};
 assert.deepEqual(await observeSourceRequest(metrics,sample,()=>response,()=>10),{response,recorded:false});
 await assert.rejects(observeSourceRequest(metrics,{...sample,synthetic:false},()=>assert.fail('request ran')),/Synthetic/);
 assert.deepEqual(await metrics.read({now:10,windowMs:1}),{status:'unavailable',samples:[]});
});
test('claim age uses time of transition and a competing claim cannot start a second attempt',async t=>{
 const {delivery}=fixture(t);
 await delivery.record(event('enqueue',0,10));
 const a=event('claim',1,100);
 const result=await Promise.all([delivery.record(a),delivery.record({...a,eventId:'other-claim'})]);
 assert.equal(result.filter(x=>x.result==='stored').length,1);
 assert.equal(result.filter(x=>x.result==='stale').length,1);
 assert.equal((await delivery.read({now:130,maxSendingAgeMs:30})).needsReview,false);
 assert.equal((await delivery.read({now:131,maxSendingAgeMs:30})).needsReview,true);
 assert.equal((await delivery.read({now:90,maxSendingAgeMs:30})).states.pending.oldestStatusAgeMs,80);
});
test('an ambiguous outcome cannot retry before manual evidence, then follows explicit retry time',async t=>{
 const {delivery}=fixture(t);
 await delivery.record(event('enqueue',0,10));
 await delivery.record(event('claim',1,20));
 await delivery.record(event('outcome-unknown',2,30));
 assert.equal((await delivery.read({now:31,maxSendingAgeMs:10})).needsReview,true);
 await assert.rejects(delivery.record(event('claim',3,31)),/Invalid delivery transition/);
 await assert.rejects(delivery.record(event('manual-not-delivered',3,31,{retryAt:50})),/evidence/);
 const checked=event('manual-not-delivered',3,31,{retryAt:50,evidence:'non-delivery-confirmed'});
 await delivery.record(checked);
 await assert.rejects(delivery.record(event('claim',4,49)),/Invalid delivery transition/);
 await delivery.record(event('claim',4,50));
 await delivery.record(event('delivered',5,51));
 assert.equal((await delivery.read({now:52,maxSendingAgeMs:10})).states.delivered.count,1);
 assert.equal((await delivery.record(checked)).result,'duplicate');
 await assert.rejects(delivery.record({...checked,retryAt:51}),/Conflicting delivery event ID/);
});
test('known rejection requires proof and confirmed manual delivery is terminal',async t=>{
 const {delivery,db}=fixture(t);
 await delivery.record(event('enqueue',0,10));
 await delivery.record(event('claim',1,11));
 await assert.rejects(delivery.record(event('rejected',2,12,{retryAt:21})),/evidence/);
 await delivery.record(event('rejected',2,12,{retryAt:21,evidence:'rejection-confirmed'}));
 await delivery.record(event('claim',3,21));
 await delivery.record(event('outcome-unknown',4,22));
 await delivery.record(event('manual-delivered',5,24,{evidence:'delivery-confirmed'}));
 await assert.rejects(delivery.record(event('claim',6,25)),/Invalid delivery transition/);
 assert.throws(()=>db.exec('DELETE FROM dev_delivery_audit'),/append-only/);
 assert.throws(()=>db.exec("UPDATE dev_delivery_audit SET status='pending'"),/append-only/);
});
test('failed writes do not advance the synthetic queue and missing storage does not report it as empty',async t=>{
 const {delivery,db}=fixture(t);
 await delivery.record(event('enqueue',0,10));
 db.exec("CREATE TRIGGER error_case BEFORE INSERT ON dev_delivery_audit BEGIN SELECT RAISE(ABORT,'write failure'); END;");
 await assert.rejects(delivery.record(event('claim',1,20)),/write failure/);
 assert.equal((await delivery.read({now:21,maxSendingAgeMs:10})).states.pending.count,1);
 db.exec('DROP TABLE dev_delivery_audit');
 assert.deepEqual(await delivery.read({now:22,maxSendingAgeMs:10}),{status:'unavailable',needsReview:null});
});
const notice=(status,now)=>({synthetic:true,health:{status,checks:['private context']},now,cooldownMs:30});
test('reports an incident and delayed recovery only once across consumers',async t=>{
 const {db,port}=fixture(t);
 const a=new HealthNotices(port),b=new HealthNotices(port);
 assert.deepEqual(await a.claim(notice('healthy',10)),{result:'unchanged'});
 const reports=await Promise.all([a.claim(notice('degraded',20)),b.claim(notice('unavailable',20))]);
 assert.equal(reports.filter(r=>r.result==='recorded'&&r.kind==='incident').length,1);
 assert.deepEqual(await a.claim(notice('unavailable',35)),{result:'unchanged'});
 assert.deepEqual(await a.claim(notice('healthy',49)),{result:'rate-limited',eligibleAt:50});
 assert.deepEqual(await b.claim(notice('healthy',50)),{result:'recorded',kind:'recovered',revision:2});
 assert.deepEqual(await a.claim(notice('healthy',51)),{result:'unchanged'});
 assert.deepEqual(await a.claim(notice('degraded',51)),{result:'rate-limited',eligibleAt:80});
 assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dev_health_notices').get().count,2);
 assert.ok(!JSON.stringify(db.prepare('SELECT * FROM dev_health_notices').all()).includes('private'));
});
test('notice deadlines reject stale observations and storage errors keep notification eligibility unknown',async t=>{
 const {db,port}=fixture(t);
 const notices=new HealthNotices(port);
 await notices.claim(notice('degraded',100));
 assert.deepEqual(await notices.claim(notice('healthy',50)),{result:'stale-time'});
 await assert.rejects(notices.claim({...notice('healthy',130),cooldownMs:0}),/notice timing/);
 db.exec("CREATE TRIGGER notice_fail BEFORE INSERT ON dev_health_notices BEGIN SELECT RAISE(ABORT,'private'); END;");
 assert.deepEqual(await notices.claim(notice('healthy',130)),{result:'unavailable'});
 assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dev_health_notices').get().count,1);
 db.exec('DROP TRIGGER notice_fail');
 assert.equal((await notices.claim(notice('healthy',131))).kind,'recovered');
});
