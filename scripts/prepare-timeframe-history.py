#!/usr/bin/env python3
"""One symbol, 28 complete public 5m monthly ZIPs, no production access."""
import json,runpy,sys
from pathlib import Path
from datetime import datetime,timezone
ROOT=Path(__file__).resolve().parent.parent
fetch=runpy.run_path(str(ROOT/"scripts/fetch-binance-archive.py"))["fetch"]
load=runpy.run_path(str(ROOT/"scripts/import-binance-spot.py"))["import_history"]
def ms(s): return int(datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()*1000)
def prepare(symbol,dest):
    markets=json.loads((ROOT/"strategy/markets.json").read_text())
    m=next(x for x in markets if x["symbol"]==symbol)
    if len(markets)!=19 or len({x["symbol"] for x in markets})!=19 or symbol=="NEARUSDT": raise ValueError("Unexpected universe")
    archives=[]
    for y in (2024,2025,2026):
        for month in range(1,13):
            if (y,month)<(2024,7) or (y,month)>(2026,10): continue
            info=fetch(symbol,"5m",f"{y}-{month:02d}",dest)
            archives.append(info)
            print(json.dumps({"archive":info["file"],"sha256":info["sha256"]}),flush=True)
    keys=["symbol","initialCapital","fee","slippageBps","tick","qtyStep","minQty","minNotional"]
    data=load({"symbol":symbol,"tf":"5m","archives":archives,"window":{"warmupStart":ms("2024-07-01"),"start":ms("2025-02-01"),"end":ms("2026-11-01")},"retrievedAt":max(a["retrievedAt"] for a in archives),"selectionCutoff":ms("2026-11-11"),"filterSource":"repository model snapshot; historical filters unverified","params":{k:m["params"][k] for k in keys}},dest)
    (dest/"input.json").write_text(json.dumps(data,separators=(",",":"),allow_nan=False))
if __name__=="__main__":
    try: prepare(sys.argv[1],Path(sys.argv[2]))
    except Exception as e:
        print("Timeframe data incomplete: "+str(e),file=sys.stderr);sys.exit(2)
