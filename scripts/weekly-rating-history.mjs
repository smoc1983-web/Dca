// Local immutable weekly report history. No production API, D1, or Telegram sender.
import {combineWeekly,weeklyWindow,PROFILE,DAY} from './weekly-market-rating.mjs';
import {digest,ratingView,formatRatingPreview} from './market-rating-view.mjs';
import {POLICY} from './market-rating.mjs';
export const FIRST_WEEKLY_VERIFICATION=Object.freeze({commit:'4c7e36230c4fb3a8de2846fe8f2c9ad7c4303283',run:46142849737,job:140973493062,verifiedAt:Date.parse('2026-11-28T12:08:55Z')});
// The caller must independently verify CI success; a hash is not an authenticity proof.
export function buildWeeklySnapshot({archive,summary,verified}){
 if(archive?.version!=='weekly-rating-verified-observations-v1'||summary?.version!=='weekly-rating-verified-log-summary-v1'||summary.profile!==PROFILE||summary.policyVersion!==POLICY.version||!verified||! /^[a-f0-9]{40}$/.test(verified.commit)||!Number.isSafeInteger(verified.run)||verified.run<=0||!Number.isSafeInteger(verified.job)||verified.job<=0||archive.sourceCommit!==verified.commit||summary.sourceCommit!==verified.commit||archive.sourceRun!==verified.run||summary.sourceRun!==verified.run||summary.sourceJob!==verified.job||!Array.isArray(archive.records))throw Error('Weekly verification metadata mismatch');
 const window=weeklyWindow(Date.parse(summary.window.endExclusive),verified.verifiedAt);
 if(window.start!==Date.parse(summary.window.start)||window.warmupStart!==Date.parse(summary.window.warmupStart))throw Error('Weekly summary window mismatch');
 const result=combineWeekly(archive.records,window,verified.verifiedAt);
 if(digest(result.rows)!==digest(summary.rows))throw Error('Weekly result mismatch');
 const payload={version:'rating-snapshot-v1',profile:PROFILE,policy:result.policy,window:result.window,warmupStart:window.warmupStart,verified:{...verified},universe:result.universe,rated:result.rated,capitalPerIndependentPair:800,feeRate:.001,rows:result.rows,provenance:result.provenance,limitations:result.limitations,recommendationAllowed:false,changesMarketSelection:false};
 return {...payload,snapshotId:digest(payload)};
}
function check(s){
 if(s?.profile!==PROFILE||s.policy?.version!==POLICY.version||s.universe!==19||s.rows?.length!==19||s.rows.some(r=>r.status==='missing-data')||new Set(s.rows.map(r=>r.symbol)).size!==19||s.recommendationAllowed!==false||s.changesMarketSelection!==false)throw Error('Invalid weekly snapshot');
 ratingView(s,{now:s.verified.verifiedAt,scope:'all'});
 if(s.window.start!==s.window.end-365*DAY||s.warmupStart!==s.window.start-7*DAY)throw Error('Invalid weekly window');
}
const registry=s=>digest(s.rows.map(({symbol,tf,enabled})=>({symbol,tf,enabled})).sort((a,b)=>a.symbol<b.symbol?-1:1));
const eligible=s=>digest(s.rows.filter(r=>r.status==='rated').map(r=>r.symbol).sort());
export function appendWeeklySnapshot(history,snapshot){
 if(!Array.isArray(history))throw Error('Invalid history');
 check(snapshot);
 for(let i=0;i<history.length;i++){
  check(history[i]);
  if(i&&history[i-1].window.end>=history[i].window.end)throw Error('History order invalid');
  if(registry(history[i])!==registry(snapshot))throw Error('Registry changed; separate history required');
 }
 const existing=history.find(x=>x.window.end===snapshot.window.end);
 if(existing){if(existing.snapshotId!==snapshot.snapshotId)throw Error('Conflicting report for same week');return structuredClone(history);}
 if(history.length&&history.at(-1).window.end>=snapshot.window.end)throw Error('Older report cannot replace latest');
 return structuredClone([...history,snapshot]);
}
export function compareWeeklySnapshots(previous,current){
 check(previous);check(current);
 if(registry(previous)!==registry(current)||previous.window.end>=current.window.end)throw Error('Incompatible weekly snapshots');
 const rankComparable=eligible(previous)===eligible(current),prior=new Map(previous.rows.map(r=>[r.symbol,r]));
 return {version:'weekly-rating-change-v1',previousId:previous.snapshotId,currentId:current.snapshotId,previousEnd:previous.window.end,currentEnd:current.window.end,weeksBetween:(current.window.end-previous.window.end)/(7*DAY),rankComparable,rankReason:rankComparable?'same-eligible-universe':'eligible-universe-changed',recommendationAllowed:false,rows:current.rows.map(r=>{const p=prior.get(r.symbol);return {symbol:r.symbol,enabled:r.enabled,previousStatus:p.status,currentStatus:r.status,previousRank:p.rank,currentRank:r.rank,rankChange:rankComparable&&p.rank!==null&&r.rank!==null?p.rank-r.rank:null,scoreChange:rankComparable&&p.score!==null&&r.score!==null?r.score-p.score:null,returnChangePercentagePoints:r.values.netReturn-p.values.netReturn,drawdownChangePercentagePoints:r.values.drawdown-p.values.drawdown,previousFlags:p.flags,currentFlags:r.flags};})};
}
export function weeklyHistoryView(history,{now,scope='active',limit=19}={}){
 if(!Array.isArray(history)||!history.length)throw Error('No weekly snapshots');
 const latest=history.at(-1);
 // Validate ordering, uniqueness and checksums even on reads.
 const validated=history.reduce((acc,s)=>appendWeeklySnapshot(acc,s),[]);
 if(validated.length!==history.length)throw Error('Duplicate history entries');
 const view=ratingView(latest,{now,scope,limit});
 return {version:'weekly-rating-history-view-v1',weeks:validated.map(s=>({snapshotId:s.snapshotId,end:s.window.end,rated:s.rated})),latest:view,comparison:history.length>1?compareWeeklySnapshots(history.at(-2),latest):null,telegramPreview:formatRatingPreview(view)};
}
