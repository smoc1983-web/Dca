import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregate5m,rankFrames,FRAMES} from '../scripts/backtest-timeframes.mjs';
const rows=Array.from({length:9},(_,i)=>({time:i*300000,closeTime:(i+1)*300000-1,open:100+i,high:102+i,low:99+i,close:101+i,volume:10}));
test('custom 45m aggregate uses exactly nine 5m closes',()=>assert.deepEqual(aggregate5m(rows,'45m'),[{time:0,closeTime:2699999,open:100,high:110,low:99,close:109,volume:90}]));
test('partial groups and gaps rejected',()=>{assert.throws(()=>aggregate5m(rows.slice(1),'45m'),/Partial/);const bad=structuredClone(rows);bad[4].time++;assert.throws(()=>aggregate5m(bad,'45m'),/Gap/);});
test('all original frames included and train selection is independent of validation',()=>{
 assert.equal(FRAMES.length,11);const g=[{tf:'5m',train:{returnPct:3,drawdownPct:2},full:{returnPct:1,drawdownPct:1}},{tf:'15m',train:{returnPct:2,drawdownPct:1},full:{returnPct:9,drawdownPct:3}}];
 assert.equal(rankFrames(g,'train')[0].tf,'5m');assert.equal(rankFrames(g,'full')[0].tf,'15m');
});
