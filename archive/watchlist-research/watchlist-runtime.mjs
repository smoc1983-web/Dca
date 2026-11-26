import fs from 'node:fs';import path from 'node:path';
import {DEFAULTS,newState,advance,intervalMs,message,candle} from './watchlist-engine.mjs';
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
  const p={...entry.params,symbol:entry.symbol,exitOnly:entry.legacy||!entry.entryEnabled||legacyPosition||cycleLimit||c.closeTime<(settings.latestActionableFrom??-Infinity),availableAllocation:available};
  const beforeCash=entry.s.cash,result=advance(entry.s,c,p,entry.tf);
  if(settings.budgetMode==='shared')state.portfolio.cash+=entry.s.cash-beforeCash;
  if(entry.legacy&&entry.s.qty===0){
    if(entry.selectedParams){entry.params=entry.selectedParams;entry.legacy=false;}
    else entry.retired=true;
  }
  return result?.event??null;
}
export function queue(state,entry,event,now,maxAge){
  if(!event||event.closeTime<state.activatedAt||state.outbox.some(x=>x.id===event.id))return;
  state.outbox.push({id:event.id,event,text:message(entry.tf,event,entry.params),status:now-event.closeTime>maxAge*1000?'expired':'pending'});
}
export async function main({app,bridge,atomic}){
  const config=JSON.parse(fs.readFileSync(path.join(app,'config.json'),'utf8'));
  const settings=config.watchlist;if(!settings)throw Error('Watchlist is not configured');
  const {assertActive}=await import('./activation.mjs');
  const guard=()=>assertActive({directories:[app,config.serviceDirectory],ownerComputer:config.ownerComputer});
  const runtime=path.resolve(app,config.runtimeDirectory),stateFile=path.join(runtime,'watchlist-state.json'),statusFile=path.join(app,'status.json');
  const marketTime=async()=>Number((await bridge({operation:'market',endpoint:'time',parameters:{}})).serverTime);
  const log=(kind,fields={})=>fs.appendFileSync(path.join(runtime,'watchlist-events.jsonl'),JSON.stringify({at:new Date().toISOString(),kind,...fields})+'\n');
  const load=()=>JSON.parse(fs.readFileSync(stateFile,'utf8'));
  const save=s=>atomic(stateFile,s);
  const summarize=(s,health)=>({service:'DCA800 watchlist',pid:process.pid,mode:config.mode,updatedAt:new Date().toISOString(),lastSuccessfulPoll:s.lastSuccessfulPoll??null,health,dependsOnTradingView:false,budgetMode:settings.budgetMode,maxActiveCycles:settings.maxActiveCycles??null,allocation:allocated(s),allocationLimit:settings.budgetMode==='shared'?settings.totalBudget*settings.maxUsage:null,
    timeframes:Object.fromEntries(Object.entries(s.entries).map(([key,e])=>[key,{symbol:e.symbol,tf:e.tf,lastClosedCandle:e.s.lastTime===null?null:new Date(e.s.lastTime).toISOString(),quantity:e.s.qty,invested:e.s.invested,average:e.s.average,tp:e.s.qty?e.s.average*1.03:null,dca:e.s.dca,legacy:e.legacy,retired:e.retired??false,entryEnabled:e.entryEnabled}])),deliveries:s.outbox.slice(-20).map(({id,status,message_id})=>({id,status,message_id}))});
  async function prepare(){
    if(fs.existsSync(stateFile))throw Error('Watchlist state exists; preparation refused');
    const now=await marketTime(),markets=JSON.parse(fs.readFileSync(path.join(app,'markets.json'),'utf8'));
    const old=JSON.parse(fs.readFileSync(path.join(runtime,'state.json'),'utf8'));
    const state={version:2,activatedAt:now,entries:{},outbox:old.outbox??[]};
    for(const market of markets){
      const {symbol,tf,params}=market,key=symbol+':'+tf;
      if(symbol==='UNIUSDT'&&old.engines[tf]){
        const s=structuredClone(old.engines[tf]),legacy=s.qty>0;
        state.entries[key]={symbol,tf,params:legacy?{...params,qtyStep:.001}:params,s,entryEnabled:market.enabled,legacy,selectedParams:legacy?params:undefined};continue;
      }
      const step=intervalMs(tf),end=Math.floor(now/step)*step,start=Math.max(Date.parse('2025-01-01T00:00:00Z'),end-1000*step);
      const bars=await fetchBars(bridge,symbol,tf,start,end),s=newState(params);
      if(bars.length<200)throw Error(symbol+' insufficient warmup');
      for(const c of bars)advance(s,c,{...params,exitOnly:true},tf);
      state.entries[key]={symbol,tf,params,s,entryEnabled:market.enabled,legacy:false};console.log('Prepared '+key+' '+bars.length+' candles');
    }
    for(const [tf,s] of Object.entries(old.engines)){
      const key='UNIUSDT:'+tf;if(s.qty<=0||state.entries[key])continue;
      state.entries[key]={symbol:'UNIUSDT',tf,params:{...DEFAULTS,symbol:'UNIUSDT',baseAsset:'UNI',quoteAsset:'USDT'},s:structuredClone(s),entryEnabled:false,legacy:true};
    }
    for(const item of state.outbox)if(item.status==='sending')item.status='uncertain';
    state.portfolio={cash:settings.totalBudget-Object.values(state.entries).reduce((sum,e)=>sum+e.s.qty*e.s.average,0)};
    state.activatedAt=await marketTime();save(state);console.log('PREPARED; no messages sent; old UNI cycles retained');
  }
  async function poll(state,diagnostic=false){
    const now=await marketTime(),pending=[];
    for(const [key,e] of Object.entries(state.entries)){
      if(e.retired)continue;const step=intervalMs(e.tf),end=Math.floor(now/step)*step;
      if(e.s.lastTime+step<end){
        const bars=await fetchBars(bridge,e.symbol,e.tf,e.s.lastTime+step,end);
        for(const c of bars)pending.push({key,c});
      }
    }
    // Replay all symbols chronologically; deterministic symbol order breaks ties.
    // It defines allocation priority rather than pretending all assets have separate cash.
    pending.sort((a,b)=>a.c.closeTime-b.c.closeTime||a.key.localeCompare(b.key));
    for(const {key,c} of pending){const e=state.entries[key],event=stepEntry(state,key,c,{...settings,latestActionableFrom:diagnostic?-Infinity:Math.max(state.activatedAt,now-config.maxSignalAgeSeconds*1000)});if(!diagnostic){queue(state,e,event,now,config.maxSignalAgeSeconds);save(state);}}
    if(!diagnostic&&config.mode==='live'){
      for(const item of state.outbox.filter(x=>x.status==='pending')){
        if(!item.event||now-item.event.closeTime>config.maxSignalAgeSeconds*1000){item.status='expired';save(state);continue;}
        guard();item.status='sending';save(state);
        try{const receipt=await bridge({operation:'telegram',method:'sendMessage',chat_id:'[CHAT_ID_REDACTED]',text:item.text});item.status='delivered';item.message_id=receipt.message_id;log('telegram_delivered',{id:item.id,message_id:receipt.message_id});}
        catch{item.status='uncertain';log('telegram_uncertain',{id:item.id});}
        save(state);
      }
    }
    state.lastSuccessfulPoll=new Date().toISOString();if(!diagnostic){save(state);atomic(statusFile,summarize(state,'ok'));}
    return {ok:true,entries:Object.keys(state.entries).length,catchUpBars:pending.length,messagesSent:0,stateChanged:false};
  }
  const arg=process.argv[2]??'--run';
  if(arg==='--prepare')return prepare();
  if(arg==='--check'){console.log(JSON.stringify({market:{serverTime:await marketTime()},bot:await bridge({operation:'telegram',method:'getMe'})}));return;}
  if(arg==='--diagnose'){console.log(JSON.stringify({...await poll(load(),true),bot:await bridge({operation:'telegram',method:'getMe'})}));return;}
  if(arg==='--status'){console.log(fs.readFileSync(statusFile,'utf8'));return;}
  if(!['--run','--once'].includes(arg))throw Error('Unsupported command');
  guard();const lock=path.join(runtime,'process.lock');
  if(fs.existsSync(lock)){
    const pid=Number(fs.readFileSync(lock,'utf8'));try{process.kill(pid,0);throw Error('An instance is already running');}catch(e){if(e.code!=='ESRCH')throw e;}fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock,String(process.pid),{flag:'wx'});process.on('exit',()=>{try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}});
  const state=load();for(const item of state.outbox)if(item.status==='sending')item.status='uncertain';save(state);
  do{
    try{await poll(state);}catch(e){log('poll_failed',{error:e.message});atomic(statusFile,summarize(state,'network_or_data_error'));if(arg==='--once')throw e;}
    if(arg==='--once')break;await new Promise(r=>setTimeout(r,config.pollSeconds*1000));
  }while(true);
}
