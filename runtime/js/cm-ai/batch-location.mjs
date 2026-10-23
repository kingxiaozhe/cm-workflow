// Where a batch's parallel members live: .cm-worktrees/<segment>/<taskId> and
// branch cm/<segment>/<feature>/<taskId>. One function for the scheduler, the
// driver and the batch host, so the three never disagree.
//
// Batches used to take the first 8 characters of batchId as the segment, so
// "batch-20261022-A" and "batch-20261022-B" shared worktrees and branches. A new
// batch now records a segment derived from its full id in its batch_start row.
// A batch that already started without that field keeps the old segment, so a
// resumed batch still finds the worktrees and branches it created.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {need} from './effect-contract.mjs';

export const BATCH_SEGMENT_FIELD='worktree_segment';

// Git rejects ".." and a trailing dot in a ref component while batchId allows
// dots, so the readable prefix normalises them; the digest keeps it unique.
export function batchSegment(batchId){
  need(typeof batchId==='string'&&batchId.length>0,'invalid_input');
  return `${batchId.slice(0,8).replace(/\./g,'-')}-${createHash('sha256').update(batchId).digest('hex').slice(0,12)}`;
}

export function batchStarted({specsDir,batchId}){return startRow(specsDir,batchId)!==null;}
function startRow(specsDir,batchId){
  const log=path.join(specsDir,'运行日志.jsonl');
  if(!fs.existsSync(log))return null;
  for(const line of fs.readFileSync(log,'utf8').split('\n')){
    if(!line.trim())continue;let row;try{row=JSON.parse(line);}catch{continue;}
    if(row?.workflow==='cm-ai'&&row.event==='decision'&&row.phase==='batch_start'&&row.run_id===batchId)return row;
  }
  return null;
}

// {dir, ref}: the directory segment and the ref segment. They differ only for a
// legacy batch whose 8-character prefix contains a dot.
export function batchSegments({specsDir,batchId}){
  const row=startRow(specsDir,batchId);
  if(row!==null&&!Object.hasOwn(row,BATCH_SEGMENT_FIELD)){
    const legacy=batchId.slice(0,8);
    return {dir:legacy,ref:legacy.replace(/\./g,'-'),legacy:true};
  }
  const segment=batchSegment(batchId);
  // A recorded segment must be the one this id derives; never a path from the log.
  if(row!==null)need(row[BATCH_SEGMENT_FIELD]===segment,'batch_history_invalid');
  return {dir:segment,ref:segment,legacy:false};
}

export function batchMemberWorktree({codeProject,segments,taskId}){
  return path.resolve(codeProject,'..','.cm-worktrees',segments.dir,taskId);
}
export function batchMemberBranch({segments,feature,taskId}){
  return `cm/${segments.ref}/${feature.replace(/^\d+\./,'')}/${taskId}`;
}
