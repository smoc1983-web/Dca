export function reconcileFlat(original,settings,{at,reason}){
  if(!Number.isFinite(at)||!reason||!Number.isFinite(settings.totalBudget)||settings.totalBudget<=0)throw Error('Invalid manual reconciliation');
  const state=structuredClone(original),positions=Object.entries(state.entries).filter(([,e])=>e.s.qty>0).map(([key,e])=>({key,quantity:e.s.qty,average:e.s.average,invested:e.s.invested,dca:e.s.dca}));
  if(!positions.length)return {state:original,changed:false,positions};
  for(const entry of Object.values(state.entries)){
    if(entry.selectedParams){entry.params=entry.selectedParams;delete entry.selectedParams;}
    Object.assign(entry.s,{cash:entry.params.initialCapital,qty:0,average:0,invested:0,dca:0,lastEntry:null,cycleEquity:null,cycleStart:null});
    entry.legacy=false;
  }
  for(const item of state.outbox)if(item.status==='pending')Object.assign(item,{status:'cancelled_manual_reconciliation',reason:'User confirmed all real positions are closed'});
  state.portfolio.cash=settings.totalBudget;state.activatedAt=at;
  (state.manualAdjustments??=[]).push({at:new Date(at).toISOString(),reason,previousModelPositions:positions,modelBudget:settings.totalBudget,ordersSentToExchange:0});
  return {state,changed:true,positions};
}
