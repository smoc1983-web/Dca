// D1-shaped storage port; local SQLite tests only. No Worker wiring or network.
import {normalizeExecution,replayLedger} from './trade-ledger.mjs';
const key=e=>JSON.stringify([e.source,e.id]);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const required=(v,n)=>{if(typeof v!=='string'||!v.trim()||v.length>512)throw Error('Invalid '+n);return v;};
function canonical(raw){
  const e=normalizeExecution(raw);
  for(const a of [e.baseAsset,e.quoteAsset,e.feeAsset])if(!/^[A-Z0-9]{1,32}$/.test(a))throw Error('Invalid asset');
  const {notional,feeQuote,...fields}=e;
  // Preserve the conversion rate rather than trying to normalize a derived fee twice.
  return {...fields,...(e.source==='manual'?{confirmed:true}:{}),
    ...(e.fee&&e.feeAsset!==e.baseAsset&&e.feeAsset!==e.quoteAsset?{feeQuoteRate:raw.feeQuoteRate}:{})};
}
function operation(raw){
  if(!raw||!['fill','correct'].includes(raw.kind))throw Error('Invalid operation');
  const opId=required(raw.opId,'opId'),actor=required(raw.actor,'actor');
  if(!Number.isSafeInteger(raw.recordedAt)||raw.recordedAt<0)throw Error('Invalid recordedAt');
  const e=canonical(raw.execution);
  const result={opId,kind:raw.kind,actor,recordedAt:raw.recordedAt,execution:e};
  if(raw.kind==='correct'){
    if(e.source!=='manual')throw Error('Only manual fills may be corrected');
    if(!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<1)throw Error('Invalid expectedVersion');
    Object.assign(result,{expectedVersion:raw.expectedVersion,reason:required(raw.reason,'reason')});
  }
  return result;
}
function apply(state,op){
  const e=op.execution,k=key(e),previous=state.get(k);
  if(op.kind==='fill'){
    if(previous){
      if(same(previous.original,e))return false;
      throw Error('Conflicting execution ID');
    }
    state.set(k,{original:e,current:e,version:1});
  }else{
    if(!previous)throw Error('Unknown execution');
    if(previous.version!==op.expectedVersion)throw Error('Stale correction version');
    for(const f of ['cycleId','symbol','tf','baseAsset','quoteAsset','side']){
      if(previous.current[f]!==e[f])throw Error('Correction cannot change '+f);
    }
    // Map insertion order stays the same, so a correction cannot reorder fills.
    state.set(k,{original:previous.original,current:e,version:previous.version+1});
  }
  return true;
}
const current=state=>[...state.values()].map(x=>x.current);
export class TradeLedgerStore{
  constructor(db){this.db=db;}
  async read(){
    const result=await this.db.prepare('SELECT seq,op_id,payload FROM trade_ledger_audit ORDER BY seq').all();
    const state=new Map(),ops=new Map();let revision=0;
    for(const row of result.results){
      const op=operation(JSON.parse(row.payload));
      if(op.opId!==row.op_id||ops.has(op.opId)||!Number.isSafeInteger(row.seq)||row.seq<=revision)throw Error('Corrupt audit');
      if(!apply(state,op))throw Error('Unexpected duplicate audit');
      ops.set(op.opId,op);revision=row.seq;
    }
    return {state,ops,revision,cycles:replayLedger(current(state))};
  }
  async snapshot(){
    const s=await this.read();
    return {revision:s.revision,executions:[...s.state.values()].map(x=>({version:x.version,execution:x.current})),cycles:s.cycles};
  }
  async audit(){return [...(await this.read()).ops.values()];}
  async write(raw){
    const op=operation(raw);
    for(let attempt=0;attempt<8;attempt++){
      const s=await this.read();
      if(s.ops.has(op.opId)){
        if(!same(s.ops.get(op.opId),op))throw Error('Conflicting operation ID');
        return {status:'duplicate',revision:s.revision};
      }
      const changed=apply(s.state,op);
      if(!changed)return {status:'duplicate',revision:s.revision};
      // Reject any correction or fill that would invalidate downstream executions.
      replayLedger(current(s.state));
      // One atomic SQL statement compares the entire audit revision before append.
      // A competing writer must reread and revalidate; stale corrections fail explicitly.
      const r=await this.db.prepare(
        'INSERT INTO trade_ledger_audit(op_id,payload) SELECT ?,? WHERE COALESCE((SELECT MAX(seq) FROM trade_ledger_audit),0)=?'
      ).bind(op.opId,JSON.stringify(op),s.revision).run();
      if(r.meta.changes===1)return {status:'stored',revision:Number(r.meta.last_row_id)};
      if(r.meta.changes!==0)throw Error('Unexpected write result');
    }
    throw Error('Ledger contention: retry operation');
  }
}
