// DCA800 v11/v14 port. Only closed candles, market fills at the closing price.
export const DEFAULTS = Object.freeze({initialCapital:800,baseCash:25,multiplier:1.5,maxUsage:.70,
  drops:[.05,.06,.08,.10,.12],tp:.03,rsiLength:14,rsiLevel:30,emaLength:200,
  slopeBars:5,maxSlopeDrop:.03,crashBars:10,maxCrashDrop:.22,emergency:.40,fee:.001,tick:.001,qtyStep:.001});
export const intervalMs = tf => ({'15m':900000,'1h':3600000})[tf] ?? (()=>{throw Error('Unsupported timeframe')})();
export const roundedTarget = (average,p=DEFAULTS) => Math.round((average*(1+p.tp)+Number.EPSILON)/p.tick)*p.tick;
// Pine comparisons round operands to nine fractional digits.
const comparable = n => Math.round(n*1e9)/1e9;
export function newState(){return {lastTime:null,previousClose:null,ema:null,emas:[],highs:[],changes:0,
  sumGain:0,sumLoss:0,gain:null,loss:null,rsi:null,cash:800,qty:0,average:0,
  invested:0,dca:0,lastEntry:null,cycleEquity:null,cycleStart:null,orders:0};}
export function advance(s,c,p=DEFAULTS,tf='1h'){
  const duration=intervalMs(tf);
  if(![c.time,c.closeTime,c.open,c.high,c.low,c.close].every(Number.isFinite)||c.close<=0||c.low<=0||c.high<c.low)
    throw Error('Invalid candle');
  if(s.lastTime!==null&&c.time<=s.lastTime)return null;
  if(s.lastTime!==null&&c.time!==s.lastTime+duration)throw Error('Candle gap: reconciliation required');
  const previousRsi=s.rsi;
  s.ema=s.ema===null?c.close:s.ema+(2/(p.emaLength+1))*(c.close-s.ema);
  const oldEma=s.emas.length>=p.slopeBars?s.emas[s.emas.length-p.slopeBars]:null;
  s.emas.push(s.ema);s.emas=s.emas.slice(-p.slopeBars);
  s.highs.push(c.high);s.highs=s.highs.slice(-p.crashBars);
  if(s.previousClose!==null){
    const d=c.close-s.previousClose,g=Math.max(d,0),l=Math.max(-d,0);s.changes++;
    if(s.changes<=p.rsiLength){s.sumGain+=g;s.sumLoss+=l;
      if(s.changes===p.rsiLength){s.gain=s.sumGain/p.rsiLength;s.loss=s.sumLoss/p.rsiLength;}}
    else{s.gain=(s.gain*(p.rsiLength-1)+g)/p.rsiLength;s.loss=(s.loss*(p.rsiLength-1)+l)/p.rsiLength;}
    if(s.gain!==null)s.rsi=s.loss===0?100:s.gain===0?0:100-100/(1+s.gain/s.loss);
  }
  s.previousClose=c.close;s.lastTime=c.time;
  const pre={qty:s.qty,average:s.average,invested:s.invested,dca:s.dca,lastEntry:s.lastEntry,
    cycleStart:s.cycleStart,cycleEquity:s.cycleEquity};
  const equity=s.cash+s.qty*c.close;
  let event=null;
  const buy=(kind,amount)=>{
    const qty=Math.floor((amount/c.close+1e-12)/p.qtyStep)*p.qtyStep;
    const notional=qty*c.close;if(qty<=0)return;
    // Default Pine margin_long=100: reject an unaffordable order.
    if(s.cash+1e-9<notional*(1+p.fee))return;
    const total=s.qty+qty;s.average=(s.average*s.qty+notional)/total;s.qty=total;
    s.cash-=notional*(1+p.fee);s.invested+=amount;s.lastEntry=c.close;
    if(kind==='START'){s.cycleStart=c.close;s.cycleEquity=equity;s.dca=0;}
    else s.dca++;
    event={kind,cash:amount,quantity:qty,average:s.average,tp:roundedTarget(s.average,p),price:c.close};
  };
  if(s.qty>0){
    const target=s.average*(1+p.tp),dd=(s.cycleEquity-equity)/s.cycleEquity;
    if(comparable(dd)>=comparable(p.emergency)||comparable(c.close)>=comparable(target)){
      event={kind:comparable(dd)>=comparable(p.emergency)?'STOP':'TP',quantity:s.qty,price:c.close,average:s.average,
        tp:roundedTarget(s.average,p),drawdown:dd};
      s.cash+=s.qty*c.close*(1-p.fee);s.qty=0;s.average=0;s.invested=0;s.dca=0;
      s.lastEntry=null;s.cycleEquity=null;s.cycleStart=null;
    }else if(s.dca<5&&comparable(c.close)<=comparable(s.lastEntry*(1-p.drops[s.dca]))){
      const amount=Math.min(p.baseCash*p.multiplier**(s.dca+1),Math.max(0,p.initialCapital*p.maxUsage-s.invested));
      if(amount>=1)buy(`DCA${s.dca+1}`,amount);
    }
  }else{
    const cross=previousRsi!==null&&s.rsi!==null&&comparable(previousRsi)>=comparable(p.rsiLevel)&&comparable(s.rsi)<comparable(p.rsiLevel);
    const trend=oldEma!==null&&comparable((s.ema-oldEma)/oldEma)>=comparable(-p.maxSlopeDrop);
    const high=Math.max(...s.highs),crash=comparable((high-c.close)/high)<=comparable(p.maxCrashDrop);
    if(cross&&trend&&crash)buy('START',Math.min(p.baseCash,p.initialCapital*p.maxUsage));
  }
  if(event){s.orders++;event={...event,time:c.time,closeTime:c.closeTime,id:`UNIUSDT:${tf}:${c.time}:${event.kind}`};}
  return {event,pre,ema:s.ema,rsi:s.rsi};
}
export function message(tf,e,p=DEFAULTS){
  const label=tf==='15m'?'15 минут':'1 час';
  const time=new Date(e.closeTime+1).toLocaleString('ru-RU',{timeZone:'Europe/Astrakhan',hour12:false});
  const head=`DCA800 LOCAL | UNIUSDT | ТФ: ${label}\nСвеча закрыта: ${time} (Астрахань)`;
  const body=e.kind==='START'||e.kind.startsWith('DCA')
    ?`${e.kind==='START'?'СТАРТ':'УСРЕДНЕНИЕ '+e.kind}\nКупить на: ${e.cash.toFixed(2)} USDT\nЦена сигнала: ${e.price.toFixed(3)} USDT\nКоличество модели: ${e.quantity.toFixed(3)} UNI\nРасчётная средняя после покупки: ${e.average.toFixed(3)} USDT\nНовый TP на всю позицию этого цикла: ${e.tp.toFixed(3)} USDT (+${(p.tp*100).toFixed(1)}% от средней)`
    :`${e.kind==='STOP'?'АВАРИЙНЫЙ ВЫХОД':'ТЕЙК'}\nСигнал закрытия всей позиции этого цикла: ${e.quantity.toFixed(6)} UNI\nЦена сигнала: ${e.price.toFixed(3)} USDT\nРасчётный TP: ${e.tp.toFixed(3)} USDT`;
  return `${head}\n${body}\nЭто модель стратегии, не баланс биржи. При отличии ваших исполнений пересчитайте TP по фактической средней. Комиссия в TP не включена.\nID: ${e.id}`;
}
export function candle(row){return {time:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),closeTime:Number(row[6])};}
