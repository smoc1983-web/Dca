import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {BudgetStore} from '../cloudflare/budget-store.mjs';
import {CashStore} from '../cloudflare/cash-store.mjs';
const schema=['trade-ledger-schema.sql','budget-store-schema.sql','cash-store-schema.sql'].map(f=>readFileSync(new URL('../cloudflare/'+f,import.meta.url),'utf8')).join('\n');
function port(db){return {prepare(sql){let args=[];return {bind(...v){args=v;return this;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}};}
const cmd=(kind,opId,expectedRevision,o={})=>({kind,opId,expectedRevision,actor:'test',recordedAt:10,confirmed:true,...o});
const e=(o={})=>({source:'manual',confirmed:true,id:'b',cycleId:'c',symbol:'ADAUSDT',baseAsset:'ADA',quoteAsset:'USDT',tf:'5m',time:1,side:'buy',price:'105',quantity:'0.2',fee:'0.021',feeAsset:'USDT',dca:0,...o});
const fix=(rev,o={})=>cmd('correct','fix',rev,{id:'c',execution:e({price:'100',fee:'0.02'}),expectedVersion:1,reason:'Correct receipt',...o});
async function fixture(t,guard=false){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(schema);
 const b=new BudgetStore(port(db),{clock:()=>10}),c=new CashStore(port(db));
 await b.apply(cmd('init','init',null,{...(guard?{cashGuardMaxAgeMs:100}:{}),settings:{policy:'equal-slots-v1',capital:'800',freeCash:'800',maxCycles:1,feeRate:'0.001'}}));
 if(guard){await c.write(cmd('opening','opening',0,{time:0,cash:'800',noOpeningPositions:true}));await c.write(cmd('observe','obs',1,{time:0,free:'800',locked:'0',completeHistory:true}));}
 await b.apply(cmd('reserve','r',0,{id:'c',symbol:'ADAUSDT',tickSize:'0.01',exitFeeRate:'0.001'}));
 await b.apply(cmd('fill','buy',1,{id:'c',execution:e()}));
 return {b,c,db};
}
const review=(rev,ledgerRev)=>cmd('reviewCorrection','review',rev,{id:'c',expectedLedgerRevision:ledgerRev,ordersReviewed:true});
test('confirmed correction replaces actual fill and requires review before next DCA',async t=>{
 const {b}=await fixture(t);await b.apply(cmd('complete','complete',2,{id:'c',step:0}));
 const r=await b.apply(fix(3));assert.equal(r.summary.cycles[0].averageEntry,'100');assert.equal(r.summary.cycles[0].tp.price,'103');assert.equal(r.summary.cycles[0].nextDca,null);
 assert.ok(r.summary.flags.includes('CORRECTION_RECONCILIATION_REQUIRED'));
 const snapshot=await b.ledger.snapshot();assert.equal(snapshot.executions.length,1);assert.equal(snapshot.executions[0].version,2);
 const audit=await b.ledger.audit();assert.equal(audit[0].execution.price,105);assert.equal(audit[1].reason,'Correct receipt');
 const done=await b.apply(review(4,snapshot.revision));assert.equal(done.summary.cycles[0].nextDca.price,'95');
 assert.equal((await b.apply(fix(3))).status,'duplicate');
});
test('correction requires version, reason, confirmation and unchanged identity',async t=>{
 const {b}=await fixture(t);const before=await b.snapshot();
 for(const [patch,pattern] of [[{confirmed:false},/Confirmed/],[{expectedVersion:2},/Stale correction/],[{reason:''},/Invalid reason/],[{execution:e({dca:1})},/cannot change dca/]]){
   await assert.rejects(b.apply(fix(2,patch)),pattern);
 }
 assert.deepEqual(await b.snapshot(),before);assert.equal((await b.ledger.snapshot()).executions[0].version,1);
});
test('correction cannot make a downstream sale exceed inventory',async t=>{
 const {b}=await fixture(t);await b.apply(cmd('fill','sell',2,{id:'c',execution:e({id:'s',time:2,side:'sell',price:'110',fee:'0.022',dca:null})}));
 const before=await b.snapshot();await assert.rejects(b.apply(fix(3,{execution:e({quantity:'0.1'})})),/exceeds quantity/);assert.deepEqual(await b.snapshot(),before);
});
test('released cycle corrected into open inventory reholds reserve and blocks new entry',async t=>{
 const {b}=await fixture(t);await b.apply(cmd('fill','sell',2,{id:'c',execution:e({id:'s',time:2,side:'sell',price:'110',fee:'0.022',dca:null})}));
 await b.apply(cmd('release','release',3,{id:'c',ordersCancelled:true,freeCash:'800'}));
 const r=await b.apply(fix(4,{execution:e({id:'s',time:2,side:'sell',price:'110',quantity:'0.1',fee:'0.011',dca:null})}));
 assert.equal(r.summary.cycles[0].quantity,'0.1');assert.ok(Number(r.summary.held)>0);assert.ok(r.summary.flags.includes('REOPENED_AFTER_CORRECTION'));
 assert.equal((await b.apply(cmd('reserve','new',5,{id:'d',symbol:'BTCUSDT',tickSize:'0.01',exitFeeRate:'0.001'}))).reason,'RECONCILIATION_REQUIRED');
 await assert.rejects(b.apply(cmd('release','bad',5,{id:'c',ordersCancelled:true,freeCash:'800'})),/review required/);
 await b.apply(review(5,(await b.ledger.snapshot()).revision));
 await assert.rejects(b.apply(cmd('release','bad2',6,{id:'c',ordersCancelled:true,freeCash:'800'})),/open position/);
});
test('fresh reconciled observation required after correction in guarded mode',async t=>{
 const {b,c}=await fixture(t,true);await b.apply(fix(2));
 await assert.rejects(b.apply(review(3,(await b.ledger.snapshot()).revision)),/Cash reconciliation required/);
 await c.write(cmd('observe','fresh',2,{time:5,free:'779.98',locked:'0',completeHistory:true}));
 await assert.rejects(b.apply(review(3,1)),/Stale ledger review/);
 const done=await b.apply(review(3,(await b.ledger.snapshot()).revision));assert.equal(done.state.reservations[0].correctionPending,false);
});
test('guarded release needs fresh cash observation after sale',async t=>{
 const {b,c}=await fixture(t,true);await b.apply(cmd('fill','sell',2,{id:'c',execution:e({id:'s',time:2,side:'sell',price:'110',fee:'0.022',dca:null})}));
 const release=cmd('release','release',3,{id:'c',ordersCancelled:true,freeCash:'800'});
 await assert.rejects(b.apply(release),/Cash reconciliation required/);
 await c.write(cmd('observe','fresh',2,{time:5,free:'800.957',locked:'0',completeHistory:true}));
 assert.equal((await b.apply(release)).state.reservations[0].status,'released');
});
test('atomic correction trigger failure leaves original execution and budget intact',async t=>{
 const {b,db}=await fixture(t),before=await b.snapshot();
 db.exec("CREATE TRIGGER fail_correct BEFORE INSERT ON trade_ledger_audit BEGIN SELECT RAISE(ABORT,'Injected correction failure'); END;");
 await assert.rejects(b.apply(fix(2)),/Injected correction failure/);
 assert.deepEqual(await b.snapshot(),before);assert.equal((await b.ledger.snapshot()).executions[0].version,1);
});
