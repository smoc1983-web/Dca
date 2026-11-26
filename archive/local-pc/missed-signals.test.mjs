import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {queueMissedReports,recoverMissedReports} from './missed-signals.mjs';
import {main} from './watchlist-runtime.mjs';import {newState,DEFAULTS} from './watchlist-engine.mjs';
const eventItem=(kind,time,symbol='TRXUSDT',status='expired')=>({id:`${symbol}:15m:${time}:${kind}`,status,event:{kind,closeTime:time+899999,price:.322}});
test('historical summary includes exact local time, pair, timeframe and every signal kind; once only',()=>{
 const state={activatedAt:0,entries:{'TRXUSDT:15m':{}},outbox:[eventItem('TP',1793733300000),eventItem('START',1793747700000),eventItem('DCA3',1793748600000),eventItem('STOP',1793749500000)]};
 assert.equal(queueMissedReports(state,1793750000000),1);const text=state.missedSignalReports[0].text;
 for(const phrase of ['03.11.2026, 23:30','04.11.2026, 03:30','TRXUSDT','15 мин','ТЕЙК-ПРОФИТ','ВХОД','УСРЕДНЕНИЕ 3/5','АВАРИЙНЫЙ ВЫХОД','не новые сигналы'])assert.ok(text.includes(phrase),phrase);
 assert.equal(queueMissedReports(state,1793750000000),0);assert.equal(state.missedSignalReports.length,1);
});
test('removed pairs, old activation and delivered events are excluded; uncertain signals are recovered as history',()=>{
 const state={activatedAt:1000000,entries:{'TRXUSDT:15m':{}},outbox:[eventItem('START',0),eventItem('TP',2000000,'NEARUSDT'),eventItem('TP',2000000,'TRXUSDT','delivered'),eventItem('START',3000000,'TRXUSDT','uncertain')]};
 assert.equal(queueMissedReports(state,4000000),1);assert.equal(state.missedSignalReports[0].eventIds.length,1);assert.equal(state.missedSignalReports[0].eventIds[0],'TRXUSDT:15m:3000000:START');assert.equal(queueMissedReports(state,4000000),0);
});
test('large offline history splits within Telegram limit with no lost or duplicated IDs',()=>{
 const state={activatedAt:0,entries:{'TRXUSDT:15m':{}},outbox:Array.from({length:150},(_,i)=>eventItem('DCA1',i*900000)).reverse()};
 queueMissedReports(state,200000000);assert.ok(state.missedSignalReports.length>1);
 const ids=state.missedSignalReports.flatMap(r=>r.eventIds);assert.equal(ids.length,150);assert.equal(new Set(ids).size,150);
 assert.ok(state.missedSignalReports.every(r=>r.text.length<4096));assert.equal(queueMissedReports(state,200000000),0);
});
test('interrupted or legacy uncertain summaries recover after restart with duplicate warning',()=>{
 const state={missedSignalReports:[{status:'sending'},{status:'delivered'},{status:'pending'},{status:'uncertain'}]};recoverMissedReports(state);assert.deepEqual(state.missedSignalReports.map(r=>r.status),['pending','delivered','pending','pending']);assert.equal(state.missedSignalReports[0].possibleDuplicate,true);assert.equal(state.missedSignalReports[3].possibleDuplicate,true);
});
async function fixture(run){
 const app=fs.mkdtempSync(path.join(os.tmpdir(),'DCA800-missed-')),data=path.join(app,'data');fs.mkdirSync(data);
 const atomic=(file,obj)=>fs.writeFileSync(file,JSON.stringify(obj)),oldArg=process.argv[2],p={...DEFAULTS,symbol:'AAAUSDT',baseAsset:'AAA',quoteAsset:'USDT',signalOnly:true};
 const s=newState(p);Object.assign(s,{lastTime:0,previousClose:100,ema:100,emas:[100,100,100,100,100],changes:14,gain:1,loss:2,rsi:31});
 atomic(path.join(app,'config.json'),{ownerComputer:os.hostname(),serviceDirectory:app,runtimeDirectory:'data',mode:'live',maxSignalAgeSeconds:180,pollSeconds:20,missedSignalSummary:{enabled:true},watchlist:{budgetMode:'signals',totalBudget:800,maxUsage:.7}});
 atomic(path.join(data,'watchlist-state.json'),{version:2,activatedAt:0,outbox:[],entries:{'AAAUSDT:5m':{symbol:'AAAUSDT',tf:'5m',params:p,s,entryEnabled:true,legacy:false}}});
 const messages=[];let fail=false,now=1200001;
 const bridge=async request=>{
  if(request.operation==='telegram'){messages.push(request.text);if(fail)throw Error('ambiguous response');return {message_id:messages.length};}
  if(request.endpoint==='time')return {serverTime:now};
  const prices={300000:90,600000:85,900000:83,1200000:91},rows=[];
  for(let t=request.parameters.startTime;t<=request.parameters.endTime;t+=300000){const price=prices[t];assert.ok(price);rows.push([t,price,price,price,price,1,t+299999]);}return rows;
 };
 const read=()=>JSON.parse(fs.readFileSync(path.join(data,'watchlist-state.json')));
 const once=async(options={})=>{if(options.now)now=options.now;fail=options.fail??false;process.argv[2]=options.diagnose?'--diagnose':'--once';const listeners=new Set(process.listeners('exit'));try{await main({app,bridge,atomic});}finally{const lock=path.join(data,'process.lock');if(fs.existsSync(lock))fs.unlinkSync(lock);for(const l of process.listeners('exit'))if(!listeners.has(l))process.removeListener('exit',l);}};
 try{await run({once,read,messages,app});}finally{process.argv[2]=oldArg;const resolved=path.resolve(app);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'DCA800-missed-'));fs.rmSync(resolved,{recursive:true,force:true});}
}
test('offline START and DCA are one historical summary; restart no duplicate; fresh TP remains normal',async()=>{
 await fixture(async({once,read,messages})=>{await once();assert.equal(messages.length,1);assert.match(messages[0],/ПРОПУЩЕННЫЕ СИГНАЛЫ/);assert.match(messages[0],/УСРЕДНЕНИЕ 1\/5/);
 assert.equal(read().entries['AAAUSDT:5m'].s.dca,1);assert.equal(read().missedSignalReports[0].status,'delivered');
 await once();assert.equal(messages.length,1);await once({now:1500001});assert.equal(messages.length,2);assert.match(messages[1],/ТЕЙК-ПРОФИТ ДОСТИГНУТ/);assert.equal(read().entries['AAAUSDT:5m'].s.qty,0);
 });
});
test('fresh DCA sends normally alongside historical START summary',async()=>{
 await fixture(async({once,read,messages})=>{await once({now:900001});assert.equal(messages.length,2);assert.match(messages[0],/УСРЕДНЕНИЕ DCA1/);assert.match(messages[1],/ПРОПУЩЕННЫЕ СИГНАЛЫ/);assert.equal(read().missedSignalReports[0].eventIds.length,1);await once();assert.equal(messages.length,2);});
});
test('outage schedules a durable retry, waits across restart, then confirms delivery once network recovers',async()=>{
 await fixture(async({once,read,messages})=>{await once({fail:true});assert.equal(read().missedSignalReports[0].status,'pending');assert.equal(read().missedSignalReports[0].nextAttemptAt,1260001);await once();assert.equal(messages.length,1);await once({now:1260002});assert.equal(messages.length,2);assert.match(messages[1],/Повторная попытка/);assert.equal(read().missedSignalReports[0].status,'delivered');await once();assert.equal(messages.length,2);});
});
