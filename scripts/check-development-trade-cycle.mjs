// End-to-end acceptance of the synthetic manual spot cycle. No broker or sender.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runTradeCycleAcceptance} from './run-trade-cycle-acceptance.mjs';

const {Miniflare}=createRequire(import.meta.url)('miniflare');
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=mkdtempSync(join(tmpdir(),'dca-trade-cycle-'));
const account={id:'cycle-fixture',binding:'DEV_LEDGER_DB_CYCLE',token:randomBytes(32).toString('base64url'),
 canWrite:true,budgeted:true};
let mf,outbound=0;
async function open(){
 mf=new Miniflare({host:'127.0.0.1',port:0,logRequests:false,modules:true,modulesRoot:root,
  scriptPath:root+'cloudflare/development-ledger.mjs',compatibilityDate:'2026-07-30',
  bindings:{DEV_LEDGER_MODE:'synthetic',DEV_LEDGER_ACCOUNTS:[account]},
  d1Persist:dir,d1Databases:{[account.binding]:'trade-cycle-fixture'},
  outboundService:()=>{outbound++;return new Response(null,{status:500});}});
 return mf.getD1Database(account.binding);
}
async function prepare(db){
 const names=['trade-ledger-schema','development-ledger-account-schema','budget-store-schema','cash-store-schema'];
 const schema=names.flatMap(name=>readFileSync(new URL('../cloudflare/'+name+'.sql',import.meta.url),'utf8')
  .split(/(?=^CREATE )/m).filter(s=>s.startsWith('CREATE ')).map(s=>s.trim()));
 await db.batch(schema.map(sql=>db.prepare(sql)));
 await db.prepare('INSERT INTO dev_ledger_account(singleton,account_id) VALUES(1,?)').bind(account.id).run();
}
function request(path,body){
 const headers={Authorization:'Bearer '+account.token};
 const options=body?{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)}:{headers};
 return mf.dispatchFetch('http://ledger.fixture'+path,options);
}
async function reconnect(){
 await mf.dispose();
 mf=undefined;
 return open();
}

try{
 const db=await open();
 await prepare(db);
 const fixture={db,accountId:account.id,request,reconnect};
 await assert.rejects(runTradeCycleAcceptance({...fixture,accountId:'different-account'}),/Dedicated fresh synthetic D1 required/);
 const wrongAccount=async(path,body)=>{
  const response=await request(path,body);
  return Response.json({...await response.json(),accountId:'different-account'},response);
 };
 await assert.rejects(runTradeCycleAcceptance({...fixture,request:wrongAccount}),/different synthetic account/);
 const result=await runTradeCycleAcceptance(fixture);
 await assert.rejects(runTradeCycleAcceptance({...fixture,db:await mf.getD1Database(account.binding)}),/Dedicated fresh synthetic D1 required/);
 assert.equal(outbound,0);
 console.log('Trade cycle acceptance: '+JSON.stringify(result));
}finally{
 try{if(mf)await mf.dispose();}finally{rmSync(dir,{recursive:true,force:true});}
}
