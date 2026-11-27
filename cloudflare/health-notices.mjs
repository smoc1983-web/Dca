// Records which diagnostic transition is eligible to be reported. No sending or retries.
import {healthTransition} from './health-read.mjs';

export class HealthNotices{
 constructor(db){this.db=db;}
 async read(){
  try{
   const {results:[latest]}=await this.db.prepare(`SELECT revision,kind,health_status AS healthStatus,
    recorded_at AS recordedAt FROM dev_health_notices ORDER BY revision DESC LIMIT 1`).all();
   return {status:latest?'available':'no-notices',latest:latest??null};
  }catch{return {status:'unavailable',latest:null};}
 }

 async claim({synthetic,health,now,cooldownMs}={}){
  const status=health?.status;
  if(synthetic!==true||!['healthy','degraded','unavailable'].includes(status)||
     !Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(cooldownMs)||cooldownMs<=0||
     !Number.isSafeInteger(now+cooldownMs))throw Error('Explicit synthetic health and notice timing required');
  try{
   const {results:[last]}=await this.db.prepare(`SELECT revision,health_status,recorded_at
      FROM dev_health_notices ORDER BY revision DESC LIMIT 1`).all();
   if(last&&now<last.recorded_at)return {result:'stale-time'};
   const kind=healthTransition({status:last?.health_status??'healthy'},{status});
   if(!kind)return {result:'unchanged'};
   if(last&&now-last.recorded_at<cooldownMs)return {result:'rate-limited',eligibleAt:last.recorded_at+cooldownMs};
   const rev=last?.revision??0;
   const saved=await this.db.prepare(`INSERT INTO dev_health_notices(revision,kind,health_status,recorded_at)
     SELECT ?,?,?,? WHERE COALESCE((SELECT MAX(revision) FROM dev_health_notices),0)=?`)
     .bind(rev+1,kind,status,now,rev).run();
   return saved.meta.changes===1?{result:'recorded',kind,revision:rev+1}:{result:'stale'};
  }catch{return {result:'unavailable'};}
 }
}
