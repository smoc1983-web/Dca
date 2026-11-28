// Public market requests. No credentials, no circumvention of explicit access restrictions.
const BASES=Object.freeze(['https://data-api.binance.vision/api/v3/','https://api.binance.com/api/v3/','https://api-gcp.binance.com/api/v3/']);
const defaultRequest=(url,options)=>fetch(url,options);
export class MarketDataError extends Error {
 constructor(code,{host=null,status=null,endpoint=null}={}){
  super(['MARKET_DATA',code,endpoint,host,status].filter(x=>x!==null).join(' '));
  this.name='MarketDataError';this.code=code;this.host=host;this.status=status;this.endpoint=endpoint;
 }
}
function classify(status,body){
 if(status===451||/restricted location|block access from your country|unavailable in your (country|region)/i.test(body))return 'REGION_RESTRICTED';
 if(status===429||status===418)return 'RATE_LIMITED';
 if(status===403)return 'ACCESS_DENIED';
 if([502,503,504].includes(status))return 'UPSTREAM_UNAVAILABLE';
 return 'HTTP_ERROR';
}
export function createMarketReader({log=(...args)=>console.error(...args)}={}){
 let preferred=BASES[0];
 return async function market({endpoint,parameters},request=defaultRequest){
  if(!['time','klines'].includes(endpoint))throw new MarketDataError('INVALID_ENDPOINT');
  let last;
  for(const base of new Set([preferred,...BASES])){
   const url=new URL(endpoint,base);url.search=new URLSearchParams(parameters);
   const host=url.hostname;
   let res;
   try{res=await request(url,{signal:AbortSignal.timeout(12000),redirect:'manual'});}
   catch(e){throw new MarketDataError(e?.name==='TimeoutError'?'TIMEOUT':e?.name==='AbortError'?'CANCELLED':'TRANSPORT_ERROR',{host,endpoint});}
   if(res.ok){
    let data;
    try{data=await res.json();}catch{throw new MarketDataError('INVALID_JSON',{host,status:res.status,endpoint});}
    preferred=base;return data;
   }
   let body='';
   try{body=await res.text();}catch{throw new MarketDataError('ERROR_BODY_UNREADABLE',{host,status:res.status,endpoint});}
   const code=classify(res.status,body);
   last=new MarketDataError(code,{host,status:res.status,endpoint});
   // Preserve existing generic 403/502/503/504 fallback only; never retry
   // explicit regional blocks or rate limits at other hosts.
   log(last.message);
   if(!['ACCESS_DENIED','UPSTREAM_UNAVAILABLE'].includes(code))throw last;
  }
  throw last??new MarketDataError('SOURCE_UNAVAILABLE',{endpoint});
 };
}
export async function readMarketClock(read,now=Date.now){
 const reply=await read({endpoint:'time',parameters:{}});
 const serverTime=reply?.serverTime,localTime=now();
 if(!Number.isSafeInteger(serverTime)||serverTime<=0||!Number.isSafeInteger(localTime)||Math.abs(serverTime-localTime)>120000)throw new MarketDataError('INVALID_CLOCK',{endpoint:'time'});
 return serverTime;
}
