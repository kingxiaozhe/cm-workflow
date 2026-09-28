// Bounded, no-follow reader for the specs-local JSONL log. Leaf module: it has
// no workflow imports, so read-only inspectors (admission included) can share it.
import fs from 'node:fs';
import {json,need} from './effect-contract.mjs';

const MiB=1024*1024;
export function scanRows(log,visit) {
  let descriptor;
  try {
    const stat=fs.lstatSync(log);need(stat.isFile()&&!stat.isSymbolicLink(),'qa_log_failed');
    descriptor=fs.openSync(log,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const chunk=Buffer.alloc(64*1024);let pending=Buffer.alloc(0);
    const consume=line=>{if(line.length){need(line.length<=MiB,'qa_log_failed');
      visit(json(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(line)),MiB));}};
    while(true){const size=fs.readSync(descriptor,chunk,0,chunk.length,null);if(size===0)break;
      pending=Buffer.concat([pending,chunk.subarray(0,size)]);let newline;
      while((newline=pending.indexOf(10))!==-1){consume(pending.subarray(0,newline));pending=pending.subarray(newline+1);}
      need(pending.length<=MiB,'qa_log_failed');}
    consume(pending);
  } finally {if(descriptor!==undefined)fs.closeSync(descriptor);}
}
