import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function assertActive({directories,ownerComputer}, computer=os.hostname()) {
  for(const directory of new Set(directories.filter(Boolean))) {
    for(const marker of ['TRANSFERRED-DO-NOT-START.json','INSTALLATION-PENDING.json']) {
      if(fs.existsSync(path.join(directory,marker))) throw Error('DCA800 is disabled on this installation: '+marker);
    }
  }
  if(ownerComputer && ownerComputer.toLowerCase()!==computer.toLowerCase()) {
    throw Error('DCA800 belongs to another computer; use the migration installer');
  }
}
