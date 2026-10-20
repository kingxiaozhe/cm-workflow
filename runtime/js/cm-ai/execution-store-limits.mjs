// Size and count limits of the local durable record store, without the store
// itself (no node:sqlite import), so owners can check an append before making it.
import { digest,json } from './effect-contract.mjs';
import {fixJournalWorkflow,packFixJournalPayload,packFixJournalState} from './review-presentation.mjs';

export const MiB=1024*1024,STATE_LIMIT=16*MiB,PHYSICAL_LIMIT=32*MiB,RECORD_LIMIT=1024;

// Whether append(input) on this snapshot stays within the store's limits (append
// input, payload, record count, whole state). Pure: an owner can refuse cleanly
// before an append that would fail inside its writer. The directory's physical
// limit (state plus retained temporary files) is not checked here.
export function appendFits(current,input){
  try{
    const bytes=value=>Buffer.byteLength(JSON.stringify(value));
    const entry=json(input,10*MiB),physicalPayload=packFixJournalPayload(entry.payload,{workflow:fixJournalWorkflow(current)});
    if(bytes({...entry,payload:physicalPayload})>MiB+1024||current.records.length>=RECORD_LIMIT)return false;
    const record={version:1,seq:current.records.length+1,id:entry.id,kind:entry.kind,payload:entry.payload,
      previousDigest:current.records.at(-1)?.digest??null};
    const {revision,...data}=current,next={...data,records:[...current.records,{...record,digest:digest(record)}]};
    const logical={...next,revision:digest(next)};
    // Both budgets remain unchanged. Encoded payloads cannot hide logical-state
    // growth, and the writer also needs the physical trailing newline to fit.
    return bytes(logical)<=STATE_LIMIT&&bytes(packFixJournalState(logical))+1<=STATE_LIMIT;
  }catch{return false;}
}
