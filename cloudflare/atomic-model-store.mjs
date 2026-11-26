// SQLite-tested atomic development port. No sender, no production migration.
import {newState,intervalMs} from './watchlist-engine.mjs';
import {prepareModelStep} from './model-ledger.mjs';
import {TradeLedgerStore} from './trade-store.mjs';
import {replayLedger} from './trade-ledger.mjs';
const near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-9+Number.EPSILON*64*Math.max(Math.abs(a),Math.abs(b));
function json(value){
  return JSON.stringify(value,(_,v)=>{
    if(typeof v==='number'&&!Number.isFinite(v))throw Error('Nonfinite state or configuration');
    if(v&&typeof v==='object'&&!Array.isArray(v))return Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]]));
    return v;
  });
}
function candleValue(c,tf){
  const {time,closeTime,open,high,low,close}=c;
  if(!Number.isSafeInteger(time)||time<0||closeTime!==time+intervalMs(tf)-1||
     ![open,high,low,close].every(x=>Number.isFinite(x)&&x>0)||high<Math.max(open,close)||low>Math.min(open,close))throw Error('Invalid candle');
  return {time,closeTime,open,high,low,close};
}
export class AtomicModelStore{
  constructor(db){this.db=db;this.ledger=new TradeLedgerStore(db);}
  async rows(sql,...args){return (await this.db.prepare(sql).bind(...args).all()).results;}
  async register(modelId,tf,params){
    if(typeof modelId!=='string'||!modelId.trim()||modelId.length>128)throw Error('Invalid modelId');
    if(typeof params?.symbol!=='string'||! /^[A-Z0-9]+USDT$/.test(params.symbol)||params.symbol==='USDT')throw Error('Explicit USDT pair required');
    if(!Number.isSafeInteger(intervalMs(tf))||intervalMs(tf)<=0)throw Error('Invalid timeframe');
    if(!Number.isFinite(params.initialCapital)||params.initialCapital<=0||!Number.isFinite(params.fee)||params.fee<0||params.fee>=1)throw Error('Invalid configuration');
    const config=json({tf,params});
    await this.db.prepare('INSERT INTO dev_model_registry(model_id,config) VALUES (?,?) ON CONFLICT(model_id) DO NOTHING').bind(modelId,config).run();
    const [r]=await this.rows('SELECT config FROM dev_model_registry WHERE model_id=?',modelId);
    if(!r||r.config!==config)throw Error('Model configuration mismatch');
  }
  async load(modelId){
    // Single SELECT reads model config and cursor from one SQLite snapshot.
    const [r]=await this.rows(`SELECT r.config,s.seq,s.state FROM dev_model_registry r
      LEFT JOIN dev_model_steps s ON s.seq=(SELECT MAX(seq) FROM dev_model_steps WHERE model_id=r.model_id)
      WHERE r.model_id=?`,modelId);
    if(!r)throw Error('Unknown model');
    const config=JSON.parse(r.config);
    return {config,revision:r.seq??0,state:r.state?JSON.parse(r.state):newState(config.params)};
  }
  async outbox(modelId){return this.rows('SELECT op_id,payload FROM dev_model_outbox WHERE model_id=? ORDER BY rowid',modelId);}
  async step(modelId,raw){
    for(let i=0;i<8;i++){
      const current=await this.load(modelId),{tf,params}=current.config;
      const candle=candleValue(raw,tf),encoded=json(candle);
      const [previous]=await this.rows('SELECT candle FROM dev_model_steps WHERE model_id=? AND candle_time=?',modelId,candle.time);
      if(previous){
        if(previous.candle!==encoded)throw Error('Conflicting candle replay');
        return {status:'duplicate',...(await this.load(modelId)),event:null};
      }
      if(current.state.lastTime!==null&&candle.time<=current.state.lastTime)throw Error('Unrecorded historical candle');
      const next=prepareModelStep({state:current.state,candle,params,tf,modelId});
      const snapshot=await this.ledger.snapshot();
      if(next.operation){
        const e=next.operation.execution;
        if(snapshot.executions.some(x=>x.execution.source===e.source&&x.execution.id===e.id))throw Error('Orphan ledger execution; reconciliation required');
        const cycle=snapshot.cycles.find(c=>c.source==='model'&&c.cycleId===e.cycleId);
        if(next.event.kind!=='START'&&(!cycle||!near(cycle.quantity,current.state.qty)||!near(cycle.averageEntry,current.state.average)))throw Error('Ledger/model position mismatch');
        if(next.event.kind==='START'&&cycle)throw Error('Unexpected existing cycle');
        replayLedger([...snapshot.executions.map(x=>x.execution),e]);
      }
      // A single statement is atomic, including trigger inserts. Both revisions are guarded.
      const r=await this.db.prepare(`INSERT INTO dev_model_steps(model_id,candle_time,candle,state,operation,event)
        SELECT ?,?,?,?,?,? WHERE COALESCE((SELECT MAX(seq) FROM dev_model_steps WHERE model_id=?),0)=?
        AND COALESCE((SELECT MAX(seq) FROM trade_ledger_audit),0)=?`)
        .bind(modelId,candle.time,encoded,json(next.state),next.operation?JSON.stringify(next.operation):null,next.event?JSON.stringify(next.event):null,modelId,current.revision,snapshot.revision).run();
      if(r.meta.changes===1)return {status:'stored',state:next.state,event:next.event,revision:Number(r.meta.last_row_id)};
      if(r.meta.changes!==0)throw Error('Unexpected model write result');
    }
    throw Error('Model contention: retry candle');
  }
}
