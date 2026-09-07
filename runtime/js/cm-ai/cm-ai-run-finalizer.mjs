// Thin N8 adapter for the JS run_done authority through its platform lock adapter and status file.
import childProcess from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hex,id,json,need,shape,text,validIdentity} from './effect-contract.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));
const MiB=1024*1024;

function statusTarget(specsDir) {
  try {
    const specs=fs.realpathSync(specsDir),stat=fs.lstatSync(specs);
    need(stat.isDirectory()&&!stat.isSymbolicLink(),'status_invalid');
    const target=path.join(specs,'.cm-status.json');
    if(fs.existsSync(target)){
      const targetStat=fs.lstatSync(target);
      need(targetStat.isFile()&&!targetStat.isSymbolicLink(),'status_invalid');
      need(fs.realpathSync(target)===target,'status_invalid');
    }
    return {specs,target};
  } catch(error) {
    if(error?.code==='status_invalid')throw error;
    need(false,'status_invalid');
  }
}

function prepareStatus({specs,target},feature,identity) {
  const temporary=path.join(specs,`.cm-status.json.tmp.${process.pid}.${randomUUID()}`);
  const value={node:'N8',feature,task:identity.taskId,detail:'全部任务和文档同步已完成',
    state:'run_done',at:new Date().toTimeString().slice(0,8)};
  let descriptor;
  try {
    descriptor=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL
      |(fs.constants.O_NOFOLLOW??0),0o644);
    fs.writeFileSync(descriptor,`${JSON.stringify(value)}\n`);fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);descriptor=undefined;
    return {temporary,target,specs};
  } catch {
    if(descriptor!==undefined)try{fs.closeSync(descriptor);}catch{}
    try{fs.unlinkSync(temporary);}catch{}
    need(false,'status_write_failed');
  }
}

function readResult(stdout,identity,specsDir) {
  try {
    const result=json(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(stdout)),MiB);
    shape(result,['event_id','run_id','project_log','global_log','global_written','pointer_written','deduplicated','degraded']);
    id(result.event_id);need(result.run_id===identity.runId);text(result.project_log);text(result.global_log);
    need(path.resolve(result.project_log)===path.join(fs.realpathSync(specsDir),'运行日志.jsonl'));
    need(typeof result.global_written==='boolean'&&(typeof result.pointer_written==='boolean'||result.pointer_written===null)
      &&typeof result.deduplicated==='boolean'&&typeof result.degraded==='boolean');
    return result;
  } catch {need(false,'run_log_failed');}
}

export function recordCmAiRunDone(input) {
  const keys=['specsDir','codeProject','feature','identity','packageDigest','contextDigest','documentationSyncId'];
  if(input&&Object.hasOwn(input,'logHome'))keys.push('logHome');
  shape(input,keys);text(input.specsDir);text(input.codeProject);text(input.feature);validIdentity(input.identity);
  hex(input.packageDigest);hex(input.contextDigest);id(input.documentationSyncId);
  need(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(input.identity.runId),'invalid_run_id');
  const target=statusTarget(input.specsDir),prepared=prepareStatus(target,input.feature,input.identity);
  const data={node:'N8',feature:input.feature,task:input.identity.taskId,package_digest:input.packageDigest,
    context_digest:input.contextDigest,documentation_sync_id:input.documentationSyncId};
  const args=[writer,'--workflow','cm-ai','--event','run_done','--runtime','codex',
    '--project-root',input.codeProject,'--specs-dir',input.specsDir,'--run-id',input.identity.runId,
    '--detail','全部任务和文档同步已完成','--data-json',JSON.stringify(data)];
  const options={timeout:10000,maxBuffer:MiB,killSignal:'SIGKILL'};
  if(Object.hasOwn(input,'logHome')){text(input.logHome);options.env={...process.env,CM_WORKFLOW_LOG_HOME:input.logHome};}
  let result;
  try{result=childProcess.spawnSync('python3',args,options);}
  catch{try{fs.unlinkSync(prepared.temporary);}catch{}need(false,'run_log_failed');}
  if(result.error||result.status!==0||result.signal!==null||!Buffer.isBuffer(result.stdout)
    ||result.stdout.length>MiB){try{fs.unlinkSync(prepared.temporary);}catch{}need(false,'run_log_failed');}
  let receipt;
  try{receipt=readResult(result.stdout,input.identity,input.specsDir);}
  catch{try{fs.unlinkSync(prepared.temporary);}catch{}need(false,'run_finalize_unknown');}
  try {
    fs.renameSync(prepared.temporary,prepared.target);
    const directory=fs.openSync(prepared.specs,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
  } catch {
    try{fs.unlinkSync(prepared.temporary);}catch{}
    need(false,'run_finalize_unknown');
  }
  return Object.freeze({eventId:receipt.event_id,runId:receipt.run_id,
    deduplicated:receipt.deduplicated,degraded:receipt.degraded});
}
