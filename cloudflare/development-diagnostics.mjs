// Local synthetic Worker entry. Requires an isolated DB and a mock service binding.
import {tick} from './worker.mjs';
import {readHealth} from './health-read.mjs';
import {HealthNotices} from './health-notices.mjs';
import {SourceMetrics,observeSourceRequest} from './source-metrics.mjs';
import {isSyntheticToken,matchesToken,readBearer} from './synthetic-bearer.mjs';

const mockBot='synthetic-fixture-token';
const mockChat='synthetic-fixture-chat';
const minute=60_000;
const sourceHosts=new Map([
 ['data-api.binance.vision','binance-vision'],['api.binance.com','binance-primary'],['api-gcp.binance.com','binance-gcp']
]);
const defaults=Object.freeze({
 maxTickAgeMs:2*minute,candleGraceMs:minute,pendingAgeMs:minute,dailyEnabled:false,dailyGraceMs:minute,
 sourceWindowMs:24*60*minute,incidentCooldownMs:minute
});
const maxWindowMs=7*24*60*minute;

export function developmentPolicy(overrides={}){
 function invalid(){throw Error('Invalid synthetic monitoring policy');}
 if(!overrides||typeof overrides!=='object'||Array.isArray(overrides))invalid();
 for(const [key,value] of Object.entries(overrides)){
  if(!Object.hasOwn(defaults,key))invalid();
  if(key==='dailyEnabled'){
   if(typeof value!=='boolean')invalid();
  }else{
   const permitsZero=key==='candleGraceMs'||key==='dailyGraceMs';
   // The existing daily check begins at 06:00 and expires at local midnight.
   const maximum=key==='dailyGraceMs'?18*60*minute-1:maxWindowMs;
   if(!Number.isSafeInteger(value)||value<(permitsZero?0:1)||value>maximum)invalid();
  }
 }
 return {...defaults,...overrides};
}
const enabled=env=>env.DEV_WORKER_MODE==='synthetic';
const reply=(data,status=200,extra={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...extra}});

function observedRequest(env,metrics){
 return async (input,options)=>{
  const url=new URL(input);
  const market=url.pathname.match(/^\/api\/v3\/(time|klines)$/)?.[1];
  const source=market?sourceHosts.get(url.hostname):null;
  const telegram=url.hostname==='api.telegram.org'&&url.pathname==='/bot'+mockBot+'/sendMessage'&&options?.method==='POST';
  if(url.protocol!=='https:'||url.port||url.username||url.password||
     !(market&&source&&!options?.method||telegram))throw Error('Unexpected synthetic outbound request');
  const sample={synthetic:true,id:crypto.randomUUID(),source:telegram?'telegram':source,operation:telegram?'sendMessage':market};
  const {response}=await observeSourceRequest(metrics,sample,()=>env.DEV_MOCK_NETWORK.fetch(url.href,options));
  return response;
 };
}

async function runSyntheticTick(env){
 if(!env.DEV_DB||typeof env.DEV_MOCK_NETWORK?.fetch!=='function')throw Error('Missing isolated Worker bindings');
 const policy=developmentPolicy(env.DEV_MONITORING_POLICY);
 const metrics=new SourceMetrics(env.DEV_DB);
 try{
  await tick({DB:env.DEV_DB,BOT_TOKEN:mockBot,CHAT_ID:mockChat,DAILY_SUMMARY:policy.dailyEnabled?'on':'off'},
   {request:observedRequest(env,metrics)});
 }finally{
  const now=Date.now();
  const health=await readHealth(env.DEV_DB,{...policy,now});
  await new HealthNotices(env.DEV_DB).claim({synthetic:true,health,now,cooldownMs:policy.incidentCooldownMs});
 }
}

export default {
 scheduled(_event,env,ctx){
  if(enabled(env))ctx.waitUntil(runSyntheticTick(env));
 },
 async fetch(request,env){
  const url=new URL(request.url);
  if(!enabled(env)||url.pathname!=='/diagnostics'||url.search||
     !isSyntheticToken(env.DEV_DIAGNOSTICS_TOKEN))
   return reply({status:'not-found'},404);
  if(request.method!=='GET')return reply({status:'method-not-allowed'},405,{Allow:'GET'});
  const candidate=readBearer(request);
  if(!candidate||!await matchesToken(candidate,env.DEV_DIAGNOSTICS_TOKEN))
   return reply({status:'unauthorized'},401,{'WWW-Authenticate':'Bearer'});
  let policy;
  try{policy=developmentPolicy(env.DEV_MONITORING_POLICY);}
  catch{return reply({status:'configuration-unavailable'},503);}
  const now=Date.now();
  const [health,sources,notice]=await Promise.all([
   readHealth(env.DEV_DB,{...policy,now}),
   new SourceMetrics(env.DEV_DB).read({now,windowMs:policy.sourceWindowMs}),
   new HealthNotices(env.DEV_DB).read()
  ]);
  return reply({observedAt:now,health,sources,notice},health.status==='unavailable'?503:200);
 }
};
