import test from 'node:test';
import assert from 'node:assert/strict';
import {checkArchivePins} from '../scripts/prepare-long-target.mjs';
import {compareLongScenario,summarizeLong} from '../scripts/compare-long-universes.mjs';
const pins={},archives=[];
for(let y=2024;y<=2026;y++)for(let m=1;m<=12;m++){if(y===2024&&m<7||y===2026&&m>10)continue;const name='BTCUSDT-5m-'+y+'-'+String(m).padStart(2,'0')+'.zip';pins[name]='a'.repeat(64);archives.push({name,sha256:pins[name],start:Date.UTC(y,m-1,1),end:Date.UTC(y,m,1)});}
test('complete 28 archives in pinned order; checksum and coverage checked',()=>{
 assert.doesNotThrow(()=>checkArchivePins('BTCUSDT',archives,pins));
 const bad=structuredClone(archives);bad[7].sha256='b'.repeat(64);assert.throws(()=>checkArchivePins('BTCUSDT',bad,pins),/pin mismatch/);
 assert.throws(()=>checkArchivePins('BTCUSDT',archives.slice(1),pins),/28 monthly/);
 bad[7]=archives[7];bad[3]={...bad[3],start:0};assert.throws(()=>checkArchivePins('BTCUSDT',bad,pins),/pin mismatch/);
});
test('long scenario rejects missing market and unapproved settings',()=>{
 assert.throws(()=>compareLongScenario([],2,2),/Frozen scenario/);
 assert.throws(()=>compareLongScenario([],1,2),/All 19/);
});
test('duration, admission fraction and open age explicit',()=>{
 const r={settings:{maxCycles:1,slippageBps:2},window:{end:7200001},metrics:{initialCapital:800},closed:[{startedAt:0,closedAt:3600000,exit:'STOP'}],events:[{kind:'START',symbol:'BTCUSDT',time:3600000}],openPositions:[{symbol:'BTCUSDT'}],rejected:[{reason:'MAX_ACTIVE_CYCLES'}]};
 const s=summarizeLong(r,11);assert.equal(s.meanClosedDurationHours,1);assert.equal(s.openPositions[0].ageHours,1);assert.equal(s.admittedStartPercent,50);assert.equal(s.stops,1);
});
