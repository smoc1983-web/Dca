// Structured development measurements. Request addresses, tokens and bodies are never stored.
const operations={
 'binance-vision':['time','klines'], 'binance-primary':['time','klines'],
 'binance-gcp':['time','klines'], telegram:['sendMessage']
};
const token=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,96}$/.test(value);
const time=value=>Number.isSafeInteger(value)&&value>=0;
const transportErrors=['timeout','cancelled','transport-error'];
const errors=[...transportErrors,'invalid-data','candle-gap'];
const maxWindowMs=7*86_400_000;

function classify(status){
 if(status>=200&&status<300)return 'ok';
 if(status===429)return 'rate-limited';
 if(status===451)return 'region-restricted';
 if(status===403)return 'access-denied';
 if(status>=500)return 'server-error';
 return 'http-error';
}

export class SourceMetrics{
 constructor(db){this.db=db;}
 async record({synthetic,id,source,operation,startedAt,endedAt,httpStatus=null,error=null}={}){
  if(synthetic!==true||!token(id)||!Object.hasOwn(operations,source)||!operations[source].includes(operation)||
     !time(startedAt)||!time(endedAt)||endedAt<startedAt)throw Error('Invalid synthetic source sample');
  const validHttp=Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599;
  const httpSuccess=validHttp&&httpStatus>=200&&httpStatus<300;
  const validError=errors.includes(error)&&(httpStatus===null||httpSuccess&&!transportErrors.includes(error));
  if(!(error===null?validHttp:validError))throw Error('Invalid source outcome');
  const outcome=error??classify(httpStatus),duration=endedAt-startedAt;
  const inserted=await this.db.prepare(`INSERT INTO dev_source_samples
   (sample_id,source,operation,observed_at,duration_ms,outcome,http_status)
   VALUES (?,?,?,?,?,?,?) ON CONFLICT(sample_id) DO NOTHING`)
   .bind(id,source,operation,endedAt,duration,outcome,httpStatus).run();
  if(inserted.meta.changes===1)return {status:'stored',outcome};
  const {results:[r]}=await this.db.prepare(`SELECT source,operation,observed_at,duration_ms,outcome,http_status
      FROM dev_source_samples WHERE sample_id=?`).bind(id).all();
  if(!r||r.source!==source||r.operation!==operation||r.observed_at!==endedAt||r.duration_ms!==duration||
     r.outcome!==outcome||r.http_status!==httpStatus)throw Error('Conflicting source sample ID');
  return {status:'duplicate',outcome};
 }
 async read({now,windowMs}={}){
  if(!time(now)||!time(windowMs)||windowMs===0||windowMs>maxWindowMs)throw Error('Invalid measurement window');
  try{
   const {results}=await this.db.prepare(`SELECT source,operation,outcome,COUNT(*) AS count,
    MIN(duration_ms) AS fastestMs,AVG(duration_ms) AS meanMs,MAX(duration_ms) AS slowestMs,MAX(observed_at) AS lastAt
    FROM dev_source_samples WHERE observed_at>=? AND observed_at<=?
    GROUP BY source,operation,outcome ORDER BY source,operation,outcome`).bind(Math.max(0,now-windowMs),now).all();
   return {status:results.length?'available':'no-samples',samples:results};
  }catch{return {status:'unavailable',samples:[]};}
 }
}

// Only wraps one request, including a rejected promise. The caller owns all retry policy.
export async function observeSourceRequest(metrics,sample,request,clock=Date.now){
 if(sample?.synthetic!==true)throw Error('Synthetic request observation required');
 const {synthetic,id,source,operation}=sample;
 const startedAt=clock();
 async function record(outcome){
  try{await metrics.record({synthetic,id,source,operation,...outcome,startedAt,endedAt:clock()});return true;}
  catch{return false;}
 }
 let response;
 try{response=await request();}
 catch(error){
  const kind=error?.name==='TimeoutError'?'timeout':error?.name==='AbortError'?'cancelled':'transport-error';
  await record({error:kind});
  throw error;
 }
 const httpStatus=response?.status;
 const recorded=await record(Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599
  ?{httpStatus}:{error:'invalid-data'});
 return {response,recorded};
}
