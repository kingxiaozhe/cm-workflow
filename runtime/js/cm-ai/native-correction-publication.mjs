// Fixed projections of a strictly replayed original-run correction; never a grant.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest,need,id,shape,validIdentity,hex} from './effect-contract.mjs';
import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {readRunnerHistory} from './durable-runner-state.mjs';
export function nativeCorrectionPaths(reviewsDir,feature,task,materialReview=false,evidenceContinuation=false,providerRecovery=false){
  id(feature);id(task);
  need(path.isAbsolute(reviewsDir)&&fs.realpathSync(reviewsDir)===reviewsDir
    &&fs.lstatSync(reviewsDir).isDirectory()&&!fs.lstatSync(reviewsDir).isSymbolicLink(),'unsupported_path');
  const prefix=path.join(reviewsDir,`${feature}-${task}-native-correction-1`);
  return {record:prefix+'.json',handoff:prefix+'-handoff.json',review:prefix+(providerRecovery?'-provider-recovery-1':evidenceContinuation?'-evidence-1':materialReview?'-material-1':'')+'.md',receipt:prefix+(providerRecovery?'-provider-recovery-1':evidenceContinuation?'-evidence-1':materialReview?'-material-1':'')+'-receipt.json'};
}
export function inspectNativeCorrectionOwner({reviewsDir,feature,task,correction}){
  shape(correction,['recordDigest','identity','executionStatePath']);hex(correction.recordDigest);validIdentity(correction.identity);
  const identity=correction.identity;
  need(identity.taskId===task&&identity.attempt===2,'identity_mismatch');
  const specsRoot=path.dirname(reviewsDir),expected=path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json');
  need(correction.executionStatePath===expected,'unsupported_path');
  const snapshot=readExecutionSnapshot({specsRoot,identity:{repositoryId:identity.repositoryId,runId:identity.runId}});
  const config=snapshot.records[0].payload.config,history=readRunnerHistory(snapshot.records,config,3);
  const records=snapshot.records.filter(row=>row.payload.type==='native-correction-authorized');
  need(records.length===1&&records[0].digest===correction.recordDigest
    &&history.nativeCorrection?.recordDigest===correction.recordDigest
    &&config.identity.taskId===task&&digest({...config.identity,attempt:2})===digest(identity)
    &&config.taskLearning?.feature.replace(/^\d+\./,'')===feature,'native_correction_owner_mismatch');
  const retained=records[0].payload.retainedEvidence;
  const material=snapshot.records.find(row=>row.payload.type==='native-material-review-authorized');
  if(material){
    const expected=nativeCorrectionPaths(reviewsDir,feature,task);
    need(material.payload.retainedEvidence.length===2&&digest(material.payload.retainedEvidence.map(x=>x.path))===digest([expected.review,expected.receipt]),'native_correction_history_mismatch');
    for(const item of material.payload.retainedEvidence){const st=fs.lstatSync(item.path);need(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<=256*1024&&createHash('sha256').update(fs.readFileSync(item.path)).digest('hex')===item.sha256,'native_correction_history_mismatch');}
  }
  if(history.evidenceContinuation){
    const old=nativeCorrectionPaths(reviewsDir,feature,task,Boolean(history.nativeCorrection.materialReview));
    need(digest(history.evidenceContinuation.retainedEvidence.map(r=>r.path))===digest([old.review,old.receipt]),'evidence_continuation_retained_changed');
    for(const row of history.evidenceContinuation.retainedEvidence){const st=fs.lstatSync(row.path);need(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<=256*1024&&createHash('sha256').update(fs.readFileSync(row.path)).digest('hex')===row.sha256,'evidence_continuation_retained_changed');}
  }
  const expectedFiles=[`${feature}-${task}-a1-handoff.json`,`${feature}-${task}-r1.md`,`${feature}-${task}-a2-handoff.json`,`${feature}-${task}-r2.md`].map(name=>path.join(reviewsDir,name));
  need(Array.isArray(retained)&&retained.length===4&&digest(retained)===records[0].payload.sourceDigest
    &&new Set(retained.map(item=>item.path)).size===4&&retained.every(item=>expectedFiles.includes(item.path)),'native_correction_history_mismatch');
  for(const item of retained){
    shape(item,['path','sha256']);hex(item.sha256);
    const before=fs.lstatSync(item.path);need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=256*1024,'unsupported_file');
    const fd=fs.openSync(item.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),current=fs.lstatSync(item.path);
      need([after,current].every(stat=>['dev','ino','size','mtimeMs','ctimeMs'].every(key=>stat[key]===before[key]))
        &&createHash('sha256').update(bytes).digest('hex')===item.sha256,'native_correction_history_mismatch');
    }finally{fs.closeSync(fd);}
  }
  return {snapshot,config,history,record:records[0],paths:nativeCorrectionPaths(reviewsDir,feature,task,Boolean(history.nativeCorrection.materialReview),Boolean(history.evidenceContinuation?.authorization),Boolean(history.providerRecovery))};
}
