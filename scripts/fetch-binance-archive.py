#!/usr/bin/env python3
"""Bounded public Binance Vision download. No exchange API or credentials."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sys
import urllib.request
import urllib.error

BASE = "https://data.binance.vision/data/spot/daily/klines/"
MAX_ZIP = 64 * 1024 * 1024
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def checksum(text, name):
    lines = text.strip().splitlines()
    if len(lines) != 1:
        raise ValueError("Expected one CHECKSUM line")
    m = re.fullmatch(r"([0-9a-fA-F]{64})[ \t]+\*?([^\s]+)", lines[0])
    if not m or m[2] != name:
        raise ValueError("CHECKSUM filename or format mismatch")
    return m[1].lower()

def get(url, limit):
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(urllib.request.Request(url, headers={"User-Agent":"DCA800-offline-research/1"}), timeout=20) as r:
        if r.status != 200:
            raise ValueError("Unexpected HTTP status")
        data = r.read(limit+1)
    if len(data)>limit:
        raise ValueError("Download size limit exceeded")
    return data

def fetch(symbol, tf, date, dest, download=get):
    if not re.fullmatch(r"[A-Z0-9]+USDT", symbol) or symbol=="USDT":
        raise ValueError("Invalid symbol")
    if tf not in {"1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d"}:
        raise ValueError("Unsupported native timeframe")
    day=dt.date.fromisoformat(date)
    if day.isoformat()!=date or day>=dt.datetime.now(dt.timezone.utc).date():
        raise ValueError("Archive day must be completed UTC day")
    name=f"{symbol}-{tf}-{date}.zip"
    url=BASE+f"{symbol}/{tf}/{name}"
    expected=checksum(download(url+".CHECKSUM",4096).decode("ascii"),name)
    raw=download(url,MAX_ZIP)
    if len(raw)>MAX_ZIP or hashlib.sha256(raw).hexdigest()!=expected:
        raise ValueError("ZIP checksum mismatch")
    dest.mkdir(parents=True,exist_ok=True)
    path=dest/name
    # Never overwrite an existing different archive.
    if path.exists():
        if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
            raise ValueError("Existing archive conflicts")
    else:
        with path.open("xb") as f:
            f.write(raw)
    return {"file":name,"sha256":expected,"archiveUrl":url,"checksumUrl":url+".CHECKSUM","retrievedAt":int(dt.datetime.now(dt.timezone.utc).timestamp()*1000)}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("symbol");p.add_argument("tf");p.add_argument("date");p.add_argument("dest",type=Path)
    a=p.parse_args()
    try:
        print(json.dumps(fetch(a.symbol,a.tf,a.date,a.dest)))
    except (ValueError,OSError,UnicodeError) as e:
        print("Public archive unavailable: "+str(e),file=sys.stderr)
        return 2
    return 0
if __name__=="__main__":
    sys.exit(main())
