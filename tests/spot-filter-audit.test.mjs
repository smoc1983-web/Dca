import test from 'node:test';
import assert from 'node:assert/strict';
import {extractSpotFilters,auditLimitStart,auditSnapshot} from '../scripts/spot-filter-audit.mjs';
const s={symbol:'BTCUSDT',status:'TRADING',quoteAsset:'USDT',isSpotTradingAllowed:true,orderTypes:['LIMIT'],filters:[{filterType:'PRICE_FILTER',tickSize:'0.01',minPrice:'0.01',maxPrice:'1000000'},{filterType:'LOT_SIZE',stepSize:'0.00001',minQty:'0.00001',maxQty:'100'},{filterType:'MIN_NOTIONAL',minNotional:'5'}]};
test('five USDT can fail after lot rounding; exact minimum returned',()=>{
 const filters=extractSpotFilters(s);
 const a=auditLimitStart({price:'81234.56',budget:'5',filters});
 assert.equal(a.passesStaticLimitFilters,false);assert.equal(a.minimumBudgetAtPrice,'5.6864192');assert.equal(a.recommendationAllowed,false);
 assert.equal(auditLimitStart({price:'81234.56',budget:'10',filters}).passesStaticLimitFilters,true);
});
test('stricter notional bound and quantity minimum applied',()=>{
 const raw=structuredClone(s);raw.filters.push({filterType:'NOTIONAL',minNotional:'10',maxNotional:'100'});
 raw.filters[1].minQty='0.001';
 const f=extractSpotFilters(raw);assert.equal(f.minNotional,'10');
 assert.equal(auditLimitStart({price:'10000',budget:'5',filters:f}).minimumBudgetAtPrice,'10');
});
test('missing filters or nontrading status rejected',()=>{
 assert.throws(()=>extractSpotFilters({...s,filters:s.filters.slice(0,2)}),/Missing/);
 assert.throws(()=>extractSpotFilters({...s,status:'BREAK'}),/unavailable/);
});
test('snapshot demands all eleven explicit symbols',()=>{assert.throws(()=>auditSnapshot({symbols:[s],prices:[],requested:['BTCUSDT'],capturedAt:1}),/Invalid snapshot/);});
