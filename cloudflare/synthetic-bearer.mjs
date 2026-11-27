// Shared bearer verification for the isolated development Workers.
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const encoder=new TextEncoder();
const purpose=encoder.encode('dca800-synthetic-bearer-v1');
export const isSyntheticToken=value=>typeof value==='string'&&value.length===43&&tokenPattern.test(value);

export function readBearer(request){
 const value=request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
 return isSyntheticToken(value)?value:null;
}

export async function matchesToken(candidate,secret){
 const key=(value,usage)=>crypto.subtle.importKey('raw',encoder.encode(value),
  {name:'HMAC',hash:'SHA-256'},false,[usage]);
 const [trusted,provided]=await Promise.all([key(secret,'verify'),key(candidate,'sign')]);
 const proof=await crypto.subtle.sign('HMAC',provided,purpose);
 return crypto.subtle.verify('HMAC',trusted,proof,purpose);
}
