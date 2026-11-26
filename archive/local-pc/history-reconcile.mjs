// Pure reconciliation: caller reads inputs and performs any guarded, atomic write.
// Importing this module never starts a daemon, accesses credentials, or sends messages.
import {createHash} from 'node:crypto';
import {intervalMs} from './watchlist-engine.mjs';

const clone=value=>structuredClone(value);
const fail=message=>{throw Error('Historical-cycle reconciliation: '+message);};
const timestamp=(value,label)=>{const n=typeof value==='number'?value:Date.parse(value);if(!Number.isSafeInteger(n)||n<0)fail(label+' must be exact epoch milliseconds or an ISO date');return n;};
const positive=(value,label)=>{if(!Number.isFinite(value)||value<=0)fail(label+' must be positive');};
const same=(a,b,label)=>{if(!Number.isFinite(a)||!Number.isFinite(b)||Math.abs(a-b)>Math.max(1e-9,Math.max(Math.abs(a),Math.abs(b))*1e-10))fail(label+' mismatch');};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyOf=value=>value.key??(value.metadata?value.metadata.symbol+':'+value.metadata.tf:value.symbol+':'+value.tf);
function keyed(input,label){
  const values=Array.isArray(input)?input:Object.values(input??{}),map=new Map();
  for(const value of values){const key=keyOf(value);if(!key||key.includes('undefined')||map.has(key))fail(label+' has a missing or duplicate key: '+key);map.set(key,value);}
  return map;
}
function exactKeys(map,expected,label){if(map.size!==expected.length||expected.some(key=>!map.has(key)))fail(label+' must contain exactly the selected 20 symbol/timeframe keys');}
const strategyFields=['initialCapital','baseCash','multiplier','maxUsage','tp','rsiLength','rsiLevel','emaLength','slopeBars','maxSlopeDrop','crashBars','maxCrashDrop','emergency','fee','tick'];

function inspectLedger(replay,end,p,label){
  if(!Array.isArray(replay.ledger))fail(label+' missing complete replay ledger');
  let last=-1,open=[],cash=p.initialCapital,cycleEquity=null;
  for(const event of replay.ledger){
    if(event.time<=last||event.closeTime!==event.time+intervalMs(replay.metadata.tf)-1||event.time<timestamp(replay.metadata.historyStart,'historyStart')||event.closeTime>=timestamp(replay.metadata.endExclusive,'endExclusive'))fail(label+' ledger chronology is invalid');
    last=event.time;
    if(event.closeTime>=end)continue;
    positive(event.quantity,label+' ledger quantity');
    const fill=event.fillPrice??event.price;positive(fill,label+' ledger fill');
    if(event.kind==='START'||/^DCA[1-5]$/.test(event.kind)){
      const expected=open.length?'DCA'+open.length:'START';if(event.kind!==expected||open.length>5)fail(label+' invalid START/DCA ordering');
      if(!open.length)cycleEquity=cash;
      const amount=Math.min(p.baseCash*p.multiplier**open.length,Math.max(0,p.initialCapital*p.maxUsage-open.reduce((sum,e)=>sum+e.cash,0)));
      same(event.cash,amount,label+' planned order budget');
      same(event.quantity,Math.floor((amount/fill+1e-12)/p.qtyStep)*p.qtyStep,label+' model order quantity');
      cash-=event.quantity*fill*(1+p.fee);open.push(event);
    }else if(event.kind==='TP'||event.kind==='STOP'){
      if(!open.length)fail(label+' closes an empty cycle');
      same(event.quantity,open.reduce((sum,e)=>sum+e.quantity,0),label+' exit quantity');
      cash+=event.quantity*fill*(1-p.fee);open=[];cycleEquity=null;
    }else fail(label+' unrecognized ledger event '+event.kind);
  }
  return {open,cash,cycleEquity};
}

function verifyEvidence(replay,evidence,p,key){
  if(evidence.allMatched!==true||evidence.countMatches!==true||!Array.isArray(evidence.checks)||evidence.checks.some(c=>c.match!==true))fail(key+' chart evidence was not fully matched');
  const observed=timestamp(evidence.observedAt,key+' observedAt'),end=timestamp(evidence.replayEnd,key+' evidence replayEnd'),duration=intervalMs(replay.metadata.tf);
  if(end!==Math.floor(observed/duration)*duration||end>timestamp(replay.metadata.endExclusive,key+' replay end'))fail(key+' chart evidence chronology mismatch');
  const {open}=inspectLedger(replay,end,p,key+' evidence');
  if(open.length!==evidence.checks.length||open.length!==evidence.expectedOpenEntries||open.length!==evidence.actualOpenEntries)fail(key+' chart evidence fill count mismatch');
  evidence.checks.forEach((check,index)=>{
    const expected=check.expected,event=open[index];
    if(!expected||expected.kind!==event.kind||expected.barOpen!==event.time)fail(key+' chart evidence order/time mismatch');
    same(event.price,expected.price,key+' chart evidence price');
    positive(expected.quantityScale,key+' displayed quantity scale');
    if(!Number.isInteger(expected.quantityDecimals)||expected.quantityDecimals<0||expected.quantityDecimals>12)fail(key+' invalid displayed quantity precision');
    same(Number((event.quantity/expected.quantityScale).toFixed(expected.quantityDecimals)),expected.quantityDisplay,key+' displayed quantity');
    same(Number((event.quantity*(event.fillPrice??event.price)).toFixed(2)),expected.notionalShown??expected.notionalDisplay,key+' displayed notional');
  });
  return {observedAt:new Date(observed).toISOString(),replayEnd:new Date(end).toISOString(),evidenceSha256:digest(evidence)};
}

/**
 * Build an all-20 replacement from complete replayFromStart results and verified
 * chart-parity-validation results. Does not mutate inputs and does not perform IO.
 * replays accepts an array/keyed object; validatedEvidence also accepts {results}.
 */
export function buildReconciledState({previous,markets,replays,validatedEvidence,cutoverAt}){
  const cutoff=timestamp(cutoverAt,'cutoverAt'),marketMap=keyed(markets,'markets');
  const keys=[...marketMap.keys()];if(keys.length!==20)fail('exactly 20 selected markets are required');
  const replayMap=keyed(replays,'replays'),evidenceMap=keyed(validatedEvidence?.results??validatedEvidence,'validatedEvidence');
  exactKeys(replayMap,keys,'replays');exactKeys(evidenceMap,keys,'validatedEvidence');
  if(!previous||!previous.entries||!Array.isArray(previous.outbox))fail('previous state is incomplete');
  exactKeys(new Map(Object.entries(previous.entries)),keys,'previous state');
  const entries={};
  for(const key of keys){
    const market=marketMap.get(key),replay=replayMap.get(key),evidence=evidenceMap.get(key),p=replay.metadata?.params,s=replay.state;
    if(!p||!s||!market.params||replay.metadata.symbol!==market.symbol||replay.metadata.tf!==market.tf)fail(key+' missing or mismatched replay parameters');
    const duration=intervalMs(market.tf),end=timestamp(replay.metadata.endExclusive,key+' endExclusive'),start=timestamp(replay.metadata.historyStart,key+' historyStart');
    if(end!==Math.floor(cutoff/duration)*duration||start%duration||end<=start||s.lastTime!==end-duration||replay.metadata.bars!==(end-start)/duration)fail(key+' replay must end at the latest fully closed candle at cutover');
    if(start!==timestamp(evidence.chartHistoryDate+'T00:00:00Z',key+' chartHistoryDate'))fail(key+' chart/replay starting date mismatch');
    if(timestamp(evidence.observedAt,key+' evidence observedAt')>cutoff)fail(key+' evidence is later than cutover');
    for(const field of strategyFields)same(p[field],market.params[field],key+' strategy '+field);
    if(JSON.stringify(p.drops)!==JSON.stringify(market.params.drops))fail(key+' DCA ladder differs from selected strategy');
    positive(evidence.quantityStep,key+' chart model quantity step');same(p.qtyStep,evidence.quantityStep,key+' chart model quantity step');
    if((p.slippageBps??0)!==0||(p.minQty??0)!==0||(p.minNotional??0)!==0)fail(key+' chart replay must use zero slippage and no Binance execution minimums');
    for(const field of ['previousClose','ema'])positive(s[field],key+' '+field);
    for(const field of ['cash','qty','average','invested','gain','loss','rsi'])if(!Number.isFinite(s[field]))fail(key+' non-finite state '+field);
    if(s.cash< -1e-8||s.qty<0||s.rsi<0||s.rsi>100||!Number.isInteger(s.dca)||s.dca<0||s.dca>p.drops.length)fail(key+' invalid cycle state');
    if(!Array.isArray(s.emas)||!Array.isArray(s.highs)||s.emas.length!==p.slopeBars||s.highs.length!==p.crashBars||![...s.emas,...s.highs].every(n=>Number.isFinite(n)&&n>0))fail(key+' incomplete indicator warmup');
    const verified=verifyEvidence(replay,evidence,p,key),ledger=inspectLedger(replay,end,p,key);
    same(s.cash,ledger.cash,key+' cash from complete ledger');
    if(s.orders!==replay.ledger.length)fail(key+' order count mismatch');
    if(!Array.isArray(replay.openEntries)||replay.openEntries.length!==ledger.open.length||replay.openEntries.some((e,i)=>e.id!==ledger.open[i].id))fail(key+' replay openEntries disagree with ledger');
    if(ledger.open.length){
      const quantity=ledger.open.reduce((sum,e)=>sum+e.quantity,0),notional=ledger.open.reduce((sum,e)=>sum+e.quantity*(e.fillPrice??e.price),0);
      same(s.qty,quantity,key+' open quantity');same(s.average,notional/quantity,key+' weighted average');same(s.invested,ledger.open.reduce((sum,e)=>sum+e.cash,0),key+' invested planned budgets');
      if(s.dca!==ledger.open.length-1)fail(key+' DCA count does not match the current cycle');
      same(s.lastEntry,ledger.open.at(-1).fillPrice??ledger.open.at(-1).price,key+' last entry');same(s.cycleStart,ledger.open[0].price,key+' cycle start price');same(s.cycleEquity,ledger.cycleEquity,key+' cycle initial equity');
    }else if(s.qty!==0||s.average!==0||s.invested!==0||s.dca!==0||s.lastEntry!==null||s.cycleEquity!==null||s.cycleStart!==null)fail(key+' flat cycle retains a position');
    const modelParams={...clone(market.params),...clone(p),qtyStep:evidence.quantityStep,modelQtyStep:evidence.quantityStep,exchangeQtyStep:market.params.exchangeQtyStep??market.params.qtyStep,exchangeMinQty:market.params.exchangeMinQty??market.params.minQty??0,exchangeMinNotional:market.params.exchangeMinNotional??market.params.minNotional??0,minQty:0,minNotional:0,signalOnly:true};
    const nextState=clone(s);nextState.cycleStartedAt=ledger.open.length?ledger.open[0].time:null;
    entries[key]={symbol:market.symbol,tf:market.tf,params:modelParams,s:nextState,entryEnabled:market.enabled!==false,legacy:false,cycleSync:{source:'TradingView BINANCE spot DCARU11 executions + continuous Binance replay',...verified,historyStart:replay.metadata.historyStart,replayedThrough:new Date(end).toISOString(),reconciledAt:new Date(cutoff).toISOString(),modelQuantityStep:evidence.quantityStep,engineSha256:replay.metadata.engineSha256??null}};
  }
  const next=clone(previous);next.entries=entries;next.version=2;next.activatedAt=cutoff;
  next.portfolio={...next.portfolio,usedAsSharedWallet:false};
  next.cycleSync={version:1,source:'TradingView open executions validated for all 20 pairs; uninterrupted historical replay',reconciledAt:new Date(cutoff).toISOString(),pairCount:keys.length,deliveryCutoverAt:new Date(cutoff).toISOString(),previousActivatedAt:previous.activatedAt??null,replaySource:'historical-model',exchangePositionsImported:false};
  next.outbox=clone(previous.outbox).map(item=>{
    if(item.status==='pending')return {...item,status:'superseded',supersededAt:new Date(cutoff).toISOString(),supersededReason:'Historical model reconciled; pre-reconciliation notification must not be sent'};
    if(item.status==='sending')return {...item,status:'uncertain',uncertainAt:new Date(cutoff).toISOString(),uncertainReason:'Delivery was in flight before reconciliation; never automatically retry'};
    return item;
  });
  next.lastSuccessfulPoll=null;
  return next;
}
