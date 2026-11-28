// Shared synthetic scenario. The caller supplies the isolated D1 and HTTP transport.
import assert from 'node:assert/strict';
import {BudgetStore} from '../cloudflare/budget-store.mjs';
import {CashStore} from '../cloudflare/cash-store.mjs';

export async function runTradeCycleAcceptance({db,accountId,request,reconnect}){
 const cycleId='cycle-ada',symbol='ADAUSDT',openingAt=Date.now()-60_000;
 const maxAgeMs=3_600_000;
 async function call(path,status,body){
  const response=await request(path,body);
  assert.equal(response.status,status,`${path} ${body?.opId??'GET'}`);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  return response.json();
 }
 const status=()=>call('/ledger/budget',200);
 const cashReport=cash=>cash.report({now:Date.now(),maxAgeMs});
 const command=(kind,opId,expectedRevision,extra)=>({kind,opId,expectedRevision,recordedAt:Date.now(),
  actor:'synthetic-operator',confirmed:true,...extra});
 const execution=(id,step,side,price,quantity,fee,dca)=>({id,cycleId,symbol,source:'manual',confirmed:true,
  baseAsset:'ADA',quoteAsset:'USDT',tf:'5m',time:openingAt+step*1000,side,price,quantity,fee,feeAsset:'USDT',dca});
 async function record(fill){
  const {budgetRevision}=await status();
  const request={kind:'fill',opId:fill.id,expectedBudgetRevision:budgetRevision,execution:fill};
  assert.deepEqual(await call('/ledger',201,request),{status:'stored',budgetRevision:budgetRevision+1});
  return request;
 }
 const saveObservation=(cash,id,expectedRevision,free)=>cash.write(command('observe',id,expectedRevision,
  {free,locked:'0',completeHistory:true,time:Date.now()}));

 const owner=await db.prepare(`SELECT account_id,
  (SELECT COUNT(*) FROM dev_budget_audit) AS budget,
  (SELECT COUNT(*) FROM trade_ledger_audit) AS ledger,
  (SELECT COUNT(*) FROM dev_cash_audit) AS cash FROM dev_ledger_account WHERE singleton=1`).first();
 assert.deepEqual(owner,{account_id:accountId,budget:0,ledger:0,cash:0},'Dedicated fresh synthetic D1 required');
 const empty=await status();
 assert.equal(empty.accountId,accountId,'HTTP reply belongs to a different synthetic account');
 assert.equal(empty.budgetRevision,null);
 assert.equal(empty.ledgerRevision,0);
 assert.equal(empty.cashRevision,0);
 let budget=new BudgetStore(db),cash=new CashStore(db);
 await budget.apply(command('init','budget-init',null,{cashGuardMaxAgeMs:maxAgeMs,
  settings:{policy:'equal-slots-v1',capital:'800',freeCash:'800',maxCycles:1,feeRate:'0.001'}}));
 await cash.write(command('opening','opening',0,{time:openingAt,cash:'800',noOpeningPositions:true}));
 await saveObservation(cash,'opening-observation',1,'800');
 const settings=await status();
 assert.equal(settings.budgetRevision,0);
 assert.equal(settings.reconciliation.reconciled,true);
 const reservation=await budget.apply(command('reserve','reserve',settings.budgetRevision,
  {id:cycleId,symbol,tickSize:'0.01',exitFeeRate:'0.001'}));
 assert.equal(reservation.summary.held,'520.05078125');
 assert.equal(reservation.summary.available,'279.94921875');
 assert.equal(reservation.summary.cycles[0].status,'awaiting_fill');

 await record(execution('start-a',1,'buy','100','0.1','0.01',0));
 const startPartial=(await budget.snapshot()).summary.cycles[0];
 assert.equal(startPartial.steps[0].status,'partial');
 assert.equal(startPartial.cost,'10.01');
 assert.equal(startPartial.nextDca,null);
 await record(execution('start-b',2,'buy','100','0.1','0.01',0));
 assert.equal((await budget.snapshot()).summary.cycles[0].nextDca,null);
 const startDone=await budget.apply(command('complete','start-done',(await status()).budgetRevision,{id:cycleId,step:0}));
 assert.deepEqual(startDone.summary.cycles[0].nextDca,{number:1,anchor:'100',price:'95',nominal:'37.5'});
 await record(execution('dca-one',3,'buy','95','0.2','0.019',1));
 const dcaDone=await budget.apply(command('complete','dca-done',(await status()).budgetRevision,{id:cycleId,step:1}));
 assert.equal(dcaDone.summary.cycles[0].quantity,'0.4');
 assert.equal(dcaDone.summary.cycles[0].cost,'39.039');
 assert.equal(dcaDone.summary.cycles[0].nextDca.price,'89.3');

 await record(execution('sell-a',4,'sell','110','0.1','0.011',null));
 const partial=await budget.snapshot();
 const position=partial.summary.cycles[0];
 assert.deepEqual([position.status,position.quantity,position.cost,position.realizedPnl],['open','0.3','29.27925','1.22925']);
 assert.equal(partial.summary.held,reservation.summary.held);
 const release=(rev,extra={})=>command('release','release',rev,{id:cycleId,ordersCancelled:true,freeCash:'804.917',...extra});
 await assert.rejects(budget.apply(release(partial.state.revision)),/Cannot release open position/);

 const finalSale=await record(execution('sell-b',5,'sell','110','0.3','0.033',null));
 const closed=await budget.snapshot();
 assert.equal(closed.summary.held,reservation.summary.held);
 assert.equal(closed.summary.cycles[0].status,'closed');
 assert.equal(closed.summary.cycles[0].quantity,'0');
 const finish=release(closed.state.revision);
 await assert.rejects(budget.apply(release(closed.state.revision,{ordersCancelled:false})),/Confirm cancellation/);
 await assert.rejects(budget.apply(finish),/Cash reconciliation required/);
 assert.deepEqual(await budget.snapshot(),closed);
 await saveObservation(cash,'closing-observation',2,'804.917');
 assert.deepEqual((await status()).reconciliation,{reconciled:false,flags:['CONFIRM_REMAINING_ORDERS_CANCELLED']});
 const released=await budget.apply(finish);
 assert.equal(released.status,'stored');
 assert.equal(released.state.reservations[0].status,'released');
 assert.deepEqual(released.summary,{active:0,held:'0',available:'800',deficit:'0',flags:[],cycles:[]});
 const report=await cashReport(cash);
 assert.equal(report.expectedQuoteCash,'804.917');
 assert.equal(report.realizedTradingPnl,'4.917');
 assert.equal(report.remainingPositionCost,'0');
 assert.equal(report.remainingReserve,'0');
 assert.equal(report.reconciled,true);

 const view=await call('/ledger',200),settledStatus=await status();
 assert.deepEqual(view.executions.map(x=>x.execution.id),['start-a','start-b','dca-one','sell-a','sell-b']);
 assert.equal(view.cycles[0].exact.realized,'4.917');
 assert.deepEqual(settledStatus.reconciliation,{reconciled:true,flags:[]});
 db=await reconnect();
 budget=new BudgetStore(db);cash=new CashStore(db);
 assert.equal((await call('/ledger',200,finalSale)).status,'duplicate');
 assert.deepEqual(await call('/ledger',409,{...finalSale,execution:{...finalSale.execution,price:'111'}}),{status:'conflict'});
 assert.equal((await budget.apply(finish)).status,'duplicate');
 assert.deepEqual(await call('/ledger',200),view);
 assert.deepEqual(await status(),settledStatus);
 assert.deepEqual(await cashReport(cash),report);
 return {executions:view.executions.length,held:reservation.summary.held,
  remainingReserve:report.remainingReserve,pnl:report.realizedTradingPnl,cash:report.expectedQuoteCash,
  budgetRevision:settledStatus.budgetRevision,ledgerRevision:settledStatus.ledgerRevision,cashRevision:settledStatus.cashRevision};
}
