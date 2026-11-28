import {readFileSync,writeFileSync} from 'node:fs';
import {compareSpotSources} from './spot-source-parity.mjs';
const [ref,alt,out]=process.argv.slice(2);
if(!ref||!alt||!out)throw Error('Usage: node scripts/check-spot-source-parity.mjs reference.json candidate.json report.json');
const reference=JSON.parse(readFileSync(ref,'utf8')),candidate=JSON.parse(readFileSync(alt,'utf8'));
const report=compareSpotSources({start:reference.start,end:reference.end,reference,candidate,now:Date.now()});
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(report.status,report.compared,report.mismatchCount);
if(report.mismatchCount)process.exitCode=1;
