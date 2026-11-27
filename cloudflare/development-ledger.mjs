// Read-only HTTP entry for synthetic accounts. Never select a DB using request data.
import {isSyntheticToken,matchesToken,readBearer} from './synthetic-bearer.mjs';
import {TradeLedgerStore} from './trade-store.mjs';

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
     ids.has(account.id)||bindings.has(account.binding)||tokens.has(account.token))return null;
  ids.add(account.id);
  bindings.add(account.binding);
  tokens.add(account.token);
 }
 return accounts;
}

export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(env.DEV_LEDGER_MODE!=='synthetic'||url.pathname!=='/ledger'||url.search)
   return reply({status:'not-found'},404);
  if(request.method!=='GET')return reply({status:'method-not-allowed'},405,{Allow:'GET'});
  const accounts=accountDirectory(env.DEV_LEDGER_ACCOUNTS);
  if(!accounts)return unavailable();
  const candidate=readBearer(request);
  const matches=candidate?await Promise.all(accounts.map(a=>matchesToken(candidate,a.token))):[];
  const account=accounts[matches.indexOf(true)];
  if(!account)return reply({status:'unauthorized'},401,{'WWW-Authenticate':'Bearer'});
  try{
   const db=env[account.binding];
   const marker=await db.prepare('SELECT account_id FROM dev_ledger_account WHERE singleton=1').first();
   if(marker?.account_id!==account.id)return unavailable();
   const {revision,executions,cycles}=await new TradeLedgerStore(db).snapshot();
   return reply({status:'available',accountId:account.id,revision,executions,cycles});
  }catch{return unavailable();}
 }
};
