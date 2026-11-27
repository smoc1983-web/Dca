// Separate Miniflare service. Handles only synthetic requests.
const step=300_000;
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(url.hostname==='data-api.binance.vision'&&request.method==='GET'){
   if(url.pathname==='/api/v3/time')return Response.json({serverTime:Date.now()});
   if(url.pathname==='/api/v3/klines'&&url.searchParams.get('symbol')==='ADAUSDT'&&url.searchParams.get('interval')==='5m'){
    const from=Number(url.searchParams.get('startTime')),to=Number(url.searchParams.get('endTime'));
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<=0||from%step!==0||
       (to+1)%step!==0||to<from||to-from>=24*step)return new Response(null,{status:400});
    const rows=[];
    for(let t=from;t<=to;t+=step)rows.push([t,95,95,95,95,0,t+step-1]);
    return Response.json(rows);
   }
  }
  if(url.hostname==='api.telegram.org'&&url.pathname==='/botsynthetic-fixture-token/sendMessage'&&request.method==='POST'){
   const body=await request.json();
   if(body.chat_id!=='synthetic-fixture-chat'||typeof body.text!=='string')return new Response(null,{status:400});
   if(env.RECEIPT_FIXTURE==='missing')return Response.json({ok:true,result:{}});
   if(env.RECEIPT_FIXTURE==='confirmed')return Response.json({ok:true,result:{message_id:71}});
  }
  return new Response(null,{status:404});
 }
};
