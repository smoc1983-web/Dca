// Read-only development diagnostics over the existing schema. No network or sender.
import {intervalMs} from './watchlist-engine.mjs';
import {ACTIVE_KEYS, ACTIVE_DAILY_SUFFIX, EXCLUDED_SYMBOLS, EXCLUDED_ALERT_SQL} from './active-watchlist.mjs';

const validTime=value=>Number.isSafeInteger(value)&&value>=0;
const HOUR=3_600_000;
const DAY=24*HOUR;
const localOffset=4*HOUR;

function inspectModels(rows,now,grace){
 const delayed=[],unreadable=[];
 for(const {key,model} of rows){
  try{
   const m=JSON.parse(model);
   if(m.retired===true)continue;
   const frame=typeof m.tf==='string'&&/^[1-9][0-9]*[mhd]$/.test(m.tf)?intervalMs(m.tf):null;
   if(!validTime(frame)||frame===0||key!==m.symbol+':'+m.tf||
      !/^[A-Z0-9]+USDT$/.test(m.symbol)||!validTime(m.s?.lastTime)||m.s.lastTime+frame>now)
    throw Error('Invalid model clock');
   const lastClose=m.s.lastTime+frame;
   const nextExpected=lastClose+frame;
   if(now>nextExpected+grace)delayed.push({key,lastClose,overdueMs:now-nextExpected});
  }catch{unreadable.push(typeof key==='string'&&/^[A-Z0-9]+USDT:[1-9][0-9]*[mhd]$/.test(key)?key:'unknown');}
 }
 return {delayed,unreadable};
}
const decision=(checks,extra)=>({status:checks.length?'degraded':'healthy',checks,...extra});

export async function readHealth(db,{now,maxTickAgeMs,candleGraceMs,pendingAgeMs,dailyEnabled,dailyGraceMs,activeOnly=false}={}){
 if(!validTime(now)||now>8.64e15-localOffset||![maxTickAgeMs,candleGraceMs,pendingAgeMs,dailyGraceMs].every(validTime)||
    typeof dailyEnabled!=='boolean')throw Error('Explicit health time and thresholds required');
 const dayStart=Math.floor((now+localOffset)/DAY)*DAY-localOffset;
 const dailyId='DAILY:'+new Date(dayStart+localOffset).toISOString().slice(0,10);
 const minute=Math.floor(now/60_000);
 let data;
 try{
 const statuses="status IN ('pending','sending','uncertain')";
 const pendingQuery=activeOnly
  ? db.prepare("SELECT status,COUNT(*) AS count,MIN(closed) AS oldest,CASE WHEN "+EXCLUDED_ALERT_SQL+
    " THEN 0 ELSE 1 END AS held FROM alerts WHERE "+statuses+" GROUP BY status,held").bind(...EXCLUDED_SYMBOLS)
  : db.prepare("SELECT status,COUNT(*) AS count,MIN(closed) AS oldest FROM alerts WHERE "+statuses+" GROUP BY status");
  data=await db.batch([
   db.prepare('SELECT mode FROM control WHERE id=1'),
   db.prepare('SELECT minute,checked,failures FROM runs WHERE minute<=? ORDER BY minute DESC LIMIT 1').bind(minute),
   db.prepare('SELECT minute FROM runs WHERE minute<=? AND failures=0 ORDER BY minute DESC LIMIT 1').bind(minute),
   db.prepare('SELECT market_time FROM runs WHERE minute<=? AND market_time IS NOT NULL ORDER BY minute DESC LIMIT 1').bind(minute),
   db.prepare('SELECT key,model FROM models ORDER BY key'),
   pendingQuery,
   db.prepare("SELECT status FROM alerts WHERE id=? OR (id=? AND status='delivered') ORDER BY id DESC LIMIT 1")
    .bind(activeOnly?dailyId+ACTIVE_DAILY_SUFFIX:dailyId,dailyId)
  ]);
 }catch{return {status:'unavailable',checks:['storage-unavailable']};}
 const [[control],[latest],[successful],[clock],models,pending,[daily]]=data.map(x=>x.results);
 const mode=control?.mode??null,checks=[];
 const lastSuccessMinute=successful?.minute??null;
 if(mode===null)checks.push('control-missing');
 // Run telemetry is minute precision. Allow the rest of the recorded minute.
 if(lastSuccessMinute===null||now-(lastSuccessMinute+1)*60_000>maxTickAgeMs)checks.push('tick-stale');
 if(latest?.failures>0)checks.push('tick-had-failures');
 const frozen=activeOnly?models.filter(row=>EXCLUDED_SYMBOLS.includes(row.key.split(':')[0])):[];
 const {delayed,unreadable}=inspectModels(models.filter(row=>!frozen.includes(row)),now,candleGraceMs);
 const missing=activeOnly?ACTIVE_KEYS.filter(key=>!models.some(row=>row.key===key)):[];
 if(missing.length)checks.push('active-models-missing');
 if(delayed.length)checks.push('candles-overdue');
 if(unreadable.length)checks.push('model-state-unreadable');
 const queue=Object.fromEntries(['pending','sending','uncertain'].map(status=>{
  const row=pending.find(x=>x.status===status&&!x.held);
  return [status,{count:row?.count??0,oldestEventAgeMs:validTime(row?.oldest)?Math.max(0,now-row.oldest):null}];
 }));
 const held=pending.filter(row=>row.held).reduce((sum,row)=>sum+row.count,0);
 if(mode==='live'){
  if(queue.pending.oldestEventAgeMs>pendingAgeMs)checks.push('pending-backlog');
  if(queue.sending.oldestEventAgeMs>pendingAgeMs)checks.push('old-signal-still-sending');
  if(queue.uncertain.count>0)checks.push('delivery-needs-review');
  if(held>0)checks.push('held-alerts-need-review');
 }
 const dailyExpected=dailyEnabled&&mode==='live'&&now>=dayStart+6*HOUR+dailyGraceMs;
 if(dailyExpected&&daily?.status!=='delivered')checks.push('daily-summary-unconfirmed');
 return decision(checks,{mode,tick:{latest:latest??null,lastSuccessMinute,lastMarketTimestamp:clock?.market_time??null},
  models:{delayed,unreadable,...(activeOnly?{frozenCount:frozen.length,missing}:{} )},
  queue,daily:{expected:dailyExpected,status:daily?.status??null},...(activeOnly?{heldCount:held}:{})});
}

// Transition is a value for a future consumer. It does not write or resend any signal.
export function healthTransition(previous,current){
 if(!previous||!current||previous.status===current.status)return null;
 return current.status==='healthy'?'recovered':previous.status==='healthy'?'incident':null;
}
