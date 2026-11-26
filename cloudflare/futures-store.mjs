// Local SQLite/D1-shaped port for synthetic confirmed futures executions only.
import {normalizeFuturesEvent,replayFutures,stressManualFutures} from './futures-ledger.mjs';
function required(v,n){if(typeof v!=='string'||!v.trim()||v.length>128)throw Error('Invalid '+n);return v;}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function canonical(raw){
 if(!raw||!['append','correct'].includes(raw.kind)||raw.confirmed!==true)throw Error('Confirmed futures operation required');
 const opId=required(raw.opId,'opId'),actor=required(raw.actor,'actor');
 if(!Number.isSafeInteger(raw.recordedAt)||raw.recordedAt<0)throw Error('Invalid recordedAt');
 const event=normalizeFuturesEvent(raw.event);
 if(event.time>raw.recordedAt)throw Error('Future event time');
 const op={opId,actor,recordedAt:raw.recordedAt,kind:raw.kind,confirmed:true,event};
 if(raw.kind==='correct'){
  if(!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<1)throw Error('Invalid expectedVersion');
  Object.assign(op,{expectedVersion:raw.expectedVersion,reason:required(raw.reason,'reason')});
 }
 return op;
}
function apply(entries,op){
 const e=op.event,old=entries.get(e.id);
 if(op.kind==='append'){
  if(old){
   if(same(old.original,e))return false;
   throw Error('Conflicting futures event ID');
  }
  entries.set(e.id,{original:e,event:e,version:1});
 }else{
  if(!old)throw Error('Unknown futures event');
  if(old.version!==op.expectedVersion)throw Error('Stale futures event version');
  for(const f of ['cycleId','symbol','leverage','kind','dca']){
   if(old.event[f]!==e[f])throw Error('Correction cannot change '+f);
  }
  entries.set(e.id,{original:old.original,event:e,version:old.version+1});
 }
 return true;
}
const events=entries=>[...entries.values()].map(x=>x.event);
export class FuturesStore{
 constructor(db){this.db=db;}
 async read(){
  const result=await this.db.prepare('SELECT seq,op_id,payload FROM dev_futures_audit ORDER BY seq').all();
  const entries=new Map(),ops=new Map();let revision=0;
  for(const row of result.results){
   const op=canonical(JSON.parse(row.payload));
   if(op.opId!==row.op_id||ops.has(op.opId)||!Number.isSafeInteger(row.seq)||row.seq<=revision)throw Error('Corrupt futures audit');
   if(!apply(entries,op))throw Error('Unexpected duplicate futures audit');
   ops.set(op.opId,op);revision=row.seq;
  }
  const cycles=replayFutures(events(entries));
  return {revision,entries,ops,cycles};
 }
 async snapshot(){
  const s=await this.read();
  return {revision:s.revision,events:[...s.entries.values()].map(x=>({event:x.event,version:x.version})),cycles:s.cycles};
 }
 async audit(){return [...(await this.read()).ops.values()];}
 async write(raw){
  const op=canonical(raw);
  if(!Number.isSafeInteger(raw.expectedRevision)||raw.expectedRevision<0)throw Error('Invalid expectedRevision');
  for(let attempt=0;attempt<8;attempt++){
   const s=await this.read();
   if(s.ops.has(op.opId)){
    if(!same(s.ops.get(op.opId),op))throw Error('Conflicting futures operation ID');
    return {status:'duplicate',revision:s.revision};
   }
   // Retry of the original fill remains idempotent even after correction.
   if(op.kind==='append'&&s.entries.has(op.event.id)){
    if(!same(s.entries.get(op.event.id).original,op.event))throw Error('Conflicting futures event ID');
    return {status:'duplicate',revision:s.revision};
   }
   if(raw.expectedRevision!==s.revision)throw Error('Stale futures revision');
   if(!apply(s.entries,op))throw Error('Unexpected duplicate');
   replayFutures(events(s.entries));
   const r=await this.db.prepare('INSERT INTO dev_futures_audit(op_id,payload) SELECT ?,? WHERE COALESCE((SELECT MAX(seq) FROM dev_futures_audit),0)=?')
    .bind(op.opId,JSON.stringify(op),s.revision).run();
   if(r.meta.changes===1)return {status:'stored',revision:Number(r.meta.last_row_id)};
   if(r.meta.changes!==0)throw Error('Unexpected futures write result');
  }
  throw Error('Futures contention: retry');
 }
 async stress(raw){
  const s=await this.snapshot();
  if(raw.expectedRevision!==s.revision)throw Error('Stale futures risk revision');
  // Authoritative executions are from the journal; never from the risk request.
  const report=stressManualFutures({...raw,events:s.events.map(x=>x.event)});
  return {revision:s.revision,...report};
 }
}
