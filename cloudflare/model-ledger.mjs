// Isolated model-to-ledger adapter. Does not call Worker, Binance or Telegram.
import {advance,intervalMs} from './watchlist-engine.mjs';
import {normalizeExecution} from './trade-ledger.mjs';
const near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-9+Number.EPSILON*64*Math.max(Math.abs(a),Math.abs(b));
export function prepareModelStep({state,candle,params,tf,modelId}){
  if(typeof modelId!=='string'||!modelId.trim()||modelId.length>128)throw Error('Invalid modelId');
  if(typeof params?.symbol!=='string'||! /^[A-Z0-9]+USDT$/.test(params.symbol)||params.symbol==='USDT')throw Error('Explicit USDT pair required');
  if(!Number.isFinite(params.fee)||params.fee<0||params.fee>=1)throw Error('Invalid fee');
  const slip=params.slippageBps??0;
  if(!Number.isFinite(slip)||slip<0||slip>=10000)throw Error('Invalid slippage');
  if(!Number.isSafeInteger(candle.time)||candle.time<0||candle.closeTime!==candle.time+intervalMs(tf)-1)throw Error('Invalid candle time');
  const next=structuredClone(state);
  const result=advance(next,candle,params,tf);
  const event=result?.event??null;
  if(!event)return {state:next,event:null,operation:null};
  const start=event.kind==='START',sell=event.kind==='TP'||event.kind==='STOP';
  if(!start&&!sell&&!/^DCA[1-5]$/.test(event.kind))throw Error('Unknown event');
  const anchor=start?next.cycleStartedAt:state.cycleStartedAt;
  if(!Number.isSafeInteger(anchor)||anchor<0||anchor>candle.time)throw Error('Missing cycle origin; historical reconciliation required');
  const price=sell?event.price*(1-slip/10000):event.fillPrice;
  const quantity=event.quantity,notional=price*quantity,fee=notional*params.fee;
  const expectedCash=sell?notional-fee:-(notional+fee);
  if(!near(next.cash-state.cash,expectedCash)||!near(next.qty-state.qty,sell?-quantity:quantity))throw Error('Model fill reconciliation failed');
  const execution={source:'model',id:JSON.stringify([modelId,event.id]),cycleId:JSON.stringify([modelId,params.symbol,tf,anchor]),
    symbol:params.symbol,tf,baseAsset:params.symbol.slice(0,-4),quoteAsset:'USDT',time:candle.closeTime,
    side:sell?'sell':'buy',price,quantity,fee,feeAsset:'USDT',dca:event.dca};
  normalizeExecution(execution);
  return {state:next,event,operation:{kind:'fill',opId:JSON.stringify(['model',execution.id]),actor:'model-adapter',recordedAt:candle.closeTime,execution}};
}
// Writes the execution first, returns new cursor only after acknowledged storage.
// Caller retains original state on error. Identical replay is safe for the same modelId and parameters.
// This does not atomically commit the model cursor and ledger in D1.
export async function recordModelStep(store,input){
  const prepared=prepareModelStep(input);
  if(prepared.operation){
    const {execution:e}=prepared.operation;
    // Refuse a mid-cycle event without a previously recorded START. Never invent history.
    const snapshot=await store.snapshot();
    const cycle=snapshot.cycles.find(c=>c.source==='model'&&c.cycleId===e.cycleId);
    const existing=snapshot.executions.find(x=>x.execution.source==='model'&&x.execution.id===e.id);
    if(prepared.event.kind!=='START'&&!existing&&!cycle)throw Error('Missing recorded START; historical reconciliation required');
    if(!existing&&prepared.event.kind!=='START'&&(!near(cycle.quantity,input.state.qty)||!near(cycle.averageEntry,input.state.average)))throw Error('Ledger/model position mismatch');
    await store.write(prepared.operation);
  }
  return prepared;
}
