// Explicit source selection; current executions and cycle summaries, not audit/private export by default.
import {normalizeExecution} from './trade-ledger.mjs';
const guard=s=>/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/u.test(s)?"'"+s:s;
function cell(v){
  if(v===null||v===undefined)return '';
  if(typeof v==='number'){if(!Number.isFinite(v))throw Error('Nonfinite CSV value');return String(v);}
  return '"'+guard(String(v)).replaceAll('"','""')+'"';
}
const csv=(headers,rows)=>[headers.join(','),...rows.map(r=>r.map(cell).join(','))].join('\r\n')+'\r\n';
const select=source=>{if(!['model','manual'].includes(source))throw Error('Explicit source required');return source;};
export function executionsCsv(snapshot,source){
  select(source);
  const headers=['source','execution_id','cycle_id','symbol','timeframe','time_utc_ms','side','dca','price','quantity','notional_usdt','fee','fee_asset','fee_usdt','version'];
  return csv(headers,snapshot.executions.filter(x=>x.execution.source===source).map(x=>{
    const e=normalizeExecution(x.execution);
    return [e.source,e.id,e.cycleId,e.symbol,e.tf,e.time,e.side,e.dca,e.price,e.quantity,e.notional,e.fee,e.feeAsset,e.feeQuote,x.version];
  }));
}
export function cyclesCsv(snapshot,source){
  select(source);
  const headers=['source','cycle_id','symbol','timeframe','start_utc_ms','close_utc_ms','duration_ms','quantity','average_entry','average_cost','remaining_cost_usdt','realized_pnl_usdt','realized_basis_usdt','realized_percent','fees_usdt','executions'];
  return csv(headers,snapshot.cycles.filter(c=>c.source===source).map(c=>[c.source,c.cycleId,c.symbol,c.tf,c.startedAt,c.closedAt,c.durationMs,c.quantity,c.averageEntry,c.averageCost,c.cost,c.realized,c.realizedBasis,c.realizedPercent,c.feesQuote,c.executions]));
}
