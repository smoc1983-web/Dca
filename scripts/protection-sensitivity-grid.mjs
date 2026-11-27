// Frozen research matrix, not production parameters or optimization.
export const pools=Object.freeze([50,100,150,200]);
export const caps=Object.freeze([10,20,30,40]);
export function sensitivityGrid(pool){
 if(!pools.includes(pool))throw Error('Invalid sensitivity pool');
 const scenarios=[];
 for(const policy of ['fixed-notional','scaled-notional'])for(const leverage of [1,2,3]){
  // Cap irrelevant without topups, single matched control per pool/policy/leverage.
  scenarios.push({policy,leverage,responseMode:'none',researchAllocation:{pool,cycleCap:20}});
  for(const cycleCap of caps)for(const responseMode of ['next-close','two-closes'])
   scenarios.push({policy,leverage,responseMode,researchAllocation:{pool,cycleCap}});
 }
 return scenarios;
}
