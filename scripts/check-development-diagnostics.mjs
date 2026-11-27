// Runs the development Worker inside workerd with a local D1 and service-bound mocks.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DEFAULTS,intervalMs,newState} from '../cloudflare/watchlist-engine.mjs';

const {Miniflare}=createRequire(import.meta.url)('miniflare');
const token='A'.repeat(43),step=intervalMs('5m');
const root=fileURLToPath(new URL('../',import.meta.url));
const calls=[];
let globalFetches=0;
const mf=new Miniflare({
 modules:true,modulesRoot:root,scriptPath:root+'tests/fixtures/development-diagnostics-driver.mjs',
 compatibilityDate:'2026-07-30',bindings:{DEV_WORKER_MODE:'synthetic',DEV_DIAGNOSTICS_TOKEN:token},
 d1Databases:['DEV_DB'],
 outboundService:()=>{
  globalFetches++;
  return new Response('Unexpected outbound fetch',{status:500});
 },
 serviceBindings:{DEV_MOCK_NETWORK:async request=>{
  const url=new URL(request.url);
  calls.push([url.hostname,url.pathname]);
  if(url.hostname==='data-api.binance.vision'){
   if(url.pathname==='/api/v3/time')return Response.json({serverTime:Date.now()});
   assert.equal(url.pathname,'/api/v3/klines');
   assert.equal(url.searchParams.get('symbol'),'ADAUSDT');
   const from=Number(url.searchParams.get('startTime')),to=Number(url.searchParams.get('endTime'));
   const rows=[];
   for(let t=from;t<=to;t+=step)rows.push([t,95,95,95,95,0,t+step-1]);
   return Response.json(rows);
  }
  assert.equal(url.hostname,'api.telegram.org');
  assert.equal(url.pathname,'/botsynthetic-fixture-token/sendMessage');
  assert.equal(request.method,'POST');
  assert.equal((await request.json()).chat_id,'synthetic-fixture-chat');
  return Response.json({ok:true,result:{message_id:42}});
 }}
});
try{
 const db=await mf.getD1Database('DEV_DB');
 for(const name of ['schema','operational-telemetry-schema']){
  const sql=readFileSync(new URL('../cloudflare/'+name+'.sql',import.meta.url),'utf8');
  await db.batch(sql.trim().split(/;\r?\n/).map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 }
 await db.prepare("INSERT INTO control VALUES(1,'live','local-worker')").run();
 const base=Math.floor(Date.now()/step)*step;
 const params={...DEFAULTS,symbol:'ADAUSDT',tick:.0001,qtyStep:.000001};
 const s=newState(params);
 Object.assign(s,{lastTime:base-2*step,qty:.25,average:100,invested:25,lastEntry:100,cash:774.975,cycleEquity:800,cycleStart:100});
 await db.prepare('INSERT INTO models(key,model,next_close) VALUES(?,?,?)')
  .bind('ADAUSDT:5m',JSON.stringify({symbol:params.symbol,tf:'5m',params,s,entryEnabled:true}),base).run();
 const headers={Authorization:'Bearer '+token};
 const fetch=(path='/diagnostics',options={headers})=>mf.dispatchFetch('http://fixture.local'+path,options);
 const startTick=network=>fetch('/__fixture_tick',{method:'POST',headers:{'X-Fixture-Network':network}});
 assert.equal((await fetch('/diagnostics',{headers:{}})).status,401);
 assert.equal((await fetch('/diagnostics',{headers:{Authorization:'Bearer '+'B'.repeat(43)}})).status,401);
 assert.equal((await fetch('/diagnostics?credential='+token)).status,404);
 assert.equal((await fetch('/diagnostics',{headers,method:'POST'})).status,405);
 const before=await(await fetch()).json();
 assert.equal(before.sources.status,'no-samples');
 assert.equal(before.notice.status,'no-notices');
 assert.deepEqual(calls,[]);

 const timedOut=await startTick('telegram-timeout');
 assert.equal(timedOut.status,200,await timedOut.clone().text());
 assert.equal((await timedOut.json()).ran,true);
 const response=await fetch();
 assert.equal(response.status,200);
 assert.equal(response.headers.get('Cache-Control'),'no-store');
 const report=await response.json();
 assert.equal(report.health.status,'degraded');
 assert.ok(report.health.checks.includes('delivery-needs-review'));
 assert.equal(report.health.queue.uncertain.count,1);
 assert.equal(report.notice.latest.kind,'incident');
 assert.ok(report.sources.samples.some(r=>r.source==='binance-vision'&&r.operation==='klines'&&r.outcome==='ok'));
 assert.ok(report.sources.samples.some(r=>r.source==='telegram'&&r.operation==='sendMessage'&&r.outcome==='timeout'));
 const publicBody=JSON.stringify(report);
 for(const secret of [token,'synthetic-fixture-token','synthetic-fixture-chat','Synthetic timeout after acceptance','DCA 1/5','https://'])
  assert.ok(!publicBody.includes(secret),secret+' leaked through diagnostics');
 assert.equal(calls.filter(([,path])=>path.includes('sendMessage')).length,0);

 const readsBefore=await db.prepare('SELECT COUNT(*) AS total FROM dev_source_samples').first();
 const networkBefore=calls.length;
 assert.equal((await fetch()).status,200);
 assert.deepEqual(await db.prepare('SELECT COUNT(*) AS total FROM dev_source_samples').first(),readsBefore);
 assert.equal(calls.length,networkBefore);
 assert.equal((await startTick('ready')).status,200);
 assert.equal((await(await fetch()).json()).health.queue.uncertain.count,1);
 assert.equal(calls.filter(([,path])=>path.includes('sendMessage')).length,0);

 // Explicit fixture reminder: unknown sends stay pending review, while other queued messages still work.
 await db.prepare("INSERT INTO alerts(id,closed,body,status) VALUES('second-signal',?,'fixture body','pending')").bind(Date.now()).run();
 assert.equal((await startTick('ready')).status,200);
 assert.equal((await db.prepare("SELECT status FROM alerts WHERE id='second-signal'").first()).status,'delivered');
 assert.equal(calls.filter(([,path])=>path.includes('sendMessage')).length,1);
 const reviewed=await db.prepare("UPDATE alerts SET status='delivered',receipt=43 WHERE status='uncertain'").run();
 assert.equal(reviewed.meta.changes,1);
 const afterReview=await(await fetch()).json();
 assert.equal(afterReview.health.status,'healthy');
 assert.equal(afterReview.health.queue.uncertain.count,0);
 assert.equal(calls.filter(([,path])=>path.includes('sendMessage')).length,1);

 await db.prepare('DROP TABLE runs').run();
 const unavailable=await fetch();
 assert.equal(unavailable.status,503);
 assert.equal((await unavailable.json()).health.status,'unavailable');
 assert.equal(globalFetches,0);
 assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM dev_health_notices').first()).total,1);
 console.log('Workerd diagnostics: protected read-only route, no real network, Telegram timeout and health storage failure passed');
}finally{await mf.dispose();}
