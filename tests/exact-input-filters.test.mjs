import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {units,decimalString} from '../cloudflare/ledger-decimal.mjs';
import {normalizeExecution,replayLedger} from '../cloudflare/trade-ledger.mjs';
import {TradeLedgerStore} from '../cloudflare/trade-store.mjs';
import {executionsCsv,cyclesCsv} from '../cloudflare/ledger-csv.mjs';
import {validateLimit,planLimitBuy} from '../cloudflare/order-filters.mjs';
const fill=(o={})=>({source:'manual',confirmed:true,id:'a',cycleId:'c',symbol:'ADAUSDT',tf:'5m',baseAsset:'ADA',quoteAsset:'USDT',side:'buy',price:'1.000000000000000001',quantity:'1',time:1,fee:'0',...o});
const f={tickSize:'0.05',stepSize:'0.03',minPrice:'0.05',maxPrice:'100',minQty:'0.03',maxQty:'100',minNotional:'5',maxNotional:'1000'};
test('string decimals retain exact digits and reject unsupported precision',()=>{
  assert.equal(decimalString(units('1.000000000000000001')),'1.000000000000000001');
  assert.throws(()=>units('0.0000000000000000000000001'),/precision/);
  assert.throws(()=>units('1e-3'),/Invalid/);
  assert.equal(normalizeExecution(fill()).exact.notional,'1.000000000000000001');
});
test('realized profit retains sub-Number precision and exact fee conversion',()=>{
  const [c]=replayLedger([fill({fee:'0.000000000000000001',feeAsset:'BNB',feeQuoteRate:'2'}),fill({id:'b',side:'sell',time:2,price:'1.000000000000000010'})]);
  assert.equal(c.exact.realized,'0.000000000000000007');
  assert.equal(c.exact.feesQuote,'0.000000000000000002');
});
test('string and number equivalent duplicates normalize; distinct exact input conflicts',()=>{
  assert.equal(replayLedger([fill({price:'1.00'}),fill({price:1})])[0].executions,1);
  assert.throws(()=>replayLedger([fill(),fill({price:'1.000000000000000002'})]),/Conflicting/);
});
test('exact limit buy rounds down without exceeding budget',()=>{
  const r=planLimitBuy({targetPrice:'3.149',budget:'10',filters:f});
  assert.deepEqual(r,{valid:true,failures:[],price:'3.1',quantity:'3.21'});
  assert.equal(validateLimit({price:r.price,quantity:r.quantity,filters:f}).valid,true);
});
test('filter rejects off-step, low nominal, max quantity and missing limits',()=>{
  assert.deepEqual(validateLimit({price:'3.12',quantity:'0.01',filters:f}).failures,['PRICE_FILTER','LOT_SIZE','NOTIONAL']);
  assert.deepEqual(planLimitBuy({targetPrice:'3.1',budget:'4.99',filters:f}).failures,['NOTIONAL']);
  assert.ok(validateLimit({price:'1',quantity:'100.02',filters:f}).failures.includes('LOT_SIZE'));
  assert.throws(()=>planLimitBuy({targetPrice:'1',budget:'10',filters:{tickSize:'0.01'}}),/Invalid/);
});
test('SQLite and CSV preserve exact input and negative decimal PnL',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(readFileSync(new URL('../cloudflare/trade-ledger-schema.sql',import.meta.url),'utf8'));
  const port={prepare(sql){let args=[];return {bind(...v){args=v;return this;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}};
  const s=new TradeLedgerStore(port);const op=(e)=>({kind:'fill',opId:e.id,actor:'test',recordedAt:e.time,execution:e});
  await s.write(op(fill()));await s.write(op(fill({id:'b',side:'sell',time:2,price:'1'})));
  const snap=await s.snapshot();assert.equal(snap.executions[0].execution.price,'1.000000000000000001');
  assert.equal(snap.cycles[0].exact.realized,'-0.000000000000000001');
  assert.ok(executionsCsv(snap,'manual').includes(',1.000000000000000001,'));
  assert.ok(cyclesCsv(snap,'manual').includes(',-0.000000000000000001,'));
  assert.equal((await s.write(op(fill()))).status,'duplicate');
});
