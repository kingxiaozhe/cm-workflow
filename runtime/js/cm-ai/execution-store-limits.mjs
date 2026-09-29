// Size and count limits of the local durable record store, without the store
// itself (no node:sqlite import), so owners can check an append before making it.
import { digest } from './effect-contract.mjs';

export const MiB=1024*1024,STATE_LIMIT=16*MiB,PHYSICAL_LIMIT=32*MiB,RECORD_LIMIT=1024;

// Whether append(input) on this snapshot stays within the store's limits (append
// input, payload, record count, whole state). Pure: an owner can refuse cleanly
// before an append that would fail inside its writer. The directory's physical
// limit (state plus retained temporary files) is not checked here.
export function appendFits(current,input){
  const bytes=value=>Buffer.byteLength(JSON.stringify(value));
  if(bytes(input)>MiB+1024||bytes(input.payload)>MiB||current.records.length>=RECORD_LIMIT)return false;
  const record={version:1,seq:current.records.length+1,id:input.id,kind:input.kind,payload:input.payload,
    previousDigest:current.records.at(-1)?.digest??null};
  const {revision,...data}=current,next={...data,records:[...current.records,{...record,digest:digest(record)}]};
  return bytes({...next,revision:digest(next)})<=STATE_LIMIT;
}
