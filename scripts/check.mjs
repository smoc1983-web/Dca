import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
for(const dir of ['cloudflare','scripts','tests']) for(const name of fs.readdirSync(dir)) {
  if(!name.endsWith('.mjs'))continue;
  const r=spawnSync(process.execPath,['--check',`${dir}/${name}`],{stdio:'inherit'});
  if(r.status!==0)process.exit(r.status||1);
}
const markets=JSON.parse(fs.readFileSync('strategy/markets.json','utf8'));
if(markets.length!==19||new Set(markets.map(x=>x.symbol)).size!==19||markets.some(x=>x.symbol==='NEARUSDT'))throw Error('Unexpected watchlist');
if(markets.filter(x=>x.enabled===true).length!==11||markets.filter(x=>x.enabled===false).map(x=>x.symbol).sort().join(',')!=="AAVEUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,ETHUSDT,LTCUSDT,SOLUSDT,SUIUSDT")throw Error('Unexpected active watchlist');
console.log('Syntax OK; 19 historical markets; 11 enabled; eight excluded from new selection. No network or delivery.');
