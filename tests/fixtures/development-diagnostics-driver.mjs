// Miniflare fixture only. The diagnostic Worker itself has no HTTP tick route.
import developmentWorker from '../../cloudflare/development-diagnostics.mjs';

export default {
 async fetch(request,env){
  if(new URL(request.url).pathname!=='/__fixture_tick')return developmentWorker.fetch(request,env);
  if(request.method!=='POST')return new Response(null,{status:405});
  const mode=request.headers.get('X-Fixture-Network');
  const DEV_MOCK_NETWORK={fetch(input,options){
   // Throw from the Worker runtime to model a lost acknowledgement, before any real network call.
   if(mode==='telegram-timeout'&&new URL(input).hostname==='api.telegram.org')
    throw new DOMException('Synthetic timeout after acceptance','TimeoutError');
   return env.DEV_MOCK_NETWORK.fetch(input,options);
  }};
  let result;
  developmentWorker.scheduled({}, {...env,DEV_MOCK_NETWORK}, {waitUntil(promise){result=promise;}});
  await result;
  return Response.json({ran:result!==undefined});
 }
};
