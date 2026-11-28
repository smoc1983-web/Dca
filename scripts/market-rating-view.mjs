// Offline read-only presentation contract, not a deployed API or sender.
import {createHash} from 'node:crypto';
import {rankMarkets,POLICY} from './market-rating.mjs';
const DAY=86400000;
export const VERIFIED=Object.freeze({commit:'448f534486d33a377ee826157553ed6a2b84ea81',run:46142439313,job:140971155611,verifiedAt:Date.parse('2026-11-28T12:00:03Z')});
export const DRAFT_MAX_AGE_MS=7*DAY;
function canonical(v){
 if(Array.isArray(v))return v.map(canonical);
 if(v!==null&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));
 return v;
}
export const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export function buildRatingSnapshot({archive,markets}){
 if(archive?.version!=='market-rating-verified-input-v1'||archive.sourceRun!==46136832610||archive.sourceCommit!=='f8743de1f66c217222a3a9a669f0a9138cc65b91'||archive.correctedPolicyVersion!==POLICY.version||!Array.isArray(archive.observations)||archive.observations.length!==19||!Array.isArray(markets)||markets.length!==19||markets.filter(m=>m.enabled).length!==11)throw Error('Invalid verified rating archive');
 const window={start:archive.observations[0].start,end:archive.observations[0].end};
 if(window.start!==Date.UTC(2025,1,1)||window.end!==Date.UTC(2026,10,1))throw Error('Unexpected historical window');
 const result=rankMarkets({markets,observations:archive.observations,window,calculatedAt:VERIFIED.verifiedAt});
 if(result.rated!==19||digest(result.rows)!==digest(archive.correctedRows))throw Error('Rating archive or registry mismatch');
 // Verification time is CI completion, not an invented calculation timestamp.
 const payload={version:'rating-snapshot-v1',policy:result.policy,window:result.window,verified:VERIFIED,universe:result.universe,rated:result.rated,capitalPerIndependentPair:800,feeRate:.001,rows:result.rows,limitations:result.limitations,recommendationAllowed:false,changesMarketSelection:false};
 return {...payload,snapshotId:digest(payload)};
}
export function ratingView(snapshot,{now,scope='active',limit=19,maxAgeMs=DRAFT_MAX_AGE_MS}={}){
 if(!snapshot||snapshot.version!=='rating-snapshot-v1'||!Number.isSafeInteger(now)||now<snapshot.verified?.verifiedAt||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<=0||!['active','excluded','all'].includes(scope)||!Number.isSafeInteger(limit)||limit<1||limit>19)throw Error('Invalid rating view request');
 const {snapshotId,...payload}=snapshot;
 if(digest(payload)!==snapshotId)throw Error('Rating snapshot checksum mismatch');
 const ageMs=now-snapshot.window.end;
 if(ageMs<0)throw Error('Future rating window');
 const selected=snapshot.rows.filter(r=>scope==='all'||r.enabled===(scope==='active'));
 return {version:'rating-view-v1',snapshotId,policyVersion:snapshot.policy.version,profile:snapshot.profile??'fixed-21-month-history',window:snapshot.window,verified:snapshot.verified,scope,available:selected.length,returned:Math.min(limit,selected.length),ageMs,maxAgeMs,freshness:ageMs>maxAgeMs?'stale':'within-draft-window',historical:true,recommendationAllowed:false,changesMarketSelection:false,limitations:snapshot.limitations,rows:selected.slice(0,limit).map(r=>({symbol:r.symbol,tf:r.tf,enabled:r.enabled,rank:r.rank,score:r.score,status:r.status,netReturn:r.values?.netReturn??null,drawdown:r.values?.drawdown??null,worstCostReturn:r.worstCostReturn??null,cycles:r.costs?.find(c=>c.bps===2)?.cycles??null,longestExposureDays:r.values?.longestExposureDays??null,flags:[...r.flags]}))};
}
const date=t=>new Date(t).toISOString().slice(0,10);
export function formatRatingPreview(view){
 if(view?.version!=='rating-view-v1'||!Array.isArray(view.rows)||view.recommendationAllowed!==false)throw Error('Invalid rating preview');
 const pct=x=>x===null?'—':x.toFixed(2).replace('.',',')+'%';
 const scope={active:'Активные',excluded:'Исключённые',all:'Все пары'}[view.scope];
 const lines=[view.profile==='rolling-year-weekly-draft-v1'?'DCA800 — годовой рейтинг':'DCA800 — исторический рейтинг','Период UTC: '+date(view.window.start)+' — '+date(view.window.end-1),'Проверено: '+date(view.verified.verifiedAt)+' UTC',view.freshness==='stale'?'Данные устарели — новый период не проверен.':'Данные в пределах проектного срока.',scope+': '+view.returned+'/'+view.available];
 for(const r of view.rows)lines.push((r.rank??'—')+'. '+r.symbol+' '+r.tf+' | '+(r.score===null?'—':r.score.toFixed(2).replace('.',','))+' балла | '+pct(r.netReturn)+' | DD '+pct(r.drawdown)+(r.enabled?'':' | отключена'));
 lines.push('Исследовательский рейтинг, не торговый сигнал. Состав стратегии не меняется.');
 const text=lines.join('\n');
 if(text.length>4096)throw Error('Rating preview too long');
 return text;
}
