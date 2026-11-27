// SQLite-tested synthetic diagnostic audit. Neither reserves collateral nor authorizes an order.
import {FuturesStore} from './futures-store.mjs';
import {IsolatedCollateralStore} from './isolated-collateral-store.mjs';
import {isolatedPreflight} from './isolated-preflight.mjs';

export class IsolatedPreflightStore{
 constructor(db){
  this.db=db;
  this.futures=new FuturesStore(db);
  this.collateral=new IsolatedCollateralStore(db);
 }
 async record({decisionId,synthetic,account,expected,action,now,maxAgeMs}){
  if(synthetic!==true||account?.mode!=='isolated'||
     typeof decisionId!=='string'||!decisionId.trim()||decisionId.length>128)
   throw Error('Synthetic isolated decision required');
  const scope={synthetic:true,mode:'isolated',venue:account.venue,accountId:account.accountId};
  const blocked=reason=>({status:'blocked',reasons:[reason],recommendationAllowed:false});
  const [futures,collateral]=await Promise.all([
   this.futures.boundSnapshot(scope),this.collateral.snapshot(scope.venue,scope.accountId)
  ]);
  const result=isolatedPreflight({synthetic,account:scope,collateral,futures,expected,action,now,maxAgeMs});
  if(result.status==='blocked')return result;
  const {futuresRevision,collateralRevision}=result;
  const payload=JSON.stringify({now,maxAgeMs,action:{kind:action.kind,cycleId:action.cycleId,
   symbol:action.symbol,leverage:action.leverage,step:action.step,
   ...(action.kind==='DCA'?{previousStepConfirmed:true}:{})}});
  const r=await this.db.prepare(`INSERT INTO dev_isolated_preflight_audit
   (decision_id,venue,account_id,futures_revision,collateral_revision,payload)
   SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM dev_futures_account WHERE venue=? AND account_id=?)
   AND COALESCE((SELECT MAX(seq) FROM dev_futures_audit),0)=?
   AND (SELECT MAX(revision) FROM dev_collateral_audit WHERE venue=? AND account_id=?)=?
   ON CONFLICT(decision_id) DO NOTHING`)
   .bind(decisionId,scope.venue,scope.accountId,futuresRevision,collateralRevision,payload,
    scope.venue,scope.accountId,futuresRevision,scope.venue,scope.accountId,collateralRevision).run();
  if(r.meta.changes===1)return {...result,audit:'stored'};
  if(r.meta.changes!==0)throw Error('Unexpected diagnostic audit write result');
  const {results:[existing]}=await this.db.prepare('SELECT * FROM dev_isolated_preflight_audit WHERE decision_id=?').bind(decisionId).all();
  if(existing){
   if(existing.venue!==scope.venue||existing.account_id!==scope.accountId||existing.payload!==payload||
      existing.futures_revision!==futuresRevision||existing.collateral_revision!==collateralRevision)
    throw Error('Conflicting preflight decision ID');
   // An audit of a past attempt cannot be reused as a fresh matched preflight.
   return blocked('decision-already-recorded');
  }
  return blocked('revision-changed-during-preflight');
 }
}
