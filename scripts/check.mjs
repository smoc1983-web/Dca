import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
for(const dir of ['cloudflare','scripts','tests']) for(const name of fs.readdirSync(dir)) {
  if(!name.endsWith('.mjs'))continue;
  const r=spawnSync(process.execPath,['--check',`${dir}/${name}`],{stdio:'inherit'});
  if(r.status!==0)process.exit(r.status||1);
}
const markets=JSON.parse(fs.readFileSync('strategy/markets.json','utf8'));
if(markets.length!==19||new Set(markets.map(x=>x.symbol)).size!==19||markets.some(x=>x.symbol==='NEARUSDT'))throw Error('Unexpected watchlist');
console.log('Syntax OK; 19 unique markets; NEAR excluded. No network or delivery.');
