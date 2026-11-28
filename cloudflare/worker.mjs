import {ACTIVE_KEYS,ACTIVE_KEY_SQL,EXCLUDED_SYMBOLS,EXCLUDED_ALERT_SQL,validateActiveModel} from './active-watchlist.mjs';
import {fetchBars,stepEntry} from './runtime.mjs';
import {intervalMs,message} from './watchlist-engine.mjs';
import {queueDaily} from './daily.mjs';

import {createMarketReader,readMarketClock} from './market-reader.mjs';

const defaultRequest=(url,options)=>fetch(url,options);
const market=createMarketReader();

export async function advanceModel(entry,end,read=market) {
  const step=intervalMs(entry.tf), key=entry.symbol+':'+entry.tf;
  const start=entry.s.lastTime+step;
  // Limit recovery cost per tick. The persisted cursor resumes the next batch.
  const bars=await fetchBars(read,entry.symbol,entry.tf,start,Math.min(end,start+24*step));
  const events=[];
  for(const bar of bars) {
    const event=stepEntry({entries:{[key]:entry}},key,bar,{budgetMode:'signals'});
    if(event) events.push({id:event.id,closed:event.closeTime,body:message(entry.tf,event,entry.params)});
  }
  return events;
}

async function processModel(db,row,control,now,read) {
  const entry=validateActiveModel(row);
  const events=await advanceModel(entry,now,read);
  const guard='EXISTS(SELECT 1 FROM control WHERE id=1 AND epoch=? AND mode=?)';
  const writes=events.map(e=>db.prepare(
    'INSERT OR IGNORE INTO alerts(id,closed,body,status) SELECT ?,?,?,? FROM models WHERE key=? AND rev=? AND '+guard
  ).bind(e.id,e.closed,e.body,control.mode==='live'?'pending':'shadow',row.key,row.rev,control.epoch,control.mode));
  writes.push(db.prepare('UPDATE models SET model=?,next_close=?,rev=rev+1 WHERE key=? AND rev=? AND '+guard)
    .bind(JSON.stringify(entry),entry.s.lastTime+2*intervalMs(entry.tf),row.key,row.rev,control.epoch,control.mode));
  await db.batch(writes);
}

async function deliver(env,control,request) {
  const db=env.DB;
  if(!env.BOT_TOKEN || !env.CHAT_ID) throw Error('Missing Telegram configuration');
  const ready=control.mode==='live'?'pending':'test_pending';
  const {results}=await db.prepare("SELECT id,closed,body FROM alerts WHERE status=? AND next_try<=? AND "+EXCLUDED_ALERT_SQL+" ORDER BY closed,id LIMIT 2").bind(ready,Date.now(),...EXCLUDED_SYMBOLS).all();
  for(const a of results) {
    const claim=await db.prepare("UPDATE alerts SET status='sending' WHERE id=? AND status=? AND next_try<=? AND EXISTS(SELECT 1 FROM control WHERE mode=? AND epoch=?) AND "+EXCLUDED_ALERT_SQL).bind(a.id,ready,Date.now(),control.mode,control.epoch,...EXCLUDED_SYMBOLS).run();
    if(!claim.meta.changes) continue;
    const delayed=control.mode==='live' && !a.id.startsWith('DAILY:') && Date.now()-a.closed>180000;
    const signalTime=delayed?new Date(a.closed+1).toLocaleString('ru-RU',{
      timeZone:'Europe/Astrakhan',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false
    }):null;
    const body=signalTime?`Пропущенный сигнал · ${signalTime} (Астрахань)\n${a.body}`:a.body;
    let status='uncertain',receipt=null,next=0;
    try {
      const r=await request('https://api.telegram.org/bot'+env.BOT_TOKEN+'/sendMessage',{
        method:'POST',headers:{'Content-Type':'application/json'},redirect:'manual',signal:AbortSignal.timeout(12000),
        body:JSON.stringify({chat_id:env.CHAT_ID,text:body})
      });
      const reply=await r.json();
      if(reply.ok && reply.result?.message_id) {status='delivered';receipt=reply.result.message_id;}
      else if(reply.ok===false) {
        status=ready;next=Date.now()+1000*Math.max(60,Number(reply.parameters?.retry_after)||60);
      }
    } catch { /* An absent receipt can mean Telegram already posted the message. */ }
    await db.prepare('UPDATE alerts SET status=?,receipt=?,next_try=? WHERE id=?').bind(status,receipt,next,a.id).run();
    if(status===ready) break;
  }
}

async function deliverLive(env,control,now,request){
  if(env.DAILY_SUMMARY==='on'){
    try{await queueDaily(env,control,now);}
    catch(error){console.error('Daily summary:',error.message);}
  }
  await deliver(env,control,request);
}

export async function tick(env,{request=defaultRequest}={}) {
  const read=options=>market(options,request);
  const control=await env.DB.prepare('SELECT * FROM control WHERE id=1').first();
  if(!control) return;
  if(control.mode==='shadow' && env.BOT_TOKEN && env.CHAT_ID) await deliver(env,control,request);
  const now=Date.now(),minute=Math.floor(now/60000);
  const {results}=await env.DB.prepare('SELECT * FROM models WHERE next_close<=? AND key IN ('+ACTIVE_KEY_SQL+') ORDER BY next_close,key LIMIT 10').bind(now,...ACTIVE_KEYS).all();
  let serverTime=null;
  if(results.length) {
    try {
      serverTime=await readMarketClock(read);
    } catch(error) {
      if(control.mode==='live') await deliverLive(env,control,now,request);
      await env.DB.prepare('INSERT OR REPLACE INTO runs VALUES(?,?,?,?)').bind(minute,0,results.length,null).run();
      throw error;
    }
  }
  const failures=[];
  for(const row of results) {
    if(row.next_close>serverTime) continue;
    try {await processModel(env.DB,row,control,serverTime,read);}
    catch(err) {failures.push(row.key);console.error(row.key,err.message);}
  }
  if(control.mode==='live') await deliverLive(env,control,now,request);
  await env.DB.prepare('INSERT OR REPLACE INTO runs VALUES(?,?,?,?)').bind(minute,results.length,failures.length,serverTime).run();
  if(minute%60===0) await env.DB.batch([
    env.DB.prepare('DELETE FROM runs WHERE minute<?').bind(minute-1440),
    env.DB.prepare("DELETE FROM alerts WHERE status IN ('delivered','shadow') AND closed<?").bind(now-90*86400000)
  ]);
  if(failures.length) throw Error('Failed models: '+failures.join(','));
}
export default {scheduled(_event,env,ctx){ctx.waitUntil(tick(env));}};
