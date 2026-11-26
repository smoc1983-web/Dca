import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {DEFAULTS,newState,advance,intervalMs} from './watchlist-engine.mjs';
import {watchlist,extra} from './acquire.mjs';
export const frames=['5m','15m','30m','45m','1h','2h','3h','4h','6h','12h','1d'];
const START=Date.parse('2025-02-01T00:00:00Z'),SPLIT=Date.parse('2026-01-01T00:00:00Z'),END=Date.parse('2026-11-01T00:00:00Z');
export function aggregate(rows,tf,sourceStep=300000){
  const step=intervalMs(tf),count=step/sourceStep,result=[];let bucket=null,group=[];
  const flush=()=>{if(!group.length)return;const time=bucket*step;
    if(group.length!==count||group[0][0]!==time||group.at(-1)[0]!==time+step-sourceStep)return;
    if(group.some((r,i)=>i&&r[0]!==group[i-1][0]+sourceStep))throw Error('Gap inside aggregate');
    result.push({time,closeTime:time+step-1,open:group[0][1],high:Math.max(...group.map(r=>r[2])),low:Math.min(...group.map(r=>r[3])),close:group.at(-1)[4]});};
  for(const row of rows){const b=Math.floor(row[0]/step);if(b!==bucket){flush();group=[];bucket=b;}group.push(row);}flush();return result;
}
export function resetTrading(s,p){Object.assign(s,{cash:p.initialCapital,qty:0,average:0,invested:0,dca:0,lastEntry:null,cycleEquity:null,cycleStart:null,orders:0});}
export function paramsFor(info){
  const f=type=>info.filters.find(x=>x.filterType===type)??{};
  return {...DEFAULTS,symbol:info.symbol,baseAsset:info.baseAsset,quoteAsset:info.quoteAsset,tick:Number(f('PRICE_FILTER').tickSize),qtyStep:Number(f('LOT_SIZE').stepSize),minQty:Number(f('LOT_SIZE').minQty),minNotional:Number(f('NOTIONAL').minNotional??f('MIN_NOTIONAL').minNotional??0)};
}
export function backtest(bars,tf,p,begin,end){
  const s=newState(p);let initialized=false,peak=p.initialCapital,dd=0,cycles=0,wins=0,cycleCash=null,started=null,longest=0,maxInvested=0,last=null;
  for(const c of bars){
    if(c.time>=end)break;
    if(c.time<begin){advance(s,c,{...p,exitOnly:true},tf);continue;}
    if(!initialized){resetTrading(s,p);initialized=true;}
    const before=s.cash,r=advance(s,c,p,tf);last=c;
    if(r?.event?.kind==='START'){cycleCash=before;started=c.time;}
    if(r?.event&&['TP','STOP'].includes(r.event.kind)){cycles++;if(s.cash>cycleCash)wins++;longest=Math.max(longest,(c.closeTime-started)/86400000);started=null;}
    const equity=s.cash+s.qty*c.close;peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak);maxInvested=Math.max(maxInvested,s.invested);
  }
  if(!last)throw Error('No common history');
  const equity=s.cash+s.qty*last.close*(1-p.fee)*(1-(p.slippageBps??0)/10000);
  if(started!==null)longest=Math.max(longest,(end-started)/86400000);
  return {profitPct:(equity/p.initialCapital-1)*100,drawdownPct:dd*100,cycles,winRate:cycles?wins/cycles*100:0,openPosition:s.qty>0,maxInvested,longestCycleDays:longest,orders:s.orders};
}
export function research(cache,output){
  fs.mkdirSync(output,{recursive:true});const info=JSON.parse(fs.readFileSync(path.join(cache,'exchange-info.json'),'utf8'));
  const results=[],errors=[];
  for(const symbol of [...watchlist,...extra]){
    try{
      const instrument=info.symbols.find(x=>x.symbol===symbol);if(!instrument||instrument.status!=='TRADING'||!instrument.isSpotTradingAllowed)throw Error('Not an active Spot instrument');
      const p={...paramsFor(instrument),slippageBps:2};const rows=JSON.parse(fs.readFileSync(path.join(cache,symbol+'-5m.json'),'utf8'));
      if(rows[0][0]>Date.parse('2025-01-01T00:00:00Z')||rows.at(-1)[0]!==END-300000)throw Error('Incomplete common history');
      const grid=frames.map(tf=>{
        let prefix=[];const warmFile=path.join(cache,`${symbol}-warm-${tf}.json`);
        if(fs.existsSync(warmFile))prefix=aggregate(JSON.parse(fs.readFileSync(warmFile,'utf8')),tf,tf==='3h'?3600000:intervalMs(tf));
        const bars=[...prefix,...aggregate(rows,tf)];return {tf,warmupBars:bars.filter(c=>c.time<START).length,full:backtest(bars,tf,p,START,END),train:backtest(bars,tf,p,START,SPLIT),validation:backtest(bars,tf,p,SPLIT,END)};
      });
      grid.sort((a,b)=>b.full.profitPct-a.full.profitPct||a.full.drawdownPct-b.full.drawdownPct);
      const best=grid[0];const selected={symbol,requested:watchlist.includes(symbol),params:{...p,slippageBps:0},tf:best.tf,enabled:best.full.profitPct>0&&best.full.cycles>=5,recommendedExtra:!watchlist.includes(symbol)&&best.full.profitPct>0&&best.validation.profitPct>0&&best.full.cycles>=5,grid};
      results.push(selected);console.log(symbol,best.tf,best.full.profitPct.toFixed(2)+'%',best.full.drawdownPct.toFixed(2)+'% DD');
    }catch(e){errors.push({symbol,error:e.message});console.log('EXCLUDED',symbol,e.message);}
  }
  const report={createdAt:new Date().toISOString(),start:new Date(START).toISOString(),end:new Date(END).toISOString(),feePct:.1,slippageBpsEachSide:2,selection:'Maximum full-period net liquidation return, same dates. Validation is descriptive and not blind after full-period selection.',results,errors};
  fs.writeFileSync(path.join(output,'research-results.json'),JSON.stringify(report,null,2));
  const markets=results.filter(x=>x.requested||x.recommendedExtra).map(({grid,requested,recommendedExtra,...m})=>({...m,requested,enabled:m.enabled,metrics:grid[0]}));
  fs.writeFileSync(path.join(output,'markets.json'),JSON.stringify(markets,null,2));
  const n=x=>x.toFixed(2),lines=['# DCA800: пары и таймфреймы','','Binance Spot, общий период 01.02.2025–01.11.2026 UTC. Для старших интервалов добавлен прогрев до 01.01.2025 (до 1000 свечей каждого интервала); затем используются январские свечи 2025 года. 800 USDT на каждый независимый тест. Комиссия 0,1% за исполнение, проскальзывание 2 базисных пункта (0,02%) на каждой стороне. В конце открытая позиция оценена как принудительно проданная с этими расходами; отметка «открыта» показывает, что стратегия не закрыла её сама.','','Выбран максимум прибыли по всей истории среди 11 интервалов: '+frames.join(', ')+'. Это отбор по уже просмотренным данным, не слепая проверка и не гарантия будущей прибыли. Проверка 2026 года запускается отдельно с плоской позицией и используется для оценки устойчивости.','','| Пара | Источник | ТФ | Прибыль % | Просадка % | Циклы | 2025 % | 2026 % | Открыта в конце |','|---|---|---|---:|---:|---:|---:|---:|---|'];
  for(const r of results){const b=r.grid[0];lines.push(`| ${r.symbol} | ${r.requested?'Твой список':'Дополнительно'} | ${r.tf} | ${n(b.full.profitPct)} | ${n(b.full.drawdownPct)} | ${b.full.cycles} | ${n(b.train.profitPct)} | ${n(b.validation.profitPct)} | ${b.full.openPosition?'Да':'Нет'} |`);}
  lines.push('','Дополнительные пары включены в пакет, если выбранный вариант прибыльный и за весь период, и отдельно в 2026 году, и завершил минимум 5 циклов. Для пар с неположительным результатом или менее 5 циклов новые входы выключены. Данные текущих фильтров биржи применены ретроспективно; изменения фильтров в прошлом не восстановлены. Свечная просадка не включает внутрисвечной минимум. Сравнение отдельных пар не является оптимизацией портфеля с общим бюджетом.','');
  if(errors.length)lines.push('Исключения: '+JSON.stringify(errors));
  lines.push('## Полная таблица','');
  for(const r of results){lines.push('### '+r.symbol,'','| ТФ | Прибыль % | Просадка % | Циклы | 2026 % |','|---|---:|---:|---:|---:|');for(const b of r.grid)lines.push(`| ${b.tf} | ${n(b.full.profitPct)} | ${n(b.full.drawdownPct)} | ${b.full.cycles} | ${n(b.validation.profitPct)} |`);lines.push('');}
  fs.writeFileSync(path.join(output,'Research.md'),lines.join('\n'));
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))research(path.resolve(process.argv[2]),path.resolve(process.argv[3]));
