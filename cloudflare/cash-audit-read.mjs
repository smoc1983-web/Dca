export async function readCashAudit(db){
    const rows=(await db.prepare('SELECT seq,op_id,payload FROM dev_cash_audit ORDER BY seq').bind().all()).results;
    let opening=null,observation=null,revision=0;const flows=[],ops=new Map();
    for(const row of rows){
      const p=JSON.parse(row.payload);
      if(p.request.opId!==row.op_id||row.seq<=revision||ops.has(row.op_id))throw Error('Corrupt cash audit');
      if(p.request.kind==='opening'){if(opening)throw Error('Duplicate opening');opening=p.request.opening;}
      else if(!opening)throw Error('Cash opening missing');
      else if(p.request.kind==='flow'){flows.push(p.request.flow);observation=null;}
      else if(p.request.kind==='observe')observation={...p.request.observation,ledgerRevision:p.ledgerRevision};
      else throw Error('Corrupt cash operation');
      ops.set(row.op_id,p.request);revision=row.seq;
    }
    return {opening,flows,observation,revision,ops};
  }
