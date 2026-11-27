// HTTP entry for synthetic accounts. Never select a DB using request data.
import {isSyntheticToken,matchesToken,readBearer} from './synthetic-bearer.mjs';
import {LedgerWriteConflict,LedgerWriteValidation,TradeLedgerStore} from './trade-store.mjs';

const accountId=/^[A-Za-z0-9_-]{1,64}$/;
const bindingName=/^DEV_LEDGER_DB_[A-Z0-9_]{1,24}$/;
const reply=(data,status=200,extra={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...extra}});
const unavailable=()=>reply({status:'unavailable'},503);

function accountDirectory(accounts){
 if(!Array.isArray(accounts)||!accounts.length||accounts.length>16)return null;
 const ids=new Set(),bindings=new Set(),tokens=new Set();
 for(const account of accounts){
  if(typeof account?.id!=='string'||!accountId.test(account.id)||typeof account.binding!=='string'||
     !bindingName.test(account.binding)||!isSyntheticToken(account.token)||
     (account.canWrite!==undefined&&typeof account.canWrite!=='boolean')||
     ids.has(account.id)||bindings.has(account.binding)||tokens.has(account.token))return null;
  ids.add(account.id);
  bindings.add(account.binding);
  tokens.add(account.token);
 }
 return accounts;
}

const writeKeys=new Set(['kind','opId','execution','expectedVersion','reason']);
const maxBodyBytes=8192;

async function manualCommand(request,account,now){
 if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!request.body)
  throw new LedgerWriteValidation('JSON required');
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
 let text='',size=0;
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   size+=value.byteLength;
   if(size>maxBodyBytes){await reader.cancel();throw Error('Body limit');}
   text+=decoder.decode(value,{stream:true});
  }
  text+=decoder.decode();
  const body=JSON.parse(text);
  if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).some(k=>!writeKeys.has(k))||
     typeof body.opId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(body.opId)||
     !['fill','correct'].includes(body.kind)||
     (body.kind==='fill'&&(Object.hasOwn(body,'expectedVersion')||Object.hasOwn(body,'reason')))||
     body.execution?.source!=='manual'||body.execution.confirmed!==true||
     !Number.isSafeInteger(body.execution.time)||body.execution.time>now)
   throw Error('Invalid manual request');
  return {...body,opId:'http:'+body.opId,actor:account.id,recordedAt:now};
 }catch{throw new LedgerWriteValidation('Invalid manual request');}
 finally{reader.releaseLock();}
}

export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(env.DEV_LEDGER_MODE!=='synthetic'||url.pathname!=='/ledger'||url.search)
   return reply({status:'not-found'},404);
  if(request.method!=='GET'&&request.method!=='POST')return reply({status:'method-not-allowed'},405,{Allow:'GET, POST'});
  const accounts=accountDirectory(env.DEV_LEDGER_ACCOUNTS);
  if(!accounts)return unavailable();
  const candidate=readBearer(request);
  const matches=candidate?await Promise.all(accounts.map(a=>matchesToken(candidate,a.token))):[];
  const account=accounts[matches.indexOf(true)];
  if(!account)return reply({status:'unauthorized'},401,{'WWW-Authenticate':'Bearer'});
  if(request.method==='POST'&&account.canWrite!==true)return reply({status:'forbidden'},403);
  try{
   const db=env[account.binding];
   const marker=await db.prepare('SELECT account_id FROM dev_ledger_account WHERE singleton=1').first();
   if(marker?.account_id!==account.id)return unavailable();
   const store=new TradeLedgerStore(db);
   if(request.method==='POST'){
    const command=await manualCommand(request,account,Date.now());
    const result=await store.write(command,{serverTimestamp:true});
    return reply(result,result.status==='stored'?201:200);
   }
   const {revision,executions,cycles}=await store.snapshot();
   return reply({status:'available',accountId:account.id,revision,executions,cycles});
  }catch(error){
   if(error instanceof LedgerWriteValidation)return reply({status:'invalid-execution'},400);
   if(error instanceof LedgerWriteConflict)return reply({status:'conflict'},409);
   return unavailable();
  }
 }
};
