import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
const root=process.argv[2],out=process.argv[3],markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
const rows=readdirSync(root).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(join(root,n),'utf8')));
if(rows.length!==19||new Set(rows.map(x=>x.symbol)).size!==19||markets.some(m=>!rows.some(r=>r.symbol===m.symbol&&r.grid.length===11)))throw Error('Incomplete sweep');
const summaries=rows.map(r=>({symbol:r.symbol,currentTf:r.currentTf,fullWinner:r.fullWinner,trainWinner:r.trainWinner,current:r.grid.find(x=>x.tf===r.currentTf),best:r.grid.find(x=>x.tf===r.fullWinner),trainSelected:r.grid.find(x=>x.tf===r.trainWinner)}));
summaries.sort((a,b)=>b.current.full.returnPct-a.current.full.returnPct);
writeFileSync(out,JSON.stringify({kind:'historical',period:'2025-02-01/2026-10-31 UTC',summaries,rows}));
for(const r of summaries)console.log('RANK '+JSON.stringify(r));
