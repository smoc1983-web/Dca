import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const file=fileURLToPath(new URL('../scripts/fetch-binance-archive.py',import.meta.url));
function check(code){
 const r=spawnSync('python3',['-B','-c',`import runpy,sys,tempfile,hashlib
from pathlib import Path
m=runpy.run_path(sys.argv[1]);fetch=m['fetch'];checksum=m['checksum']
name='BTCUSDT-5m-2025-01-01.zip';raw=b'fixture';digest=hashlib.sha256(raw).hexdigest()
def fake(url,limit):
 return (digest+'  '+name+'\\n').encode() if url.endswith('.CHECKSUM') else raw
with tempfile.TemporaryDirectory() as d:
 dest=Path(d)
`+code,file],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
}
test('official checksum filename validated',()=>check(` assert checksum(digest+'  '+name,name)==digest
 try: checksum(digest+'  other.zip',name)
 except ValueError: pass
 else: raise AssertionError('wrong file accepted')
`));
test('pinned public fixture download and repeat',()=>check(` result=fetch('BTCUSDT','5m','2025-01-01',dest,fake)
 assert result['sha256']==digest and (dest/name).read_bytes()==raw
 assert result['archiveUrl'].startswith('https://data.binance.vision/')
 assert fetch('BTCUSDT','5m','2025-01-01',dest,fake)['sha256']==digest
`));
test('mismatch cannot write archive',()=>check(` def bad(url,limit): return fake(url,limit) if url.endswith('.CHECKSUM') else b'bad'
 try: fetch('BTCUSDT','5m','2025-01-01',dest,bad)
 except ValueError: pass
 else: raise AssertionError('bad archive accepted')
 assert not list(dest.iterdir())
`));
test('existing conflicting archive is not overwritten',()=>check(` (dest/name).write_bytes(b'old')
 try: fetch('BTCUSDT','5m','2025-01-01',dest,fake)
 except ValueError: pass
 else: raise AssertionError('overwrite accepted')
 assert (dest/name).read_bytes()==b'old'
`));
test('network refusal and invalid symbol do not fall back',()=>check(` calls=[]
 def refused(url,limit):
  calls.append(url);raise OSError('HTTP 451')
 try: fetch('BTCUSDT','5m','2025-01-01',dest,refused)
 except OSError: pass
 else: raise AssertionError('refusal ignored')
 assert len(calls)==1 and not list(dest.iterdir())
 try: fetch('../BTCUSDT','5m','2025-01-01',dest,refused)
 except ValueError: pass
 else: raise AssertionError('invalid symbol accepted')
 assert len(calls)==1
`));
