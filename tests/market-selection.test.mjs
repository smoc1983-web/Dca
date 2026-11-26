import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activeMarkets,previewMarketTransition} from '../cloudflare/market-selection.mjs';
import {DEFAULTS,newState} from '../cloudflare/watchlist-engine.mjs';
import {stepEntry} from '../cloudflare/runtime.mjs';
const markets=JSON.parse(readFileSync(new URL('../strategy/markets.json',import.meta.url),'utf8'));
const excluded=["AAVEUSDT","AVAXUSDT","BCHUSDT","BNBUSDT","ETHUSDT","LTCUSDT","SOLUSDT","SUIUSDT"];
const dt=300000,bar=(t,p)=>({time:t,closeTime:t+dt-1,open:p,high:p,low:p,close:p});
const entry=(symbol,open=false)=>{const params={...DEFAULTS,symbol},s=newState(params);s.lastTime=0;if(open)Object.assign(s,{qty:.25,average:100,invested:25,lastEntry:100,cash:774.975,cycleEquity:800,cycleStart:100,cycleStartedAt:0});return {symbol,tf:'5m',params,s,entryEnabled:true};};
test('eight excluded, TRX retained, 19 historical markets preserved',()=>{
 assert.equal(markets.length,19);assert.equal(activeMarkets(markets).length,11);
 assert.deepEqual(markets.filter(m=>!m.enabled).map(m=>m.symbol).sort(),excluded);
 assert.deepEqual(activeMarkets(markets).map(m=>m.symbol).sort(),['ADAUSDT','ATOMUSDT','BTCUSDT','DOGEUSDT','DOTUSDT','LDOUSDT','LINKUSDT','TRXUSDT','UNIUSDT','XRPUSDT','ZECUSDT']);
});
test('preview preserves open cycle, retires flat, leaves retained entries unchanged',()=>{
 const entries={'SUIUSDT:5m':entry('SUIUSDT',true),'BNBUSDT:5m':entry('BNBUSDT'),'TRXUSDT:5m':entry('TRXUSDT',true)};
 entries['SUIUSDT:5m'].selectedParams={...DEFAULTS};
 const before=structuredClone(entries),r=previewMarketTransition(markets,entries);
 assert.deepEqual(entries,before);const s=r.entries['SUIUSDT:5m'];
 assert.deepEqual(s.s,before['SUIUSDT:5m'].s);assert.deepEqual(s.params,before['SUIUSDT:5m'].params);
 assert.equal(s.entryEnabled,false);assert.equal(s.legacy,true);assert.equal(s.selectedParams,undefined);
 assert.equal(r.entries['BNBUSDT:5m'].retired,true);assert.deepEqual(r.entries['TRXUSDT:5m'],before['TRXUSDT:5m']);assert.equal(r.productionApplied,false);
});
test('excluded existing model can finish DCA and TP but not restart',()=>{
 const key='SUIUSDT:5m',r=previewMarketTransition(markets,{[key]:entry('SUIUSDT',true)}),state={entries:r.entries};
 const dca=stepEntry(state,key,bar(dt,95),{budgetMode:'signals'});assert.equal(dca.kind,'DCA1');
 const e=state.entries[key];const tp=stepEntry(state,key,bar(2*dt,e.s.average*1.04),{budgetMode:'signals'});assert.equal(tp.kind,'TP');
 assert.equal(e.retired,true);assert.equal(e.s.qty,0);assert.equal(stepEntry(state,key,bar(3*dt,90),{budgetMode:'signals'}),null);
});
test('all excluded flat entries retire; preview idempotent',()=>{
 const entries=Object.fromEntries(excluded.map(symbol=>[symbol+':5m',entry(symbol)]));const r=previewMarketTransition(markets,entries);
 for(const key of Object.keys(entries)){assert.equal(r.entries[key].retired,true);assert.equal(stepEntry({entries:r.entries},key,bar(dt,95),{budgetMode:'signals'}),null);}
 assert.deepEqual(previewMarketTransition(markets,r.entries).entries,r.entries);
});
test('invalid configuration and retired open model rejected',()=>{
 assert.throws(()=>activeMarkets([...markets,markets[0]]),/Invalid market/);
 const e=entry('SUIUSDT',true);e.retired=true;assert.throws(()=>previewMarketTransition(markets,{'SUIUSDT:5m':e}),/Retired model/);
});
