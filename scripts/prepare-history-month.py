#!/usr/bin/env python3
"""Fixed historical smoke: 19 public spot monthly archives, not OOS."""
import json
from pathlib import Path
import runpy
import sys

ROOT=Path(__file__).resolve().parent.parent
fetch=runpy.run_path(str(ROOT/"scripts/fetch-binance-archive.py"))["fetch"]
import_history=runpy.run_path(str(ROOT/"scripts/import-binance-spot.py"))["import_history"]
MONTH="2025-01"
START=1735689600000
EVAL=START+7*86400000
END=START+31*86400000
CUTOFF=1794355200000
KEYS=["symbol","initialCapital","fee","slippageBps","tick","qtyStep","minQty","minNotional"]

def prepare(dest):
    markets=json.loads((ROOT/"strategy/markets.json").read_text())
    if len(markets)!=19 or len({m["symbol"] for m in markets})!=19:
        raise ValueError("Unexpected market universe")
    dest.mkdir(parents=True,exist_ok=True)
    for m in markets:
        symbol,tf=m["symbol"],m["tf"]
        native={"45m":"15m","3h":"1h"}.get(tf,tf)
        info=fetch(symbol,native,MONTH,dest)
        config={"symbol":symbol,"tf":tf,"archives":[info],"window":{"warmupStart":START,"start":EVAL,"end":END},
            "retrievedAt":info["retrievedAt"],"selectionCutoff":CUTOFF,"filterSource":"repository model snapshot; not historical exchange filters",
            "params":{k:m["params"][k] for k in KEYS}}
        data=import_history(config,dest)
        data["download"]=info
        (dest/(symbol+".json")).write_text(json.dumps(data,allow_nan=False,separators=(",",":")))
        print(json.dumps({"symbol":symbol,"tf":tf,"candles":len(data["candles"]),"archive":info["file"],"sha256":info["sha256"]}),flush=True)

if __name__=="__main__":
    try:
        prepare(Path(sys.argv[1]))
    except Exception as e:
        print("Monthly preparation failed; no missing pairs substituted: "+str(e),file=sys.stderr)
        sys.exit(2)
