// A bounded projection of one frozen check scope reference, never a new command.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';
import {json,shape,digest,freeze,validIdentity,id,hex} from './effect-contract.mjs';
import {validateDeveloperScope} from './developer-adapter.mjs';
import {readReviewScope} from './review-package.mjs';

const INVALID='scope_check_supplement_invalid',DRIFT='scope_check_supplement_drift',UNSUPPORTED='scope_check_reference_unsupported';
const FILE_LIMIT=256*1024;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const must=(ok,code=INVALID)=>{if(!ok)fail(code);};
const guarded=(fn,code=INVALID)=>{try{return fn();}catch(error){if([INVALID,DRIFT,UNSUPPORTED].includes(error?.code))throw error;fail(code);}};
const inside=(root,p)=>p===root||p.startsWith(root.endsWith(path.sep)?root:root+path.sep);
const canonical=p=>must(typeof p==='string'&&path.isAbsolute(p)&&path.resolve(p)===p&&!/[\x00-\x1f\x7f]/.test(p));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const statKey=s=>[s.dev,s.ino,s.nlink,s.mode,s.size,s.mtimeNs,s.ctimeNs].join(':');
function fileSnapshot(file){return guarded(()=>{
  canonical(file);let current=path.parse(file).root;
  for(const part of file.slice(current.length).split('/').filter(Boolean)){
    current=path.join(current,part);must(!fs.lstatSync(current).isSymbolicLink(),DRIFT);
  }
  must(fs.realpathSync(file)===file,DRIFT);
  const before=fs.lstatSync(file,{bigint:true});must(before.isFile()&&before.nlink===1n&&before.size<=BigInt(FILE_LIMIT),DRIFT);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;
  try{
    must(statKey(before)===statKey(fs.fstatSync(fd,{bigint:true})),DRIFT);
    const buffer=Buffer.alloc(Number(before.size)+1);let length=0;
    while(length<buffer.length){const count=fs.readSync(fd,buffer,length,buffer.length-length,null);if(!count)break;length+=count;}
    bytes=buffer.subarray(0,length);
    must(statKey(before)===statKey(fs.fstatSync(fd,{bigint:true}))&&statKey(before)===statKey(fs.lstatSync(file,{bigint:true}))
      &&length===Number(before.size),DRIFT);
  }finally{fs.closeSync(fd);}
  const text=new TextDecoder('utf8',{fatal:true}).decode(bytes);must(Buffer.from(text).equals(bytes),DRIFT);
  return {record:{path:file,sha256:sha(bytes),size:bytes.length,mode:Number(before.mode&0o7777n)},definition:json(JSON.parse(text))};
},DRIFT);}
function checkScope(scope,original,requirements){
  validateDeveloperScope(scope);readReviewScope(scope);validateDeveloperScope(original);readReviewScope(original);
  must(scope.length>original.length&&original.every(p=>scope.includes(p)));
  const required=new Set(requirements.map(p=>p.toLowerCase()));
  for(const p of scope.filter(p=>!original.includes(p)))must(!required.has(p.toLowerCase())
    &&!p.split('/').some(part=>['requirements.md','design.md','test-cases.json','node_modules'].includes(part.toLowerCase())));
}
function originalLists(material){
  const workflow=material.execution.workflow?.configuration??material.execution.workflow;
  const lists=[material.execution.protection.checkCommands,...(workflow?.qa?.commands?[workflow.qa.commands]:[])];
  for(const list of lists){must(Array.isArray(list)&&list.length>0&&list.length<=32);const seen=new Set();
    for(const row of list){id(row.id);must(!seen.has(row.id));seen.add(row.id);must(Array.isArray(row.command)&&row.command.length>0
      &&row.command.every(argument=>typeof argument==='string'&&argument.length>0&&!argument.includes('\0')));}}
  return lists;
}
function originalMaterial(material,configFingerprint,scope,originalScope){
  hex(configFingerprint);must(digest(material)===configFingerprint);
  const d=material.definition,e=material.execution;must(d&&e&&e.kind==='cm-current-conversation-v1');
  validIdentity(d.identity);must(d.identity.attempt===1);id(e.hostContextId);
  must(e.definitionDigest===digest(d));canonical(d.codeProject);canonical(d.specsDir);
  for(const name of ['parallelSelection','bootstrap','developmentAuthorization'])must(!Object.hasOwn(material,name));
  for(const name of ['providerDevelopment','bootstrap','parallelMember','batchWorkflowsDigest'])must(!Object.hasOwn(e,name));
  must(!Object.hasOwn(d,'codeProjects')&&e.protection&&e.controlPolicy?.version===2
    &&e.controlPolicy.development==='conversation'&&e.controlPolicy.bootstrap==='disabled'&&e.controlPolicy.qaFix==='disabled');
  must(!Object.hasOwn(e.protection,'binaryAssets'));
  must(Number.isSafeInteger(e.protection.timeoutMs)&&e.protection.timeoutMs>0);
  must(Array.isArray(d.scope)&&Array.isArray(d.requirements));
  must(digest(d.scope)===digest(originalScope));checkScope(scope,d.scope,d.requirements);
  return originalLists(material);
}
// Locate actual top-level const tokens. Quotes/comments are never code. Regex
// and template literals deliberately remain unsupported, rather than guessing
// where executable template substitutions or regex character classes end.
function topLevelConst(source){
  const starts=new Set();let i=0,braces=0,parens=0,brackets=0,previous=null;
  while(i<source.length){const ch=source[i],next=source[i+1];
    if(/\s/.test(ch)){i++;continue;}
    if(ch==='/'&&next==='/'){i=source.indexOf('\n',i+2);if(i<0)break;continue;}
    if(ch==='/'&&next==='*'){const end=source.indexOf('*/',i+2);must(end>=0,UNSUPPORTED);i=end+2;continue;}
    must(ch!=='/'&&ch!=='`',UNSUPPORTED);
    if(ch==='"'||ch==="'"){const quote=ch;i++;while(i<source.length&&source[i]!==quote){if(source[i]==='\\')i++;i++;}
      must(i<source.length,UNSUPPORTED);i++;previous='literal';continue;}
    if(/[A-Za-z_$]/.test(ch)){const start=i;i++;while(i<source.length&&/[A-Za-z0-9_$]/.test(source[i]))i++;
      const word=source.slice(start,i);if(word==='const'&&braces===0&&parens===0&&brackets===0
        &&(previous===null||previous===';'))starts.add(start);previous=word;continue;}
    if(ch==='{')braces++;if(ch==='}')braces--;if(ch==='(')parens++;if(ch===')')parens--;if(ch==='[')brackets++;if(ch===']')brackets--;
    previous=ch;i++;
  }return starts;
}
function projectScript(command,file,scope){return guarded(()=>{
  must(Array.isArray(command)&&command.length===3&&['node',process.execPath].includes(command[0])
    &&command[1]==='-e'&&typeof command[2]==='string',UNSUPPORTED);
  const script=command[2];new Script(script);const starts=topLevelConst(script);
  const expression=/\bconst[ \t]+scope[ \t]*=[ \t]*new[ \t]+Set[ \t]*\((JSON\.parse\(fs\.readFileSync\((['"])([^'"\\\r\n]*)\2,[ \t]*(['"])utf8\4\)\)\.scope)\);/g;
  const matches=[...script.matchAll(expression)].filter(match=>starts.has(match.index));
  must(matches.length===1&&matches[0][3]===file,UNSUPPORTED);
  const match=matches[0],at=match.index+match[0].indexOf(match[1]);
  const projected=script.slice(0,at)+JSON.stringify(scope)+script.slice(at+match[1].length);new Script(projected);
  return [command[0],command[1],projected];
},UNSUPPORTED);}
export function validateProtectedScopeSupplement(raw,{configFingerprint,scope,originalScope}){return guarded(()=>{
  const value=json(raw);shape(value,['version','material','definitionFile','checkIds']);must(value.version===1);
  const lists=originalMaterial(value.material,configFingerprint,scope,originalScope);
  shape(value.definitionFile,['path','sha256','size','mode']);canonical(value.definitionFile.path);hex(value.definitionFile.sha256);
  must(Number.isSafeInteger(value.definitionFile.size)&&value.definitionFile.size>0&&value.definitionFile.size<=FILE_LIMIT
    &&Number.isInteger(value.definitionFile.mode)&&value.definitionFile.mode>=0&&value.definitionFile.mode<=0o7777);
  must(!inside(value.material.definition.codeProject,value.definitionFile.path)&&!inside(value.material.definition.specsDir,value.definitionFile.path));
  must(Array.isArray(value.checkIds)&&value.checkIds.length<=32&&new Set(value.checkIds).size===value.checkIds.length);
  for(const checkId of value.checkIds){id(checkId);const matching=lists.flat().filter(row=>row.id===checkId);must(matching.length>0);
    for(const row of matching)projectScript(row.command,value.definitionFile.path,scope);}
  return freeze(value);
});}
export function createProtectedScopeSupplement(raw,{material,configFingerprint,scope}){return guarded(()=>{
  const input=json(raw);shape(input,['version','definitionFile','checkIds']);must(input.version===1);
  const original=json(material);originalMaterial(original,configFingerprint,scope,original.definition?.scope);
  const captured=fileSnapshot(input.definitionFile);must(digest(captured.definition)===digest(original.definition),DRIFT);
  return validateProtectedScopeSupplement({version:1,material:original,definitionFile:captured.record,checkIds:input.checkIds},
    {configFingerprint,scope,originalScope:original.definition.scope});
});}
export function projectProtectedScopeCommands(raw,supplement,scope,{recheck=true}={}){return guarded(()=>{
  must(typeof recheck==='boolean');const rawSupplement=json(supplement);
  const s=validateProtectedScopeSupplement(rawSupplement,{configFingerprint:digest(rawSupplement.material),scope,originalScope:rawSupplement.material?.definition?.scope});
  const commands=json(raw),lists=originalLists(s.material);must(lists.some(list=>digest(commands)===digest(list)));
  if(recheck){const captured=fileSnapshot(s.definitionFile.path);must(digest(captured.record)===digest(s.definitionFile)
    &&digest(captured.definition)===digest(s.material.definition),DRIFT);}
  const selected=new Set(s.checkIds);
  return freeze(commands.map(row=>selected.has(row.id)?{...row,command:projectScript(row.command,s.definitionFile.path,scope)}:row));
});}
