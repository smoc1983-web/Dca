import path from 'node:path';import {fileURLToPath} from 'node:url';
import {bridge as originalBridge,atomic} from './legacy-bot.mjs';
import {resilientBridge} from './resilient-bridge.mjs';
import {main} from './watchlist-runtime.mjs';
export const bridge=resilientBridge(originalBridge);
export {atomic};
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main({app:path.dirname(fileURLToPath(import.meta.url)),bridge,atomic}).catch(e=>{console.error(e.message);process.exitCode=1;});
}
