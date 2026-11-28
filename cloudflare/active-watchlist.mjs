// Frozen active-only runtime profile. Historical registry remains intact.
export const ACTIVE_KEYS=Object.freeze(['ADAUSDT:5m','ATOMUSDT:5m','BTCUSDT:5m','DOGEUSDT:15m','DOTUSDT:30m','LDOUSDT:30m','LINKUSDT:5m','TRXUSDT:15m','UNIUSDT:15m','XRPUSDT:45m','ZECUSDT:5m']);
export const EXCLUDED_SYMBOLS=Object.freeze(['AAVEUSDT','AVAXUSDT','BCHUSDT','BNBUSDT','ETHUSDT','LTCUSDT','SOLUSDT','SUIUSDT']);
export const ACTIVE_KEY_SQL=ACTIVE_KEYS.map(()=>'?').join(',');
export const EXCLUDED_ALERT_SQL="substr(id,1,instr(id,':')-1) NOT IN ("+EXCLUDED_SYMBOLS.map(()=>'?').join(',')+")";
export function validateActiveModel(row){
 const entry=JSON.parse(row.model);
 if(!ACTIVE_KEYS.includes(row.key)||row.key!==entry.symbol+':'+entry.tf||entry.params?.symbol!==entry.symbol||entry.retired===true)throw Error('Invalid active model identity');
 return entry;
}
