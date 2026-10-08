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

// A whole-log reader without the 1 MiB review-material file limit, keeping that
// reader's file guarantees: one regular single-link file, not a symlink, the
// same file before, while and after reading (dev/ino/mode/nlink/size/times),
// read to its recorded size. Lines are parsed with plain JSON.parse, as the
// historical log readers did; only selected rows are kept, in log order.
const stableKey=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
export function readStableLogRows(file,select,code){
  let descriptor;
  try{
    const before=fs.lstatSync(file,{bigint:true});
    need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n,code);
    descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    need(stableKey(fs.fstatSync(descriptor,{bigint:true}))===stableKey(before),code);
    const rows=[],chunk=Buffer.alloc(64*1024),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
    let pending=Buffer.alloc(0),total=0;
    const consume=line=>{
      need(line.length<=MiB,code);const text=decoder.decode(line);
      if(!text.trim())return;
      let row;try{row=JSON.parse(text);}catch{need(false,code);}
      if(select(row))rows.push(row);
    };
    while(true){
      const size=fs.readSync(descriptor,chunk,0,chunk.length,null);if(size===0)break;total+=size;
      need(BigInt(total)<=before.size,code);
      pending=Buffer.concat([pending,chunk.subarray(0,size)]);let newline;
      while((newline=pending.indexOf(10))!==-1){consume(pending.subarray(0,newline));pending=pending.subarray(newline+1);}
      need(pending.length<=MiB,code);
    }
    consume(pending);
    need(BigInt(total)===before.size&&stableKey(fs.fstatSync(descriptor,{bigint:true}))===stableKey(before)
      &&stableKey(fs.lstatSync(file,{bigint:true}))===stableKey(before),code);
    return rows;
  }catch(error){if(error?.code===code)throw error;need(false,code);}
  finally{if(descriptor!==undefined)fs.closeSync(descriptor);}
}
