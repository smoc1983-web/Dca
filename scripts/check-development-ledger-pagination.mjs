// Local Workerd and D1 measurement on deterministic synthetic fills and corrections.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {TradeLedgerStore,normalizeLedgerOperation} from '../cloudflare/trade-store.mjs';

const {Miniflare}=createRequire(import.meta.url)('miniflare');
const root=fileURLToPath(new URL('../',import.meta.url));
const account={id:'pagination-fixture',token:randomBytes(32).toString('base64url'),binding:'DEV_LEDGER_DB_PAGE'};
const mf=new Miniflare({host:'127.0.0.1',port:0,logRequests:false,modules:true,modulesRoot:root,
 scriptPath:root+'cloudflare/development-ledger.mjs',compatibilityDate:'2026-07-30',
 d1Databases:{DEV_LEDGER_DB_PAGE:'pagination-fixture-db'},
 bindings:{DEV_LEDGER_MODE:'synthetic',DEV_LEDGER_ACCOUNTS:[account]}});
const fills=4000,corrections=1000,limit=50;
function event(i,correct){
 const execution={source:'manual',confirmed:true,id:'f-'+i,cycleId:'c-'+i,symbol:'ADAUSDT',
  baseAsset:'ADA',quoteAsset:'USDT',tf:'5m',time:i,side:'buy',price:correct?'101':'100',quantity:'0.2',fee:'0.02',feeAsset:'USDT'};
 return normalizeLedgerOperation({kind:correct?'correct':'fill',opId:(correct?'correct-':'entry-')+i,
  actor:'synthetic-load',recordedAt:correct?fills+i:i,execution,
  ...(correct?{expectedVersion:1,reason:'Synthetic correction'}:{})});
}

try{
 const db=await mf.getD1Database(account.binding);
 const schemas=['trade-ledger-schema','development-ledger-account-schema'].flatMap(name=>
  readFileSync(new URL('../cloudflare/'+name+'.sql',import.meta.url),'utf8').split(/(?=^CREATE )/m)
   .filter(s=>s.startsWith('CREATE ')).map(s=>s.trim()));
 const indexSchemas=schemas.filter(sql=>sql.startsWith('CREATE INDEX'));
 await db.batch(schemas.filter(sql=>!indexSchemas.includes(sql)).map(sql=>db.prepare(sql)));
 await db.prepare('INSERT INTO dev_ledger_account(singleton,account_id) VALUES(1,?)').bind(account.id).run();
 const ops=[...Array.from({length:fills},(_,i)=>event(i,false)),...Array.from({length:corrections},(_,i)=>event(i,true))];
 for(let i=0;i<ops.length;i+=80)await db.batch(ops.slice(i,i+80).map(e=>
  db.prepare('INSERT INTO trade_ledger_audit(op_id,payload) VALUES(?,?)').bind(e.opId,JSON.stringify(e))));
 for(let attempt=0;attempt<2;attempt++)await db.batch(indexSchemas.map(sql=>db.prepare(sql)));

 async function measured(read){
  let results=0,rowsRead=0;
  let pageQuery;
  const port={prepare(sql){
   let args=[];
   return {bind(...v){args=v;return this;},async all(){
    const r=await db.prepare(sql).bind(...args).all();
    results+=r.results.length;
    rowsRead+=r.meta.rows_read;
    if(sql.includes('WITH fills'))pageQuery={sql,args};
    return r;
   }};
  }};
  const start=performance.now();
  const data=await read(new TradeLedgerStore(port));
  return {results,rowsRead,elapsedMs:Math.round(performance.now()-start),data,pageQuery};
 }
 const full=await measured(store=>store.snapshot());
 const first=await measured(store=>store.pageExecutions({limit}));
 const last=await measured(store=>store.pageExecutions({limit,before:limit+1,revision:ops.length}));
 assert.equal(full.results,ops.length);
 assert.equal(full.data.executions.length,fills);
 assert.equal(first.results,limit+2);
 assert.equal(last.results,limit+1);
 assert.ok(first.rowsRead<=4*(limit+1));
 assert.ok(last.rowsRead<=4*(limit+1));
 assert.equal(last.data.next,null);
 assert.deepEqual(first.data.executions,full.data.executions.slice(-limit).reverse());
 assert.deepEqual(last.data.executions,full.data.executions.slice(0,limit).reverse());

 const {sql,args}=first.pageQuery;
 const plan=(await db.prepare('EXPLAIN QUERY PLAN '+sql).bind(...args).all()).results.map(r=>r.detail).join('\n');
 assert.match(plan,/SEARCH.*trade_ledger_fill_order/);
 assert.match(plan,/SEARCH.*trade_ledger_execution_history/);
 const url='http://ledger.fixture/ledger/executions';
 const headers={Authorization:'Bearer '+account.token};
 const response=await mf.dispatchFetch(url+'?limit='+limit,{headers});
 assert.equal(response.status,200);
 const body=await response.text(),httpPage=JSON.parse(body);
 assert.equal(httpPage.accountId,account.id);
 assert.deepEqual(httpPage.executions,first.data.executions);
 const next=await mf.dispatchFetch(url+'?'+new URLSearchParams({...httpPage.next,limit}),{headers});
 assert.equal(next.status,200);
 const secondPage=await next.json();
 assert.equal(secondPage.revision,httpPage.revision);
 assert.deepEqual(secondPage.executions,full.data.executions.slice(-2*limit,-limit).reverse());
 const report={operations:ops.length,full:{returnedRows:full.results,rowsRead:full.rowsRead,elapsedMs:full.elapsedMs,
  jsonBytes:Buffer.byteLength(JSON.stringify(full.data))},firstPage:{returnedRows:first.results,rowsRead:first.rowsRead,
  elapsedMs:first.elapsedMs,httpBytes:Buffer.byteLength(body)},lastPage:{returnedRows:last.results,rowsRead:last.rowsRead,elapsedMs:last.elapsedMs}};
 console.log('Ledger pagination measurement '+JSON.stringify(report));
}finally{await mf.dispose();}
