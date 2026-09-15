// Structural pre-write inspection, not semantic approval or a write capability.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {freeze,need} from '../cm-ai/effect-contract.mjs';

const rules=new Set(['coding-style','testing','security','git-workflow','frontend','miniprogram',
  'backend-api','database','smart-contract','finance']);
const allowed=file=>file==='AGENTS.md'||file==='.claude/CLAUDE.md'
  ||(/^\.claude\/rules\/([a-z-]+)\.md$/.test(file)&&rules.has(file.slice(14,-3)));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

export function readCmInitSource(root,file){
  need(typeof file==='string'&&file.split('/').every(part=>part&&part!=='.'&&part!=='..')
    &&!file.includes('\\')&&!file.includes('\0'),'init_draft_path_invalid');
  const segments=file.split('/');let current=root;
  for(let i=0;i<segments.length;i++){
    current=path.join(current,segments[i]);
    let stat;
    try{stat=fs.lstatSync(current);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    need(!stat.isSymbolicLink(),'init_draft_link');
    if(i<segments.length-1)need(stat.isDirectory(),'init_draft_parent_invalid');
    else{
      need(stat.isFile()&&stat.nlink===1&&stat.size<=1048576,'init_draft_target_invalid');
      const fd=fs.openSync(current,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try{
        const opened=fs.fstatSync(fd);
        need(opened.isFile()&&opened.nlink===1&&opened.size<=1048576,'init_draft_target_invalid');
        const bytes=Buffer.alloc(opened.size+1),count=fs.readSync(fd,bytes,0,bytes.length,0);
        need(count===opened.size,'init_draft_target_changed');return bytes.subarray(0,count);
      }finally{fs.closeSync(fd);}
    }
  }
}

export function inspectCmInitDraft({project,documents}){
  need(typeof project==='string'&&path.isAbsolute(project),'init_project_path_invalid');
  const root=fs.realpathSync(project);
  need(fs.statSync(root).isDirectory(),'init_project_path_invalid');
  need(Array.isArray(documents)&&documents.length>=2&&documents.length<=12,'init_draft_invalid');
  const byPath=new Map();
  for(const document of documents){
    need(document&&typeof document==='object'&&!Array.isArray(document)
      &&Object.keys(document).length===2&&typeof document.path==='string'&&allowed(document.path)
      &&typeof document.content==='string'&&document.content.trim().length>0
      &&Buffer.byteLength(document.content)<=1048576&&!byPath.has(document.path),'init_draft_invalid');
    byPath.set(document.path,document.content);
  }
  need(byPath.has('AGENTS.md')&&byPath.has('.claude/CLAUDE.md'),'init_draft_entry_missing');
  const changes=[],issues=[];
  for(const [file,content] of byPath){
    const before=readCmInitSource(root,file),after=Buffer.from(content);
    changes.push({path:file,action:before===null?'create':before.equals(after)?'unchanged':'modify',
      beforeSha256:before===null?null:sha(before),afterSha256:sha(after)});
    if(file==='.claude/CLAUDE.md'&&content.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n').length>150)
      issues.push({path:file,code:'claude_line_limit'});
    // Only the compatibility entry's standalone @rules imports are covered here.
    if(file==='.claude/CLAUDE.md')for(const match of content.matchAll(/^@rules\/([^\s]+)\s*$/gm)){
      const target=`.claude/rules/${match[1]}`;
      if(!allowed(target)||(!byPath.has(target)&&readCmInitSource(root,target)===null))
        issues.push({path:file,code:'rule_reference_missing',target});
    }
  }
  return freeze({version:1,workflow:'cm-init',phase:'draft_inspection',project:root,
    status:issues.length?'blocked':'structurally_checked',issues,changes,
    existingChangeReviewRequired:changes.filter(change=>change.action==='modify').map(change=>change.path),
    remainingChecks:['semantic_constraint_preservation','commands_and_globs','other_file_references',
      'applicable_rules_and_version_control','independent_review','current_files_before_write'],
    writeAuthorized:false,executionAuthorized:false});
}
