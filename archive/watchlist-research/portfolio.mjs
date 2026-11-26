import fs from 'node:fs';import path from 'node:path';
import {aggregate,resetTrading} from './research.mjs';import {newState,advance,intervalMs} from './watchlist-engine.mjs';
import {stepEntry,allocated} from './watchlist-runtime.mjs';
const cache=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
const START=Date.parse('2025-02-01T00:00:00Z'),END=Date.parse('2026-11-01T00:00:00Z');
const markets=JSON.parse(fs.readFileSync(path.join(output,'markets.json'),'utf8'));
function testPortfolio(markets,maxActiveCycles=Infinity){
  const state={portfolio:{cash:800},entries:{}},tracks=[];const settings={budgetMode:'shared',totalBudget:800,maxUsage:.7,maxActiveCycles};
  for(const m of markets.filter(m=>m.enabled)){
    const p={...m.params,slippageBps:2},key=m.symbol+':'+m.tf,rows=JSON.parse(fs.readFileSync(path.join(cache,m.symbol+'-5m.json'),'utf8'));
    let prefix=[];const warm=path.join(cache,`${m.symbol}-warm-${m.tf}.json`);
    if(fs.existsSync(warm))prefix=aggregate(JSON.parse(fs.readFileSync(warm,'utf8')),m.tf,m.tf==='3h'?3600000:intervalMs(m.tf));
    const bars=[...prefix,...aggregate(rows,m.tf)],s=newState(p);let index=0;
    for(;index<bars.length&&bars[index].time<START;index++)advance(s,bars[index],{...p,exitOnly:true},m.tf);
    resetTrading(s,p);state.entries[key]={symbol:m.symbol,tf:m.tf,params:p,s,entryEnabled:true};tracks.push({key,bars,index,price:bars[Math.max(0,index-1)].close});
  }
  tracks.sort((a,b)=>a.key.localeCompare(b.key));let peak=800,dd=0,maxAllocation=0,cycles=0,orders=0;
  while(true){
    let time=Infinity;for(const t of tracks){const c=t.bars[t.index];if(c&&c.time<END)time=Math.min(time,c.closeTime);}if(!Number.isFinite(time))break;
    for(const t of tracks)if(t.bars[t.index]?.closeTime===time)t.price=t.bars[t.index].close;
    for(const t of tracks){if(t.bars[t.index]?.closeTime!==time)continue;
      const event=stepEntry(state,t.key,t.bars[t.index++],settings);
      if(event){orders++;if(['TP','STOP'].includes(event.kind))cycles++;}
    }
    if(state.portfolio.cash< -1e-7)throw Error('Shared wallet overspent');
    const equity=state.portfolio.cash+tracks.reduce((sum,t)=>sum+state.entries[t.key].s.qty*t.price,0);
    peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak);maxAllocation=Math.max(maxAllocation,allocated(state));
    if(maxAllocation>560+1e-7)throw Error('Shared allocation cap breached');
  }
  const liquidationEquity=state.portfolio.cash+tracks.reduce((sum,t)=>sum+state.entries[t.key].s.qty*t.price*(1-.001)*(1-.0002),0);
  return {symbols:markets.map(m=>m.symbol),budget:800,allocationCap:560,profitPct:(liquidationEquity/800-1)*100,drawdownPct:dd*100,maxAllocation,cycles,orders,openCycles:Object.values(state.entries).filter(e=>e.s.qty>0).length,finalModelEquity:liquidationEquity};
}
const results={requestedOnly:testPortfolio(markets.filter(m=>m.requested)),withPositiveExtras:testPortfolio(markets),requestedOneCycle:testPortfolio(markets.filter(m=>m.requested),1),allOneCycle:testPortfolio(markets,1)};
fs.writeFileSync(path.join(output,'portfolio-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
const n=x=>x.toFixed(2),lines=['','## Общий бюджет 800 USDT','','Портфельный прогон выбранных вариантов с общим пределом плановых вложений 560 USDT (70%). Доступные деньги учитываются после покупок, продаж и комиссий; при нехватке лимита новый вход или DCA пропускается. При совпадении времени приоритет задаётся алфавитом тикеров — так же, как в программе уведомлений. Выбор таймфреймов уже сделан по всей этой истории, поэтому портфельный результат тоже не является слепым тестом.','','| Состав | Прибыль % | Просадка % | Максимум вложений USDT | Завершённые циклы | Открытые циклы |','|---|---:|---:|---:|---:|---:|'];
for(const [key,r] of Object.entries(results))lines.push(`| ${{requestedOnly:'Твои 10 пар, одновременно',withPositiveExtras:'Все 20 пар, одновременно',requestedOneCycle:'Твои 10 пар, максимум 1 цикл',allOneCycle:'Все 20 пар, максимум 1 цикл'}[key]} | ${n(r.profitPct)} | ${n(r.drawdownPct)} | ${n(r.maxAllocation)} | ${r.cycles} | ${r.openCycles} |`);
lines.push('','Глобальный лимит ограничивает модельные покупки. Реальные ручные исполнения программа не получает. Начальные открытые позиции текущей службы в этот тест не перенесены: портфель начинает период без позиций. В рабочей миграции открытый цикл UNI сохраняется и учитывается в лимите. Состав с максимальной портфельной доходностью среди всех возможных комбинаций не искался.','');
const reportFile=path.join(output,'Research.md');
const previous=fs.readFileSync(reportFile,'utf8').split('\n## Общий бюджет 800 USDT')[0].trimEnd();
fs.writeFileSync(reportFile,previous+'\n'+lines.join('\n'));
