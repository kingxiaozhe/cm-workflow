#!/usr/bin/env node
// Standalone runtime preferences; never mutates an existing run or dispatches AI.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ConfigError,findConfig,loadConfig,readConfigText,parseUserRuntimes,
  userRuntimesPath,runtimePreset,RUNTIME_PRESETS,resolveRole,runtimesSource,
  CONFIG_FILENAMES,previewUserRuntimeConfig} from './cm-workflow-config.mjs';
import {editRuntimeDeclaration} from './cm-runtime-edit.mjs';
import {runtimeLanguage,runtimeText as t} from './cm-runtime-i18n.mjs';
import {askRuntimePreset,runtimeQuestions,PromptCancelled} from './cm-runtime-install.mjs';
export {askRuntimePreset} from './cm-runtime-install.mjs';
import {probeRuntimes} from './cm-failover.mjs';

const scripts=path.dirname(fileURLToPath(import.meta.url));
function stat(file){try{return fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function safeTarget(file){
  const parent=path.dirname(file),dir=stat(parent),target=stat(file);
  if(dir&&(dir.isSymbolicLink()||!dir.isDirectory()))throw new ConfigError(`refusing non-directory or symlink parent: ${parent}`);
  if(target&&(target.isSymbolicLink()||!target.isFile()))throw new ConfigError(`refusing non-file or symlink target: ${file}`);
}
export function atomicRuntimeWrite(file,text,{before=null,privateFile=false}={}){
  safeTarget(file);
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=path.join(path.dirname(file),`.runtimes-${randomUUID()}.tmp`);
  try{
    fs.writeFileSync(temporary,text,{flag:'wx',mode:privateFile?0o600:(stat(file)?.mode??0o644)&0o777});
    safeTarget(file);
    const current=stat(file)?fs.readFileSync(file):null;
    if(before===null?current!==null:current===null||!current.equals(before))throw new ConfigError('configuration changed during edit; retry from current file');
    fs.renameSync(temporary,file);
  }finally{if(stat(temporary))fs.unlinkSync(temporary);}
}
function userRuntimeText(preset,lang){
  const declaration=runtimePreset(preset);
  const text=`# ${t('comment',lang)}\nruntimes: {available: ${declaration.runtimes.available}}\npreset: ${preset}\n`;
  parseUserRuntimes(text);return text;
}
export function writeUserRuntime(preset,{lang=runtimeLanguage(),preview}={}){
  if(preview){
    if(preview.scope!=='user'||preview.preset!==preset)throw new ConfigError('runtime preview does not match requested preset/scope');
    return applyRuntimePreview(preview);
  }
  const text=userRuntimeText(preset,lang),file=userRuntimesPath();safeTarget(file);
  atomicRuntimeWrite(file,text,{before:stat(file)?fs.readFileSync(file):null,privateFile:true});
  return file;
}
function projectDirectory(raw){
  const root=fs.realpathSync(path.resolve(raw));
  if(!fs.statSync(root).isDirectory())throw new ConfigError('project must be a directory');
  return root;
}
function prepareProjectRuntime(project,preset){
  const root=projectDirectory(project),declaration=runtimePreset(preset);
  // Reject broken links/directories too, even though findConfig only finds files.
  for(const name of CONFIG_FILENAMES)safeTarget(path.join(root,name));
  const existing=findConfig(root),file=existing??path.join(root,'.cm-workflow.yml');
  const before=existing?fs.readFileSync(file):null;
  const original=readConfigText(existing??path.join(scripts,'../templates/cm-workflow.yml'));
  loadConfig({projectRoot:root,configPath:file,text:original});
  const text=editRuntimeDeclaration(original,file,declaration);
  const effective=loadConfig({projectRoot:root,configPath:file,text});
  return {file,text,before,effective};
}
export function setProjectRuntime(project,preset){
  const {file,text,before}=prepareProjectRuntime(project,preset);
  atomicRuntimeWrite(file,text,{before});return file;
}
function describeRuntime(config,{runtime=process.env.CM_RUNTIME||'codex',lang=runtimeLanguage()}={}){
  const preset=Object.keys(RUNTIME_PRESETS).find(name=>{
    const value=runtimePreset(name);
    return config.runtimes.available===value.runtimes.available
      &&['coder','reviewer'].every(role=>['adapter','source'].every(field=>config.roles[role][field]===value.roles[role][field]));
  })??(runtimesSource(config)==='none'?'none':'custom');
  const lines=[`runtimes.available: ${config.runtimes.available}`,`preset: ${preset}`,`runtimes_source: ${runtimesSource(config)}`];
  for(const role of ['coder','reviewer']){
    const resolved=resolveRole(config,role,runtime);
    lines.push(`${role}: adapter=${resolved.adapter} source=${resolved.source} model=${resolved.model} route_state=${resolved.route_state}${resolved.route_state==='declared-adapter'?t('declared',lang):''}`);
  }
  return lines.join('\n');
}
export function showRuntime(project,{runtime=process.env.CM_RUNTIME||'codex',probe=probeRuntimes,lang=runtimeLanguage()}={}){
  const config=loadConfig({projectRoot:project}),source=runtimesSource(config);
  const file=source==='user'?userRuntimesPath():source==='project'?findConfig(project):null;
  const lines=[describeRuntime(config,{runtime,lang}),`declaration_file: ${file??t('builtin',lang)}`];
  const wanted=config.runtimes.available==='both'?['codex','claude']:config.runtimes.available==='unknown'?[]:[config.runtimes.available];
  for(const result of probe(wanted))lines.push(result.available
    ?t('cli',lang,{runtime:result.runtime})
    :t('warning',lang,{available:config.runtimes.available,runtime:result.runtime}));
  return lines.join('\n');
}
const previewPlans=new WeakMap();
const sha256=value=>createHash('sha256').update(value).digest('hex');
function snapshot(file){safeTarget(file);return {file,before:stat(file)?Buffer.from(readConfigText(file)):null};}
function assertSnapshots(snapshots,lang){
  for(const {file,before} of snapshots){
    safeTarget(file);const current=stat(file)?fs.readFileSync(file):null;
    if(before===null?current!==null:current===null||!current.equals(before))throw new ConfigError(t('drift',lang,{file}));
  }
}
const runtimeFields=config=>({
  'runtimes.available':config.runtimes.available,
  ...Object.fromEntries(['coder','reviewer'].flatMap(role=>['adapter','source'].map(field=>[`roles.${role}.${field}`,config.roles[role][field]]))),
});
// null project is the installer: preview user defaults only, with no incidental cwd project.
export function prepareRuntimePreview(project,preset,{user=false,lang=runtimeLanguage()}={}){
  runtimePreset(preset);
  if(project===null&&!user)throw new ConfigError('project is required for a project preview');
  const root=project===null?null:projectDirectory(project),snapshots=root?CONFIG_FILENAMES.map(name=>snapshot(path.join(root,name))):[];
  let current=root?loadConfig({projectRoot:root}):null;
  const userFile=userRuntimesPath();
  if(user||current&&runtimesSource(current)!=='project')snapshots.push(snapshot(userFile));
  if(root)current=loadConfig({projectRoot:root});
  let candidate,changes;
  if(user){
    const previous=snapshots.find(item=>item.file===userFile).before;
    const old=previous===null?null:parseUserRuntimes(previous.toString('utf8'));
    candidate={file:userFile,before:previous,text:userRuntimeText(preset,lang),
      effective:root?previewUserRuntimeConfig({projectRoot:root},preset):null};
    changes=[{field:'runtimes.available',before:old?.runtimes.available??null,after:runtimePreset(preset).runtimes.available},
      {field:'preset',before:old?.preset??null,after:preset}];
  }else{
    if(!findConfig(root))snapshots.push(snapshot(path.join(scripts,'../templates/cm-workflow.yml')));
    candidate=prepareProjectRuntime(root,preset);
    const before=runtimeFields(current),after=runtimeFields(runtimePreset(preset));
    changes=Object.keys(after).map(field=>({field,before:before[field],after:after[field]}));
  }
  assertSnapshots(snapshots,lang);
  const report={scope:user?'user':'project',project:root,target:candidate.file,preset,creates_file:candidate.before===null,changes,
    current:current?describeRuntime(current,{lang}):null,effective:candidate.effective?describeRuntime(candidate.effective,{lang}):null,
    project_overrides_user:user&&current!==null&&runtimesSource(current)==='project'};
  const digest=sha256(JSON.stringify({version:1,report,candidate:sha256(candidate.text),
    inputs:snapshots.map(({file,before})=>({file,sha256:before===null?null:sha256(before)}))}));
  const preview={...report,preview_sha256:digest};
  previewPlans.set(preview,{candidate,snapshots,lang,userFile,root});
  return preview;
}
function applyRuntimePreview(preview){
  const plan=previewPlans.get(preview);if(!plan)throw new ConfigError('unknown runtime preview; generate a fresh preview');
  const {candidate,snapshots,lang,userFile,root}=plan;
  if(userRuntimesPath()!==userFile||root&&projectDirectory(root)!==root)throw new ConfigError(t('drift',lang,{file:candidate.file}));
  assertSnapshots(snapshots,lang);
  atomicRuntimeWrite(candidate.file,candidate.text,{before:candidate.before,privateFile:preview.scope==='user'});
  previewPlans.delete(preview);return candidate.file;
}
export function formatRuntimePreview(preview,lang=runtimeLanguage()){
  const fields=preview.changes.map(({field,before,after})=>`  ${field}: ${before??t('absent',lang)} -> ${after}`).join('\n');
  const impact=preview.scope==='user'?t(preview.project_overrides_user?'overridden':'userImpact',lang):t('projectImpact',lang);
  return t('preview',lang,{file:preview.target,scope:preview.scope,preset:preview.preset,fields,impact,
    current:preview.current??t('notProject',lang),effective:preview.effective??t('notProject',lang)})
    +t('modelWarning',lang)+`preview_sha256: ${preview.preview_sha256}\n`;
}
export function advancedRuntimeHelp(lang=runtimeLanguage()){
  return t('advanced',lang,{doc:path.join(scripts,'../runtime/workflow-config.md'),validator:path.join(scripts,'cm-workflow-config.mjs')})
    +`External provider model setup: node ${path.join(scripts,'cm-model-setup.mjs')} configure --provider codex|claude\n`
    +`Single-task opt-in and recovery limits: ${path.join(scripts,'../docs/external-models.md')}\n`;
}
function logSet(preset,source,project){
  // Reuse cm-log-event.mjs through its required Python platform lock adapter.
  // No specs/run pointer: this decision is independent of any in-flight run.
  const args=[path.join(scripts,'cm-log-event.py'),'--workflow','cm-runtime','--event','decision','--phase','route',
    '--runtime','local','--project-root',project,'--detail','runtime preference set',
    '--data-json',JSON.stringify({preset,source})];
  for(const python of process.env.CM_PYTHON_BIN?[process.env.CM_PYTHON_BIN]:['python3','python']){
    const result=spawnSync(python,args,{encoding:'utf8',timeout:30000,env:{...process.env,
      CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME||path.join(path.dirname(userRuntimesPath()),'logs')}});
    if(result.error?.code==='ENOENT')continue;
    if(result.status===0)return;
    throw new ConfigError(`preference saved, decision log failed: ${result.stderr?.trim()||result.error?.message||result.status}`);
  }
  throw new ConfigError('preference saved, decision log failed: Python 3.9+ lock adapter unavailable');
}
const COMMANDS='cm-runtime show [--project PATH]\ncm-runtime preview <preset> [--project PATH | --user] [--json]\ncm-runtime set <preset> [--project PATH | --user] [--expect-preview SHA256]\ncm-runtime unset --user';
export async function interactiveRuntime(project,{input=process.stdin,output=process.stdout,lang=runtimeLanguage()}={}){
  const root=projectDirectory(project),existing=findConfig(root),file=existing??path.join(root,'.cm-workflow.yml');
  const questions=runtimeQuestions(input,output,lang),ask=questions.ask;
  try{
    output.write(showRuntime(root,{lang,probe:()=>[]})+'\n');
    let action;do{action=await ask(t('menu',lang));}while(!['','1','2','3'].includes(action));
    if(action===''||action==='1'){output.write(t('kept',lang));return 0;}
    if(action==='3'){output.write(advancedRuntimeHelp(lang));return 0;}
    const fallback=existing?'1':'2';let scope;
    do{scope=await ask(t('scope',lang,{project:file,user:userRuntimesPath(),default:fallback}));scope=scope||fallback;}while(!['1','2'].includes(scope));
    const user=scope==='2';
    if(!user&&!existing)output.write(t('create',lang,{file}));
    const preset=await askRuntimePreset(ask,lang);
    const preview=prepareRuntimePreview(root,preset,{user,lang});
    output.write(formatRuntimePreview(preview,lang));
    let confirm;
    do{confirm=(await ask(t('confirm',lang))).toLowerCase();}while(!['','y','n'].includes(confirm));
    if(confirm!=='y')throw new PromptCancelled();
    saveRuntime(root,preset,user,lang,output,preview);
    output.write(showRuntime(root,{lang})+'\n');return 0;
  }catch(error){if(error instanceof PromptCancelled){output.write(t('cancelled',lang));return 0;}throw error;}
  finally{questions.close();}
}
function saveRuntime(project,preset,user,lang,output,preview){
  runtimePreset(preset);project=projectDirectory(project);
  const file=preview?applyRuntimePreview(preview):user?writeUserRuntime(preset,{lang}):setProjectRuntime(project,preset);
  logSet(preset,user?'user':'project',project);
  output.write(t('saved',lang,{file,preset,source:user?'user':'project'})+'\n');
}
export async function main(argv=process.argv.slice(2),{input=process.stdin,output=process.stdout,lang=runtimeLanguage()}={}){
  const USAGE=t('help',lang)+'\n'+COMMANDS;
  try{
    if(argv.length===1&&['--help','-h'].includes(argv[0])){output.write(USAGE+'\n');return 0;}
    const command=argv[0]?.startsWith('--')?undefined:argv[0];const args=command?argv.slice(1):argv;let project=process.cwd(),user=false,preset=null,projectSeen=false,expected=null,json=false;
    for(let i=0;i<args.length;i++){
      if(args[i]==='--user'&&!user){user=true;continue;}
      if(args[i]==='--project'&&!projectSeen&&args[i+1]&&!args[i+1].startsWith('--')){project=args[++i];projectSeen=true;continue;}
      if(['set','preview'].includes(command)&&!preset&&!args[i].startsWith('--')){preset=args[i];continue;}
      if(command==='set'&&args[i]==='--expect-preview'&&expected===null&&/^[a-f0-9]{64}$/.test(args[i+1]??'')){expected=args[++i];continue;}
      if(command==='preview'&&args[i]==='--json'&&!json){json=true;continue;}
      throw new ConfigError(USAGE);
    }
    if(user&&projectSeen)throw new ConfigError('--user cannot be combined with --project');
    if(!command&&!user){if(!input.isTTY||!output.isTTY){output.write(USAGE+'\n');return 2;}return await interactiveRuntime(project,{input,output,lang});}
    if(command==='show'&&!user){output.write(showRuntime(project,{lang})+'\n');return 0;}
    if(command==='preview'&&preset){
      const preview=prepareRuntimePreview(project,preset,{user,lang});
      output.write(json?JSON.stringify(preview)+'\n':formatRuntimePreview(preview,lang));return 0;
    }
    if(command==='set'&&preset){
      const preview=expected===null?null:prepareRuntimePreview(project,preset,{user,lang});
      if(preview&&preview.preview_sha256!==expected)throw new ConfigError(t('drift',lang,{file:preview.target}));
      saveRuntime(project,preset,user,lang,output,preview);return 0;
    }
    if(command==='unset'&&user){const file=userRuntimesPath();safeTarget(file);if(stat(file))fs.unlinkSync(file);output.write(t('removed',lang,{file})+'\n');return 0;}
    throw new ConfigError(USAGE);
  }catch(error){console.error(`cm-runtime: ${error.message}`);return 1;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
