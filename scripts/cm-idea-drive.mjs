#!/usr/bin/env node
// cm-idea 请求表（cm-idea-host.mjs handle()；host-session.mjs operationNames）：
// start / advance -> idea_interview；host.mjs interviewing 分支，人工问题或 PRD 草稿。
// finish -> idea_confirm_save；host.mjs confirming_save 分支，人工当前用户决定；宿主自己
//           以 exclusive 写法保存并回读，无驾驶员命令 runner。
// status/cancel/prepare_save: 无 host_request；host.mjs handle()。
// resume: 重放 pending.request，故按原 operation 和 checkpoint.stage 推导；
//         未知调用只接受原 callId/requestDigest/evidence 绑定的真实回执。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectCmIdeaAdmission} from './cm-idea-entry.mjs';
import {stderr,stop,readJson,loadPlanFile,requireFields,preflightAnswers,driveHost} from '../runtime/js/cm-ai/drive-core.mjs';

const HOST=fileURLToPath(new URL('./cm-idea-host.mjs',import.meta.url));
const KNOWN=new Set(['start','advance','status','cancel','prepare_save','finish','resume']);
const nonempty=x=>typeof x==='string'&&x.trim().length>0;
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function valid(ok,label){if(!ok)stop(2,`答案格式错误：${label}`);}
function main(){
  if(process.argv.length===3&&['--help','-h'].includes(process.argv[2])){
    process.stdout.write('用法: cm-idea-drive.mjs --plan PLAN.json <operation>\nPLAN: project, sessionFile, mode:create|resume, text/maturity, answers；finish 需 saveRoot、filename 和当前用户的确认答案。宿主负责真实保存与回读。\n');return;
  }
  const {plan,operation,base}=loadPlanFile({name:'cm-idea-drive.mjs',known:KNOWN});
  requireFields(plan,['project','sessionFile','mode']);
  valid(['create','resume'].includes(plan.mode),'PLAN.mode');
  const project=path.resolve(base,plan.project),skillDir=fileURLToPath(new URL('../skills/cm-idea',import.meta.url));
  let admission;try{admission=inspectCmIdeaAdmission({skillDir});}catch(error){stop(2,`cm-idea 定义无效: ${error.code??error.message}`);}
  valid(admission.workflowRoot===path.dirname(path.dirname(skillDir)),'cm-idea 定义路径');
  valid(fs.existsSync(project)&&fs.realpathSync(project)===project&&fs.statSync(project).isDirectory(),'PLAN.project');
  const sessionFile=path.resolve(base,plan.sessionFile),state=readJson(sessionFile,'恢复存档');
  if(!fs.existsSync(path.dirname(sessionFile))||fs.realpathSync(path.dirname(sessionFile))!==path.dirname(sessionFile))
    stop(2,`sessionFile 父目录不存在或不是规范路径: ${path.dirname(sessionFile)}`);
  if(plan.mode==='create'&&state!==undefined)stop(2,`新会话存档已存在: ${sessionFile}`);
  if(plan.mode==='resume'&&state===undefined)stop(2,`恢复存档不存在: ${sessionFile}`);
  if(plan.mode==='resume')valid(state.workflow==='cm-idea'&&state.binding?.cwd===project
    &&obj(state.checkpoint),'resume 存档与 project 不匹配');
  if(state?.pending&&operation!=='resume')stop(2,'恢复存档存在 pending；必须用 resume 和原调用回执，不能重派');
  const stage=state?.checkpoint?.stage??'ready';
  if(operation==='status'&&plan.mode!=='resume')stop(2,'status 需要已有会话');
  if(operation==='resume'){
    if(plan.mode!=='resume')stop(2,'resume 需要已有存档');
    if(state.pending?.writing)stop(2,'保存结果未知，不能自动恢复');
    const call=state.pending?.call,resolution=plan.resolution??null;
    if(call&&!Object.hasOwn(call,'result'))valid(obj(resolution)&&resolution.callId===call.callId
      &&resolution.requestDigest===call.requestDigest&&nonempty(resolution.evidence)
      &&Object.hasOwn(resolution,'result'),'resume 缺少原调用的真实回执');
    else valid(resolution===null,'resume 不应提供新回执');
  }
  const actualOp=operation==='resume'?(state.pending?.request?.operation??'status'):operation;
  if(actualOp==='start')valid(stage==='ready'&&nonempty(plan.text),'start 缺少 text 或阶段错误');
  if(actualOp==='advance')valid(['awaiting_user','draft_ready'].includes(stage)&&nonempty(plan.text)
    &&['L1','L2','L3'].includes(plan.maturity)
    &&(stage!=='awaiting_user'||state?.checkpoint?.draft!==null||plan.maturity==='L1'),
  'advance 缺少 text/maturity 或阶段错误');
  const saveRoot=plan.saveRoot?path.resolve(base,plan.saveRoot):null;
  if(saveRoot!==null)valid(fs.existsSync(saveRoot)&&fs.realpathSync(saveRoot)===saveRoot
    &&fs.statSync(saveRoot).isDirectory(),'saveRoot');
  if(actualOp==='prepare_save')valid(stage==='draft_ready'&&saveRoot!==null,'prepare_save 缺少 saveRoot 或草稿');
  if(actualOp==='finish'){
    valid(stage==='draft_ready'&&nonempty(plan.filename)&&/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(plan.filename),
      'finish 缺少草稿或安全的 filename');
    const root=saveRoot??state?.checkpoint?.saveRoot;
    valid(nonempty(root),'finish 缺少 saveRoot');
    valid(state?.checkpoint?.saveRoot===null||state?.checkpoint?.saveRoot===root,'finish saveRoot 与已绑定会话不符');
    const directory=path.join(root,'prd'),target=path.join(directory,plan.filename);
    valid(!fs.existsSync(directory)||fs.lstatSync(directory).isDirectory()&&!fs.lstatSync(directory).isSymbolicLink(),
      'finish 保存目录越界');
    valid(!fs.existsSync(target),'finish 目标文件已存在');
  }
  const kind=['start','advance'].includes(actualOp)?'idea_interview':actualOp==='finish'?'idea_confirm_save':null;
  const answers=plan.answers?path.resolve(base,plan.answers):null;
  const answer=preflightAnswers(kind?[kind]:[],key=>{
    const file=path.join(answers??base,key==='idea_interview'?'interview.json':'confirm-save.json');
    const value=readJson(file,key);
    if(value===undefined)stop(2,`步骤 ${operation} 会反问 ${key}，但答案文件不存在: ${file}`);
    valid(obj(value),'idea answer');
    if(key==='idea_confirm_save')valid(Object.keys(value).join(',')==='decision'
      &&['approved','rejected'].includes(value.decision),'confirm-save.json');
    else if(value.status==='question')valid(Object.keys(value).sort().join(',')==='productType,question,status'
      &&nonempty(value.question)&&(value.productType===null||['A','B','C','D','E'].includes(value.productType)),
    'interview.json question');
    else if(value.status==='draft')valid(Object.keys(value).sort().join(',')==='content,followup,maturity,productType,status'
      &&nonempty(value.content)&&nonempty(value.followup)&&['A','B','C','D','E'].includes(value.productType)
      &&value.maturity===(actualOp==='start'?'L1':plan.maturity),'interview.json draft');
    else valid(value.status==='blocked'&&Object.keys(value).sort().join(',')==='reason,status'
      &&nonempty(value.reason),'interview.json blocked');
    return value;
  });
  driveHost({host:HOST,args:['serve','--skill-dir',skillDir,'--session-file',sessionFile,
    ...(saveRoot?['--save-root',saveRoot]:[])],cwd:project,operation,
    request:{...(['start','advance'].includes(operation)?{text:plan.text}:{}),
      ...(operation==='advance'?{maturity:plan.maturity}:{}),
      ...(operation==='finish'?{filename:plan.filename}:{}),
      ...(operation==='prepare_save'?{saveRoot}:{}),
      ...(operation==='resume'?{resolution:plan.resolution??null}:{})},answers:answer,
    answerFor:row=>answer[row.kind]??null});
}
main();
