// Synchronous safe reader for the runtime's own read of notify.json.
// Side-effect free on purpose: notify.mjs is imported by every host, so this
// module only imports node:fs and never touches process, timers or the disk
// at import time. The boundary is the same as the sender's async
// readRegularFile (runtime/js/notify-send.mjs, which stays a self-contained
// single file because it is copied alone to <CM_WORKFLOW_HOME>/notify/): lstat
// must show a regular file (never a symlink), at most 64 KiB, opened without
// following links and without blocking (a FIFO is refused, never waited on),
// and the opened handle must be the same file object (dev+ino) and still pass
// the type and size checks. A test runs one fixture matrix through both
// readers and fails if their accept/reject decisions or reasons drift apart.
import fs from 'node:fs';

export const MAX_NOTIFY_FILE_BYTES=64*1024;

// state: 'missing' (no such path) | 'invalid'. reason: 'permission' (not a
// regular file, a link, or swapped while checking) | 'too_large' | undefined.
export class SafeReadError extends Error{
  constructor(message,state,reason){super(message);this.state=state;this.reason=reason;}
}
const refuse=(message,reason)=>new SafeReadError(message,'invalid',reason);

// Returns a Buffer (bytes:true) or the text decoded strictly as UTF-8 with a
// leading BOM removed, like the sender's reader. Throws SafeReadError only.
export function readRegularFileSync(file,label,{fileOps=fs,bytes:raw=false}={}){
  let link;
  try{link=fileOps.lstatSync(file,{bigint:true});}
  catch(error){throw error?.code==='ENOENT'?new SafeReadError(`读不到 ${label}`,'missing'):refuse(`读不到 ${label}`);}
  const notRegular=()=>refuse(`${label} 必须是普通文件（不能是符号链接）`,'permission');
  const tooLarge=()=>refuse(`${label} 太大`,'too_large');
  if(link.isSymbolicLink()||!link.isFile())throw notRegular();
  if(link.size>BigInt(MAX_NOTIFY_FILE_BYTES))throw tooLarge();
  let fd=null;
  try{
    // O_NONBLOCK: a file swapped for a FIFO after lstat opens at once and is
    // then refused by the type check on the handle.
    fd=fileOps.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));
    const st=fileOps.fstatSync(fd,{bigint:true});
    if(!st.isFile())throw notRegular();
    if(st.dev!==link.dev||st.ino!==link.ino)throw refuse(`${label} 在核对期间被替换，为安全起见不使用它`,'permission');
    if(st.size>BigInt(MAX_NOTIFY_FILE_BYTES))throw tooLarge();
    const size=Number(st.size),buffer=Buffer.alloc(size);let read=0;
    while(read<size){const n=fileOps.readSync(fd,buffer,read,size-read,read);if(n===0)break;read+=n;}
    const data=buffer.subarray(0,read);
    return raw?data:new TextDecoder('utf-8',{fatal:true}).decode(data).replace(/^\uFEFF/,'');
  }catch(error){
    throw error instanceof SafeReadError?error:refuse(`读取 ${label} 失败`);
  }finally{if(fd!==null){try{fileOps.closeSync(fd);}catch{}}}
}
