#!/usr/bin/env python3
"""Offline import of checksum-pinned Binance Vision spot kline ZIPs.
No network, extraction to disk, credentials, or exchange actions.
"""
import argparse
import calendar
import csv
import datetime as dt
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sys
import zipfile

DAY = 86400000
CHANGE = 1735689600000
NATIVE = {"1m":60000,"3m":180000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"2h":7200000,"4h":14400000,"6h":21600000,"8h":28800000,"12h":43200000,"1d":DAY}
CUSTOM = {"45m":"15m","3h":"1h"}
MAX_ZIP = 64 * 1024 * 1024
MAX_CSV = 128 * 1024 * 1024

def require(ok, msg):
    if not ok:
        raise ValueError(msg)

def uint(x, name):
    require(type(x) is int and 0 <= x <= 2**53-1, "Invalid "+name)
    return x

def ms(day):
    return calendar.timegm(day.timetuple()) * 1000

def archive_range(name, symbol, tf):
    match = re.fullmatch(re.escape(symbol+"-"+tf+"-")+r"(\d{4}-\d{2})(-\d{2})?\.zip", name)
    require(match is not None, "Unexpected archive filename")
    first = dt.date.fromisoformat(match[1]+(match[2] or "-01"))
    if match[2]:
        end = first + dt.timedelta(days=1)
    else:
        end = dt.date(first.year + (first.month == 12), first.month % 12 + 1, 1)
    return ms(first), ms(end)

def num(raw, name, positive=False):
    require(re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", raw) is not None, "Invalid "+name)
    v = float(raw)
    require(math.isfinite(v) and (v > 0 if positive else v >= 0), "Invalid "+name)
    return v

def load_archive(spec, root, symbol, tf):
    path = root / spec["file"]
    name = path.name
    start, end = archive_range(name, symbol, tf)
    expected = spec["sha256"]
    require(isinstance(expected,str) and re.fullmatch(r"[a-f0-9]{64}", expected), "Explicit pinned SHA256 required")
    require(path.stat().st_size <= MAX_ZIP, "ZIP too large")
    raw = path.read_bytes()
    require(len(raw) <= MAX_ZIP, "ZIP too large")
    digest = hashlib.sha256(raw).hexdigest()
    require(digest == expected, "ZIP checksum mismatch: "+name)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        entries = z.infolist()
        require(len(entries)==1 and entries[0].filename == name[:-4]+".csv" and not entries[0].is_dir(), "Unexpected ZIP member")
        require(entries[0].file_size <= MAX_CSV, "CSV too large")
        data = z.read(entries[0])
    require(len(data)<=MAX_CSV, "CSV too large")
    rows = []
    duration = NATIVE[tf]
    # Binance Spot changed to microsecond timestamps on 2025-01-01.
    factor = 1000 if start >= CHANGE else 1
    for i, fields in enumerate(csv.reader(io.StringIO(data.decode("ascii"), newline=""), strict=True)):
        require(len(fields)==12, "Expected 12 Binance kline columns")
        t = start+i*duration
        require(t<end and fields[0].isdigit() and fields[6].isdigit(), "Invalid timestamp or excess rows")
        require(int(fields[0])==t*factor and int(fields[6])==(t+duration)*factor-1, "Candle gap, duplicate or incorrect timestamp unit")
        o,h,l,c = [num(fields[j],"OHLC",True) for j in (1,2,3,4)]
        v = num(fields[5],"volume")
        require(l<=min(o,c)<=max(o,c)<=h, "Invalid OHLC envelope")
        rows.append({"time":t,"closeTime":t+duration-1,"open":o,"high":h,"low":l,"close":c,"volume":v})
    require(len(rows)==(end-start)//duration,"Incomplete archive coverage")
    return rows, {"name":name,"sha256":digest,"csvSha256":hashlib.sha256(data).hexdigest(),"start":start,"end":end,"timestampUnit":"us" if factor==1000 else "ms","rows":len(rows)}

def import_history(config, root):
    symbol=config["symbol"]
    require(isinstance(symbol,str) and re.fullmatch(r"[A-Z0-9]+USDT",symbol) is not None,"Invalid USDT symbol")
    target=config["tf"]
    source=CUSTOM.get(target,target)
    require(source in NATIVE,"Unsupported timeframe")
    source_ms=NATIVE[source]
    target_ms={"45m":2700000,"3h":10800000}.get(target,source_ms)
    w=config["window"]
    a,b,c=[uint(w[k],k) for k in ("warmupStart","start","end")]
    retrieved=uint(config["retrievedAt"],"retrievedAt")
    cutoff=uint(config["selectionCutoff"],"selectionCutoff")
    require(a<b<c<=retrieved and all(t%target_ms==0 for t in (a,b,c)),"Invalid aligned closed window")
    require(isinstance(config["filterSource"],str) and bool(config["filterSource"].strip()),"Explicit filter provenance required")
    specs=config["archives"]
    require(isinstance(specs,list) and 0<len(specs)<=2000,"Invalid archive list")
    all_rows=[]; manifests=[]; last_end=None
    # Caller supplies chronological, non-overlapping full archives.
    for spec in specs:
        rows, m=load_archive(spec,root,symbol,source)
        require(last_end is None or last_end==m["start"],"Archive gap or overlap")
        require(m["end"]<=retrieved,"Archive extends beyond retrieval")
        last_end=m["end"];manifests.append(m)
        all_rows.extend(r for r in rows if a<=r["time"]<c)
    require(len(all_rows)==(c-a)//source_ms and all(r["time"]==a+i*source_ms for i,r in enumerate(all_rows)),"Incomplete requested coverage")
    ratio=target_ms//source_ms
    candles=[]
    for i in range(0,len(all_rows),ratio):
        chunk=all_rows[i:i+ratio]
        require(len(chunk)==ratio,"Partial aggregate")
        volume=math.fsum(r["volume"] for r in chunk)
        require(math.isfinite(volume),"Invalid aggregate volume")
        candles.append({"time":chunk[0]["time"],"closeTime":chunk[-1]["closeTime"],"open":chunk[0]["open"],"high":max(r["high"] for r in chunk),"low":min(r["low"] for r in chunk),"close":chunk[-1]["close"],"volume":volume})
    manifest={"provider":"Binance Vision spot klines","symbol":symbol,"sourceTf":source,"targetTf":target,"retrievedAt":retrieved,"archives":manifests,"window":w}
    manifest_hash=hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(",",":"),ensure_ascii=True).encode()).hexdigest()
    params=config["params"]
    require(params.get("symbol")==symbol,"Parameter symbol mismatch")
    return {"tf":target,"window":w,"params":params,"source":{"kind":"historical","provider":"Binance Vision spot klines","datasetId":"archive-manifest:"+manifest_hash,"retrievedAt":retrieved,"selectionCutoff":cutoff,"filterSource":config["filterSource"]},"candles":candles,"archiveManifest":manifest,"archiveManifestSha256":manifest_hash}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("config",type=Path)
    args=p.parse_args()
    try:
        config=json.loads(args.config.read_text(encoding="utf-8"))
        print(json.dumps(import_history(config,args.config.parent),allow_nan=False,separators=(",",":")))
    except (OSError,ValueError,KeyError,TypeError,zipfile.BadZipFile,UnicodeError,OverflowError,csv.Error) as exc:
        print("Import failed: "+str(exc),file=sys.stderr)
        return 2
    return 0

if __name__=="__main__":
    sys.exit(main())
