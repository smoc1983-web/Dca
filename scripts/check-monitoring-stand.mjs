// Reproducible local stand. Exercise real Worker entrypoints and disposable persisted D1.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {DEFAULTS,intervalMs,newState} from '../cloudflare/watchlist-engine.mjs';
import {SourceMetrics} from '../cloudflare/source-metrics.mjs';

const {Miniflare}=createRequire(import.meta.url)('miniflare');
const root=fileURLToPath(new URL('../',import.meta.url));
const storage=mkdtempSync(join(tmpdir(),'dca-health-stand-'));
const standName='dca-monitoring-test',mockName='dca-monitoring-mock';
const date='2026-07-30',step=intervalMs('5m');
const profile={sourceWindowMs:5*60_000,incidentCooldownMs:250};
let externalRequests=0;
const denyOutbound=()=>{
 externalRequests++;
 return new Response('Unexpected outbound fetch',{status:500});
};
function open(receipt){
 const token=randomBytes(32).toString('base64url');
 const mf=new Miniflare({
  host:'127.0.0.1',port:0,logRequests:false,d1Persist:storage,
  workers:[
   {name:standName,modules:true,modulesRoot:root,scriptPath:join(root,'cloudflare/development-diagnostics.mjs'),
    compatibilityDate:date,d1Databases:{DEV_DB:'dca-monitoring-stand-fixture'},outboundService:denyOutbound,
    bindings:{DEV_WORKER_MODE:'synthetic',DEV_DIAGNOSTICS_TOKEN:token,DEV_MONITORING_POLICY:profile},
    serviceBindings:{DEV_MOCK_NETWORK:mockName}},
   {name:mockName,modules:true,modulesRoot:root,scriptPath:join(root,'tests/fixtures/monitoring-stand-network.mjs'),
    compatibilityDate:date,bindings:{RECEIPT_FIXTURE:receipt},outboundService:denyOutbound}
  ]
 });
 return {mf,token,db:()=>mf.getD1Database('DEV_DB',standName),
  fetch:(path='/diagnostics',key=token)=>mf.dispatchFetch('http://monitoring.fixture'+path,{headers:{Authorization:'Bearer '+key}}),
  async tick(){
   const worker=await mf.getWorker(standName);
   assert.equal((await worker.scheduled()).outcome,'ok');
  }};
}
async function report(stand){
 const r=await stand.fetch();
 assert.equal(r.status,200);
 assert.equal(r.headers.get('Cache-Control'),'no-store');
 return r.json();
}
function sent(report){
 return report.sources.samples.filter(x=>x.source==='telegram').reduce((n,x)=>n+x.count,0);
}

let stand;
try{
 stand=open('missing');
 let db=await stand.db();
 for(const name of ['schema','operational-telemetry-schema']){
  const sql=readFileSync(new URL('../cloudflare/'+name+'.sql',import.meta.url),'utf8');
  await db.batch(sql.trim().split(/;\r?\n/).map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 }
 const now=Date.now(),base=Math.floor(now/step)*step;
 const params={...DEFAULTS,symbol:'ADAUSDT',tick:.0001,qtyStep:.000001};
 const s=newState(params);
 Object.assign(s,{lastTime:base-2*step,qty:.25,average:100,invested:25,lastEntry:100,cash:774.975,cycleEquity:800,cycleStart:100});
 await db.batch([db.prepare("INSERT INTO control VALUES(1,'live','synthetic-stand')"),
  db.prepare('INSERT INTO models(key,model,next_close) VALUES(?,?,?)')
   .bind('ADAUSDT:5m',JSON.stringify({symbol:params.symbol,tf:'5m',params,s,entryEnabled:true}),base)]);
 await new SourceMetrics(db).record({synthetic:true,id:'out-of-window',source:'binance-gcp',operation:'time',
  startedAt:now-600_001,endedAt:now-600_000,httpStatus:200});
 assert.equal((await stand.fetch('/cdn-cgi/handler/scheduled')).status,404);
 await stand.tick();
 const incident=await report(stand);
 assert.equal(incident.health.queue.uncertain.count,1);
 assert.equal(incident.notice.latest.kind,'incident');
 assert.equal(sent(incident),1);
 assert.ok(incident.sources.samples.some(r=>r.operation==='klines'&&r.outcome==='ok'));
 assert.ok(!incident.sources.samples.some(r=>r.source==='binance-gcp'));
 const beforeRestart=stand.token;
 await stand.mf.dispose();

 stand=open('confirmed');
 db=await stand.db();
 assert.equal((await stand.fetch('/diagnostics',beforeRestart)).status,401);
 await stand.tick();
 const reopened=await report(stand);
 assert.equal(reopened.health.queue.uncertain.count,1);
 assert.deepEqual(reopened.notice.latest,incident.notice.latest);
 assert.equal(sent(reopened),1);
 assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM dev_health_notices').first()).count,1);

 await db.prepare("INSERT INTO alerts(id,closed,body,status) VALUES('stand-new-signal',?,'fixture body','pending')").bind(Date.now()).run();
 await stand.tick();
 assert.equal((await db.prepare("SELECT status FROM alerts WHERE id='stand-new-signal'").first()).status,'delivered');
 assert.equal(sent(await report(stand)),2);
 const settlement=await db.prepare("UPDATE alerts SET status='delivered',receipt=72 WHERE status='uncertain'").run();
 assert.equal(settlement.meta.changes,1);
 const waitMs=Math.max(0,incident.notice.latest.recordedAt+profile.incidentCooldownMs-Date.now());
 if(waitMs)await wait(waitMs);
 await stand.tick();
 const recovered=await report(stand);
 assert.equal(recovered.health.status,'healthy');
 assert.equal(recovered.notice.latest.kind,'recovered');
 assert.equal(recovered.health.queue.uncertain.count,0);
 assert.equal(sent(recovered),2);
 await stand.tick();
 assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM dev_health_notices').first()).count,2);
 assert.equal(externalRequests,0);
 console.log('Monitoring stand: distinct mock Worker, isolated runtime restart, persistent D1, token rotation and exactly one recovery passed');
}finally{
 try{if(stand)await stand.mf.dispose();}
 finally{rmSync(storage,{recursive:true,force:true});}
}
