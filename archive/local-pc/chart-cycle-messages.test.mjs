import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {advance,intervalMs,message} from './watchlist-engine.mjs';
const replay=JSON.parse(fs.readFileSync(new URL('../../work/cycle-sync-review/validated-observation-replays/ADAUSDT.json',import.meta.url),'utf8'));
function nextBar(s,price){const time=s.lastTime+intervalMs('5m');return {time,closeTime:time+299999,open:price,high:price,low:price,close:price};}
test('reconciled real ADA DCA3 continues with DCA4 and cumulative manual-trade context',()=>{
 const s=structuredClone(replay.state),p={...replay.metadata.params,signalOnly:true};
 assert.equal(s.dca,3);assert.equal(s.qty,936);
 const event=advance(s,nextBar(s,.1807),p,'5m').event;
 assert.equal(event.kind,'DCA4');assert.equal(event.cash,126.5625);assert.equal(event.dca,4);
 assert.equal(event.invested,329.6875);assert.equal(event.nextDca.number,5);
 const text=message('5m',event,p);assert.match(text,/Усреднений в этом цикле: 4\/5/);assert.match(text,/Бюджет покупки: 126\.56 USDT/);assert.match(text,/329\.69 USDT/);assert.match(text,/Следующее DCA5/);assert.doesNotMatch(text,/\nСТАРТ\n/);
});
test('ADA take profit closes the recovered whole cycle and preserves completed DCA count in the notice',()=>{
 const s=structuredClone(replay.state),p={...replay.metadata.params,signalOnly:true};
 const event=advance(s,nextBar(s,.2231),p,'5m').event;
 assert.equal(event.kind,'TP');assert.equal(event.quantity,936);assert.equal(event.dca,3);assert.equal(s.qty,0);
 assert.match(message('5m',event,p),/Усреднений в этом цикле: 3\/5/);assert.equal(event.nextDca,null);
});
