// Workerd exercises physically separate synthetic D1 accounts and a deliberately incorrect binding.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {TradeLedgerStore} from '../cloudflare/trade-store.mjs';

const {Miniflare}=createRequire(import.meta.url)('miniflare');
const root=fileURLToPath(new URL('../',import.meta.url));
const [a,b,wrong]=['A','B','WRONG'].map(id=>({
 id:'account-'+id,token:randomBytes(32).toString('base64url'),binding:'DEV_LEDGER_DB_'+id
}));
a.canWrite=true;
wrong.canWrite=true;
let outbound=0;
const mf=new Miniflare({
 host:'127.0.0.1',port:0,logRequests:false,modules:true,modulesRoot:root,
 scriptPath:root+'cloudflare/development-ledger.mjs',compatibilityDate:'2026-07-30',
 bindings:{DEV_LEDGER_MODE:'synthetic',DEV_LEDGER_ACCOUNTS:[a,b,wrong]},
 d1Databases:{[a.binding]:'account-db-a',[b.binding]:'account-db-b',[wrong.binding]:'account-db-a',DEV_LEDGER_DB_UNASSIGNED:'account-db-unassigned'},
 outboundService:()=>{outbound++;return new Response(null,{status:500});}
});
const auth=account=>({Authorization:'Bearer '+account.token});
const request=(account,path='/ledger',options={})=>mf.dispatchFetch('http://ledger.fixture'+path,
 {method:options.method,body:options.body,headers:{...(account?auth(account):{}),...options.headers}});

const post=(account,body)=>request(account,'/ledger',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

async function seed(account,price,{bind=true}={}){
 const db=await mf.getD1Database(account.binding);
 const schemas=['trade-ledger-schema','development-ledger-account-schema'].flatMap(name=>
  readFileSync(new URL('../cloudflare/'+name+'.sql',import.meta.url),'utf8').split(/(?=^CREATE )/m)
   .filter(s=>s.startsWith('CREATE ')).map(s=>s.trim()));
 await db.batch(schemas.map(sql=>db.prepare(sql)));
 if(bind){
  await db.prepare('INSERT INTO dev_ledger_account(singleton,account_id) VALUES(1,?)').bind(account.id).run();
  await assert.rejects(db.prepare("INSERT OR REPLACE INTO dev_ledger_account VALUES(1,'account-WRONG')").run(),/immutable/);
 }
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
 assert.equal(outbound,0);
 console.log('Ledger access: separate accounts, immutable marker, write permission, audited fill and correction, idempotent retry and no outbound requests');
}finally{await mf.dispose();}
