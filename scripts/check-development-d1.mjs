// Optional isolated D1 emulator check. Requires Miniflare on NODE_PATH.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {IsolatedPreflightStore} from '../cloudflare/isolated-preflight-store.mjs';
import {readHealth} from '../cloudflare/health-read.mjs';
const {Miniflare}=createRequire(import.meta.url)('miniflare');
const mf=new Miniflare({modules:true,script:'export default {}',d1Databases:['DB']});
try {
 const db=await mf.getD1Database('DB');
 for(const name of ['schema','futures-store-schema','isolated-collateral-schema','isolated-preflight-schema']){
  const sql=readFileSync(new URL('../cloudflare/'+name+'.sql',import.meta.url),'utf8');
  await db.batch(sql.trim().split(/;\r?\n/).map(x=>x.trim()).filter(Boolean).map(x=>db.prepare(x)));
 }
 const s=new IsolatedPreflightStore(db);
 const scope={mode:'isolated',venue:'test',accountId:'a',synthetic:true};
 const snapshot={...scope,observedAt:10,freeCollateral:'100',dcaReserve:'60',protectionCap:'30',positions:[]};
 await s.futures.bindAccount(scope);
 await s.collateral.initialize(snapshot);
 await s.collateral.write({...scope,manual:true,expectedRevision:0,opId:'obs',time:20,kind:'reconcile',
  maxAgeMs:10,observation:{...snapshot,confirmed:true,complete:true,observedAt:20}});
 const request={decisionId:'d',synthetic:true,account:scope,expected:{futuresRevision:0,collateralRevision:1},
  action:{kind:'START',step:0,cycleId:'new',symbol:'BTCUSDT',leverage:2},now:21,maxAgeMs:10};
 const output=await Promise.all([s.record(request),s.record(request)]);
 assert.equal(output.filter(r=>r.audit==='stored').length,1);
 assert.equal(output.filter(r=>r.reasons.includes('decision-already-recorded')).length,1);
 assert.ok(output.every(r=>r.recommendationAllowed===false));
 const now=Date.parse('2026-11-27T02:02:00Z');
 await db.batch([db.prepare("INSERT INTO control VALUES(1,'live','test')"),
  db.prepare('INSERT INTO runs VALUES(?,?,?,?)').bind(now/60_000,0,0,null)]);
 const health=await readHealth(db,{now,maxTickAgeMs:180000,candleGraceMs:30000,pendingAgeMs:60000,dailyEnabled:false,dailyGraceMs:120000});
 assert.equal(health.status,'healthy');
 console.log('Miniflare D1: schemas, initialization, concurrent matched preflight and read-only health all passed');
} finally {await mf.dispose();}
