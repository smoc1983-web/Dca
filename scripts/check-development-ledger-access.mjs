// Workerd exercises physically separate synthetic D1 accounts and a deliberately incorrect binding.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {BudgetStore} from '../cloudflare/budget-store.mjs';
import {TradeLedgerStore} from '../cloudflare/trade-store.mjs';

const {Miniflare}=createRequire(import.meta.url)('miniflare');
const root=fileURLToPath(new URL('../',import.meta.url));
const [a,b,wrong,linked]=['A','B','WRONG','LINKED'].map(id=>({
 id:'account-'+id,token:randomBytes(32).toString('base64url'),binding:'DEV_LEDGER_DB_'+id
}));
a.canWrite=true;
wrong.canWrite=true;
linked.canWrite=true;
linked.budgeted=true;
let outbound=0;
const mf=new Miniflare({
 host:'127.0.0.1',port:0,logRequests:false,modules:true,modulesRoot:root,
 scriptPath:root+'cloudflare/development-ledger.mjs',compatibilityDate:'2026-07-30',
 bindings:{DEV_LEDGER_MODE:'synthetic',DEV_LEDGER_ACCOUNTS:[a,b,wrong,linked]},
 d1Databases:{[a.binding]:'account-db-a',[b.binding]:'account-db-b',[wrong.binding]:'account-db-a',
  [linked.binding]:'account-db-linked',DEV_LEDGER_DB_UNASSIGNED:'account-db-unassigned'},
 outboundService:()=>{outbound++;return new Response(null,{status:500});}
});
const auth=account=>({Authorization:'Bearer '+account.token});
const request=(account,path='/ledger',options={})=>mf.dispatchFetch('http://ledger.fixture'+path,
 {method:options.method,body:options.body,headers:{...(account?auth(account):{}),...options.headers}});

const post=(account,body)=>request(account,'/ledger',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

async function prepareAccount(account,{bind=true}={}){
 const db=await mf.getD1Database(account.binding);
 const files=['trade-ledger-schema','development-ledger-account-schema'];
 if(account.budgeted)files.push('budget-store-schema');
 const schemas=files.flatMap(name=>
  readFileSync(new URL('../cloudflare/'+name+'.sql',import.meta.url),'utf8').split(/(?=^CREATE )/m)
   .filter(s=>s.startsWith('CREATE ')).map(s=>s.trim()));
 await db.batch(schemas.map(sql=>db.prepare(sql)));
 if(bind){
  await db.prepare('INSERT INTO dev_ledger_account(singleton,account_id) VALUES(1,?)').bind(account.id).run();
  await assert.rejects(db.prepare("INSERT OR REPLACE INTO dev_ledger_account VALUES(1,'account-WRONG')").run(),/immutable/);
 }
 return db;
}
async function seed(account,price,options){
 const db=await prepareAccount(account,options);
 const store=new TradeLedgerStore(db);
 const fill={id:'same-receipt',cycleId:'same-cycle',source:'manual',confirmed:true,symbol:'ADAUSDT',
  baseAsset:'ADA',quoteAsset:'USDT',tf:'5m',time:1,side:'buy',price,quantity:'0.2',fee:'0.02',feeAsset:'USDT',dca:0};
 await store.write({kind:'fill',opId:'same-operation',recordedAt:10,actor:'hidden-actor-'+account.id,execution:fill});
 return {db,store,fill};
}
try{
 const [first,second]=await Promise.all([seed(a,'100'),seed(b,'200')]);
 await first.store.write({kind:'correct',opId:'correct-a',recordedAt:11,actor:'hidden-actor-A',
  execution:{...first.fill,price:'101'},expectedVersion:1,reason:'hidden-audit-explanation'});
 for(const [account,binding,price,revision] of [[a,b,101,2],[b,a,200,1]]){
  const res=await request(account,'/ledger',{headers:{'X-Account':binding.id}});
  assert.equal(res.status,200);
  assert.equal(res.headers.get('Cache-Control'),'no-store');
  const raw=await res.text(),view=JSON.parse(raw);
  assert.equal(view.accountId,account.id);
  assert.equal(view.revision,revision);
  assert.equal(view.executions.length,1);
  assert.equal(view.executions[0].execution.id,'same-receipt');
  assert.equal(view.executions[0].execution.price,price);
  assert.equal(view.cycles.length,1);
  for(const value of [binding.id,a.token,b.token,'hidden-actor','hidden-audit'])
   assert.ok(!raw.includes(value),'Ledger emitted data outside the authorised view');
 }
 assert.equal((await request(null)).status,401);
 assert.equal((await request(null,'/ledger/executions')).status,401);
 assert.equal((await request(wrong,'/ledger/executions')).status,503);
 assert.equal((await request(b,'/ledger/executions',{method:'POST'})).status,405);
 assert.equal((await request(b,'/ledger/executions?account=account-A')).status,400);
 assert.equal((await request(b,'/ledger/executions?limit=1&limit=2')).status,400);
 const page=await(await request(b,'/ledger/executions?limit=1',{headers:{'X-Account':a.id}})).json();
 assert.equal(page.accountId,b.id);
 assert.equal(page.executions[0].execution.price,200);
 assert.equal((await request(a,'/ledger/account-b')).status,404);
 assert.equal((await request(a,'/ledger?account=account-b')).status,404);
 assert.equal((await request(b,'/ledger',{method:'POST'})).status,403);
 const misbound=await request(wrong);
 assert.equal(misbound.status,503);
 assert.deepEqual(await misbound.json(),{status:'unavailable'});
 for(const sql of ["UPDATE dev_ledger_account SET account_id='account-B'","DELETE FROM dev_ledger_account"])
  await assert.rejects(first.db.prepare(sql).run(),/immutable/);
 await assert.rejects(first.db.prepare("INSERT OR REPLACE INTO dev_ledger_account VALUES(1,'account-WRONG')").run(),/immutable/);
 const unassigned=await seed({id:'account-legacy',binding:'DEV_LEDGER_DB_UNASSIGNED'},'300',{bind:false});
 await assert.rejects(unassigned.db.prepare("INSERT INTO dev_ledger_account VALUES(1,'account-A')").run(),/Cannot assign existing ledger history/);
 const entered={kind:'fill',opId:'manual-entry',execution:{...first.fill,id:'second-receipt',time:2,dca:1}};
 assert.equal((await post(null,entered)).status,401);
 assert.equal((await post(b,entered)).status,403);
 assert.equal((await post(wrong,entered)).status,503);
 assert.equal((await post(a,{...entered,actor:'account-B'})).status,400);
 assert.equal((await post(a,{...entered,expectedBudgetRevision:1})).status,400);
 assert.equal((await post(a,{...entered,recordedAt:1})).status,400);
 assert.equal((await post(a,{...entered,execution:{...entered.execution,source:'model'}})).status,400);
 assert.equal((await post(a,{...entered,execution:{...entered.execution,confirmed:false}})).status,400);
 assert.equal((await post(a,{...entered,execution:{...entered.execution,time:Date.now()+60_000}})).status,400);
 assert.equal((await post(a,{...entered,padding:'x'.repeat(8192)})).status,400);
 assert.equal((await first.store.snapshot()).revision,2);

 const startTime=Date.now();
 assert.equal((await post(a,entered)).status,201);
 assert.equal((await post(a,entered)).status,200);
 const correction={kind:'correct',opId:'manual-correction',expectedVersion:1,reason:'Synthetic receipt correction',
  execution:{...entered.execution,price:'103'}};
 const results=await Promise.all([post(a,correction),post(a,correction)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
 assert.equal((await post(a,{...correction,reason:'Conflicting reason'})).status,409);
 assert.equal((await post(a,{...correction,opId:'stale-new-id'})).status,409);
 const audit=await first.store.audit();
 assert.equal(audit.length,4);
 assert.equal(audit[2].actor,a.id);
 assert.equal(audit[3].actor,a.id);
 assert.equal(audit[3].reason,correction.reason);
 assert.ok(audit[2].recordedAt>=startTime&&audit[2].recordedAt<=Date.now());
 const view=await(await request(a)).json();
 assert.equal(view.executions.find(x=>x.execution.id==='second-receipt').version,2);
 assert.equal(view.executions.find(x=>x.execution.id==='second-receipt').execution.price,103);
 assert.equal((await first.store.snapshot()).revision,4);
 assert.equal((await second.store.snapshot()).revision,1);
 console.log('Ledger access: separate accounts, immutable marker, write permission, audited fill and correction, idempotent retry and no outbound requests');

 const db=await prepareAccount(linked),budget=new BudgetStore(db);
 const budgetFill={kind:'fill',opId:'linked-fill',expectedBudgetRevision:1,
  execution:{...first.fill,id:'linked-receipt',cycleId:'linked-cycle'}};
 assert.equal((await post(linked,entered)).status,400);
 assert.equal((await post(linked,budgetFill)).status,409);
 assert.equal((await budget.ledger.snapshot()).revision,0);
 const command=(kind,expectedRevision,extra)=>({kind,opId:kind,expectedRevision,actor:'synthetic-fixture',recordedAt:10,...extra});
 await budget.apply(command('init',null,{settings:{policy:'equal-slots-v1',capital:'800',freeCash:'800',maxCycles:1,feeRate:'0.001'}}));
 await budget.apply(command('reserve',0,{id:budgetFill.execution.cycleId,symbol:'ADAUSDT',tickSize:'0.01',exitFeeRate:'0.001'}));
 const heads=()=>db.prepare(`SELECT (SELECT MAX(seq) FROM dev_budget_audit) AS budget,
  (SELECT COUNT(*) FROM trade_ledger_audit) AS executions`).first();
 const before=await heads();
 assert.equal((await post(linked,{...budgetFill,expectedBudgetRevision:0})).status,409);
 assert.equal((await post(linked,{...budgetFill,execution:{...budgetFill.execution,price:'invalid'}})).status,400);
 assert.equal((await post(linked,{...budgetFill,execution:{...budgetFill.execution,cycleId:'same-pair-wrong-id'}})).status,409);
 assert.deepEqual(await heads(),before);
 await db.prepare(`CREATE TRIGGER fail_http_fill BEFORE INSERT ON trade_ledger_audit
  WHEN NEW.op_id='budget:http:linked-fill' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END`).run();
 const failed=await post(linked,budgetFill);
 assert.equal(failed.status,503);
 assert.deepEqual(await failed.json(),{status:'unavailable'});
 assert.deepEqual(await heads(),before);
 await db.prepare('DROP TRIGGER fail_http_fill').run();
 const saved=await post(linked,budgetFill);
 assert.equal(saved.status,201);
 assert.deepEqual(await saved.json(),{status:'stored',budgetRevision:2});
 assert.deepEqual(await heads(),{budget:before.budget+1,executions:1});
 assert.equal((await budget.snapshot()).summary.cycles[0].cost,'20.02');

 const budgetFix={kind:'correct',opId:'linked-fix',expectedBudgetRevision:2,expectedVersion:1,
  reason:'Synthetic receipt correction',execution:{...budgetFill.execution,price:'105'}};
 const beforeFix=await heads();
 await db.prepare(`CREATE TRIGGER fail_http_fix BEFORE INSERT ON trade_ledger_audit
  WHEN NEW.op_id='budget:http:linked-fix' BEGIN SELECT RAISE(ABORT,'synthetic correction failure'); END`).run();
 assert.equal((await post(linked,budgetFix)).status,503);
 assert.deepEqual(await heads(),beforeFix);
 assert.equal((await budget.snapshot()).summary.cycles[0].cost,'20.02');
 await db.prepare('DROP TRIGGER fail_http_fix').run();
 const fixed=await Promise.all([post(linked,budgetFix),post(linked,budgetFix)]);
 assert.deepEqual(fixed.map(r=>r.status).sort(),[200,201]);
 for(const response of fixed)assert.equal((await response.json()).budgetRevision,3);
 assert.equal((await post(linked,{...budgetFix,reason:'Conflicting reason'})).status,409);
 assert.equal((await post(linked,{...budgetFix,opId:'stale-correction',expectedBudgetRevision:3})).status,409);
 assert.equal((await post(linked,budgetFill)).status,200);
 assert.deepEqual(await heads(),{budget:before.budget+2,executions:2});
 const final=await budget.snapshot(),operations=await budget.ledger.audit();
 assert.equal(final.summary.cycles[0].cost,'21.02');
 assert.ok(final.summary.flags.includes('CORRECTION_RECONCILIATION_REQUIRED'));
 assert.ok(operations.every(op=>op.actor===linked.id));
 assert.equal((await first.store.snapshot()).revision,4);
 assert.equal((await second.store.snapshot()).revision,1);
 assert.equal(outbound,0);
 console.log('Budgeted ledger: protected fill and correction commit both audits atomically; D1 rollback, parallel retry, stale revisions and account isolation passed');
}finally{await mf.dispose();}
