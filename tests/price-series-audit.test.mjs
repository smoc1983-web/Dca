import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDay,compareCase} from '../scripts/price-series-audit.mjs';
const day='2025-10-10',start=Date.parse(day+'T00:00:00Z'),dt=300000;
function csv(scale=1){return Array.from({length:288},(_,i)=>[(start+i*dt)*scale,4,5,i===256?.001:3,4,1,(start+(i+1)*dt)*scale-1,1,1,1,1,0].join(',')).join('\n');}
test('daily spot microseconds normalize exactly and futures milliseconds match',()=>{const s=parseDay(csv(1000),day,'spot'),f=parseDay('open_time,open,high,low,close,volume,close_time,x,x,x,x,x\n'+csv(),day,'mark');assert.deepEqual(s,f);assert.equal(s[256].low,.001);});
test('missing rows wrong units or invalid OHLC rejected',()=>{assert.throws(()=>parseDay(csv().split('\n').slice(1).join('\n'),day,'trade'),/coverage/);assert.throws(()=>parseDay(csv(1000),day,'mark'),/time/);assert.throws(()=>parseDay(csv().replace(',4,5,3,4,',',4,2,3,4,'),day,'trade'),/OHLC/);});
test('comparison preserves spot low separately from mark, verifies pinned data',()=>{const s=parseDay(csv(),day,'spot'),c={symbol:'ATOMUSDT',time:s[256].time},m=s.map(r=>({...r,low:3})),series={spot:s,trade:m,mark:m,index:m};const r=compareCase(c,s[256],series);assert.equal(r.rows.spot.low,.001);assert.equal(r.rows.mark.low,3);assert.equal(r.liquidationPrice,null);assert.throws(()=>compareCase(c,{...s[256],low:2},series),/Pinned spot/);assert.throws(()=>compareCase(c,s[256],{...series,index:[]}),/Missing/);});
