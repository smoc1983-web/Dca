import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BudgetStore} from '../cloudflare/budget-store.mjs';
const schema=['trade-ledger-schema.sql','budget-store-schema.sql'].map(f=>readFileSync(new URL('../cloudflare/'+f,import.meta.url),'utf8')).join('\n');
function port(db){return {prepare(sql){let args=[];return {bind(...v){args=v;return this;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}};}
const settings={policy:'equal-slots-v1',capital:'800',freeCash:'800',maxCycles:1,feeRate:'0.001'};
const command=(kind,opId,expectedRevision,extra={})=>({kind,opId,actor:'test',recordedAt:1,expectedRevision,...extra});
const init=command('init','init',null,{settings});
const reserve=command('reserve','reserve',0,{id:'c',symbol:'ADAUSDT',tickSize:'0.01',exitFeeRate:'0.001'});
const e=(o={})=>({source:'manual',confirmed:true,id:'b',cycleId:'c',symbol:'ADAUSDT',baseAsset:'ADA',quoteAsset:'USDT',tf:'5m',time:1,side:'buy',price:'105',quantity:'0.2',fee:'0.021',feeAsset:'USDT',dca:0,...o});
const fill=command('fill','fill',1,{id:'c',execution:e()});
async function setup(db){db.exec(schema);const s=new BudgetStore(port(db));await s.apply(init);await s.apply(reserve);return s;}
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return db;}
test('reservation, manual fill, step completion and actual TP persist together',async t=>{
  const s=await setup(fixture(t));let r=await s.apply(fill);
  assert.equal(r.summary.cycles[0].quantity,'0.2');assert.equal(r.summary.cycles[0].averageEntry,'105');
  assert.equal(r.summary.cycles[0].nextDca,null);
  r=await s.apply(command('complete','complete',2,{id:'c',step:0,confirmed:true}));
  assert.equal(r.summary.cycles[0].nextDca.price,'99.75');assert.equal(r.summary.cycles[0].tp.price,'108.15');
  assert.equal((await s.ledger.snapshot()).executions.length,1);
  assert.equal((await s.apply(fill)).status,'duplicate');
  assert.equal((await s.apply(command('fill','repeat',3,{id:'c',execution:e()}))).status,'duplicate');
});
test('trigger failure rolls back both budget and manual ledger',async t=>{
  const db=fixture(t),s=await setup(db),before=await s.snapshot();
  db.exec("CREATE TRIGGER injected BEFORE INSERT ON trade_ledger_audit BEGIN SELECT RAISE(ABORT,'Injected fill failure'); END;");
  await assert.rejects(s.apply(fill),/Injected fill failure/);assert.deepEqual(await s.snapshot(),before);
  assert.equal((await s.ledger.snapshot()).executions.length,0);
  db.exec('DROP TRIGGER injected');assert.equal((await s.apply(fill)).status,'stored');
});
test('concurrent reservation commands cannot both commit stale revision',async t=>{
  const db=fixture(t);db.exec(schema);const a=new BudgetStore(port(db)),b=new BudgetStore(port(db));await a.apply(init);
  const results=await Promise.allSettled([a.apply(reserve),b.apply(command('reserve','other',0,{id:'d',symbol:'BTCUSDT',tickSize:'0.01',exitFeeRate:'0.001'}))]);
  assert.equal(results.filter(x=>x.status==='fulfilled'&&x.value.status==='stored').length,1);
  assert.equal((await a.snapshot()).summary.active,1);
});
test('the same server-timestamped fill survives a commit between reading budget and ledger',async t=>{
  const db=fixture(t),first=await setup(db),base=port(db);
  let raced=false;
  const interleaved={prepare(sql){
    const statement=base.prepare(sql);
    if(!sql.startsWith('SELECT seq,state FROM dev_budget_audit'))return statement;
    return {...statement,async all(){
      const previous=await statement.all();
      if(!raced){raced=true;assert.equal((await first.apply(fill,{serverTimestamp:true})).status,'stored');}
      return previous;
    }};
  }};
  const after={...fill,recordedAt:2};
  const second=await new BudgetStore(interleaved).apply(after,{serverTimestamp:true});
  assert.equal(second.status,'duplicate');
  assert.equal(second.state.revision,2);
  assert.equal((await first.ledger.audit()).length,1);
  assert.equal((await first.ledger.audit())[0].recordedAt,fill.recordedAt);
  await assert.rejects(first.apply(after),/Conflicting budget operation ID/);
  await assert.rejects(first.apply({...after,actor:'different'},{serverTimestamp:true}),/Conflicting budget operation ID/);
});
test('restart and duplicate command preserve state and single fill',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dca-budget-')),path=join(dir,'budget.sqlite');let db=new DatabaseSync(path);
  try{let s=await setup(db);await s.apply(fill);const before=await s.snapshot();db.close();db=new DatabaseSync(path);s=new BudgetStore(port(db));
    assert.deepEqual(await s.snapshot(),before);assert.equal((await s.apply(fill)).status,'duplicate');
    assert.equal((await s.ledger.snapshot()).executions.length,1);
    await assert.rejects(s.apply({...fill,actor:'other'}),/Conflicting budget operation/);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('cannot release open position; closed cycle requires cancellation and new pool',async t=>{
  const s=await setup(fixture(t));await s.apply(fill);
  const release=(rev,o={})=>command('release','release',rev,{id:'c',confirmed:true,ordersCancelled:true,...o});
  await assert.rejects(s.apply(release(2)),/open position/);
  await s.apply(command('fill','sell',2,{id:'c',execution:e({id:'s',time:2,side:'sell',price:'110',fee:'0.022',dca:null})}));
  const closed=await s.snapshot();assert.equal(closed.summary.active,1);assert.ok(closed.summary.flags.includes('CONFIRM_REMAINING_ORDERS_CANCELLED'));
  await assert.rejects(s.apply(release(3,{ordersCancelled:false})),/cancellation/);
  await assert.rejects(s.apply(release(3)),/freeCash required/);
  const done=await s.apply(release(3,{freeCash:'799'}));assert.equal(done.summary.held,'0');assert.equal(done.summary.available,'799');assert.equal(done.state.reservations[0].status,'released');
});
test('actual overspend remains recorded and blocks further reservations',async t=>{
  const s=await setup(fixture(t));await s.apply({...fill,execution:e({quantity:'8',fee:'0.84'})});
  const snap=await s.snapshot();assert.equal(snap.summary.cycles[0].quantity,'8');assert.ok(Number(snap.summary.deficit)>0);
  assert.equal((await s.apply(command('reserve','new',2,{id:'d',symbol:'BTCUSDT',tickSize:'0.01',exitFeeRate:'0.001'}))).reason,'RECONCILIATION_REQUIRED');
});
test('unlinked manual ledger fill blocks new budget reservations',async t=>{
  const db=fixture(t);db.exec(schema);const s=new BudgetStore(port(db));await s.apply(init);
  await s.ledger.write({kind:'fill',opId:'outside',actor:'test',recordedAt:1,execution:e({cycleId:'outside'})});
  assert.equal((await s.apply(reserve)).reason,'RECONCILIATION_REQUIRED');
});
