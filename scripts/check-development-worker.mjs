// Executes the actual scheduled Worker against a throwaway local D1 and strictly mocked fetch.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import worker from '../cloudflare/worker.mjs';
import {DEFAULTS,intervalMs,newState} from '../cloudflare/watchlist-engine.mjs';
import {observeSourceRequest,SourceMetrics} from '../cloudflare/source-metrics.mjs';
import {DeliveryAudit} from '../cloudflare/delivery-audit.mjs';
import {readHealth} from '../cloudflare/health-read.mjs';
import {HealthNotices} from '../cloudflare/health-notices.mjs';

const {Miniflare}=createRequire(import.meta.url)('miniflare');
const mf=new Miniflare({modules:true,script:'export default {}',d1Databases:['DB']});
const originalFetch=globalThis.fetch,originalNow=Date.now;
const start=Date.UTC(2026,10,27,2),minute=60_000,step=intervalMs('5m');
let now=start;
const sourceHosts=new Map([
 ['data-api.binance.vision','binance-vision'],['api.binance.com','binance-primary'],['api-gcp.binance.com','binance-gcp']
]);
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});
const row=(time,price)=>[time,price,price,price,price,0,time+step-1];
const prepareFile=(db,file,pattern)=>db.batch(readFileSync(new URL(file,import.meta.url),'utf8')
 .trim().split(pattern).map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));

try{
 const db=await mf.getD1Database('DB');
 for(const name of ['schema','operational-telemetry-schema'])
  await prepareFile(db,'../cloudflare/'+name+'.sql',/;\r?\n/);
 await prepareFile(db,'../tests/fixtures/worker-observation.sql',/;\r?\n(?=(?:CREATE|$))/);
 await db.batch([
  db.prepare('INSERT INTO dev_worker_clock VALUES(1,?)').bind(now),
  db.prepare("INSERT INTO control VALUES(1,'live','test-fixture')")
 ]);
 const metrics=new SourceMetrics(db),delivery=new DeliveryAudit(db),notices=new HealthNotices(db);
 const env={DB:db,BOT_TOKEN:'synthetic-fixture-token',CHAT_ID:'synthetic-chat'};
 let observed=0;
 let marketMode='restricted';
 let send=()=>{throw Error('Unexpected delivery');};
 const binance=[],sent=[];
 let unexpectedFetch=null;
 globalThis.fetch=async (input,options)=>{
  const url=new URL(input),source=sourceHosts.get(url.hostname);
  const operation=url.pathname.split('/').at(-1);
  const market=source&&options?.method===undefined&&['klines','time'].includes(operation);
  const telegram=url.hostname==='api.telegram.org'&&url.pathname==='/botsynthetic-fixture-token/sendMessage'&&options?.method==='POST';
  if(!market&&!telegram){
   unexpectedFetch={host:url.hostname,operation};
   throw Error('Outbound request outside fixture');
  }
  const sample={synthetic:true,id:'request-'+(++observed),source:market?source:'telegram',operation};
  const {response,recorded}=await observeSourceRequest(metrics,sample,async()=>{
   if(telegram){
    const {chat_id,text}=JSON.parse(options.body);
    assert.equal(chat_id,env.CHAT_ID);
    sent.push(text);
    return send(text);
   }
   binance.push({source,operation});
   if(operation==='time'){
    if(marketMode==='restricted')return json({code:0},451);
    if(marketMode==='gap'&&source==='binance-vision')return json({code:0},503);
    return json({serverTime:now});
   }
   assert.equal(url.searchParams.get('symbol'),'ADAUSDT');
   const complete=[row(start-2*step,95),row(start-step,89.3)];
   return json(marketMode==='gap'?complete.slice(1):complete);
  },()=>now);
  assert.equal(recorded,true);
  return response;
 };
 Date.now=()=>now;
 async function move(time){
  now=time;
  await db.prepare('UPDATE dev_worker_clock SET at=? WHERE id=1').bind(now).run();
 }
 function tick(bindings=env){
  let done;
  worker.scheduled({scheduledTime:now,cron:'* * * * *'},bindings,{waitUntil(promise){done=promise;}});
  assert.ok(done instanceof Promise);
  return done;
 }
 const getAlert=id=>db.prepare('SELECT status,receipt,next_try FROM alerts WHERE id=?').bind(id).first();
 const enqueue=(id,body)=>db.prepare("INSERT INTO alerts(id,closed,body,status) VALUES(?,?,?,'pending')").bind(id,now,body).run();
 const health=()=>readHealth(db,{now,maxTickAgeMs:2*minute,candleGraceMs:minute,pendingAgeMs:minute,dailyEnabled:false,dailyGraceMs:minute});
 const claimHealth=async()=>notices.claim({synthetic:true,health:await health(),now,cooldownMs:minute});
 const params={...DEFAULTS,symbol:'ADAUSDT',tick:.0001,qtyStep:.000001};
 const s=newState(params);
 Object.assign(s,{lastTime:start-3*step,qty:.25,average:100,invested:25,lastEntry:100,cash:774.975,cycleEquity:800,cycleStart:100});
 await db.prepare('INSERT INTO models(key,model,next_close) VALUES(?,?,?)').bind('ADAUSDT:5m',
  JSON.stringify({symbol:params.symbol,tf:'5m',params,s,entryEnabled:true}),start).run();
 const getModel=async()=>{
  const saved=await db.prepare("SELECT model,rev FROM models WHERE key='ADAUSDT:5m'").first();
  return {rev:saved.rev,state:JSON.parse(saved.model).s};
 };
 await enqueue('previous-pending','fixture: originally queued');
 send=()=>{throw new DOMException('fixture: received but acknowledgement timed out','TimeoutError');};
 await assert.rejects(tick(),error=>error?.name==='MarketDataError'&&error.code==='REGION_RESTRICTED'&&error.status===451&&error.endpoint==='time'&&error.host==='data-api.binance.vision');
 assert.deepEqual(binance,[{source:'binance-vision',operation:'time'}]);
 assert.equal((await getModel()).state.lastTime,s.lastTime);
 assert.equal((await getAlert('previous-pending')).status,'uncertain');
 assert.equal((await claimHealth()).kind,'incident');
 console.log('Worker scenario: HTTP 451 stops market fallback; acknowledgement timeout keeps delivery uncertain');

 await move(start+minute);
 marketMode='gap';
 await assert.rejects(tick(),/Failed models: ADAUSDT/);
 assert.deepEqual(binance.slice(1,3),[
  {source:'binance-vision',operation:'time'},{source:'binance-primary',operation:'time'}
 ]);
 assert.ok((await health()).checks.includes('tick-had-failures'));
 assert.equal((await getModel()).rev,0);
 assert.equal((await getModel()).state.lastTime,s.lastTime);
 assert.equal(sent.length,1);
 assert.equal((await claimHealth()).result,'unchanged');
 assert.equal((await delivery.read({now,maxSendingAgeMs:minute})).needsReview,true);

 await move(start+2*minute);
 // Confirm the mock acknowledgement directly in the isolated fixture, without a send.
 await db.prepare("UPDATE alerts SET status='delivered',receipt=1 WHERE id='previous-pending' AND status='uncertain'").run();
 marketMode='healthy';
 send=()=>json({ok:true,result:{message_id:sent.length}});
 await tick();
 const restored=await getModel();
 assert.equal(restored.rev,1);
 assert.equal(restored.state.lastTime,start-step);
 assert.equal(restored.state.dca,2);
 assert.equal(sent.length,3);
 assert.match(sent[1],/DCA 1\/5/);
 assert.match(sent[2],/DCA 2\/5/);
 assert.equal((await health()).status,'healthy');
 assert.equal((await claimHealth()).kind,'recovered');
 await tick();
 assert.equal(sent.length,3);
 assert.equal((await claimHealth()).result,'unchanged');
 const observedMetrics=await metrics.read({now,windowMs:10*minute});
 assert.ok(observedMetrics.samples.some(x=>x.outcome==='region-restricted'&&x.operation==='time'));
 assert.ok(observedMetrics.samples.some(x=>x.outcome==='timeout'&&x.source==='telegram'));
 assert.ok(observedMetrics.samples.some(x=>x.outcome==='server-error'&&x.source==='binance-vision'));
 console.log('Worker scenario: incomplete candles preserve cursor; recovery catches up DCA1 and DCA2 once');

 await move(start+3*minute);
 await enqueue('rate-limited','fixture: retry deadline');
 let markSelected,releaseSelection;
 const selected=new Promise(resolve=>{markSelected=resolve;});
 const release=new Promise(resolve=>{releaseSelection=resolve;});
 // Pause one real tick after it reads the candidate, but before it attempts its claim.
 const delayedDb={
  batch:db.batch.bind(db),
  prepare(sql){
   const statement=db.prepare(sql);
   if(!sql.startsWith('SELECT id,closed,body FROM alerts'))return statement;
   return {bind(...args){return {async all(){
    const rows=await statement.bind(...args).all();
    markSelected();
    await release;
    return rows;
   }};}};
  }
 };
 send=()=>json({ok:false,error_code:429,parameters:{retry_after:60}},429);
 const oldTick=tick({...env,DB:delayedDb});
 try{
  await Promise.race([selected,oldTick.then(()=>{throw Error('Competing tick did not select a candidate');})]);
  await tick();
  assert.equal((await getAlert('rate-limited')).next_try,now+minute);
 }finally{releaseSelection();await oldTick;}
 assert.equal(sent.length,4,'a stale candidate must not send again during a recorded cooldown');
 assert.equal((await getAlert('rate-limited')).status,'pending');
 await move(start+4*minute);
 send=()=>json({ok:true,result:{message_id:sent.length}});
 await tick();
 assert.equal(sent.length,5);
 assert.equal((await getAlert('rate-limited')).status,'delivered');
 assert.ok((await metrics.read({now,windowMs:10*minute})).samples.some(x=>x.outcome==='rate-limited'));
 console.log('Worker scenario: concurrent stale candidate respects Telegram 429 retry deadline');

 await enqueue('failed-settlement','fixture: failed D1 settlement');
 await db.prepare(`CREATE TRIGGER dev_fail_settlement BEFORE UPDATE ON alerts
  WHEN NEW.id='failed-settlement' AND NEW.status='delivered'
  BEGIN SELECT RAISE(ABORT,'fixture settlement failure'); END`).run();
 await assert.rejects(tick(),/fixture settlement failure/);
 assert.equal((await getAlert('failed-settlement')).status,'sending');
 await db.prepare('DROP TRIGGER dev_fail_settlement').run();
 await tick();
 assert.equal(sent.length,6,'restarting a tick does not resend an unsettled delivery');
 assert.equal((await delivery.read({now:now+minute+1,maxSendingAgeMs:minute})).needsReview,true);
 console.log('Worker scenario: a D1 settlement failure leaves the send for review without resending');

 for(const id of ['backlog-a','backlog-b','backlog-c'])await enqueue(id,'fixture: '+id);
 await tick();
 assert.equal(sent.length,8,'a tick delivers no more than two queued messages');
 assert.equal((await health()).queue.pending.count,1);
 await tick();
 assert.equal(sent.length,9);
 assert.equal((await health()).queue.pending.count,0);
 assert.equal((await getAlert('failed-settlement')).status,'sending');
 assert.equal(unexpectedFetch,null);
 console.log('Worker scenario: a queue backlog drains in bounded batches');

 // Excluded model and queued signal remain preserved but cannot reach market or Telegram.
 const excludedModel=JSON.stringify({symbol:'BCHUSDT',tf:'30m',params:{...params,symbol:'BCHUSDT'},s,entryEnabled:true});
 await db.prepare('INSERT INTO models(key,model,next_close,rev) VALUES(?,?,?,?)').bind('BCHUSDT:30m',excludedModel,start,7).run();
 await enqueue('BCHUSDT:30m:'+now+':START','fixture: excluded signal');
 const callsBefore=binance.length,sentBefore=sent.length;
 await tick();
 assert.equal(binance.length,callsBefore);assert.equal(sent.length,sentBefore);
 const frozen=await db.prepare("SELECT model,rev FROM models WHERE key='BCHUSDT:30m'").first();
 assert.equal(frozen.model,excludedModel);assert.equal(frozen.rev,7);
 assert.equal((await getAlert('BCHUSDT:30m:'+now+':START')).status,'pending');
 console.log('Worker scenario: excluded pair frozen; no market request or Telegram delivery');
}finally{
 Date.now=originalNow;
 globalThis.fetch=originalFetch;
 await mf.dispose();
}
