// Strict V3 payload grammar, shared by live authorization and journal replay.
import {need,shape,id,hex,text,json,REVIEW_TEXT_LIMIT} from './effect-contract.mjs';

// Read-only context carried from the most recent superseded run's last review
// receipt. It is never a verdict: runners only show it to the attempt-1
// developer and reviewer, and stage, attempt and budget rules never read it.
export function readCarriedReview(value,previousRunIds=null){
  const fail=()=>need(false,'supersede_record_invalid');
  try{
    shape(value,['previousRunId','verdict','summary','findings']);id(value.previousRunId);
    need(['approved','changes_requested','blocked'].includes(value.verdict));text(value.summary);
    need(Array.isArray(value.findings)&&value.findings.length<=100);
    const ids=new Set();
    for(const f of value.findings){
      shape(f,['id','severity','path','message','evidence']);id(f.id);need(!ids.has(f.id));ids.add(f.id);
      need(['P0','P1','P2','P3'].includes(f.severity));text(f.path);text(f.message);text(f.evidence);
    }
    const {previousRunId,...body}=value;
    need(Buffer.byteLength(JSON.stringify(body),'utf8')<=REVIEW_TEXT_LIMIT);
  }catch{fail();}
  if(previousRunIds)need(previousRunIds.has(value.previousRunId),'supersede_record_invalid');
  return value;
}

export function readEvidenceSupersession(raw,expected=null){
  const record=json(raw,1024*1024);
  shape(record,['version','feature','taskId','newRunId','previousRunIds','reason','files','authorizedAt',
    ...(Object.hasOwn(record,'acceptedCodeDrift')?['acceptedCodeDrift']:[]),
    ...(Object.hasOwn(record,'carriedReview')?['carriedReview']:[])]);
  need(record.version===1,'supersede_record_invalid');
  need(typeof record.authorizedAt==='string'
    &&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.authorizedAt)
    &&!Number.isNaN(Date.parse(record.authorizedAt)),'supersede_record_invalid');
  for(const key of ['feature','taskId','newRunId'])id(record[key]);
  need(Array.isArray(record.previousRunIds)&&record.previousRunIds.length>0&&record.previousRunIds.length<=128,'supersede_record_invalid');
  const runs=new Set();for(const runId of record.previousRunIds){id(runId);need(!runs.has(runId)&&runId!==record.newRunId,'supersede_record_invalid');runs.add(runId);}
  if(Object.hasOwn(record,'acceptedCodeDrift')){
    need(Array.isArray(record.acceptedCodeDrift)&&record.acceptedCodeDrift.length>0
      &&record.acceptedCodeDrift.length<=8192,'supersede_record_invalid');
    const seen=new Set();
    for(const file of record.acceptedCodeDrift){
      shape(file,['predecessorRunId','path','sha256']);
      need(runs.has(file.predecessorRunId)&&typeof file.path==='string'&&file.path.length>0
        &&file.path.normalize('NFC')===file.path&&!/[\\:\x00-\x1f\x7f-\x9f]/.test(file.path)
        &&file.path.split('/').every(part=>part&&part!=='.'&&part!=='..'),'supersede_record_invalid');
      if(file.sha256!==null)hex(file.sha256);
      const key=`${file.predecessorRunId}\0${file.path}`;
      need(!seen.has(key),'supersede_record_invalid');seen.add(key);
    }
  }
  if(Object.hasOwn(record,'carriedReview'))readCarriedReview(record.carriedReview,runs);
  need(typeof record.reason==='string'&&record.reason.trim()&&Buffer.byteLength(record.reason,'utf8')<=500
    &&!/[\r\n\0]/.test(record.reason),'supersede_reason_required');
  // Zero files: the prior runs stopped before any handoff or review existed.
  need(Array.isArray(record.files)&&record.files.length<=256,'supersede_record_invalid');
  const names=new Set();for(const file of record.files){
    shape(file,['name','sha256']);
    need(typeof file.name==='string'&&/^[A-Za-z0-9._-]+\.(md|json)$/.test(file.name)
      &&supersedableEvidenceName(file.name,record.feature,record.taskId)
      &&!names.has(file.name),'supersede_record_invalid');
    names.add(file.name);hex(file.sha256);
  }
  if(expected)need(record.feature===expected.feature&&record.taskId===expected.taskId
    &&record.newRunId===expected.newRunId,'supersede_record_invalid');
  return record;
}

export function supersedableEvidenceName(name,feature,taskId){
  const prefix=`${feature.replace(/^\d+\./,'')}-${taskId}-`;
  if(!name.startsWith(prefix))return false;
  const suffix=name.slice(prefix.length);
  return /^(?:a[12]-handoff\.json|r[12]\.md|(?:correction|qa)[A-Za-z0-9._-]*\.(?:md|json))$/.test(suffix);
}
