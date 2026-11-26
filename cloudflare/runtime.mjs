import {advance,intervalMs,candle} from './watchlist-engine.mjs';
const BASE={'45m':'15m','3h':'1h'};
export async function fetchBars(bridge,symbol,tf,start,end){
  const step=intervalMs(tf),base=BASE[tf]??tf,baseStep=intervalMs(base),result=[];let cursor=start;
  end=Math.floor(end/step)*step;
  while(cursor<end){
    const finish=Math.min(end,cursor+baseStep*1000);
    const rows=await bridge({operation:'market',endpoint:'klines',parameters:{symbol,interval:base,startTime:cursor,endTime:finish-1,limit:1000}});
    if(!Array.isArray(rows)||!rows.length)throw Error(symbol+' '+tf+': missing candles');
    const batch=rows.map(candle);if(batch[0].time!==cursor)throw Error(symbol+' '+tf+': history starts after requested time');
    if(batch.some((c,i)=>c.closeTime!==c.time+baseStep-1||c.time>=finish||(i>0&&c.time!==batch[i-1].time+baseStep)))throw Error('Gap or invalid close time in market candles');
    result.push(...batch);cursor=batch.at(-1).time+baseStep;
  }
  if(base===tf)return result;
  const grouped=[];const ratio=step/baseStep;
  for(let i=0;i<result.length;i+=ratio){
    const group=result.slice(i,i+ratio);if(group.length!==ratio)throw Error('Incomplete custom timeframe');
    if(group.some((c,j)=>j&&c.time!==group[j-1].time+baseStep))throw Error('Gap in custom timeframe');
    grouped.push({time:group[0].time,closeTime:group.at(-1).closeTime,open:group[0].open,close:group.at(-1).close,high:Math.max(...group.map(c=>c.high)),low:Math.min(...group.map(c=>c.low))});
  }
  return grouped;
}
export const allocated=state=>Object.values(state.entries).reduce((sum,e)=>sum+e.s.invested,0);
export function stepEntry(state,key,c,settings){
  const entry=state.entries[key];if(entry.retired)return null;
  const legacyPosition=Object.entries(state.entries).some(([other,e])=>other!==key&&e.symbol===entry.symbol&&e.legacy&&!e.retired&&e.s.qty>0);
  const activeOthers=Object.entries(state.entries).filter(([other,e])=>other!==key&&!e.retired&&e.s.qty>0).length;
  const cycleLimit=settings.budgetMode==='shared'&&activeOthers>=(settings.maxActiveCycles??Infinity);
  const available=settings.budgetMode==='shared'?Math.min(Math.max(0,settings.totalBudget*settings.maxUsage-allocated(state)),Math.max(0,state.portfolio.cash)/(1+entry.params.fee)):Infinity;
  // A stale candle must still advance the independent historical model. Age is
  // a delivery constraint, not permission to forget START and its later DCA.
  const staleSharedEntry=settings.budgetMode!=='signals'&&c.closeTime<(settings.latestActionableFrom??-Infinity);
  const p={...entry.params,symbol:entry.symbol,exitOnly:entry.legacy||!entry.entryEnabled||legacyPosition||cycleLimit||staleSharedEntry,availableAllocation:available};
  const beforeCash=entry.s.cash,result=advance(entry.s,c,p,entry.tf);
  if(settings.budgetMode==='shared')state.portfolio.cash+=entry.s.cash-beforeCash;
  if(entry.legacy&&entry.s.qty===0){
    if(entry.selectedParams){entry.params=entry.selectedParams;entry.legacy=false;}
    else entry.retired=true;
  }
  return result?.event??null;
}
