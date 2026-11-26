import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReconciledState} from './history-reconcile.mjs';
import {DEFAULTS,newState,intervalMs} from './watchlist-engine.mjs';

function fixture(){
  const cutoverAt=5400000001,markets=[],replays=[],results=[],entries={};
  for(let i=0;i<20;i++){
    const symbol='AAA'+String(i).padStart(2,'0')+'USDT',tf=['5m','15m','30m','45m'][i%4],key=symbol+':'+tf,step=intervalMs(tf),end=Math.floor(cutoverAt/step)*step;
    const original={...DEFAULTS,symbol,baseAsset:symbol.slice(0,-4),quoteAsset:'USDT',qtyStep:.1,minQty:.1,minNotional:5};
    const p={...original,qtyStep:1,minQty:0,minNotional:0,slippageBps:0};
    const ledger=[.25,.2375,.22325].map((price,n)=>{const cash=25*1.5**n,quantity=Math.floor(cash/price),time=end-(3-n)*step,kind=n?'DCA'+n:'START';return {id:`${key}:${time}:${kind}`,kind,time,closeTime:time+step-1,price,fillPrice:price,cash,quantity};});
    const quantity=ledger.reduce((sum,e)=>sum+e.quantity,0),notional=ledger.reduce((sum,e)=>sum+e.quantity*e.price,0),invested=ledger.reduce((sum,e)=>sum+e.cash,0);
    const state={...newState(p),lastTime:end-step,previousClose:.22325,ema:.23,emas:Array(5).fill(.23),highs:Array(10).fill(.24),gain:.001,loss:.002,rsi:20,qty:quantity,average:notional/quantity,invested,dca:2,lastEntry:.22325,cycleStart:.25,cycleEquity:800,cash:800-notional*1.001,orders:3};
    const metadata={symbol,tf,params:p,historyStart:'1970-01-01T00:00:00Z',endExclusive:new Date(end).toISOString(),bars:end/step,engineSha256:'fixture'};
    markets.push({symbol,tf,params:original,enabled:true});replays.push({metadata,state,ledger,openEntries:structuredClone(ledger)});entries[key]={symbol,tf,params:original,s:newState(original),legacy:false,entryEnabled:true};
    results.push({key,observedAt:new Date(cutoverAt).toISOString(),replayEnd:new Date(end).toISOString(),chartHistoryDate:'1970-01-01',quantityStep:1,allMatched:true,countMatches:true,expectedOpenEntries:3,actualOpenEntries:3,checks:ledger.map(event=>({match:true,expected:{kind:event.kind,barOpen:event.time,price:event.price,quantityScale:1,quantityDecimals:2,quantityDisplay:event.quantity,notionalShown:Number((event.quantity*event.price).toFixed(2))}}))});
  }
  const previous={version:2,activatedAt:1,entries,portfolio:{cash:800,usedAsSharedWallet:false},lastSuccessfulPoll:'1970-01-01T00:00:00Z',outbox:[{id:'delivered',status:'delivered',message_id:42,text:'receipt'},{id:'pending',status:'pending',text:'old incorrect start'},{id:'sending',status:'sending',text:'in flight'},{id:'expired',status:'expired'},{id:'uncertain',status:'uncertain'}]};
  return {previous,markets,replays,validatedEvidence:{results},cutoverAt};
}

test('all 20 reconciled cycles preserve broker/exchange separation and old delivery receipts without mutating inputs',()=>{
  const input=fixture(),before=structuredClone(input),result=buildReconciledState(input);
  assert.deepEqual(input,before);assert.equal(Object.keys(result.entries).length,20);assert.equal(result.activatedAt,input.cutoverAt);
  assert.deepEqual(result.outbox[0],input.previous.outbox[0]);assert.equal(result.outbox[1].status,'superseded');assert.equal(result.outbox[2].status,'uncertain');assert.deepEqual(result.outbox[3],input.previous.outbox[3]);assert.deepEqual(result.outbox[4],input.previous.outbox[4]);
  for(const entry of Object.values(result.entries)){assert.equal(entry.s.dca,2);assert.equal(entry.params.qtyStep,1);assert.equal(entry.params.modelQtyStep,1);assert.equal(entry.params.exchangeQtyStep,.1);assert.equal(entry.params.exchangeMinQty,.1);assert.equal(entry.params.exchangeMinNotional,5);assert.equal(entry.params.minQty,0);assert.equal(entry.params.minNotional,0);assert.equal(entry.s.cycleStartedAt,entry.s.lastTime-2*intervalMs(entry.tf));assert.match(entry.cycleSync.evidenceSha256,/^[a-f0-9]{64}$/);}
  assert.equal(result.cycleSync.pairCount,20);assert.equal(result.cycleSync.exchangePositionsImported,false);
});

test('missing, duplicate and mismatched market keys are rejected before producing a new state',()=>{
  for(const change of [x=>x.replays.pop(),x=>x.replays.push(structuredClone(x.replays[0])),x=>{x.replays[0].metadata.tf='1h';},x=>{delete x.previous.entries['AAA00USDT:5m'];}]){
    const input=fixture();change(input);const previous=structuredClone(input.previous);assert.throws(()=>buildReconciledState(input),/key|20|duplicate/);assert.deepEqual(input.previous,previous);
  }
});

test('qty, weighted average, DCA, cash, and incomplete bar snapshots fail without modifying prior state',()=>{
  const changes=[s=>s.qty++,s=>s.average+=.01,s=>s.dca--,s=>s.cash+=10,s=>s.lastTime+=300000,s=>s.rsi=NaN];
  for(const change of changes){const input=fixture();change(input.replays[0].state);const previous=structuredClone(input.previous);assert.throws(()=>buildReconciledState(input),/mismatch|DCA count|closed candle|non-finite/);assert.deepEqual(input.previous,previous);}
});

test('evidence is checked against replay events, not trusted based on allMatched alone',()=>{
  const input=fixture();input.validatedEvidence.results[0].checks[1].expected.barOpen-=300000;
  assert.throws(()=>buildReconciledState(input),/chart evidence order\/time/);
  const quantity=fixture();quantity.validatedEvidence.results[0].checks[1].expected.quantityDisplay++;
  assert.throws(()=>buildReconciledState(quantity),/displayed quantity/);
  const observed=fixture();observed.validatedEvidence.results[0].observedAt=new Date(observed.cutoverAt+300000).toISOString();assert.throws(()=>buildReconciledState(observed),/later than cutover/);
});

test('model execution filters or quantity step cannot silently switch back to Binance fills',()=>{
  for(const change of [p=>p.qtyStep=.1,p=>p.minNotional=5,p=>p.minQty=.1,p=>p.slippageBps=2,p=>p.tp=.04]){
    const input=fixture();change(input.replays[0].metadata.params);assert.throws(()=>buildReconciledState(input),/model quantity step|execution minimums|strategy tp/);
  }
});
