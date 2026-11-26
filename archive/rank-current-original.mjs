import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {aggregate} from '../outputs/watchlist-suite/research.mjs';
import {advance,newState,intervalMs} from '../outputs/cloudflare/watchlist-engine.mjs';
import {fetchBars} from '../outputs/cloudflare/runtime.mjs';
const {bridge}=await import(pathToFileURL(path.join(process.env.USERPROFILE,'Documents/DCA800Notifications/bot.mjs')));
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const configs=read('work/ranking-params.json'),results=[];
const start=Date.parse('2025-02-01Z'), archiveStart=Date.parse('2025-01-01Z'),tailStart=Date.parse('2026-11-01Z'),end=Date.parse('2026-11-06Z');
function simulate(bars,tf,p){
  const state=newState(p), warm={...p,exitOnly:true};
  let peak=p.initialCapital,dd=0,closed=0,stops=0,equity=peak,yearStart=null;
  for(const bar of bars){
    if(bar.time<start){advance(state,bar,warm,tf);continue;}
    if(bar.time===Date.UTC(2026,0,1))yearStart=equity;
    const event=advance(state,bar,p,tf)?.event;
    if(event?.kind==='STOP')stops++;
    if(event?.kind==='TP'||event?.kind==='STOP')closed++;
    equity=state.cash+state.qty*bar.close*(1-p.fee)*(1-(p.slippageBps??0)/10000);
    peak=Math.max(peak,equity);dd=Math.max(dd,(1-equity/peak)*100);
  }
  assert.ok(yearStart>0);
  return {profit:equity-p.initialCapital,pct:(equity/p.initialCapital-1)*100,dd,closed,stops,year:(equity/yearStart-1)*100,open:state.qty>0};
}
async function run(){
  for(let config;(config=configs.shift());){
    const [symbol,tf]=config.key.split(':'),p=JSON.parse(config.params),step=intervalMs(tf);
    const rows=read('work/watchlist-suite/cache/'+symbol+'-5m.json');
    assert.equal(rows.length,(tailStart-archiveStart)/300000,symbol);
    assert.ok(rows.every((r,i)=>r[0]===archiveStart+i*300000),symbol);
    const bars=aggregate(rows,tf),tail=await fetchBars(bridge,symbol,tf,tailStart,end);
    bars.push(...tail);
    assert.equal(bars.length,(end-archiveStart)/step,symbol);
    assert.equal(bars.at(-1).closeTime,end-1);
    results.push({symbol,tf,...simulate(bars,tf,p),stress:simulate(bars,tf,{...p,slippageBps:2}).pct});
  }
}
await Promise.all(Array.from({length:3},run));assert.equal(results.length,19);
results.sort((a,b)=>b.profit-a.profit);
console.table(results.map(({symbol,tf,profit,pct,dd,closed,stops,year,stress})=>({symbol,tf,profit:+profit.toFixed(2),pct:+pct.toFixed(2),dd:+dd.toFixed(2),closed,stops,year:+year.toFixed(2),stress:+stress.toFixed(2)})));
const fmt=n=>n.toFixed(2).replace('.',',');
const lines=['# DCA800 — рейтинг 19 пар','',
'Binance Spot, с 1 февраля 2025 по 5 ноября 2026 года включительно (UTC). Январь 2025 служит для прогрева индикаторов. Каждая модель начинает торговлю без позиции с 800 USDT, на действующем облачном таймфрейме. Прибыль включает открытую позицию по последней цене закрытия за вычетом комиссии выхода. Комиссия 0,1% за каждое исполнение, базовое проскальзывание 0%, плечо ×1. Просадка рассчитана по стоимости счёта на закрытии свечей. Закрытый цикл включает вход, возможные усреднения и выход. Доходность за 2026 год учитывает перенос позиции и рассчитана относительно капитала на начало года. Последняя колонка пересчитывает весь тест с проскальзыванием 0,02% за исполнение.','',
'| № | Пара | ТФ | Прибыль, USDT | Доходность, % | Макс. просадка, % | Закрытые циклы | Из них STOP | Открыта в конце | 2026, % | С проскальзыванием, % |','|---:|---|---|---:|---:|---:|---:|---:|---|---:|---:|',
...results.map((r,i)=>'| '+[i+1,r.symbol,r.tf,fmt(r.profit),fmt(r.pct),fmt(r.dd),r.closed,r.stops,r.open?'Да':'Нет',fmt(r.year),fmt(r.stress)].join(' | ')+' |'),'',
'Таймфреймы ранее подбирались по данным до 1 ноября 2026 года. Рейтинг описывает исторический результат выбранных настроек. При торговле одной парой за раз итог зависит от последовательности выбранных сигналов. Использованы текущие шаги цены и количества из конфигурации.',''];
fs.writeFileSync('outputs/DCA800-рейтинг-19-пар-2026-11-06.md',lines.join('\n'));
