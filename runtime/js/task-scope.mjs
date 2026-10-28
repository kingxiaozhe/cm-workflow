// Per-task file scope written in tasks.md, as indented sub-items of a task line:
//
//   - [ ] T-002: 实现 searchTodos
//     - 范围: `src/todos.js`, `test/todo-search-logic.test.js`
//     - 测试文件: `test/todo-search-logic.test.js`
//     - 设备: 需要
//
// 范围 / scope lists every file the task may change (existing files included);
// 测试文件 / tests is a subset of it; 设备 / device marks a task whose checks need a
// device or simulator. Under task grammar 3 only, 开发 / developer: 会话 / session
// marks a task the current session develops (a provider develops the rest); grammar
// 1 and 2 leave that line prose, as they always read it. Only exact relative file paths in backticks are accepted:
// no directories, no globs. The task line itself is untouched, so every existing
// task-line reader keeps its meaning; the sub-items belong to the task they sit
// under (specification-material already carries indented lines with their task).
import fs from 'node:fs';
import path from 'node:path';
import {taskLines,TASK_GRAMMAR,approvedTaskGrammar} from './spec-task-line.mjs';
import {readReviewScope} from './cm-ai/review-package.mjs';
import {protectedScopePaths} from './cm-ai/developer-adapter.mjs';

const KEYS=new Map([['范围','scope'],['scope','scope'],['测试文件','tests'],['tests','tests'],['设备','device'],['device','device']]);
const SUB_ITEM=/^(\s*)-\s+([^\s:：]+)\s*[:：]\s*(.*)$/u;
const DEVICE_VALUES=new Set(['需要','required']);
const DEVELOPER_KEYS=new Set(['开发','developer']);
// 开发进程 / provider is the default, accepted when written out.
const DEVELOPER_VALUES=new Map([['会话','session'],['session','session'],['开发进程','provider'],['provider','provider']]);
const developerValue=value=>DEVELOPER_VALUES.get(value)??DEVELOPER_VALUES.get(value.toLowerCase())??null;
// A task whose files cannot be listed up front (a scaffold generator) says so
// explicitly; it counts as declared for the split check but never runs in parallel.
const SERIAL_VALUES=new Set(['串行','serial']);
// Same ownership rule as specification-material taskScopeText: a space or a tab
// is one column, and only lines indented deeper than the task line belong to it.
const indentOf=body=>/^[ \t]*/.exec(body)[0].length;

export function validScopePath(value){
  if(typeof value!=='string'||value.endsWith('/')||/[*?[\]]/.test(value))return false;
  try{readReviewScope([value]);}catch{return false;}
  return protectedScopePaths([value]).length===0;
}

function scopeListAccepted(paths){try{readReviewScope(paths);return true;}catch{return false;}}

function pathList(raw){
  const paths=[...raw.matchAll(/`([^`]*)`/g)].map(match=>match[1]);
  const rest=raw.replace(/`[^`]*`/g,'').replace(/[\s,，、]/g,'');
  return rest===''&&paths.length>0?paths:null;
}

// {tasks: Map<taskId,{scope,tests,device,line}>, serial, sessions: Set<taskId>,
// errors: [{taskId,line,message}]}. A task without any scope sub-item is simply
// absent from `tasks`; `sessions` holds the tasks marked 开发: 会话 (grammar 3).
export function parseTaskScopes(text,{grammar=TASK_GRAMMAR}={}){
  const tasks=new Map(),errors=[],sessions=new Set(),developers=new Set();let current=null;
  const developer=grammar===TASK_GRAMMAR;
  const fail=(line,message)=>errors.push({taskId:current?.id??null,line:line.index+1,message});
  for(const line of taskLines(text,{grammar})){
    if(!line.body.trim())continue;
    if(line.declaration){current={id:line.declaration.id,indent:indentOf(line.body),fields:new Map()};continue;}
    // Exactly taskScopeText's ownership: a heading, or any line (fenced or not)
    // that is not indented under the task, ends the task's item.
    if(current!==null&&!(indentOf(line.body)>current.indent&&!/^\s*#/.test(line.body)))current=null;
    if(line.fenced)continue;
    const match=SUB_ITEM.exec(line.body);
    if(developer&&match&&(DEVELOPER_KEYS.has(match[2])||DEVELOPER_KEYS.has(match[2].toLowerCase()))){
      const value=developerValue(match[3].trim());
      if(current===null){
        if(value!==null)errors.push({taskId:null,line:line.index+1,message:`${match[2]} 不在任何任务行下面（要缩进写在任务行的下一行，用空格缩进）`});
        continue;
      }
      if(developers.has(current.id)){fail(line,`${match[2]} 重复`);continue;}
      developers.add(current.id);
      if(value===null){fail(line,'开发只能写「会话」或 session；由开发进程开发时不写这一项');continue;}
      if(value==='session')sessions.add(current.id);
      continue;
    }
    const key=match?KEYS.get(match[2].toLowerCase())??KEYS.get(match[2]):undefined;
    if(current===null){
      // Not under any task: a scope-looking item here is almost always a missing indent. Prose
      // bullets elsewhere (a risk list naming a device) are left alone.
      const looksLikeScope=key==='device'?DEVICE_VALUES.has(match[3].trim().toLowerCase())||DEVICE_VALUES.has(match[3].trim())
        :key!==undefined&&pathList(match[3].trim())!==null;
      if(looksLikeScope)errors.push({taskId:null,line:line.index+1,
        message:`${match[2]} 不在任何任务行下面（要缩进写在任务行的下一行，用空格缩进）`});
      continue;
    }
    if(key===undefined)continue;
    if(current.fields.has(key)){fail(line,`${match[2]} 重复`);continue;}
    const value=match[3].trim();
    if(key==='device'){
      if(!DEVICE_VALUES.has(value.toLowerCase())&&!DEVICE_VALUES.has(value)){fail(line,`设备只能写「需要」或 required，不需要时不写这一项`);continue;}
      current.fields.set(key,{value:true,line:line.index+1});tasks.set(current.id,current);continue;
    }
    if(key==='scope'&&(SERIAL_VALUES.has(value)||SERIAL_VALUES.has(value.toLowerCase()))){
      current.fields.set(key,{value:null,serial:true,line:line.index+1});tasks.set(current.id,current);continue;
    }
    const paths=pathList(value);
    if(paths===null){fail(line,`${match[2]} 必须是用反引号括起的文件路径，用逗号或空格分隔`);continue;}
    if(paths.length>256){fail(line,`${match[2]} 最多 256 个文件`);continue;}
    const bad=paths.filter(item=>!validScopePath(item));
    if(bad.length){fail(line,`不合法的路径（只许相对文件路径，不许目录、通配符或受保护文件）：${bad.join(', ')}`);continue;}
    // The execution side takes the whole list at once, so it also refuses paths that differ only in case.
    if(!scopeListAccepted(paths)){fail(line,`${match[2]} 有重复路径（含只差大小写的路径）`);continue;}
    current.fields.set(key,{value:paths,line:line.index+1});tasks.set(current.id,current);
  }
  const result=new Map(),serial=new Set();
  for(const [id,task] of tasks){
    if(task.fields.get('scope')?.serial){
      if(task.fields.size>1)errors.push({taskId:id,line:task.fields.get('scope').line,message:'范围写了串行，就不再写测试文件或设备'});
      else serial.add(id);
      continue;
    }
    const scope=task.fields.get('scope')?.value??null,tests=task.fields.get('tests')?.value??[];
    if(scope===null){errors.push({taskId:id,line:[...task.fields.values()][0].line,message:'写了测试文件或设备，却没有范围'});continue;}
    const outside=tests.filter(item=>!scope.includes(item));
    if(outside.length){errors.push({taskId:id,line:task.fields.get('tests').line,message:`测试文件不在范围里：${outside.join(', ')}`});continue;}
    result.set(id,Object.freeze({scope:Object.freeze([...scope]),tests:Object.freeze([...tests]),
      device:task.fields.get('device')?.value===true,line:task.fields.get('scope').line}));
  }
  return {tasks:result,serial,sessions,errors};
}
// Grammar 3's narrow rule for session-developed tasks: at most one per feature, and
// only its last task (the last one not dropped, the task that runs last and is never
// a parallel member). Last in tasks.md is not enough: the batch runs a task after its
// prerequisites, so a task that waits for the session task, directly or through others,
// would run after it. tasks: the feature's tasks in tasks.md order ({id,dropped});
// dependencies: id -> the ids it waits for. null, or {code,tasks[,dependents]}.
export function sessionTaskProblem(tasks,sessions,dependencies){
  const live=tasks.filter(task=>!task.dropped).map(task=>task.id),marked=live.filter(id=>sessions.has(id));
  if(marked.length>1)return {code:'session_task_multiple',tasks:marked};
  if(marked.length===1&&marked[0]!==live.at(-1))return {code:'session_task_not_final',tasks:marked};
  const dependents=marked.length===1?taskDependents(tasks,dependencies,marked[0]):[];
  if(dependents.length)return {code:'session_task_depended_on',tasks:marked,dependents};
  return null;
}
// The tasks not dropped that wait for taskId, directly or through other such tasks, in
// tasks.md order. A dropped task holds nothing back (admission counts it as satisfied).
export function taskDependents(tasks,dependencies,taskId){
  const live=new Set(tasks.filter(task=>!task.dropped).map(task=>task.id));
  const waits=(id,seen)=>{
    if(seen.has(id))return false;seen.add(id);
    return (dependencies.get(id)??[]).some(dep=>dep===taskId||live.has(dep)&&waits(dep,seen));
  };
  return [...live].filter(id=>id!==taskId&&waits(id,new Set()));
}
export const sessionTaskReason=problem=>problem.code==='session_task_multiple'
  ?`标了「开发: 会话」的任务有 ${problem.tasks.length} 个（${problem.tasks.join(', ')}），一个功能最多一个`
  :problem.code==='session_task_depended_on'
    ?`任务 ${problem.dependents.join(', ')} 直接或间接依赖标了「开发: 会话」的任务 ${problem.tasks[0]}，会排到它后面执行；会话任务只能是功能实际执行的最后一个任务，别的任务不能依赖它`
    :`标了「开发: 会话」的任务 ${problem.tasks[0]} 不是功能的最后一个任务；会话任务只能是功能的串行末项`;


// Two tasks may run at the same time only when neither writes a path the other writes.
export function scopesOverlap(a,b){const set=new Set(a);return b.some(item=>set.has(item));}

// The scope a feature's tasks.md declares for one task, or null when it declares
// none. A malformed sub-item of that task refuses rather than falling back to a
// session-supplied scope.
const scopeInvalid=reason=>Object.assign(new Error('task_scope_invalid'),{code:'task_scope_invalid',reason});
const inside=(root,target)=>target===root||target.startsWith(root+path.sep);
// This runs before the admission's own file checks, so it repeats them: a regular
// file inside the feature directory, opened without blocking (a FIFO never hangs).
function readTasksText(specsDir,feature){
  const root=path.join(specsDir,feature),target=path.join(root,'tasks.md');
  let real;
  try{real=fs.realpathSync(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const featureRoot=fs.realpathSync(root);
  if(!inside(fs.realpathSync(specsDir),featureRoot)||!inside(featureRoot,real))throw scopeInvalid(`${feature}/tasks.md 不在规格目录内`);
  const fd=fs.openSync(real,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK);
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>1048576)throw scopeInvalid(`${feature}/tasks.md 不是普通文件或超过 1 MiB`);
    return fs.readFileSync(fd,'utf8');
  }finally{fs.closeSync(fd);}
}
export function declaredTaskScope(specsDir,feature,taskId){
  const text=readTasksText(specsDir,feature);
  if(text===null)return null;
  // Read with the grammar the approval bound, as every runtime task reader does.
  const parsed=parseTaskScopes(text,{grammar:approvedTaskGrammar(specsDir)}),problem=parsed.errors.find(item=>item.taskId===taskId);
  if(problem)throw scopeInvalid(`${feature}/tasks.md 第 ${problem.line} 行（${taskId}）：${problem.message}`);
  // 串行 is the scaffold's exit only; anywhere else it is a malformed declaration, not "none".
  if(parsed.serial.has(taskId)&&!BOOTSTRAP_FEATURE.test(feature))
    throw scopeInvalid(`${feature}/tasks.md（${taskId}）：范围: 串行 只用于脚手架功能（N.bootstrap），其余任务要列出文件`);
  return parsed.tasks.get(taskId)??null;
}
// Shared create boundary: a new run of a task whose tasks.md declares its files
// must carry exactly those files, whichever entry built the run definition.
export function assertDeclaredScope(definition){
  const declared=declaredTaskScope(definition.specsDir,definition.feature,definition.identity.taskId);
  if(declared&&!sameScope(declared.scope,definition.scope))throw Object.assign(new Error('task_scope_mismatch'),{code:'task_scope_mismatch',
    reason:`tasks.md 为 ${definition.feature}/${definition.identity.taskId} 写的范围是 ${declared.scope.join(', ')}，运行定义给的是 ${definition.scope.join(', ')}`});
}
export const BOOTSTRAP_FEATURE=/^\d+\.bootstrap$/;
export const sameScope=(a,b)=>a.length===b.length&&new Set(a).size===a.length&&a.every(item=>b.includes(item));
