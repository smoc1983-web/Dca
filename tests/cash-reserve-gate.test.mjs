import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {BudgetStore} from '../cloudflare/budget-store.mjs';
import {CashStore} from '../cloudflare/cash-store.mjs';
const schema=['trade-ledger-schema.sql','budget-store-schema.sql','cash-store-schema.sql'].map(f=>readFileSync(new URL('../cloudflare/'+f,import.meta.url),'utf8')).join('\n');
function port(db,intercept){return {prepare(sql){let args=[];return {bind(...v){args=v;return this;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){if(intercept)await intercept(sql);const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}};}
const cmd=(kind,opId,expectedRevision,o={})=>({kind,opId,actor:'test',recordedAt:10,expectedRevision,confirmed:true,...o});
const init=cmd('init','init',null,{cashGuardMaxAgeMs:100,settings:{policy:'equal-slots-v1',capital:'800',freeCash:'800',maxCycles:1,feeRate:'0.001'}});
const reserve=cmd('reserve','r',0,{id:'c',symbol:'ADAUSDT',tickSize:'0.01',exitFeeRate:'0.001'});
async function fixture(t,{opening='800',clock=()=>10,initializeCash=true,intercept}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(schema);
 const b=new BudgetStore(port(db,intercept),{clock}),c=new CashStore(port(db));await b.apply(init);
 if(initializeCash)await c.write(cmd('opening','o',0,{time:0,cash:opening,noOpeningPositions:true}));
 return {db,b,c};
}
const obs=(free='800',locked='0',rev=1,id='obs')=>cmd('observe',id,rev,{time:5,free,locked,completeHistory:true});
test('no cash opening or observation means no new reservation',async t=>{
 const {b,c}=await fixture(t,{initializeCash:false});
 assert.deepEqual((await b.apply(reserve)).flags,['NO_CASH_OPENING']);
 await c.write(cmd('opening','o',0,{time:0,cash:'800',noOpeningPositions:true}));
 assert.ok((await b.apply(reserve)).flags.includes('NO_BALANCE_OBSERVATION'));
 assert.equal((await b.snapshot()).summary.active,0);
});
test('confirmed fresh cash supports full ladder and replay remains idempotent',async t=>{
 const {b,c,db}=await fixture(t);await c.write(obs());
 assert.equal((await b.apply(reserve)).status,'stored');
 const restored=new BudgetStore(port(db),{clock:()=>10});
 assert.equal((await restored.apply(reserve)).status,'duplicate');
 assert.equal((await restored.snapshot()).state.cashGuardMaxAgeMs,100);
});
test('mismatched or stale cash does not authorize reservation',async t=>{
 let now=10;const {b,c}=await fixture(t,{clock:()=>now});
 await c.write(obs('799'));assert.ok((await b.apply(reserve)).flags.includes('CASH_MISMATCH'));
 await c.write(obs('800','0',2,'obs2'));now=106;
 assert.ok((await b.apply(reserve)).flags.includes('STALE_OBSERVATION'));
});
test('locked cash cannot cover full reserve despite matching total',async t=>{
 const {b,c}=await fixture(t);await c.write(obs('500','300'));
 assert.equal((await b.apply(reserve)).reason,'INSUFFICIENT_RECONCILED_CASH');
});
test('concurrent cash change invalidates guard before atomic reservation',async t=>{
 let c,armed=false;const f=await fixture(t,{intercept:async sql=>{
   if(armed&&sql.includes('INSERT INTO dev_budget_audit')){armed=false;await c.write(cmd('flow','w',2,{flow:{id:'w',kind:'withdrawal',time:6,amount:'300',confirmed:true}}));}
 }});c=f.c;await c.write(obs());armed=true;
 const result=await f.b.apply(reserve);
 assert.equal(result.reason,'CASH_RECONCILIATION_REQUIRED');assert.ok(result.flags.includes('NO_BALANCE_OBSERVATION'));
 assert.equal((await f.b.snapshot()).summary.active,0);
});
test('actual manual fill remains recordable even after cash observation goes stale',async t=>{
 let now=10;const {b,c}=await fixture(t,{clock:()=>now});await c.write(obs());await b.apply(reserve);now=500;
 const e={source:'manual',confirmed:true,id:'b',cycleId:'c',symbol:'ADAUSDT',tf:'5m',baseAsset:'ADA',quoteAsset:'USDT',time:6,side:'buy',price:'105',quantity:'0.2',fee:'0.021',feeAsset:'USDT',dca:0};
 assert.equal((await b.apply(cmd('fill','fill',1,{id:'c',execution:e}))).status,'stored');
 assert.equal((await b.snapshot()).summary.cycles[0].averageEntry,'105');
});
test('cash guard cannot be disabled by settings change',async t=>{
 const {b,c}=await fixture(t);await b.apply(cmd('change','change',0,{settings:{cashGuardMaxAgeMs:null,capital:'1600'}}));
 const state=(await b.snapshot()).state;assert.equal(state.cashGuardMaxAgeMs,100);
 assert.equal((await b.apply({...reserve,expectedRevision:1})).reason,'CASH_RECONCILIATION_REQUIRED');
});
