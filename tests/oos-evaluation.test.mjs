import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {intervalMs} from '../cloudflare/watchlist-engine.mjs';
import {evaluateOos,requireClosedOos} from '../scripts/oos-evaluation.mjs';
import {hashRows,urlFor} from '../scripts/prepare-mark-history.mjs';

const read=p=>JSON.parse(readFileSync(new URL(p,import.meta.url)));
const protocol=read('../research/oos-protocol-2026-12.json');
const markets=read('../strategy/markets.json').filter(m=>m.enabled);
const window={warmupStart:Date.parse(protocol.warmupStart),start:Date.parse(protocol.start),end:Date.parse(protocol.end)};
const dayMs=86_400_000, digest='a'.repeat(64);
function fixture(){
 return markets.map(m=>{
  const distance=intervalMs(m.tf);
  const candles=Array.from({length:(window.end-window.warmupStart)/distance},(_,i)=>{
   const time=window.warmupStart+i*distance;
   return {time,closeTime:time+distance-1,open:100,high:101,low:99,close:100,volume:1};
  });
  const archives=Array.from({length:8},(_,i)=>{
   const start=window.warmupStart+i*dayMs,end=i===7?window.end:start+dayMs;
   const label=new Date(start).toISOString().slice(0,i===7?7:10);
   return {name:m.symbol+'-5m-'+label+'.zip',sha256:digest,start,end,rows:(end-start)/300_000};
  });
  const rows=candles.filter(c=>c.time>=window.start);
  return {spot:{tf:m.tf,params:Object.fromEntries(['symbol','initialCapital','fee','slippageBps','tick','qtyStep','minQty','minNotional'].map(k=>[k,m.params[k]])),window,candles,archiveManifest:{archives},source:{kind:'historical',
    provider:'fixture',datasetId:'fixture',retrievedAt:window.end,selectionCutoff:Date.parse(protocol.selectionCutoff),
    expectedSha256:hashRows(candles),filterSource:'fixture'}},
   mark:{symbol:m.symbol,tf:m.tf,start:window.start,end:window.end,rows,dataSha256:hashRows(rows),
    archives:[{month:'2026-12',url:urlFor(m.symbol,'2026-12'),sha256:digest}]}};
 });
}
test('waits for the preregistered UTC window to close',()=>{
 assert.throws(()=>requireClosedOos(window.end-1),/still open/);
 assert.doesNotThrow(()=>requireClosedOos(window.end));
});
test('runs all frozen portfolio and mark cases on aligned inputs',()=>{
 const report=evaluateOos(fixture(),window.end);
 assert.deepEqual(report.portfolios.map(r=>r.settings.slippageBps),[0,2,5,10]);
 assert.equal(report.overlays.length,24);
 assert.equal(report.provenance.length,11);
 assert.ok(report.overlays.every(r=>r.status==='completed-fixed-schedule'&&r.recommendationAllowed===false&&r.processedEvents===0));
});
test('rejects missing markets, spot checksum changes and invalid or shifted mark data',()=>{
 const data=fixture();
 assert.throws(()=>evaluateOos(data.slice(1),window.end),/universe/);
 const {spot,mark}=data[0];
 spot.source.expectedSha256=digest;
 assert.throws(()=>evaluateOos(data,window.end),/Candle checksum/);
 spot.source.expectedSha256=hashRows(spot.candles);
 mark.rows[0]={...mark.rows[0],time:mark.rows[0].time+1};
 mark.dataSha256=hashRows(mark.rows);
 assert.throws(()=>evaluateOos(data,window.end),/misaligned/);
 mark.archives[0].url='https://example.invalid/mark.zip';
 assert.throws(()=>evaluateOos(data,window.end),/mark provenance/);
});
