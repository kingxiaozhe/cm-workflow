#!/usr/bin/env node
// Standalone runtime preferences; never mutates an existing run or dispatches AI.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ConfigError,findConfig,loadConfig,readConfigText,parseUserRuntimes,
  userRuntimesPath,runtimePreset,RUNTIME_PRESETS,resolveRole,runtimesSource} from './cm-workflow-config.mjs';
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
export function writeUserRuntime(preset,{lang=runtimeLanguage()}={}){
  const declaration=runtimePreset(preset),file=userRuntimesPath();
  safeTarget(file);
  const text=`# ${t('comment',lang)}\nruntimes: {available: ${declaration.runtimes.available}}\npreset: ${preset}\n`;
  parseUserRuntimes(text);
  atomicRuntimeWrite(file,text,{before:stat(file)?fs.readFileSync(file):null,privateFile:true});
  return file;
}
function projectDirectory(raw){
  const root=fs.realpathSync(path.resolve(raw));
  if(!fs.statSync(root).isDirectory())throw new ConfigError('project must be a directory');
  return root;
}
export function setProjectRuntime(project,preset){
  const root=projectDirectory(project),declaration=runtimePreset(preset);
  // Reject broken links/directories too, even though findConfig only finds files.
  for(const name of ['.cm-workflow.yml','.cm-workflow.yaml','.cm-workflow.json'])safeTarget(path.join(root,name));
  const existing=findConfig(root),file=existing??path.join(root,'.cm-workflow.yml');
  const before=existing?fs.readFileSync(file):null;
  const original=readConfigText(existing??path.join(scripts,'../templates/cm-workflow.yml'));
  loadConfig({projectRoot:root,configPath:file,text:original});
  const text=editRuntimeDeclaration(original,file,declaration);
  loadConfig({projectRoot:root,configPath:file,text});
  atomicRuntimeWrite(file,text,{before});return file;
}
export function showRuntime(project,{runtime=process.env.CM_RUNTIME||'codex',probe=probeRuntimes,lang=runtimeLanguage()}={}){
  const config=loadConfig({projectRoot:project});
  const preset=Object.keys(RUNTIME_PRESETS).find(name=>{
    const value=runtimePreset(name);
    return config.runtimes.available===value.runtimes.available
      &&['coder','reviewer'].every(role=>['adapter','source'].every(field=>config.roles[role][field]===value.roles[role][field]));
  })??(runtimesSource(config)==='none'?'none':'custom');
  const lines=[`runtimes.available: ${config.runtimes.available}`,`preset: ${preset}`,`runtimes_source: ${runtimesSource(config)}`];
  for(const role of ['coder','reviewer']){
    const resolved=resolveRole(config,role,runtime);
    lines.push(`${role}: adapter=${resolved.adapter} source=${resolved.source} route_state=${resolved.route_state}${resolved.route_state==='declared-adapter'?t('declared',lang):''}`);
  }
  const wanted=config.runtimes.available==='both'?['codex','claude']:config.runtimes.available==='unknown'?[]:[config.runtimes.available];
  for(const result of probe(wanted))lines.push(result.available
    ?t('cli',lang,{runtime:result.runtime})
    :t('warning',lang,{available:config.runtimes.available,runtime:result.runtime}));
  return lines.join('\n');
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
const COMMANDS='cm-runtime show [--project PATH]\ncm-runtime set <preset> [--project PATH]\ncm-runtime set --user <preset>\ncm-runtime unset --user';
export async function interactiveRuntime(project,{input=process.stdin,output=process.stdout,lang=runtimeLanguage()}={}){
  const root=projectDirectory(project),existing=findConfig(root),file=existing??path.join(root,'.cm-workflow.yml');
  const questions=runtimeQuestions(input,output,lang),ask=questions.ask;
  try{
    const fallback=existing?'1':'2';let scope;
    do{scope=await ask(t('scope',lang,{project:file,user:userRuntimesPath(),default:fallback}));scope=scope||fallback;}while(!['1','2'].includes(scope));
    const user=scope==='2';
    if(!user&&!existing)output.write(t('create',lang,{file}));
    const preset=await askRuntimePreset(ask,lang);
    const target=user?userRuntimesPath():file;
    const current=user?(stat(target)?readConfigText(target):t('absent',lang)):showRuntime(root,{lang,probe:()=>[]});
    output.write(t('preview',lang,{file:target,preset,current}));
    let confirm;
    do{confirm=(await ask(t('confirm',lang))).toLowerCase();}while(!['','y','n'].includes(confirm));
    if(confirm==='n')throw new PromptCancelled();
    saveRuntime(root,preset,user,lang,output);
    output.write(showRuntime(root,{lang})+'\n');return 0;
  }catch(error){if(error instanceof PromptCancelled){output.write(t('cancelled',lang));return 0;}throw error;}
  finally{questions.close();}
}
function saveRuntime(project,preset,user,lang,output){
  runtimePreset(preset);project=projectDirectory(project);
  const file=user?writeUserRuntime(preset,{lang}):setProjectRuntime(project,preset);
  logSet(preset,user?'user':'project',project);
  output.write(t('saved',lang,{file,preset,source:user?'user':'project'})+'\n');
}
export async function main(argv=process.argv.slice(2),{input=process.stdin,output=process.stdout,lang=runtimeLanguage()}={}){
  const USAGE=t('help',lang)+'\n'+COMMANDS;
  try{
    if(argv.length===1&&['--help','-h'].includes(argv[0])){output.write(USAGE+'\n');return 0;}
    const command=argv[0]?.startsWith('--')?undefined:argv[0];const args=command?argv.slice(1):argv;let project=process.cwd(),user=false,preset=null,projectSeen=false;
    for(let i=0;i<args.length;i++){
      if(args[i]==='--user'&&!user){user=true;continue;}
      if(args[i]==='--project'&&!projectSeen&&args[i+1]&&!args[i+1].startsWith('--')){project=args[++i];projectSeen=true;continue;}
      if(command==='set'&&!preset&&!args[i].startsWith('--')){preset=args[i];continue;}
      throw new ConfigError(USAGE);
    }
    if(user&&projectSeen)throw new ConfigError('--user cannot be combined with --project');
    if(!command&&!user){if(!input.isTTY||!output.isTTY){output.write(USAGE+'\n');return 2;}return await interactiveRuntime(project,{input,output,lang});}
    if(command==='show'&&!user){output.write(showRuntime(project,{lang})+'\n');return 0;}
    if(command==='set'&&preset){
      saveRuntime(project,preset,user,lang,output);return 0;
    }
    if(command==='unset'&&user){const file=userRuntimesPath();safeTarget(file);if(stat(file))fs.unlinkSync(file);output.write(t('removed',lang,{file})+'\n');return 0;}
    throw new ConfigError(USAGE);
  }catch(error){console.error(`cm-runtime: ${error.message}`);return 1;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
