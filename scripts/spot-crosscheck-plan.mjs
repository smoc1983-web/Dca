// Offline plan only. A shared transactional quota ledger is required before any live request.
const MINUTE=60000,DAY=1440*MINUTE;
export const CROSSCHECK_POLICY=Object.freeze({version:'spot-crosscheck-draft-v1',providerDaily:1000,providerMinute:10,localDaily:950,localMinute:8,scheduledDaily:720,extraDaily:230,unallocatedDaily:50});
export function crosscheckSchedule(markets){
 if(!Array.isArray(markets)||markets.length!==19||markets.filter(m=>m.enabled===true).length!==11||markets.some(m=>typeof m.enabled!=='boolean'||! /^[A-Z0-9]+USDT$/.test(m.symbol))||new Set(markets.map(m=>m.symbol)).size!==19)throw Error('Unexpected crosscheck universe');
 const sorted=[...markets].sort((a,b)=>a.symbol<b.symbol?-1:1),jobs=[];
 for(const [i,m] of sorted.filter(m=>m.enabled).entries())jobs.push({symbol:m.symbol,enabled:true,everyMinutes:30,offsetMinute:i+2});
 for(const [i,m] of sorted.filter(m=>!m.enabled).entries())jobs.push({symbol:m.symbol,enabled:false,everyMinutes:60,offsetMinute:i+13});
 return jobs;
}
export function dueCrosschecks(markets,now){
 if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid time');
 const minute=Math.floor(now/MINUTE);
 // No backlog burst. A missed slot waits for the next slot; one trailing-window request can cover multiple bars.
 return crosscheckSchedule(markets).filter(j=>minute%j.everyMinutes===j.offsetMinute).map(j=>({...j,slot:minute,id:j.symbol+':'+minute}));
}
export function quotaDecision({now,attempts,kind}){
 if(!Number.isSafeInteger(now)||now<0||!Array.isArray(attempts)||!['scheduled','extra'].includes(kind)||attempts.some(a=>!Number.isSafeInteger(a?.time)||a.time<0||a.time>now||!['scheduled','extra'].includes(a.kind)))throw Error('Invalid quota observation');
 const recent=attempts.filter(a=>a.time>now-DAY),minute=recent.filter(a=>a.time>now-MINUTE).length,scheduled=recent.filter(a=>a.kind==='scheduled').length,extra=recent.length-scheduled;
 const p=CROSSCHECK_POLICY;
 const reason=recent.length>=p.localDaily?'daily-cap':minute>=p.localMinute?'minute-cap':kind==='scheduled'&&scheduled>=p.scheduledDaily?'scheduled-cap':kind==='extra'&&extra>=p.extraDaily?'extra-cap':null;
 return {withinDraftBudget:reason===null,reason,used24h:recent.length,used60s:minute,scheduled24h:scheduled,extra24h:extra,remainingLocal:Math.max(0,p.localDaily-recent.length),productionAllowed:false};
}
