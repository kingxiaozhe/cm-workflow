// Commander phase 2: checks run before a job is dispatched, for the failures the
// aihot reopen record showed were knowable in advance and that neither the
// driver's own preflight nor cm-start-check catches yet:
//   - a develop answer over a bound (application.note, retrospective fields)
//     that the host would refuse only after dispatch;
//   - a develop answer that changes nothing, which the runner only reports as
//     develop_empty_changes after the delivery and checks have run;
//   - a simulator already held by another registered job, or one check that
//     drives several simulators in parallel;
//   - resume checks that differ from the checks recorded for the reviewed
//     package, which completion refuses as a package mismatch.
// Every function here only reads; a finding is advice, the runner stays the authority.
import fs from 'node:fs';
import path from 'node:path';
import {createCmAiTaskLearningApplication,createCmAiTaskLearningRetrospective} from '../cm-ai/cm-ai-context-refresh.mjs';

const finding=(level,code,message,extra={})=>({level,code,message,...extra});
const fileBytes=file=>{try{return fs.readFileSync(file);}catch{return null;}};

// The answer bounds, applied with the same constructors the host uses. The
// binding is a stand-in: only the answer's own fields are being judged.
export function answerValueFindings(answer,{feature,identity}){
  if(answer?.status!=='succeeded'||answer.value?.outcome!=='implemented')return [];
  const binding={feature,identity:{...identity,attempt:identity.attempt??1},learningDigest:'0'.repeat(64)};
  const findings=[];
  for(const [part,make] of [['application',createCmAiTaskLearningApplication],['retrospective',createCmAiTaskLearningRetrospective]]){
    if(!Object.hasOwn(answer.value,part))continue;
    try{make({...binding,...answer.value[part]});}
    catch(error){
      const note=answer.value.application?.note;
      const detail=part==='application'&&typeof note==='string'&&note.length>512
        ?`application.note 有 ${note.length} 个字符（UTF-16 计，emoji 算 2），上限 512`:`${part} 不符合宿主的字段与长度规则（${error.code??error.message}）`;
      findings.push(finding('error','develop_answer_invalid',`开发应答会在派出后被判无效：${detail}。先改应答再派活`,{part}));
    }
  }
  return findings;
}

// Each edit compared with the code root as it is now. Only when every edit is a
// no-op is the whole answer reported: a partial no-op is still a delivery.
export function answerChangeFindings(answer,{answersDir,codeProject}){
  const edits=answer?.status==='succeeded'?answer.edits:null;
  if(edits===null||typeof edits!=='object'||Array.isArray(edits))return [];
  // A lesson candidate's Learning writeback changes AGENTS.md, so even an answer
  // with no code edit is a delivery (cm-ai-develop-driver-gaps, lesson-only).
  if(answer.value?.retrospective?.status==='lesson_candidate')return [];
  const entries=Object.entries(edits);
  if(!entries.length)return [finding('error','develop_no_change','开发应答没有任何 edits；交付后会是 develop_empty_changes，白跑一轮')];
  const unchanged=entries.every(([target,entry])=>{
    const file=path.join(codeProject,target),current=fileBytes(file);
    if(typeof entry==='string'||typeof entry?.file==='string'){
      const source=fileBytes(path.join(answersDir,typeof entry==='string'?entry:entry.file));
      if(current===null||source===null||!current.equals(source))return false;
      if(typeof entry?.mode!=='string')return true;
      try{return (fs.statSync(file).mode&0o777)===Number.parseInt(entry.mode,8);}catch{return false;}
    }
    if(entry?.delete===true)return current===null;
    if(typeof entry?.mode==='string'){try{return (fs.statSync(file).mode&0o777)===Number.parseInt(entry.mode,8);}catch{return false;}}
    return false;
  });
  return unchanged?[finding('error','develop_no_change',
    `开发应答的 ${entries.length} 处改动与代码根现状完全相同；交付后会是 develop_empty_changes，白跑一轮。确认应答写的是新内容`)]:[];
}

// Simulators named in check commands: only where a device is addressed — an
// xcodebuild -destination with id=, or a simctl subcommand's device argument —
// so an unrelated UUID (a record id, a request id) is never taken for one. The
// text form also covers commands wrapped in sh -c.
const DESTINATION=/-destination\s+["']?[^"'\n]*?\bid=([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/gi;
const SIMCTL=/\bsimctl\s+[a-z-]+\s+(?:[a-z-]+\s+)?([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\b/gi;
export function checkDevices(checks){
  const devices=new Set(),parallel=[],multiple=[];
  for(const check of Array.isArray(checks)?checks:[]){
    const tokens=Array.isArray(check?.command)?check.command.filter(token=>typeof token==='string'):[];
    const text=tokens.join(' '),own=new Set();
    for(const pattern of [DESTINATION,SIMCTL])for(const match of text.matchAll(pattern))own.add(match[1].toUpperCase());
    own.forEach(id=>devices.add(id));
    const workers=tokens.indexOf('-parallel-testing-worker-count'),enabled=tokens.indexOf('-parallel-testing-enabled');
    const destinations=(text.match(/-destination\b/g)??[]).length;
    if(own.size>1||(workers>=0&&Number(tokens[workers+1])>1)||(enabled>=0&&/^(YES|true|1)$/i.test(tokens[enabled+1]??'')))parallel.push(check.id??'?');
    else if(destinations>1)multiple.push(check.id??'?');
  }
  return {devices:[...devices],parallel,multiple};
}

export function deviceFindings(checks,openJobs,{runId=null}={}){
  const {devices,parallel,multiple}=checkDevices(checks),findings=[];
  for(const device of devices){
    const holders=openJobs.filter(job=>job.resources.some(resource=>resource.toUpperCase()===`DEVICE:${device}`)&&!(runId&&job.runId===runId));
    if(holders.length)findings.push(finding('error','device_busy',
      `模拟器 ${device} 正被已登记的活占用：${holders.map(job=>job.label).join('、')}。等它结束（dispatch done）再派，避免两边检查互相干扰`,{device}));
  }
  if(parallel.length)findings.push(finding('warn','parallel_simulators',
    `检查 ${parallel.join('、')} 明确会同时驱动多台模拟器（并行参数或多台设备）；负载高时容易超时。改成单台串行，或拆成多次检查`,{ids:parallel}));
  if(multiple.length)findings.push(finding('warn','multiple_destinations',
    `检查 ${multiple.join('、')} 给了多个目的地，是否并行要看 xcodebuild 版本与参数；负载高时同样容易超时，确认是有意为之`,{ids:multiple}));
  return findings;
}

// The checks a resume would send against the checks the reviewed package was
// built with. Ids and commands must match exactly, in order.
export function checksDriftFindings(planChecks,recordedChecks){
  if(!Array.isArray(recordedChecks)||!recordedChecks.length||!Array.isArray(planChecks))return [];
  const shape=list=>JSON.stringify(list.map(check=>({id:check?.id??null,command:check?.command??null})));
  return shape(planChecks)===shape(recordedChecks)?[]:[finding('error','checks_changed_since_review',
    '本 PLAN 的检查（id 与命令）与已审查交付记录的检查不一致；完成时会被判包不匹配。PLAN.checks 应原样沿用交审时的那一组')];
}
