// Offline selection and transition preview; no D1 writes or deployment.
export function activeMarkets(markets){
 if(!Array.isArray(markets)||markets.some(m=>!m||typeof m.symbol!=='string'||typeof m.enabled!=='boolean')||new Set(markets.map(m=>m.symbol)).size!==markets.length)throw Error('Invalid market configuration');
 return markets.filter(m=>m.enabled).map(m=>structuredClone(m));
}
export function previewMarketTransition(markets,entries){
 activeMarkets(markets);
 if(!entries||typeof entries!=='object'||Array.isArray(entries))throw Error('Invalid entries');
 const excluded=new Set(markets.filter(m=>!m.enabled).map(m=>m.symbol));
 const next=structuredClone(entries),actions=[];
 for(const [key,e] of Object.entries(next)){
  if(!excluded.has(e.symbol))continue;
  if(!e.s||typeof e.s.qty!=='number'||!Number.isFinite(e.s.qty)||e.s.qty<0||key!==e.symbol+':'+e.tf)throw Error('Invalid excluded model');
  if(e.retired&&e.s.qty>0)throw Error('Retired model has open position');
  e.entryEnabled=false;delete e.selectedParams;
  if(e.s.qty>0){e.legacy=true;e.retired=false;actions.push({key,action:'finish-existing-cycle'});}
  else{e.retired=true;actions.push({key,action:'retire-flat-model'});}
 }
 return {entries:next,actions,activeSymbols:activeMarkets(markets).map(m=>m.symbol),productionApplied:false};
}
