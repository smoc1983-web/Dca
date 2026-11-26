import {createHash} from 'node:crypto';
const fmt=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Astrakhan',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const label=kind=>kind==='START'?'ВХОД':kind==='TP'?'ТЕЙК-ПРОФИТ':kind==='STOP'?'АВАРИЙНЫЙ ВЫХОД':`УСРЕДНЕНИЕ ${kind.slice(3)}/5`;
export function queueMissedReports(state,now){
  state.missedSignalReports??=[];
  const eligible=state.outbox.filter(item=>{
    const e=item.event;if(!['expired','uncertain'].includes(item.status)||item.historyReportId||!e||!Number.isFinite(e.closeTime)||e.closeTime<state.activatedAt||! /^(START|TP|STOP|DCA[1-5])$/.test(e.kind))return false;
    const [symbol,tf]=item.id.split(':');const entry=state.entries[symbol+':'+tf];
    return entry&&!entry.retired;
  }).sort((a,b)=>a.event.closeTime-b.event.closeTime||a.id.localeCompare(b.id));
  const groups=[];let group=[],length=0;
  for(const item of eligible){
    const [symbol,tf]=item.id.split(':'),frame=tf.endsWith('m')?tf.slice(0,-1)+' мин':tf.endsWith('h')?tf.slice(0,-1)+' ч':tf;
    const line=`${fmt.format(new Date(item.event.closeTime+1))} | ${symbol} | ${frame} | ${label(item.event.kind)} | цена ${item.event.price}`;
    if(length+line.length+1>2900&&group.length){groups.push(group);group=[];length=0;}
    group.push({item,line});length+=line.length+1;
  }
  if(group.length)groups.push(group);
  for(let i=0;i<groups.length;i++){
    const batch=groups[i],eventIds=batch.map(x=>x.item.id),id='missed:'+createHash('sha256').update(eventIds.join('\n')).digest('hex').slice(0,24);
    const text=`DCA800 | ПРОПУЩЕННЫЕ СИГНАЛЫ\nИсторическая сводка после перерыва или задержки получения данных.\nВремя закрытия свечи — Астрахань (UTC+4).\nСобытий в этой части: ${batch.length}${groups.length>1?`; часть ${i+1}/${groups.length}`:''}.\n\n${batch.map(x=>x.line).join('\n')}\n\nЭто история модели, а не новые сигналы для входа. Состояние стратегии восстановлено с учётом этих событий.`;
    if(!state.missedSignalReports.some(r=>r.id===id))state.missedSignalReports.push({id,eventIds,text,status:'pending',createdAt:new Date(now).toISOString()});
    for(const {item} of batch)item.historyReportId=id;
  }
  return groups.length;
}
export function recoverMissedReports(state){for(const report of state.missedSignalReports??[])if(['sending','uncertain'].includes(report.status)){report.status='pending';report.possibleDuplicate=true;report.nextAttemptAt??=0;}}
export function retryMissedReport(report,now){report.status='pending';report.possibleDuplicate=true;report.nextAttemptAt=now+Math.min(300000,60000*2**Math.min(3,(report.attempts??1)-1));}
export function missedDeliveryText(report){return report.text+(report.possibleDuplicate?'\n\nПовторная попытка доставки истории: прошлый ответ Telegram не получен. Если эта сводка уже приходила, повторно учитывать события не нужно.':'');}
