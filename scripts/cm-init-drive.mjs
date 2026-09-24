#!/usr/bin/env node
// cm-init 请求表（cm-init-host.mjs handle()/generateCmInitRules()，host-session.mjs operationNames）：
// start -> init_analyze (host.mjs ready 分支)。
// advance @ ready/analysis_ready -> init_generate (host.mjs generating -> cm-init/draft-generation.mjs)。
// advance @ draft_generated -> init_verify (host.mjs verifying)。
// advance @ confirmation_required -> init_confirm (host.mjs confirming；只接受当前用户决定)。
// advance @ review_required -> init_review (host.mjs reviewing；人工独立审查结论)。
// advance @ reviewed_draft -> init_write (host.mjs writing；本驾驶员按审查过的 documents 真写磁盘并回报)。
// status/cancel/final_review_package/prepare_revision: 无 host_request；resume 重放原操作，
// 其请求种类由 pending.request.operation 与 checkpoint.stage 决定。host.mjs handle()。
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inspectCmInitAdmission} from './cm-init-entry.mjs';
import {validateCmInitSelection,cmInitRuleTargets} from '../runtime/js/cm-init/draft-generation.mjs';
import {inspectCmInitDraft,readCmInitSource} from '../runtime/js/cm-init/draft-inspection.mjs';
import {reviewResultForPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {stderr,stop,readJson,loadPlanFile,requireFields,preflightAnswers,driveHost} from '../runtime/js/cm-ai/drive-core.mjs';

const HOST=fileURLToPath(new URL('./cm-init-host.mjs',import.meta.url));
const KNOWN=new Set(['start','advance','status','cancel','final_review_package','prepare_revision','resume']);
const names={init_analyze:'analyze.json',init_generate:'generate.json',init_verify:'verify.json',
  init_confirm:'confirm.json',init_review:'review.json'};
const categories=['commands','globs','file_references','constraint_preservation','rule_applicability'];
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const nonempty=x=>typeof x==='string'&&x.trim().length>0;
function valid(ok,label){if(!ok)stop(2,`答案格式错误：${label}`);}
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
function contentFile(root,local,label){
  valid(nonempty(local)&&!path.isAbsolute(local)&&!local.split(/[\\/]/).includes('..'),label);
  const target=path.join(root,local);
  valid(fs.existsSync(target)&&fs.lstatSync(target).isFile()&&!fs.lstatSync(target).isSymbolicLink()
    &&fs.realpathSync(target).startsWith(fs.realpathSync(root)+path.sep),`${label} 缺少安全的内容文件 ${target}`);
  return fs.readFileSync(target,'utf8');
}
function stageKind(stage,operation){
  if(operation==='start')return 'init_analyze';
  if(operation!=='advance')return null;
  return {ready:'init_generate',analysis_ready:'init_generate',draft_generated:'init_verify',
    confirmation_required:'init_confirm',review_required:'init_review',reviewed_draft:'init_write'}[stage]??null;
}
function validate(kind,value,{project,selection,checkpoint,answers,hostContext}){
  if(kind==='init_analyze'){
    valid(obj(value)&&['analyzed','blocked'].includes(value.status),'analyze.json');
    if(value.status==='blocked'){valid(Object.keys(value).sort().join(',')==='reason,status'&&nonempty(value.reason),'analyze.json');return value;}
    valid(Object.keys(value).sort().join(',')==='evidence,noGitDecision,selection,status'&&nonempty(value.evidence),'analyze.json');
    try{validateCmInitSelection(value.selection);}catch{valid(false,'analyze.json.selection');}
    valid(value.selection.versionControl==='none'?value.noGitDecision==='explicit_user_refusal':value.noGitDecision===null,'analyze.json.noGitDecision');
    return value;
  }
  if(kind==='init_generate'){
    valid(obj(value)&&['generated','blocked'].includes(value.status),'generate.json');
    if(value.status==='blocked'){valid(Object.keys(value).sort().join(',')==='reason,status'&&nonempty(value.reason),'generate.json');return {status:'blocked'};}
    valid(Object.keys(value).sort().join(',')==='documents,status'&&Array.isArray(value.documents),'generate.json');
    const targets=cmInitRuleTargets(selection,project);
    valid(value.documents.length===targets.length&&new Set(value.documents.map(x=>x.path)).size===targets.length,'generate.json.documents');
    const docs=value.documents.map(row=>{
      valid(obj(row)&&Object.keys(row).sort().join(',')==='contentFile,path'&&targets.includes(row.path),`generate.json.documents ${row.path}`);
      return {path:row.path,content:contentFile(answers,row.contentFile,`generate.json ${row.path}`)};
    });
    let inspection;try{inspection=inspectCmInitDraft({project,documents:docs,selection});}
    catch(error){stop(2,`generate.json.documents 无效: ${error.code??error.message}`);}
    valid(inspection.status==='structurally_checked',`generate.json.documents ${inspection.issues.map(x=>x.path+':'+x.code).join(', ')}`);
    return {status:'generated',documents:docs};
  }
  if(kind==='init_verify'){
    valid(obj(value)&&Object.keys(value).sort().join(',')==='checks,constraintChanges'
      &&obj(value.checks)&&Object.keys(value.checks).sort().join(',')===categories.slice().sort().join(',')
      &&Array.isArray(value.constraintChanges)&&new Set(value.constraintChanges).size===value.constraintChanges.length
      &&value.constraintChanges.every(x=>checkpoint.result.inspection.existingChangeReviewRequired.includes(x)),'verify.json');
    for(const item of Object.values(value.checks))valid(obj(item)&&Object.keys(item).sort().join(',')==='evidence,status'
      &&['verified','not_applicable','unverified','failed'].includes(item.status)&&nonempty(item.evidence),'verify.json.checks');
    return value;
  }
  if(kind==='init_confirm'){
    valid(obj(value)&&Object.keys(value).join(',')==='decision'&&['approved','rejected'].includes(value.decision),'confirm.json');return value;
  }
  if(kind==='init_review'){
    valid(obj(value)&&Object.keys(value).sort().join(',')==='at,contextId,independent,result,reviewer'
      &&['codex-subagent','codex-cli','claude-cli'].includes(value.reviewer)
      &&nonempty(value.contextId)&&value.contextId!==hostContext
      &&!checkpoint.authorContexts.includes(value.contextId)&&value.independent===true
      &&nonempty(value.at)&&new Date(value.at).toISOString()===value.at,'review.json');
    const result=value.result,paths=checkpoint.result.documents.map(x=>x.path).sort();
    valid(obj(result)&&Object.keys(result).sort().join(',')==='findings,summary,verdict','review.json.result');
    try{reviewResultForPaths({...result,packageDigest:'0'.repeat(64),examinedPaths:paths},
      {packageDigest:'0'.repeat(64)},paths);}catch(error){valid(false,`review.json.result ${error.code??error.message}`);}
    return value;
  }
  return value;
}
function main(){
  if(process.argv.length===3&&['--help','-h'].includes(process.argv[2])){
    process.stdout.write('用法: cm-init-drive.mjs --plan PLAN.json <operation>\nPLAN: project, sessionFile, mode:create|resume, hostContext, resume 时 originalHostContext；advance 首轮填 selection；answers 存人工分析、草稿、核验、决定和审查。allowWrite:true 时按审查草稿实际写文件。\n');return;
  }
  const {plan,operation,base}=loadPlanFile({name:'cm-init-drive.mjs',known:KNOWN});
  requireFields(plan,['project','sessionFile','mode','hostContext']);
  valid(['create','resume'].includes(plan.mode)&&nonempty(plan.hostContext),'PLAN.mode/hostContext');
  const project=path.resolve(base,plan.project),skillDir=path.join(path.dirname(HOST),'..','skills','cm-init');
  let admission;try{admission=inspectCmInitAdmission({project,skillDir});}catch(error){stop(2,`cm-init 项目或定义无效: ${error.code??error.message}`);}
  if(admission.status!=='ready')stop(2,'cm-init 项目缺少已有内容');
  const sessionFile=path.resolve(base,plan.sessionFile),state=readJson(sessionFile,'恢复存档');
  if(!fs.existsSync(path.dirname(sessionFile))||fs.realpathSync(path.dirname(sessionFile))!==path.dirname(sessionFile))
    stop(2,`sessionFile 父目录不存在或不是规范路径: ${path.dirname(sessionFile)}`);
  if(plan.mode==='create'&&state!==undefined)stop(2,`新会话存档已存在: ${sessionFile}`);
  if(plan.mode==='resume'&&state===undefined)stop(2,`恢复存档不存在: ${sessionFile}`);
  if(plan.mode==='resume'){
    valid(nonempty(plan.originalHostContext),'resume 缺少 originalHostContext');
    valid(state.workflow==='cm-init'&&obj(state.checkpoint)&&state.checkpoint.authorContextId===plan.originalHostContext,
      'resume 存档与 originalHostContext 不匹配');
  }
  const checkpoint=state?.checkpoint??{stage:'ready',authorContexts:[plan.hostContext]},stage=checkpoint.stage;
  if(operation==='start'&&stage!=='ready')stop(2,`start 只能从 ready 开始，当前 ${stage}`);
  if(operation==='advance'&&!['ready','analysis_ready','draft_generated','confirmation_required','review_required','reviewed_draft'].includes(stage))
    stop(2,`advance 当前阶段不能继续: ${stage}`);
  if(['status','final_review_package'].includes(operation)&&plan.mode!=='resume')stop(2,`${operation} 需要已有会话`);
  if(state?.pending&&operation!=='resume')stop(2,'恢复存档存在 pending；必须用 resume 和原调用回执，不能重派');
  if(operation==='resume'){
    if(plan.mode!=='resume')stop(2,'resume 需要已有存档');
    if(state.pending?.writing)stop(2,'写入结果未知，不能自动恢复');
    const call=state.pending?.call,resolution=plan.resolution??null;
    if(call&&!Object.hasOwn(call,'result')){
      valid(obj(resolution)&&resolution.callId===call.callId&&resolution.requestDigest===call.requestDigest
        &&nonempty(resolution.evidence)&&Object.hasOwn(resolution,'result'),'resume 缺少原调用的真实回执');
    }else valid(resolution===null,'resume 不应提供新回执');
  }
  let selection=checkpoint.selection;
  if(stage==='ready'&&operation==='advance'){
    try{selection=validateCmInitSelection(plan.selection);}catch{stop(2,'advance 缺少有效 PLAN.selection');}
  }
  const actualOp=operation==='resume'?(state.pending?.request?.operation??'status'):operation;
  const kind=stageKind(stage,actualOp);
  if(operation==='prepare_revision'){
    valid(['verification_blocked','review_changes_requested','review_blocked'].includes(stage),'prepare_revision 阶段');
    valid(Array.isArray(plan.documents)&&plan.documents.length===checkpoint.result?.documents?.length
      &&new Set(plan.documents.map(x=>x?.path)).size===plan.documents.length
      &&plan.documents.every(x=>checkpoint.result.documents.some(y=>y.path===x?.path)),
    'prepare_revision 文档范围越界');
    let inspected;try{inspected=inspectCmInitDraft({project,documents:plan.documents,selection});}
    catch(error){stop(2,`prepare_revision 文档格式错误: ${error.code??error.message}`);}
    valid(inspected.status==='structurally_checked','prepare_revision 草稿无效');
  }
  if(kind==='init_write'){
    if(plan.allowWrite!==true)stop(2,'步骤 advance 会反问 init_write，但 PLAN.allowWrite 缺少真实写入授权与 runner');
    valid(checkpoint.result?.inspection?.status==='structurally_checked','init_write 审查草稿缺失');
    for(const change of checkpoint.result.inspection.changes){
      const before=readCmInitSource(project,change.path);
      valid((before===null?null:sha(before))===change.beforeSha256,`init_write 原文件已变化: ${change.path}`);
    }
  }
  const answers=plan.answers?path.resolve(base,plan.answers):null;
  const answer=preflightAnswers(kind&&names[kind]?[kind]:[],key=>{
    const file=path.join(answers??base,names[key]),value=readJson(file,key);
    if(value===undefined)stop(2,`步骤 ${operation} 会反问 ${key}，但答案文件不存在: ${file}`);
    return validate(key,value,{project,selection,checkpoint,answers,hostContext:plan.hostContext});
  });
  driveHost({host:HOST,args:['serve','--skill-dir',skillDir,'--project',project,'--host-context',plan.hostContext,
    ...(plan.allowWrite===true?['--allow-write']:[]),'--session-file',sessionFile],cwd:project,operation,
    request:{...(operation==='advance'&&stage==='ready'?{selection}:{}),
      ...(operation==='prepare_revision'?{documents:plan.documents}:{}),
      ...(operation==='resume'?{resolution:plan.resolution??null}:{})},answers:answer,
    answerFor:row=>{
      if(row.kind==='init_review'){
        const value=answer.init_review,pkg=row.payload.package;
        return {...value,result:{...value.result,packageDigest:pkg.packageDigest,examinedPaths:pkg.examinedPaths}};
      }
      if(row.kind==='init_write'){
        if(kind!=='init_write')return null;
        const expected=checkpoint.result.inspection.changes.filter(x=>x.action!=='unchanged');
        if(JSON.stringify(row.payload.expected)!==JSON.stringify(expected))return null;
        const docs=checkpoint.result.documents.filter(x=>expected.some(y=>y.path===x.path));
        if(JSON.stringify(row.payload.documents)!==JSON.stringify(docs))return null;
        for(const change of expected){
          const before=readCmInitSource(project,change.path);
          if((before===null?null:sha(before))!==change.beforeSha256)return {status:'blocked'};
          const document=docs.find(x=>x.path===change.path),target=path.join(project,change.path);
          fs.mkdirSync(path.dirname(target),{recursive:true});
          if(fs.realpathSync(path.dirname(target))!==path.dirname(target))return {status:'blocked'};
          const flags=before===null?fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW
            :fs.constants.O_WRONLY|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW;
          const fd=fs.openSync(target,flags,0o600);
          try{fs.writeFileSync(fd,document.content);}finally{fs.closeSync(fd);}
          stderr(`实际写入 ${change.path}`);
        }
        return {status:'written'};
      }
      return answer[row.kind]??null;
    }});
}
main();
