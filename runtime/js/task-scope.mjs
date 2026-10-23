// Per-task file scope written in tasks.md, as indented sub-items of a task line:
//
//   - [ ] T-002: 实现 searchTodos
//     - 范围: `src/todos.js`, `test/todo-search-logic.test.js`
//     - 测试文件: `test/todo-search-logic.test.js`
//     - 设备: 需要
//
// 范围 / scope lists every file the task may change (existing files included);
// 测试文件 / tests is a subset of it; 设备 / device marks a task whose checks need a
// device or simulator. Only exact relative file paths in backticks are accepted:
// no directories, no globs. The task line itself is untouched, so every existing
// task-line reader keeps its meaning; the sub-items belong to the task they sit
// under (specification-material already carries indented lines with their task).
import fs from 'node:fs';
import path from 'node:path';
import {taskLines} from './spec-task-line.mjs';
import {protectedScopePaths} from './cm-ai/developer-adapter.mjs';

const KEYS=new Map([['范围','scope'],['scope','scope'],['测试文件','tests'],['tests','tests'],['设备','device'],['device','device']]);
const SUB_ITEM=/^(\s*)-\s+([^\s:：]+)\s*[:：]\s*(.*)$/u;
const DEVICE_VALUES=new Set(['需要','required']);
// A task whose files cannot be listed up front (a scaffold generator) says so
// explicitly; it counts as declared for the split check but never runs in parallel.
const SERIAL_VALUES=new Set(['串行','serial']);
const indentOf=body=>body.match(/^\s*/)[0].replace(/\t/g,'    ').length;

export function validScopePath(value){
  if(typeof value!=='string'||value.length===0||value.length>512)return false;
  if(value.startsWith('/')||value.endsWith('/')||/[\\:*?[\]\x00-\x1f]/.test(value))return false;
  if(!value.split('/').every(part=>part&&part!=='.'&&part!=='..'))return false;
  return protectedScopePaths([value]).length===0;
}

function pathList(raw){
  const paths=[...raw.matchAll(/`([^`]*)`/g)].map(match=>match[1]);
  const rest=raw.replace(/`[^`]*`/g,'').replace(/[\s,，、]/g,'');
  return rest===''&&paths.length>0?paths:null;
}

// {tasks: Map<taskId,{scope,tests,device,line}>, errors: [{taskId,line,message}]}.
// A task without any scope sub-item is simply absent from `tasks`.
export function parseTaskScopes(text){
  const tasks=new Map(),errors=[];let current=null;
  const fail=(line,message)=>errors.push({taskId:current?.id??null,line:line.index+1,message});
  for(const line of taskLines(text)){
    if(line.fenced)continue;
    if(line.declaration){current={id:line.declaration.id,indent:indentOf(line.body),fields:new Map()};continue;}
    if(/^\s*#/.test(line.body)){current=null;continue;}
    if(!line.body.trim())continue;
    const match=SUB_ITEM.exec(line.body);
    const key=match?KEYS.get(match[2].toLowerCase())??KEYS.get(match[2]):undefined;
    if(current===null||indentOf(line.body)<=current.indent){
      // Back at (or above) the task's own level: this task's sub-items are over.
      // A scope-looking item here is almost always a missing indent; say so. Prose
      // bullets elsewhere (a risk list naming a device) are left alone.
      const looksLikeScope=key==='device'?DEVICE_VALUES.has(match[3].trim().toLowerCase())||DEVICE_VALUES.has(match[3].trim())
        :key!==undefined&&pathList(match[3].trim())!==null;
      if(looksLikeScope)errors.push({taskId:current?.id??null,line:line.index+1,
        message:`${match[2]} 不在任何任务行下面（要缩进写在任务行的下一行）`});
      current=null;continue;
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
    const bad=paths.filter(item=>!validScopePath(item));
    if(bad.length){fail(line,`不合法的路径（只许相对文件路径，不许目录、通配符或受保护文件）：${bad.join(', ')}`);continue;}
    if(new Set(paths).size!==paths.length){fail(line,`${match[2]} 有重复路径`);continue;}
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
  return {tasks:result,serial,errors};
}

// Two tasks may run at the same time only when neither writes a path the other writes.
export function scopesOverlap(a,b){const set=new Set(a);return b.some(item=>set.has(item));}

// The scope a feature's tasks.md declares for one task, or null when it declares
// none. A malformed sub-item of that task refuses rather than falling back to a
// session-supplied scope.
export function declaredTaskScope(specsDir,feature,taskId){
  let text;
  try{text=fs.readFileSync(path.join(specsDir,feature,'tasks.md'),'utf8');}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  const parsed=parseTaskScopes(text),problem=parsed.errors.find(item=>item.taskId===taskId);
  if(problem)throw Object.assign(new Error('task_scope_invalid'),{code:'task_scope_invalid',
    reason:`${feature}/tasks.md 第 ${problem.line} 行（${taskId}）：${problem.message}`});
  return parsed.tasks.get(taskId)??null;
}
export const sameScope=(a,b)=>a.length===b.length&&new Set(a).size===a.length&&a.every(item=>b.includes(item));
