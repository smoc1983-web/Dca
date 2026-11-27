// Synthetic status journal; never sends, schedules or modifies a live alert.
const transitions={
 enqueue:{from:null,to:'pending'},
 claim:{from:'pending',to:'sending'},
 delivered:{from:'sending',to:'delivered'},
 rejected:{from:'sending',to:'pending',retry:true,evidence:'rejection-confirmed'},
 'outcome-unknown':{from:'sending',to:'uncertain'},
 'manual-delivered':{from:'uncertain',to:'delivered',evidence:'delivery-confirmed'},
 'manual-not-delivered':{from:'uncertain',to:'pending',retry:true,evidence:'non-delivery-confirmed'}
};
const token=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,96}$/.test(value);
const time=value=>Number.isSafeInteger(value)&&value>=0;

export class DeliveryAudit{
 constructor(db){this.db=db;}
 async record({synthetic,signalId,eventId,expectedRevision,kind,at,retryAt=null,evidence=null}={}){
  if(synthetic!==true||!token(signalId)||!token(eventId)||!time(expectedRevision)||expectedRevision===Number.MAX_SAFE_INTEGER||
     !time(at)||!Object.hasOwn(transitions,kind))throw Error('Invalid synthetic delivery event');
  const rule=transitions[kind];
  if((rule.retry?!time(retryAt)||retryAt<=at:retryAt!==null)||evidence!==(rule.evidence??null))
   throw Error('Delivery retry time or manual evidence is invalid');
  const revision=expectedRevision+1;
  const duplicate=async()=>{
   const {results:[e]}=await this.db.prepare('SELECT * FROM dev_delivery_audit WHERE event_id=?').bind(eventId).all();
   if(!e)return null;
   if(e.signal_id!==signalId||e.revision!==revision||e.kind!==kind||e.changed_at!==at||
      e.retry_at!==retryAt||e.evidence!==evidence)throw Error('Conflicting delivery event ID');
   return {result:'duplicate',revision,status:rule.to};
  };
  const repeated=await duplicate();
  if(repeated)return repeated;
  const {results:[head]}=await this.db.prepare(`SELECT revision,status,changed_at,retry_at FROM dev_delivery_audit
      WHERE signal_id=? ORDER BY revision DESC LIMIT 1`).bind(signalId).all();
  if((head?.revision??0)!==expectedRevision){
   const replay=await duplicate();
   if(replay)return replay;
   return {result:'stale'};
  }
  if((head?.status??null)!==rule.from||head&&at<head.changed_at||
     kind==='claim'&&head.retry_at!==null&&at<head.retry_at)throw Error('Invalid delivery transition');
  const saved=await this.db.prepare(`INSERT INTO dev_delivery_audit
    (signal_id,revision,event_id,kind,status,changed_at,retry_at,evidence)
    SELECT ?,?,?,?,?,?,?,? WHERE COALESCE((SELECT MAX(revision) FROM dev_delivery_audit WHERE signal_id=?),0)=?
    ON CONFLICT(event_id) DO NOTHING`)
   .bind(signalId,revision,eventId,kind,rule.to,at,retryAt,evidence,signalId,expectedRevision).run();
  if(saved.meta.changes===1)return {result:'stored',revision,status:rule.to};
  return await duplicate()??{result:'stale'};
 }
 async read({now,maxSendingAgeMs}={}){
  if(!time(now)||!time(maxSendingAgeMs))throw Error('Invalid queue observation time');
  try{
   const {results}=await this.db.prepare(`WITH heads AS (
    SELECT signal_id,MAX(revision) AS revision FROM dev_delivery_audit WHERE changed_at<=? GROUP BY signal_id
   )
   SELECT status,COUNT(*) AS count,MIN(changed_at) AS oldestAt
   FROM heads JOIN dev_delivery_audit USING(signal_id,revision) GROUP BY status`).bind(now).all();
   const states=Object.fromEntries(['pending','sending','delivered','uncertain'].map(status=>{
    const state=results.find(x=>x.status===status);
    return [status,{count:state?.count??0,oldestStatusAgeMs:state?now-state.oldestAt:null}];
   }));
   return {status:results.length?'available':'no-events',states,
    needsReview:states.uncertain.count>0||states.sending.oldestStatusAgeMs>maxSendingAgeMs};
  }catch{return {status:'unavailable',needsReview:null};}
 }
}
