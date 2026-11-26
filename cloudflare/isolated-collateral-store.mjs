// Synthetic manual collateral ledger, append-only local SQLite/D1-shaped adapter.
import {createCollateralAccount,recordCollateralOperation,collateralSummary} from './isolated-collateral.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const id=(x,n)=>{if(typeof x!=='string'||!x.trim()||x.length>128)throw Error('Invalid '+n);return x;};
function restoreInit(raw){
 return createCollateralAccount(raw);
}
function restoreEvent(e,rev){
 return {...e,synthetic:true,manual:true,expectedRevision:rev,...(['settle','cancel'].includes(e.kind)?{confirmed:true}:{}),...(e.kind==='cancel'?{remainderNotExecuted:true}:{})};
}
export class IsolatedCollateralStore{
 constructor(db){this.db=db;}
 async read(venue,accountId){
  id(venue,'venue');id(accountId,'account');
  const result=await this.db.prepare('SELECT revision,op_id,payload FROM dev_collateral_audit WHERE venue=? AND account_id=? ORDER BY revision').bind(venue,accountId).all();
  let s=null;
  for(const row of result.results){
   const e=JSON.parse(row.payload);
   if(s===null){
    if(row.revision!==0||row.op_id!=='@init')throw Error('Missing collateral initial snapshot');
    s=restoreInit(e);
    if(s.venue!==venue||s.accountId!==accountId||!same(s,e))throw Error('Corrupt collateral initial snapshot');
   }else{
    if(row.revision!==s.revision+1||row.op_id!==e.opId||e.opId==='@init')throw Error('Corrupt collateral revision');
    const next=recordCollateralOperation(s,restoreEvent(e,s.revision));
    if(next.status!=='recorded'||!same(next.state.audit.at(-1),e))throw Error('Corrupt collateral operation');
    s=next.state;
   }
  }
  return s;
 }
 async initialize(raw){
  const initial=createCollateralAccount(raw),{venue,accountId}=initial;
  const existing=await this.read(venue,accountId);
  if(existing){
   const row=await this.db.prepare('SELECT payload FROM dev_collateral_audit WHERE venue=? AND account_id=? AND revision=0').bind(venue,accountId).all();
   if(!same(JSON.parse(row.results[0].payload),initial))throw Error('Conflicting initial snapshot');
   return {status:'duplicate',state:existing,summary:collateralSummary(existing)};
  }
  const r=await this.db.prepare("INSERT INTO dev_collateral_audit(venue,account_id,revision,op_id,payload) SELECT ?,?,0,'@init',? WHERE NOT EXISTS(SELECT 1 FROM dev_collateral_audit WHERE venue=? AND account_id=?)").bind(venue,accountId,JSON.stringify(initial),venue,accountId).run();
  if(r.meta.changes===0)return this.initialize(raw);
  if(r.meta.changes!==1)throw Error('Unexpected collateral init result');
  return {status:'stored',state:initial,summary:collateralSummary(initial)};
 }
 async snapshot(venue,accountId){
  const state=await this.read(venue,accountId);
  if(!state)throw Error('Unknown collateral account');
  return {state,summary:collateralSummary(state)};
 }
 async write(raw){
  if(raw?.opId==='@init')throw Error('Reserved operation ID');
  const {venue,accountId}=raw;
  for(let attempt=0;attempt<8;attempt++){
   const current=await this.read(venue,accountId);
   if(!current)throw Error('Unknown collateral account');
   const next=recordCollateralOperation(current,raw);
   if(next.status==='duplicate')return next;
   const e=next.state.audit.at(-1);
   const r=await this.db.prepare('INSERT INTO dev_collateral_audit(venue,account_id,revision,op_id,payload) SELECT ?,?,?,?,? WHERE (SELECT MAX(revision) FROM dev_collateral_audit WHERE venue=? AND account_id=?)=?').bind(venue,accountId,next.state.revision,e.opId,JSON.stringify(e),venue,accountId,current.revision).run();
   if(r.meta.changes===1)return {...next,status:'stored'};
   if(r.meta.changes!==0)throw Error('Unexpected collateral write result');
  }
  throw Error('Collateral contention: retry');
 }
}
