import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {aggregate5m} from './backtest-timeframes.mjs';
import {inspectSpotDataset} from './backtest-spot.mjs';
const read=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const markets=read('../strategy/markets.json');
const pins={...read('./long-history-pins-a.json'),...read('./long-history-pins-b.json')};
const targetPins=read('./long-target-pins.json');
const W=Date.parse('2024-07-01T00:00:00Z'),A=Date.parse('2025-02-01T00:00:00Z'),C=Date.parse('2026-11-01T00:00:00Z');
const keys=['symbol','initialCapital','fee','slippageBps','tick','qtyStep','minQty','minNotional'];
export function checkArchivePins(symbol,archives,pinned=pins){
 if(!Array.isArray(archives)||archives.length!==28)throw Error('28 monthly archives required');
 let i=0;
 for(let y=2024;y<=2026;y++)for(let m=1;m<=12;m++){
  if(y===2024&&m<7||y===2026&&m>10)continue;
  const name=symbol+'-5m-'+y+'-'+String(m).padStart(2,'0')+'.zip',a=archives[i++];
  if(a.name!==name||!pinned[name]||a.sha256!==pinned[name]||a.start!==Date.UTC(y,m-1,1)||a.end!==Date.UTC(y,m,1))throw Error('Prior archive pin mismatch: '+name);
 }
}
export function validateLongInput(d,base=false){
 const m=markets.find(x=>x.symbol===d.params?.symbol);
 if(!m||d.tf!==(base?'5m':m.tf)||d.window?.warmupStart!==W||d.window.start!==A||d.window.end!==C||d.source?.kind!=='historical'||
 Object.keys(d.params).length!==keys.length||keys.some(k=>d.params[k]!==m.params[k]))throw Error('Frozen long input mismatch');
 checkArchivePins(m.symbol,d.archiveManifest?.archives);
 const v=inspectSpotDataset(d);
 if(!base&&(targetPins[m.symbol]?.tf!==m.tf||targetPins[m.symbol]?.sha256!==v.dataSha256))throw Error('Prior target candle hash mismatch: '+m.symbol);
 return {market:m,verified:v};
}
export function prepareLongTarget(d){
 const {market,verified}=validateLongInput(d,true);
 const target={...d,tf:market.tf,candles:aggregate5m(verified.rows,market.tf),source:{...verified.manifest,expectedSha256:targetPins[market.symbol].sha256}};
 validateLongInput(target);
 return target;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const d=prepareLongTarget(JSON.parse(readFileSync(process.argv[2],'utf8')));
 writeFileSync(process.argv[3],JSON.stringify(d));
 console.log('PINNED_TARGET '+JSON.stringify({symbol:d.params.symbol,tf:d.tf,sha256:d.source.expectedSha256,bars:d.candles.length}));
}
