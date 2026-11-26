// Explicit source selection; current executions and cycle summaries, not audit/private export by default.
import {normalizeExecution} from './trade-ledger.mjs';
const guard=s=>/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/u.test(s)?"'"+s:s;
const exactCell=s=>s===null?null:{decimal:s};
function cell(v){
  if(v&&typeof v==='object'&&Object.hasOwn(v,'decimal')){if(!/^-?\d+(?:\.\d+)?$/.test(v.decimal))throw Error('Invalid exact CSV value');return v.decimal;}
  if(v===null||v===undefined)return '';
  if(typeof v==='number'){if(!Number.isFinite(v))throw Error('Nonfinite CSV value');return String(v);}
  return '"'+guard(String(v)).replaceAll('"','""')+'"';
}
const csv=(headers,rows)=>[headers.join(','),...rows.map(r=>r.map(cell).join(','))].join('\r\n')+'\r\n';
const select=source=>{if(!['model','manual'].includes(source))throw Error('Explicit source required');return source;};
export function executionsCsv(snapshot,source){
  select(source);
  const headers=['source','execution_id','cycle_id','symbol','timeframe','time_utc_ms','side','dca','price','quantity','notional_usdt','fee','fee_asset','fee_usdt','version','exact_price','exact_quantity','exact_notional_usdt','exact_fee','exact_fee_usdt'];
  return csv(headers,snapshot.executions.filter(x=>x.execution.source===source).map(x=>{
    const e=normalizeExecution(x.execution);
    return [e.source,e.id,e.cycleId,e.symbol,e.tf,e.time,e.side,e.dca,e.price,e.quantity,e.notional,e.fee,e.feeAsset,e.feeQuote,x.version,...['price','quantity','notional','fee','feeQuote'].map(k=>exactCell(e.exact[k]))];
  }));
}
export function cyclesCsv(snapshot,source){
  select(source);
  const headers=['source','cycle_id','symbol','timeframe','start_utc_ms','close_utc_ms','duration_ms','quantity','average_entry','average_cost','remaining_cost_usdt','realized_pnl_usdt','realized_basis_usdt','realized_percent','fees_usdt','executions','exact_quantity','exact_average_entry','exact_average_cost','exact_remaining_cost_usdt','exact_realized_pnl_usdt','exact_realized_basis_usdt','exact_realized_percent','exact_fees_usdt'];
  return csv(headers,snapshot.cycles.filter(c=>c.source===source).map(c=>[c.source,c.cycleId,c.symbol,c.tf,c.startedAt,c.closedAt,c.durationMs,c.quantity,c.averageEntry,c.averageCost,c.cost,c.realized,c.realizedBasis,c.realizedPercent,c.feesQuote,c.executions,...['quantity','averageEntry','averageCost','cost','realized','realizedBasis','realizedPercent','feesQuote'].map(k=>exactCell(c.exact[k]))]));
}
