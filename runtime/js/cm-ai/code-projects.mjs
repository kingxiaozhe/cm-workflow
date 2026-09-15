// Selected existing code roots within one explicit workspace. No mounts, writes,
// task splitting or command authority; callers keep the original task owner.
import fs from 'node:fs';
import path from 'node:path';
import {need,json} from './effect-contract.mjs';

function relativeFile(value){
  need(typeof value==='string'&&value.length>0&&value.normalize('NFC')===value
    &&!/[\\:\x00-\x1f\x7f-\x9f]/.test(value),'unsupported_path');
  need(value.split('/').every(part=>part&&part!=='.'&&part!=='..'
    &&!['.git','.ssh','.aws','.gnupg'].includes(part.toLowerCase())&&!/^\.env(?:\.|$)/i.test(part)),
  'unsupported_path');return value;
}

// Pure validation also used by offline baseline/package readers. Never repairs
// or requires the present filesystem merely to read historical evidence.
export function validateCodeProjectPaths(raw){
  const values=json(raw);need(Array.isArray(values)&&values.length>0&&values.length<=256,'invalid_code_projects');
  const selected=values.map(relativeFile).sort(),aliases=selected.map(value=>value.toLowerCase());
  for(let i=0;i<aliases.length;i++)for(let j=0;j<i;j++)
    need(aliases[i]!==aliases[j]&&!aliases[i].startsWith(aliases[j]+'/')
      &&!aliases[j].startsWith(aliases[i]+'/'),'overlapping_roots');
  return Object.freeze(selected);
}

function absoluteDirectory(value){
  need(typeof value==='string'&&path.isAbsolute(value)&&path.resolve(value)===value
    &&!/[\x00-\x1f\x7f-\x9f]/.test(value),'unsupported_path');
}

export function codeProjectPaths(codeProject,codeProjects){
  absoluteDirectory(codeProject);
  const selected=json(codeProjects);need(Array.isArray(selected)&&selected.length>0,'invalid_code_projects');
  return validateCodeProjectPaths(selected.map(root=>{
    absoluteDirectory(root);
    need(root.startsWith(codeProject+path.sep),'overlapping_roots');
    return path.relative(codeProject,root).split(path.sep).join('/');
  }));
}

export function resolveCodeProjects(codeProject,codeProjects){
  const relative=codeProjectPaths(codeProject,codeProjects);
  need(fs.realpathSync(codeProject)===codeProject&&fs.lstatSync(codeProject).isDirectory(),'unsupported_path');
  for(const prefix of relative){
    let cursor=codeProject;
    for(const part of prefix.split('/')){
      cursor=path.join(cursor,part);
      const stat=fs.lstatSync(cursor);
      need(stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(cursor)===cursor,'unsupported_path');
    }
  }
  return Object.freeze(relative.map(prefix=>path.join(codeProject,prefix)));
}

// Expected ancestor/root instruction paths, including missing files. Snapshot
// records below roots additionally carry every present nested AGENTS.md.
export function codeProjectInstructionPaths(projectPaths){
  const selected=validateCodeProjectPaths(projectPaths),files=new Set(['AGENTS.md']);
  for(const prefix of selected){
    const parts=prefix.split('/');
    for(let i=1;i<=parts.length;i++)files.add(parts.slice(0,i).join('/')+'/AGENTS.md');
  }
  return Object.freeze([...files].sort());
}

export function assertCodeProjectSelections(projectPaths,selections,{allowInstructions=false}={}){
  const selected=validateCodeProjectPaths(projectPaths),instructions=codeProjectInstructionPaths(selected);
  need(Array.isArray(selections),'invalid_input');
  for(const file of selections){
    relativeFile(file);
    need(selected.some(prefix=>file.startsWith(prefix+'/'))
      ||allowInstructions&&instructions.includes(file),'out_of_scope');
  }
}

// Map ancestor-relative business scope to the exact cwd/local paths consumed by
// the existing protected-edits/check adapters. Workspace instructions are not a
// business write root; the existing Learning owner handles its own AGENTS file.
export function groupCodeProjectPaths(codeProject,codeProjects,selections){
  const roots=resolveCodeProjects(codeProject,codeProjects),prefixes=codeProjectPaths(codeProject,roots);
  const files=json(selections);assertCodeProjectSelections(prefixes,files);
  need(new Set(files.map(file=>file.toLowerCase())).size===files.length,'unsupported_path');
  return json(prefixes.map((prefix,index)=>({codeProject:roots[index],prefix,
    paths:files.filter(file=>file.startsWith(prefix+'/')).map(file=>file.slice(prefix.length+1)).sort()})));
}
