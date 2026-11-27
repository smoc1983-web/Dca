// Historical spot-fill risk overlay, NOT a futures backtest or trading permission.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateLongInput} from './prepare-long-target.mjs';
const EPS=1e-7,FUNDING=8*3600000;
export function replayProtectionProxy({datasets,report,leverage,policy,fundingRate,maintenanceRate=0.005,responseMode,markDatasets,researchAllocation}){
 if(!['none','next-close','two-closes','reject'].includes(responseMode))throw Error('Explicit response mode required');
 if(![1,2,3].includes(leverage)||!['fixed-notional','scaled-notional'].includes(policy)||![0,0.0001].includes(fundingRate)||maintenanceRate!==0.005)throw Error('Invalid proxy settings');
 const {capital,maxCycles,cycleBudget,slippageBps}=report.settings;
 if(capital!==800||maxCycles!==5||cycleBudget!==160||slippageBps!==2)throw Error('Frozen baseline required');
 const factor=policy==='scaled-notional'?leverage:1,feeRate=.001;
 // Research assumptions only: identical base allocation in all paired arms.
 const allocation=researchAllocation===undefined?{pool:100,cycleCap:20}:researchAllocation;
 if(!allocation||Object.keys(allocation).length!==2||![50,100,150,200].includes(allocation.pool)||![10,20,30,40].includes(allocation.cycleCap))throw Error('Invalid research allocation');
 const {pool,cycleCap}=allocation,baseSlot=(capital-pool)/maxCycles,drop=.20,target=10;
 if(baseSlot*maxCycles+pool!==capital)throw Error('Capital allocation invariant');
 let pending=null,requested=0,confirmed=0,rejected=0,denied=0,cancelled=0,spent=0,peakHeld=0,peakPending=0;
 const entries=datasets.map(d=>({symbol:d.params.symbol,rows:d.candles,index:(d.window.start-d.window.warmupStart)/(d.candles[1].time-d.candles[0].time),p:null,mark:null}));
 const bySymbol=new Map(entries.map(e=>[e.symbol,e]));
 // Explicit independent risk series. Never replace original spot rows or fixed fills.
 if(markDatasets!==undefined){
  if(!Array.isArray(markDatasets)||markDatasets.length!==entries.length||new Set(markDatasets.map(m=>m.symbol)).size!==entries.length)throw Error('Complete mark series required');
  for(const e of entries){
   const m=markDatasets.find(x=>x.symbol===e.symbol);
   if(!m||!Array.isArray(m.rows)||m.rows.length!==e.rows.length-e.index)throw Error('Incomplete mark alignment');
   for(let i=0;i<m.rows.length;i++){
    const r=m.rows[i],c=e.rows[e.index+i];
    if(r.time!==c.time||r.closeTime!==c.closeTime||!Number.isFinite(r.low)||!Number.isFinite(r.close)||r.low<=0||r.close<r.low)throw Error('Mark alignment mismatch');
   }
   e.markRows=m.rows;e.markOffset=e.index;
  }
 }
 if(bySymbol.size!==entries.length||!entries.length||entries.some(e=>!Number.isSafeInteger(e.index)||e.index<1))throw Error('Invalid proxy data');
 const events=report.events;
 if(events.some((e,i)=>!bySymbol.has(e.symbol)||i&&e.time<events[i-1].time))throw Error('Invalid fixed schedule');
 let wallet=capital,fees=0,funding=0,realized=0,processed=0,closed=0,peak=capital,dd=0,minMaintenance=Infinity,minReserve=Infinity,minFree=capital,peakNotional=0,first=null;
 const future=p=>Array.from({length:5-p.step},(_,i)=>5*1.5**(p.step+i+1)*factor).reduce((s,n)=>s+n/leverage+n*feeRate,0);
 const fail=(reason,e,t,phase,detail)=>{if(!first)first={reason,symbol:e.symbol,time:t,phase,...detail};};
 function assess(e,mark,t,phase){
  const p=e.p;if(!p)return;
  const n=p.qty*mark,pnl=n-p.cost,equity=p.collateral+pnl,mm=n*maintenanceRate,exit=n*feeRate;
  const mh=equity-mm-exit,rh=equity-Math.max(n/leverage,mm)-exit-future(p);
  minMaintenance=Math.min(minMaintenance,mh);minReserve=Math.min(minReserve,rh);
  if(mh<=0)fail('PROXY_MAINTENANCE_BREACH',e,t,phase,{mark,headroom:mh,step:p.step});
  else if(rh< -EPS)fail('PROXY_RESERVE_DEFICIT',e,t,phase,{mark,headroom:rh,step:p.step});
 }
 const free=()=>wallet-entries.reduce((s,e)=>s+(e.p?.collateral??0),0);
 const held=()=>entries.reduce((s,e)=>s+(e.p?.added??0),0);
 const available=()=>Math.max(0,Math.min(pool-held(),free()-(maxCycles-entries.filter(e=>e.p).length)*baseSlot));
 function propose(t,due){
  if(responseMode==='none'||pending)return;
  const candidates=due.filter(e=>e.p).map(e=>{
   const p=e.p,n=p.qty*e.mark,stressN=n*(1-drop);
   const head=p.collateral+n-p.cost-n*(maintenanceRate+feeRate);
   const stressHead=p.collateral+stressN-p.cost-stressN*(maintenanceRate+feeRate);
   const reserveHead=p.collateral+stressN-p.cost-Math.max(stressN/leverage,stressN*maintenanceRate)-stressN*feeRate-future(p);
   const need=Math.max(0,target-stressHead,-reserveHead);
   return {e,head,amount:need>EPS?Math.ceil(Math.max(1,need)*100-EPS)/100:0};
  }).sort((a,b)=>a.head-b.head||a.e.symbol.localeCompare(b.e.symbol));
  for(const c of candidates){
   if(!c.amount)continue;
   if(c.amount>Math.min(available(),cycleCap-c.e.p.added)+EPS){denied++;continue;}
   pending={symbol:c.e.symbol,position:c.e.p,amount:c.amount,requestedAt:t,bars:0};
   requested++;peakPending=Math.max(peakPending,c.amount);break;
  }
 }
 function respond(t,due){
  if(!pending||t<=pending.requestedAt)return;
  const e=bySymbol.get(pending.symbol);
  if(!due.includes(e))return;
  if(e.p!==pending.position)throw Error('Pending position identity mismatch');
  pending.bars++;
  if(pending.bars<(responseMode==='two-closes'?2:1))return;
  if(responseMode==='reject'||pending.amount>available()+EPS){rejected++;pending=null;return;}
  e.p.collateral+=pending.amount;e.p.added+=pending.amount;spent+=pending.amount;confirmed++;
  peakHeld=Math.max(peakHeld,held());pending=null;
 }
 const snapshot=()=>{
  const open=entries.filter(e=>e.p).map(e=>({symbol:e.symbol,step:e.p.step,quantity:e.p.qty,entryNotional:e.p.cost,collateral:e.p.collateral,mark:e.mark,pnl:e.p.qty*e.mark-e.p.cost}));
  const upnl=open.reduce((s,p)=>s+p.pnl,0),eq=wallet+upnl,notional=open.reduce((s,p)=>s+p.quantity*p.mark,0);
  peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak);peakNotional=Math.max(peakNotional,notional);minFree=Math.min(minFree,free());
  return {wallet,open,upnl,equity:eq};
 };
 let snap=snapshot(),lastTime=report.window.start-1;
 for(;;){
  const t=Math.min(...entries.map(e=>e.rows[e.index]?.closeTime??Infinity));
  if(t===Infinity)break;
  if(t>=report.window.end)throw Error('Unexpected bar outside window');
  const due=entries.filter(e=>e.rows[e.index]?.closeTime===t);
  // Low of each closed candle tests only the position held BEFORE the close fill.
  // Low is not an exact intrabar timestamp; no simultaneous cross-margin minima inferred.
  for(const e of due){
   const spot=e.rows[e.index],c=e.markRows?e.markRows[e.index-e.markOffset]:spot;e.index++;e.mark=c.close;e.spotClose=spot.close;
   if(e.p){assess(e,c.low,t,'pre-fill-candle-low');
    if(first)break;
    if((t+1)%FUNDING===0){const f=e.p.qty*c.close*fundingRate;e.p.collateral-=f;wallet-=f;funding+=f;}
    assess(e,c.close,t,'pre-fill-close');
    if(first)break;
   }
  }
  if(first){snap=snapshot();lastTime=t;break;}
  // Low and close must survive before any delayed confirmation at this close.
  const hadPending=!!pending;respond(t,due);
  while(processed<events.length&&events[processed].time===t){
   const f=events[processed],e=bySymbol.get(f.symbol);
   if(!due.includes(e)||e.spotClose!==f.price)throw Error('Fixed fill/candle mismatch');
   const qty=f.quantity*factor,n=qty*f.fillPrice,fee=n*feeRate;
   if(f.kind==='START'){
    if(e.p)throw Error('Overlapping fixed cycle');
    if(free()-(pending?.amount??0)+EPS<baseSlot){fail('PROXY_SLOT_COLLATERAL_UNAVAILABLE',e,t,'before-start',{freeCollateral:free()});break;}
    e.p={qty:0,cost:0,step:0,collateral:baseSlot,added:0};
   }
   if(!e.p)throw Error('Missing fixed cycle');
   if(f.kind==='TP'||f.kind==='STOP'){
    if(Math.abs(qty-e.p.qty)>EPS*Math.max(1,qty))throw Error('Fixed quantity mismatch');
    const pnl=n-e.p.cost;wallet+=pnl-fee;realized+=pnl;fees+=fee;
    if(pending?.position===e.p){pending=null;cancelled++;}
    e.p=null;closed++;
   }else{
    const step=f.kind==='START'?0:Number(f.kind.slice(3));
    if(!Number.isInteger(step)||step<0||step>5||step>0&&step!==e.p.step+1)throw Error('Fixed DCA sequence mismatch');
    e.p.step=step;e.p.qty+=qty;e.p.cost+=n;e.p.collateral-=fee;wallet-=fee;fees+=fee;
    assess(e,e.mark,t,'post-fill-close');
   }
   processed++;if(first)break;
  }
  if(processed<events.length&&events[processed].time<t)throw Error('Unmatched fixed fill');
  if(!first&&!hadPending)propose(t,due);
  snap=snapshot();lastTime=t;if(first)break;
 }
 if(!first&&processed!==events.length)throw Error('Unprocessed fixed fills');
 if(Math.abs(wallet-(capital+realized-fees-funding))>EPS*Math.max(1,capital))throw Error('Proxy wallet reconciliation failed');
 return {riskPriceSource:markDatasets===undefined?'spot':'binance-um-mark',leverage,policy,fundingRate,maintenanceRate,slotCollateral:baseSlot,responseMode,protectionPool:pool,cycleProtectionCap:cycleCap,targetHeadroom:target,adverseDropFraction:drop,requested,confirmed,rejected,denied,cancelled,cumulativeTopups:spent,peakProtectionHeld:peakHeld,peakPending,finalProtectionHeld:held(),pendingAmount:pending?.amount??0,quantityScale:factor,plannedStartNotional:5*factor,plannedLadderNotional:5*factor*Array.from({length:6},(_,i)=>1.5**i).reduce((a,b)=>a+b,0),
  status:first?'stopped-at-proxy-risk':'completed-fixed-schedule',firstRisk:first,lastTime,processedEvents:processed,totalEvents:events.length,closedCycles:closed,
  minMaintenanceHeadroom:Number.isFinite(minMaintenance)?minMaintenance:null,minReserveHeadroom:Number.isFinite(minReserve)?minReserve:null,minFreeCollateral:minFree,
  fees,funding,realizedGrossPnl:realized,openPnl:snap.upnl,observedCloseDrawdownPercent:100*dd,peakNotional,
  finalProxyEquity:first?null:snap.equity,finalProxyReturnPercent:first?null:100*(snap.equity/capital-1),
  openPositions:snap.open,recommendationAllowed:false,liquidationPrice:null};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const dir=process.argv[2],baseline=JSON.parse(readFileSync(process.argv[3],'utf8')),markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8')).filter(m=>m.enabled);
 if(markets.length!==11||baseline.version!=='long-universe-comparison-v1'||baseline.maxCycles!==5||baseline.slippageBps!==2)throw Error('Unexpected baseline');
 const report=baseline.reports[1];
 const datasets=markets.map(m=>JSON.parse(readFileSync(resolve(dir,m.symbol+'.json'),'utf8')));
 for(const d of datasets){const v=validateLongInput(d).verified;if(report.datasets.find(x=>x.symbol===d.params.symbol)?.dataSha256!==v.dataSha256)throw Error('Fixed fill provenance mismatch');}
 if(report.datasets.length!==11||Math.abs(report.metrics.netMarkedReturnPercent-29.263166610282365)>1e-8)throw Error('Prior baseline mismatch');
 const rows=[];
 for(const policy of ['fixed-notional','scaled-notional'])for(const leverage of [1,2,3])for(const responseMode of ['none','next-close','two-closes','reject']){
  const r=replayProtectionProxy({datasets,report,leverage,policy,fundingRate:.0001,responseMode});rows.push(r);console.log('PROTECTION_PROXY '+JSON.stringify(r));
 }
 writeFileSync(process.argv[4],JSON.stringify({version:'spot-path-protection-proxy-v1',baselineRun:45875049345,baselineArtifact:15144743521,period:report.window,rows,limitations:['FIXED_SPOT_SIGNALS_NOT_FUTURES_REPLAY','SPOT_LOW_NOT_MARK','HYPOTHETICAL_BASE_SLOT_140_POOL_100','SYNTHETIC_RESPONSE_AND_PROTECTION_POLICY','STOP_AT_RESERVE_DEFICIT_NOT_ACTUAL_LIQUIDATION','NO_INTRABAR_SETTLEMENT','NO_OOS','ASSUMED_FLAT_MAINTENANCE_AND_FUNDING','NO_FUTURES_FILTERS','NO_CROSS_MARGIN','NO_REAL_ORDERS','NOT_OOS']}));
}
