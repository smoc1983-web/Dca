import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {readHealth,healthTransition} from '../cloudflare/health-read.mjs';

const now=Date.parse('2026-11-27T02:02:00Z'),minute=now/60_000;
const policy={now,maxTickAgeMs:120_000,candleGraceMs:30_000,pendingAgeMs:60_000,dailyEnabled:true,dailyGraceMs:60_000};
test('active health distinguishes held alerts and frozen models from live failures',async t=>{
 const {port,model,alert}=fixture(t);
 model('BCHUSDT',now-3_600_000);
 alert('BCHUSDT:30m:0:START','pending',now-3_600_000);
 alert('DAILY:2026-11-27','pending',now-3_600_000);
 alert('DAILY:2026-11-27:ACTIVE11','delivered',now-60_000);
 const health=await readHealth(port,{...policy,activeOnly:true});
 assert.equal(health.heldCount,2);
 assert.equal(health.models.frozenCount,1);
 assert.equal(health.models.missing.length,11);
 assert.equal(health.models.delayed.length,0);
 assert.equal(health.queue.pending.count,0);
 assert.equal(health.daily.status,'delivered');
 assert.ok(health.checks.includes('held-alerts-need-review'));
});
function fixture(t,mode='live'){
 const db=new DatabaseSync(':memory:');
 t.after(()=>db.close());
 db.exec(readFileSync(new URL('../cloudflare/schema.sql',import.meta.url),'utf8'));
 db.prepare("INSERT INTO control VALUES(1,?,'fixture')").run(mode);
 const port={prepare(sql){let args=[];return {bind(...values){args=values;return this;},all(){return {results:db.prepare(sql).all(...args)};}};},
  async batch(statements){return statements.map(s=>s.all());}};
 const run=(m,failed,clock=null)=>db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(m,2,failed,clock);
 const model=(symbol,lastTime,retired=false)=>db.prepare('INSERT INTO models(key,model,next_close) VALUES(?,?,?)')
  .run(symbol+':5m',JSON.stringify({symbol,tf:'5m',s:{lastTime},retired}),0);
 const alert=(id,status,closed)=>db.prepare("INSERT INTO alerts(id,status,closed,body) VALUES(?,?,?,'private message')").run(id,status,closed);
 return {db,port,run,model,alert};
}
test('candle grace excludes the boundary and retired models; empty ticks count without market clock',async t=>{
 const {port,run,model,alert}=fixture(t);
 run(minute,0);run(minute-1,0,now-60_000);
 const atExpected=now-30_000-2*300_000;
 model('BTCUSDT',atExpected);
 model('ADAUSDT',atExpected-300_000,true);
 alert('DAILY:2026-11-27','delivered',now-60_000);
 const state=await readHealth(port,policy);
 assert.equal(state.status,'healthy');
 assert.equal(state.tick.lastSuccessMinute,minute);
 assert.equal(state.tick.lastMarketTimestamp,now-60_000);
 assert.deepEqual((await readHealth(port,{...policy,now:now+1})).models.delayed.map(x=>x.key),['BTCUSDT:5m']);
});
test('detects stale ticks, queue symptoms and daily failure, with immutable read-only queries',async t=>{
 const {db,port,run,alert}=fixture(t);
 run(minute-6,0);run(minute-1,2);
 for(const [id,state] of [['p','pending'],['s','sending'],['u','uncertain'],['DAILY:2026-11-27','pending']])
  alert(id,state,now-180_000);
 db.exec('PRAGMA query_only=ON');
 const state=await readHealth(port,policy);
 assert.deepEqual(state.checks,['tick-stale','tick-had-failures','pending-backlog','old-signal-still-sending','delivery-needs-review','daily-summary-unconfirmed']);
 assert.equal(state.queue.pending.count,2);
 assert.equal(state.queue.sending.oldestEventAgeMs,180_000);
 assert.ok(!JSON.stringify(state).includes('private message'));
});
test('shadow suppresses live queue checks, reports unreadable model without private values',async t=>{
 const {db,port,run,alert}=fixture(t,'shadow');
 run(minute,0);
 alert('u','uncertain',now-180_000);
 db.prepare('INSERT INTO models(key,model,next_close) VALUES(?,?,?)').run('private-key','private-payload',0);
 const state=await readHealth(port,policy);
 assert.deepEqual(state.checks,['model-state-unreadable']);
 assert.deepEqual(state.models.unreadable,['unknown']);
 assert.equal(state.daily.expected,false);
 assert.ok(!JSON.stringify(state).includes('private-'));
});
test('reports storage error without exception content, rejects missing thresholds and detects recovery once',async()=>{
 const broken={prepare(){throw Error('private database error');}};
 const down=await readHealth(broken,policy);
 assert.deepEqual(down,{status:'unavailable',checks:['storage-unavailable']});
 await assert.rejects(readHealth(broken,{now}),/Explicit health time/);
 const healthy={status:'healthy'};
 assert.equal(healthTransition(healthy,down),'incident');
 assert.equal(healthTransition(down,healthy),'recovered');
 assert.equal(healthTransition(healthy,healthy),null);
});
