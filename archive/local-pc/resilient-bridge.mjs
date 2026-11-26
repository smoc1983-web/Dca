export function resilientBridge(base,{attempts=3,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  return async request=>{
    const read=request.operation==='market'||(request.operation==='telegram'&&request.method==='getMe');
    const limit=read?attempts:1;
    for(let attempt=1;;attempt++){
      try{return await base(request);}catch(error){if(attempt>=limit)throw error;await sleep(attempt*1000);}
    }
  };
}
