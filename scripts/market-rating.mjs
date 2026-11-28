// Pure informational ranking. No market selection, orders, or production access.
export const POLICY=Object.freeze({version:'draft-rank-v1',minimumDays:365,minimumClosedCycles:20,baseBps:2,costBps:Object.freeze([0,2,5,10]),weights:Object.freeze({netReturn:35,drawdown:30,costPenalty:20,cyclesPer30d:10,longestExposureDays:5})});
const DAY=86400000;
const metrics=Object.keys(POLICY.weights);
const directions={netReturn:1,drawdown:-1,costPenalty:-1,cyclesPer30d:1,longestExposureDays:-1};
const num=(x,label,min=-Infinity,max=Infinity)=>{if(!Number.isFinite(x)||x<min||x>max)throw Error('Invalid '+label);return x;};
const lex=(a,b)=>a<b?-1:a>b?1:0;
const round=x=>Math.round(x*1e6)/1e6;
export function rankMarkets({markets,observations,window,calculatedAt}){
 if(!Array.isArray(markets)||!markets.length||!Array.isArray(observations))throw Error('Invalid rating inputs');
 if(!Number.isSafeInteger(window?.start)||!Number.isSafeInteger(window?.end)||window.start<0||window.end<=window.start||!Number.isSafeInteger(calculatedAt)||calculatedAt<window.end)throw Error('Invalid rating window');
 const days=(window.end-window.start)/DAY;
 const expected=new Map();
 for(const m of markets){
  if(!/^[A-Z0-9]+USDT$/.test(m.symbol)||! /^[1-9][0-9]*[mhd]$/.test(m.tf)||typeof m.enabled!=='boolean'||expected.has(m.symbol))throw Error('Invalid market registry');
  expected.set(m.symbol,m);
 }
 const seen=new Set(),rows=[];
 for(const o of observations){
  const m=expected.get(o.symbol);
  if(!m||seen.has(o.symbol)||m.tf!==o.tf||o.start!==window.start||o.end!==window.end||! /^[a-f0-9]{64}$/.test(o.dataSha256))throw Error('Invalid observation identity');
  seen.add(o.symbol);
  if(!Array.isArray(o.costs)||o.costs.length!==4||new Set(o.costs.map(c=>c.bps)).size!==4||o.costs.some(c=>!POLICY.costBps.includes(c.bps)))throw Error('Incomplete cost grid');
  const costs=[...o.costs].sort((a,b)=>a.bps-b.bps).map(c=>{
   const netReturn=num(c.netReturn,'net return'),drawdown=num(c.drawdown,'drawdown',0,100),cycles=num(c.cycles,'cycles',0),stops=num(c.stops,'stops',0,cycles),longestExposureDays=num(c.longestExposureDays,'exposure',0,days),realizedPnl=num(c.realizedPnl,'realized pnl'),openExitPnl=num(c.openExitPnl,'open exit pnl'),fees=num(c.fees,'fees',0);
   if(!Number.isSafeInteger(cycles)||!Number.isSafeInteger(stops)||typeof c.open!=='boolean'||! /^[a-f0-9]{64}$/.test(c.paramsSha256))throw Error('Invalid cost metrics');
   if(!c.open&&openExitPnl!==0)throw Error('Inconsistent open PnL');
   if(Math.abs(netReturn-100*(realizedPnl+openExitPnl)/800)>1e-7)throw Error('Inconsistent return');
   return {bps:c.bps,netReturn,drawdown,cycles,stops,longestExposureDays,realizedPnl,openExitPnl,fees,open:c.open,paramsSha256:c.paramsSha256};
  });
  const b=costs.find(c=>c.bps===POLICY.baseBps),worst=Math.min(...costs.map(c=>c.netReturn)),minCycles=Math.min(...costs.map(c=>c.cycles)),flags=[];
  if(days<POLICY.minimumDays)flags.push('SHORT_WINDOW');
  if(minCycles<POLICY.minimumClosedCycles)flags.push('LOW_SAMPLE');
  if(b.netReturn<0)flags.push('NEGATIVE_BASE_RETURN');
  if(worst<0)flags.push('NEGATIVE_COST_SCENARIO');
  if(b.open)flags.push('OPEN_CYCLE_AT_END');
  if(costs.some(c=>c.stops>0))flags.push('STOP_IN_COST_SCENARIO');
  const values={netReturn:b.netReturn,drawdown:b.drawdown,costPenalty:Math.max(0,b.netReturn-worst),cyclesPer30d:b.cycles*30/days,longestExposureDays:b.longestExposureDays};
  rows.push({symbol:m.symbol,tf:m.tf,enabled:m.enabled,dataSha256:o.dataSha256,status:days<POLICY.minimumDays||minCycles<POLICY.minimumClosedCycles?'insufficient-sample':'rated',values,worstCostReturn:worst,minCycles,costs,flags,score:null,rank:null,components:null});
 }
 for(const m of expected.values())if(!seen.has(m.symbol))rows.push({symbol:m.symbol,tf:m.tf,enabled:m.enabled,status:'missing-data',flags:['MISSING_DATA'],score:null,rank:null,components:null});
 const eligible=rows.filter(r=>r.status==='rated');
 for(const r of eligible){
  r.components={};
  for(const k of metrics){
   const v=r.values[k]*directions[k],worse=eligible.filter(x=>x.values[k]*directions[k]<v).length,tied=eligible.filter(x=>x.values[k]*directions[k]===v).length;
   const percentile=eligible.length===1?50:100*(worse+(tied-1)/2)/(eligible.length-1);
   r.components[k]={percentile:round(percentile),points:round(percentile*POLICY.weights[k]/100)};
  }
  r.score=round(metrics.reduce((s,k)=>s+r.components[k].points,0));
 }
 eligible.sort((a,b)=>b.score-a.score||lex(a.symbol,b.symbol));
 for(let i=0;i<eligible.length;i++)eligible[i].rank=i&&eligible[i].score===eligible[i-1].score?eligible[i-1].rank:i+1;
 const unranked=rows.filter(r=>r.status!=='rated').sort((a,b)=>lex(a.symbol,b.symbol));
 return {version:'informational-market-rating-v1',policy:POLICY,calculatedAt,window:{start:window.start,end:window.end},days,universe:markets.length,rated:eligible.length,rows:[...eligible,...unranked],recommendationAllowed:false,changesMarketSelection:false,limitations:['DRAFT_WEIGHTS_NOT_APPROVED','SELECTION_OVERLAP_NOT_OOS','INDEPENDENT_SPOT_800_PER_PAIR_NOT_PORTFOLIO','CLOSE_DRAWDOWN_NOT_LIQUIDATION','NO_REAL_EXECUTIONS']};
}
