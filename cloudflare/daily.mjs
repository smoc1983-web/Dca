import {ACTIVE_KEYS,ACTIVE_KEY_SQL,ACTIVE_DAILY_SUFFIX,validateActiveModel} from './active-watchlist.mjs';
import {intervalMs} from './watchlist-engine.mjs';

const dayMs=86400000;
// Astrakhan uses UTC+4. All candle timestamps and outbox IDs remain UTC.
const localIso=ms=>new Date(ms+4*3600000).toISOString();
const clock=ms=>localIso(ms).slice(11,16);
const date=ms=>localIso(ms).slice(0,10).split('-').reverse().join('.');
const frame=tf=>tf.replace(/[mhd]$/,unit=>({m:'м',h:'ч',d:'д'})[unit]);

export function dailyText(rows,events,now){
  const groups=new Map(),waiting=[],late=[];
  const entries=rows.map(row=>JSON.parse(row.model)).filter(e=>!e.retired);
  for(const {symbol,tf,params:p,s} of entries){
    const name=symbol.replace(/USDT$/,'');
    const pair=name+' '+frame(tf);
    const lastClose=s.lastTime+intervalMs(tf);
    if(lastClose+intervalMs(tf)<=now) late.push(name+' '+clock(lastClose));
    if(!s.qty){waiting.push(pair);continue;}
    const title=s.dca?`DCA ${s.dca}/${p.drops.length}`:'Первый вход';
    if(!groups.has(title))groups.set(title,{level:s.dca,pairs:[]});
    groups.get(title).pairs.push(pair);
  }
  const models=new Set(entries.map(e=>e.symbol+':'+e.tf));
  const counts={START:0,DCA:0,TP:0,STOP:0};
  for(const {id} of events){
    const [symbol,tf,,kind]=id.split(':');
    const type=/^DCA\d+$/.test(kind)?'DCA':kind;
    if(!models.has(symbol+':'+tf)||!Object.hasOwn(counts,type))continue;
    counts[type]++;
  }
  const lines=[
    `☀️ DCA800 · ${date(now).slice(0,5)} · ${clock(now)} Астрахань`,
    `${entries.length} пар · Активных циклов модели ${entries.length-waiting.length} · Ждут входа ${waiting.length}`,
    `За 24ч · Входы ${counts.START} · DCA ${counts.DCA} · TP ${counts.TP} · STOP ${counts.STOP}`,
    ''
  ];
  for(const [title,g] of [...groups].sort((a,b)=>b[1].level-a[1].level)){
    lines.push(title+' · '+g.pairs.join(', '));
  }
  if(waiting.length)lines.push('Ждут входа · '+waiting.join(', '));
  if(late.length)lines.push('','Свечи отстают · последнее закрытие '+late.join(', '));
  return lines.join('\n');
}

export async function queueDaily(env,control,now){
  const stamp=localIso(now),day=stamp.slice(0,10);
  if(stamp.slice(11,13)<'06' && env.FIRST_SUMMARY_DAY!==day)return;
  const legacyId='DAILY:'+day;
  const id=legacyId+ACTIVE_DAILY_SUFFIX;
  // Preserve a single summary per day across the transition and keep old rows for review.
  if(await env.DB.prepare('SELECT 1 AS found FROM alerts WHERE id IN (?,?)').bind(id,legacyId).first())return;
  const [models,events]=await env.DB.batch([
    env.DB.prepare('SELECT key,model FROM models WHERE key IN ('+ACTIVE_KEY_SQL+') ORDER BY key').bind(...ACTIVE_KEYS),
    env.DB.prepare("SELECT id,closed FROM alerts WHERE closed>=? AND closed<? ORDER BY closed,id").bind(now-dayMs,now)
  ]);
  if(!models.results.length)return;
  models.results.forEach(validateActiveModel);
  const body=dailyText(models.results,events.results,now);
  await env.DB.prepare("INSERT OR IGNORE INTO alerts(id,closed,body,status) SELECT ?,?,?,'pending' FROM control WHERE id=1 AND mode='live' AND epoch=? AND NOT EXISTS(SELECT 1 FROM alerts WHERE id=?)")
    .bind(id,now,body,control.epoch,legacyId).run();
}
