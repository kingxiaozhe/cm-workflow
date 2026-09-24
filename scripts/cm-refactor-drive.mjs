#!/usr/bin/env node
// cm-refactor 单步驾驶员。表由 cm-refactor-host.mjs -> cm-refactor/workflow.mjs
// handle/flow/invoke 与 host-session.mjs operationNames 推出；不是其它宿主的表。
// operation              possible host_request kinds                 proof
// start                  refactor_analyze, refactor_confirm(g0),     workflow.mjs flow,
//                        refactor_prepare_tests (judge setup/repair), prepareJudges,
//                        refactor_batch (batch only), refactor_apply, batchFlow,
//                        refactor_retrospective (batch/writeback/memo), writeback,
//                        refactor_review, refactor_revise_tests      review loop.
// resume                 start 的未记录部分；refactor_recover       handle resume -> flow;
//                        only for unknown host/command effects       records.mjs effect.
// finish                 若尚未 awaiting_finish 同 resume；         handle finish -> flow/finish;
//                        refactor_confirm(finish)                    finish confirm.
// prepare_judge_revision none（请求含 judgeRevision）             handle -> prepareJudgeRevision.
// status, cancel          none                                      handle status/cancel.
// baseline/judge/mutation/cheap checks 均由 workflow.mjs command/createHostCheck
// 在项目内真实执行、记录退出码；没有可从答案文件填写的命令证据。
// unknown command/host 的恢复需原调用回执，本驾驶员没有回执 runner，预检拒绝。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCmRefactorHost} from '../runtime/js/cm-refactor/host.mjs';
import {openRefactorRecords} from '../runtime/js/cm-refactor/records.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {readLearningRetrospectiveContent} from '../runtime/js/cm-ai/cm-ai-context-refresh.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {stderr,stop,readJson,loadPlanFile,requireFields,preflightAnswers,driveHost} from '../runtime/js/cm-ai/drive-core.mjs';

const HOST=fileURLToPath(new URL('./cm-refactor-host.mjs',import.meta.url));
const KNOWN=new Set(['start','resume','finish','prepare_judge_revision','status','cancel']);
const FILES={refactor_analyze:'analyze.json',refactor_confirm:'confirm.json',refactor_apply:'apply.json',
  refactor_review:'review.json',refactor_prepare_tests:'prepare-tests.json',refactor_revise_tests:'revise-tests.json',
  refactor_batch:'batch.json',refactor_retrospective:'retrospective.json'};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
const valid=(yes,label)=>{if(!yes)stop(2,`答案格式错误：${label}`);};
const ownFile=file=>fs.existsSync(file)&&fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink();
const exact=(value,keys,label)=>valid(object(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(','),label);
function content(root,local,label){
  valid(nonempty(local)&&!path.isAbsolute(local)&&!local.includes('\\')&&!local.split('/').includes('..'),`${label}.contentFile`);
  const file=path.resolve(root,local);
  valid(file.startsWith(fs.realpathSync(root)+path.sep)&&ownFile(file)&&fs.realpathSync(file)===file,`缺少安全的内容文件: ${file}`);
  valid(fs.statSync(file).size<=1024*1024,`${label}.contentFile 过大: ${file}`);
  return fs.readFileSync(file,'utf8');
}
function files(value,root,allowed,label,{deletion=false,empty=false}={}){
  valid(Array.isArray(value)&&(empty||value.length>0),`${label}.files`);
  const seen=new Set();for(const item of value){
    exact(item,['path','contentFile'],`${label}.files[]`);
    valid(allowed.includes(item.path)&&!seen.has(item.path),`${label} 越过 scope: ${item.path}`);seen.add(item.path);
    if(item.contentFile===null)valid(deletion,`${label} 不允许删除: ${item.path}`);
    else content(root,item.contentFile,`${label}.${item.path}`);
  }
}
function materialize(value,payload,root,{deletion=false}={}){
  return value.filter(item=>payload.some(file=>file.path===item.path)).map(item=>({path:item.path,beforeDigest:payload.find(file=>file.path===item.path)?.beforeDigest,
    content:item.contentFile===null&&deletion?null:content(root,item.contentFile,item.path)}));
}
function review(value,label){
  valid(object(value)&&['codex-subagent','codex-cli','claude-cli'].includes(value.reviewer)
    &&['approved','changes_requested','blocked'].includes(value.verdict)
    &&Number.isInteger(value.blocking_findings)&&value.blocking_findings>=0
    &&(value.verdict==='approved'?value.blocking_findings===0:value.blocking_findings>0)
    &&nonempty(value.body)&&nonempty(value.at)&&Number.isFinite(Date.parse(value.at))
    &&/(Z|[+-]\d\d:\d\d)$/.test(value.at),label);
  if(value.verdict==='approved')valid(/零发现|无阻塞发现|未发现阻塞|zero findings|no findings|no blocking findings/i.test(value.body),`${label}.body`);
  if(value.judgeRevision)valid(Array.isArray(value.judgeRevision.paths)&&value.judgeRevision.paths.length>0
    &&nonempty(value.judgeRevision.reason),`${label}.judgeRevision`);
  valid(Object.keys(value).every(key=>['reviewer','verdict','blocking_findings','body','at','judgeRevision'].includes(key)),label);
}
function validate(kind,value,config,root){
  if(kind==='refactor_analyze'){
    valid(object(value)&&['proceed','no_refactor'].includes(value.decision)&&nonempty(value.reason)
      &&object(value.metric)&&nonempty(value.metric.name)&&Number.isFinite(value.metric.before)
      &&nonempty(value.metric.unit)&&Array.isArray(value.impact)&&Array.isArray(value.claimedMemos)
      &&value.claimedMemos.every(nonempty),'analyze.json');
  }else if(kind==='refactor_confirm'){
    valid(object(value)&&['approved','rejected'].includes(value.g0)
      &&(!Object.hasOwn(value,'finish')||['approved','rejected'].includes(value.finish))
      &&(!Object.hasOwn(value,'rulebook')||['approved','rejected'].includes(value.rulebook)),'confirm.json');
  }else if(kind==='refactor_apply'){
    valid(object(value)&&nonempty(value.summary)&&Number.isFinite(value.metricAfter)
      &&Array.isArray(value.unfixedDefects)&&Array.isArray(value.conventions)
      &&nonempty(value.learningApplication)&&value.learningRetrospective!==undefined,'apply.json');
    files(value.files,root,config.scope,'apply.json');
    if(object(value.learningRetrospective))try{readLearningRetrospectiveContent(value.learningRetrospective);}
    catch{stop(2,'答案格式错误：apply.json.learningRetrospective');}
  }else if(kind==='refactor_review'){
    review(value,'review.json');
    if(value.judgeRevision)valid(value.judgeRevision.paths.every(name=>config.testSetup?.paths?.includes(name)),
      'review.json.judgeRevision 越过测试 scope');
  }else if(['refactor_prepare_tests','refactor_revise_tests'].includes(kind)){
    exact(value,['files'],FILES[kind]);files(value.files,root,config.testSetup?.paths??[],FILES[kind]);
  }else if(kind==='refactor_retrospective'){
    valid(object(value)&&nonempty(value.learningApplication)&&Array.isArray(value.conventions)
      &&Array.isArray(value.documentation)&&Array.isArray(value.resolved)
      &&Array.isArray(value.unfixedDefects)&&Number.isFinite(value.metricAfter),'retrospective.json');
    try{const learning=readLearningRetrospectiveContent(value.learning);
      valid(learning.status!=='writeback_pending','retrospective.json.learning');}
    catch{stop(2,'答案格式错误：retrospective.json.learning');}
    for(const item of value.documentation){
      valid(object(item)&&['README.md','CLAUDE.md'].includes(item.path)
        &&(config.writebackPaths??[]).includes(item.path),'retrospective.json.documentation 越过 scope');
      content(root,item.contentFile,`retrospective.${item.path}`);
    }
  }else if(kind==='refactor_batch'){
    valid(object(value)&&object(value.plan)&&nonempty(value.plan.rulebook)&&Array.isArray(value.plan.units)
      &&Array.isArray(value.plan.sample)&&Number.isFinite(value.plan.perFileEstimate)
      &&nonempty(value.plan.reason),'batch.json.plan');
    valid(object(value.bakeoff)&&object(value.bakeoff.guided)&&object(value.bakeoff.blind)
      &&nonempty(value.bakeoff.guided.channelId)&&nonempty(value.bakeoff.blind.channelId)
      &&value.bakeoff.guided.channelId!==value.bakeoff.blind.channelId,'batch.json.bakeoff');
    for(const item of [value.bakeoff.guided,value.bakeoff.blind]){
      files(item.files,root,config.scope,'batch.json.bakeoff',{deletion:true});
      valid(value.plan.sample.every(name=>item.files.some(file=>file.path===name)),'batch.json.bakeoff 缺少 sample 文件');
    }
    valid(object(value.adjudicate)&&nonempty(value.adjudicate.channelId)
      &&Array.isArray(value.adjudicate.decisions)&&nonempty(value.adjudicate.rulebook),'batch.json.adjudicate');
    for(const action of ['generate','assemble']){
      valid(object(value[action]),`batch.json.${action}`);
      files(value[action].files,root,action==='assemble'?config.batch.assemblyFiles:config.scope,`batch.json.${action}`,
        {deletion:true,empty:action==='assemble'&&config.batch.assemblyFiles.length===0});
    }
    valid(config.scope.filter(name=>!config.batch.assemblyFiles.includes(name)).every(name=>value.generate.files.some(file=>file.path===name)),
      'batch.json.generate 缺少 scope 文件');
    if(config.batch.assemblyFiles.length)valid(config.batch.assemblyFiles.every(name=>value.assemble.files.some(file=>file.path===name)),
      'batch.json.assemble 缺少 assembly 文件');
    valid(Array.isArray(value.generate.needs)&&nonempty(value.generate.summary)
      &&Array.isArray(value.assemble.resolved)&&object(value.diagnose)
      &&nonempty(value.diagnose.errorClass)&&nonempty(value.diagnose.reason),'batch.json actions');
  }
}
function answer(row,answers,root){
  const {kind,payload}=row,value=answers[kind];
  if(kind==='refactor_confirm')return {decision:value[payload.gate]};
  if(kind==='refactor_review'){
    const chosen=payload.attempt===2?answers.refactor_review_r2??value:value;
    const scope=payload.files.map(item=>`  - ${item.path}`).join('\n');
    const markdown=`---\nat: ${chosen.at}\nreviewer: ${chosen.reviewer}\nindependent: true\ntask: ${payload.task}\nattempt: ${payload.attempt}\nround: ${payload.attempt}\nverdict: ${chosen.verdict}\nblocking_findings: ${chosen.blocking_findings}\nhandoff: ${path.basename(payload.handoff)}\nhandoff_sha256: ${payload.handoffSha256}\nscope:\n${scope}\n---\n\n${chosen.body}\n`;
    return {markdown,...(chosen.judgeRevision?{judgeRevision:chosen.judgeRevision}:{})};
  }
  if(['refactor_prepare_tests','refactor_revise_tests'].includes(kind))return {files:materialize(value.files,payload.assets,root)};
  if(kind==='refactor_apply')return {...value,files:materialize(value.files,payload.files,root)};
  if(kind==='refactor_batch'){
    const selected=payload.action==='bakeoff'?value.bakeoff[payload.variant]:value[payload.action];
    if(!selected)return null;
    if(['bakeoff','generate','assemble'].includes(payload.action))return {...selected,files:materialize(selected.files,payload.files,root,{deletion:true})};
    return selected;
  }
  if(kind==='refactor_retrospective')return {...value,documentation:value.documentation.map(item=>({
    path:item.path,beforeDigest:payload.files.find(file=>file.path===item.path)?.beforeDigest,
    content:content(root,item.contentFile,`retrospective.${item.path}`)}))};
  return value??null;
}
function main(){
  if(process.argv.length===3&&['--help','-h'].includes(process.argv[2])){
    process.stdout.write('用法: cm-refactor-drive.mjs --plan PLAN.json <start|resume|finish|prepare_judge_revision|status|cancel>\nPLAN: config, answers；prepare_judge_revision 另需 judgeRevision。命令由宿主执行。\n');return;
  }
  const {operation,plan,base}=loadPlanFile({name:'cm-refactor-drive.mjs',known:KNOWN});
  requireFields(plan,['config']);
  const configPath=path.resolve(base,plan.config),config=readJson(configPath,'宿主配置');
  if(config===undefined)stop(2,`宿主配置不存在: ${configPath}`);
  valid(ownFile(configPath)&&fs.statSync(configPath).size<=64*1024,'宿主配置文件');
  const root=fileURLToPath(new URL('..',import.meta.url));
  valid(config.skillDir===path.join(root,'skills/cm-refactor'),'config.skillDir 必须指向当前 checkout');
  try{createCmRefactorHost(config,{call:()=>{throw Error('preflight must not call host')}});}
  catch(error){stop(2,`宿主配置无效: ${error.code??error.message}`);}
  for(const [label,command] of [['judgeCommand',config.judgeCommand],...(config.baselineCommands??[]).map(item=>[item.id,item.command]),
    ...(config.batch?.cheapCommands??[]).map(item=>[item.id,item.command.map(arg=>arg.replaceAll('{file}',config.scope[0]))])]){
    try{createHostCheck({cwd:config.project,commands:[{id:label,command}]});}
    catch(error){stop(2,`命令定义无效 ${label}: ${error.code??error.message}`);}
  }
  for(const mutation of config.mutations){valid(config.scope.includes(mutation.path)&&nonempty(mutation.find)
    &&typeof mutation.replace==='string'&&mutation.find!==mutation.replace,`config.mutations: ${mutation.path}`);}
  const directory=path.join(config.specs??path.join(config.project,'docs'),'refactors',config.slug);
  let records;try{records=openRefactorRecords(directory);}catch(error){stop(2,`恢复记录无效: ${error.code??error.message}`);}
  if(operation==='start'&&records.context)stop(2,`start 已有运行记录，请用 resume: ${path.join(directory,'execution.jsonl')}`);
  if(['resume','finish','prepare_judge_revision'].includes(operation)&&!records.context)
    stop(2,`恢复记录不存在: ${path.join(directory,'execution.jsonl')}`);
  if(records.context&&records.context.configDigest!==digest(config))stop(2,'resume 配置绑定不匹配');
  if(['resume','finish','prepare_judge_revision'].includes(operation))for(const [key,entry] of records.effects)
    if(['host','command'].includes(entry.kind)&&!Object.hasOwn(entry,'result'))
      stop(2,`缺少原执行回执 runner: ${entry.kind} ${key}；不能从静态答案文件恢复`);
  if(operation==='prepare_judge_revision'){
    requireFields(plan,['judgeRevision']);
    valid(object(plan.judgeRevision)&&Array.isArray(plan.judgeRevision.paths)&&plan.judgeRevision.paths.length>0
      &&plan.judgeRevision.paths.every(name=>config.testSetup?.paths?.includes(name))
      &&nonempty(plan.judgeRevision.reason),'judgeRevision 越过测试 scope');
  }
  const answerRoot=plan.answers?path.resolve(base,plan.answers):null;
  const batch=Boolean(config.batch)||config.scope.length>3||config.crossModule
    ||config.scope.some(name=>!fs.existsSync(path.join(config.project,name)));
  const asks=[];
  if(['start','resume'].includes(operation)||operation==='finish'&&records.progress?.stage!=='awaiting_finish'){
    asks.push('refactor_analyze','refactor_confirm');
    if(config.testSetup?.paths?.length)asks.push('refactor_prepare_tests');
    if(batch)asks.push('refactor_batch');else asks.push('refactor_apply');
    asks.push('refactor_review');
  }
  if(operation==='finish'&&records.progress?.stage==='awaiting_finish')asks.push('refactor_confirm');
  const answers=preflightAnswers(asks,kind=>{
    const file=path.join(answerRoot??'',FILES[kind]);
    if(!answerRoot||!ownFile(file))stop(2,`步骤 ${operation} 会反问 ${kind}，但答案文件不存在: ${file}`);
    const value=readJson(file,kind);validate(kind,value,config,answerRoot);return value;
  });
  if(answers.refactor_analyze?.claimedMemos?.length||batch||config.writebackPaths?.length){
    if(!answers.refactor_retrospective&&asks.length){
      const file=path.join(answerRoot??'',FILES.refactor_retrospective);
      if(!answerRoot||!ownFile(file))stop(2,`步骤 ${operation} 会反问 refactor_retrospective，但答案文件不存在: ${file}`);
      answers.refactor_retrospective=readJson(file,'refactor_retrospective');
      validate('refactor_retrospective',answers.refactor_retrospective,config,answerRoot);
    }
  }
  if(answers.refactor_review?.judgeRevision){
    const file=path.join(answerRoot,FILES.refactor_revise_tests);
    if(!ownFile(file))stop(2,`步骤 ${operation} 会反问 refactor_revise_tests，但答案文件不存在: ${file}`);
    answers.refactor_revise_tests=readJson(file,'refactor_revise_tests');
    validate('refactor_revise_tests',answers.refactor_revise_tests,config,answerRoot);
  }
  if(answers.refactor_review?.verdict==='changes_requested'){
    const file=path.join(answerRoot,'review-r2.json');
    if(!ownFile(file))stop(2,`步骤 ${operation} 可能反问第二轮 refactor_review，但答案文件不存在: ${file}`);
    answers.refactor_review_r2=readJson(file,'refactor_review_r2');review(answers.refactor_review_r2,'review-r2.json');
    valid(answers.refactor_review_r2.verdict!=='changes_requested','review-r2.json 第二轮须 approved 或 blocked');
  }
  if(batch&&answers.refactor_confirm&&!answers.refactor_confirm.rulebook)
    stop(2,'步骤可能反问 refactor_confirm(rulebook)，但 confirm.json.rulebook 缺失');
  if(operation==='finish'&&answers.refactor_confirm&&!answers.refactor_confirm.finish)
    stop(2,'步骤 finish 会反问 refactor_confirm(finish)，但 confirm.json.finish 缺失');
  if(operation==='start'&&answers.refactor_confirm?.g0==='approved'&&!answers.refactor_review)
    stop(2,'步骤 start 会反问 refactor_review，但 review.json 缺失');
  stderr(`预检通过：${operation}`);
  driveHost({host:HOST,args:['serve','--config',configPath],cwd:config.project,operation,
    request:operation==='prepare_judge_revision'?{judgeRevision:plan.judgeRevision}:{},answers,paths:{},
    answerFor:row=>answer(row,answers,answerRoot)});
}
main();
