import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,newState,advance,message,intervalMs} from '../cloudflare/watchlist-engine.mjs';
import {fetchBars} from '../cloudflare/runtime.mjs';
import {advanceModel} from '../cloudflare/worker.mjs';
import {dailyText} from '../cloudflare/daily.mjs';
const p={...DEFAULTS,symbol:'ADAUSDT',tick:.0001,qtyStep:.000001};
const step=intervalMs('5m');
const bar=(time,price)=>({time,closeTime:time+step-1,open:price,high:price,low:price,close:price});
function position(){const s=newState(p);Object.assign(s,{lastTime:0,qty:.25,average:100,invested:25,lastEntry:100,cash:774.975,cycleEquity:800,cycleStart:100});return s;}
test('five DCA levels persist and the cycle exits at TP',()=>{
 const s=position();let price=100,invested=25;
 for(let i=0;i<5;i++){
  price*=1-p.drops[i];invested+=25*1.5**(i+1);
  const e=advance(s,bar((i+1)*step,price),p,'5m').event;
  assert.equal(e.kind,`DCA${i+1}`);assert.equal(s.dca,i+1);assert.equal(s.invested,invested);
  assert.match(message('5m',e,p),new RegExp(`DCA ${i+1}/5`));
 }
 assert.equal(s.invested,519.53125);
 assert.equal(advance(s,bar(6*step,price*.99),p,'5m').event,null);
 const e=advance(s,bar(7*step,s.average*1.031),p,'5m').event;
 assert.equal(e.kind,'TP');assert.equal(e.dca,5);assert.equal(s.qty,0);
});
test('duplicate bars ignored and gaps rejected',()=>{
 const s=position();const before=JSON.stringify(s);
 assert.equal(advance(s,bar(0,95),p,'5m'),null);assert.equal(JSON.stringify(s),before);
 assert.throws(()=>advance(s,bar(2*step,95),p,'5m'),/gap/i);
});
test('45m aggregates complete 15m bars and rejects gaps',async()=>{
 const unit=15*60000;
 const rows=[0,1,2].map(i=>[i*unit,10+i,12+i,9+i,11+i,0,(i+1)*unit-1]);
 const result=await fetchBars(async()=>rows,'XRPUSDT','45m',0,3*unit);
 assert.equal(result.length,1);assert.equal(result[0].open,10);assert.equal(result[0].close,13);
 await assert.rejects(()=>fetchBars(async()=>[rows[0],rows[2]],'XRPUSDT','45m',0,3*unit),/Gap/);
});
test('recovery reports the next DCA instead of resetting an existing cycle',async()=>{
 const s=position();const entry={symbol:p.symbol,tf:'5m',params:p,s,entryEnabled:true};
 const rows=[95,89.3].map((v,i)=>[(i+1)*step,v,v,v,v,0,(i+2)*step-1]);
 const events=await advanceModel(entry,3*step,async()=>rows);
 assert.equal(events.length,2);assert.match(events[0].body,/DCA 1\/5/);assert.match(events[1].body,/DCA 2\/5/);
 assert.equal(entry.s.dca,2);assert.equal(entry.s.lastTime,2*step);
});
test('daily summary includes waiting and active models at 06:00 Astrakhan',()=>{
 const now=Date.UTC(2026,10,26,2);const s=position();s.dca=3;s.lastTime=now-step;
 const waiting=newState(p);waiting.lastTime=now-step;
 const rows=[{model:JSON.stringify({symbol:'ADAUSDT',tf:'5m',params:p,s})},{model:JSON.stringify({symbol:'BTCUSDT',tf:'5m',params:p,s:waiting})}];
 const text=dailyText(rows,[{id:'ADAUSDT:5m:123:DCA3'}],now);
 assert.match(text,/06:00 Астрахань/);assert.match(text,/DCA 3\/5 · ADA 5м/);
 assert.match(text,/Ждут входа · BTC 5м/);assert.match(text,/DCA 1/);
});
