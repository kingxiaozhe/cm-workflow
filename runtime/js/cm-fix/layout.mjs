// Explicit bare-project archive adapter; never creates a specs/task skeleton.
import fs from 'node:fs';
import path from 'node:path';
import {canonicalFuture} from '../cm-test/source-snapshot.mjs';
import {need} from '../cm-ai/effect-contract.mjs';
import {supersedeWorkflowFile} from '../cm-ai/review-evidence-file.mjs';

export function fixArchiveRoot(specsRoot,cwd,create=false){
  if(specsRoot!=null)return fs.realpathSync(specsRoot);
  need(path.isAbsolute(cwd)&&fs.realpathSync(cwd)===cwd,'unsupported_path');
  const target=path.join(cwd,'docs','fixes');
  need(canonicalFuture(target)===target,'unsupported_path');
  if(create)fs.mkdirSync(target,{recursive:true,mode:0o700});
  need(fs.realpathSync(target)===target&&fs.lstatSync(target).isDirectory(),'unsupported_path');
  return target;
}
export const fixDossierRelative=(configuration,name)=>configuration.archiveMode==='bare'?name:`fixes/${name}`;
export const fixDossierDirectory=(root,configuration)=>configuration.archiveMode==='bare'?root:path.join(root,'fixes');

// 证据文件名由任务 slug 和轮次拼出来，跟 runId 无关——两次运行用同一个 taskId
// 就会写同一批文件。这个冲突原本要等到红灯测试去发布输出时才被发现，而那时
// intent 已经登记，运行留在 unknown 且不可重派，等于一整轮报废。名字在建运行
// 时就全都算得出来，所以在任何记录落盘之前先拒掉，并说清是哪一个名字被占了。
// 只在 create 时检查：恢复一次已有的运行，本来就该读到自己写下的证据。
export function fixEvidenceNames(identity,configuration){
  const slug=/^T-FIX-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(identity.taskId)?.[1];
  if(!slug)return [];   // 非法 taskId 由原有的 invalid_fix_slug 负责，不在这里抢答
  const names=[`fix-${slug}-${identity.taskId}-a${identity.attempt}-handoff.json`,
    `fix-${slug}-${identity.taskId}-r${identity.attempt}.md`];
  // 只列这次配置真的会写的文件，免得拦下根本不会发生的冲突。
  if(configuration.redTest&&configuration.redTest.kind!=='visual')
    names.push(`fix-${slug}-a${identity.attempt}-red-output.md`);
  if(configuration.causeReview)names.push(`fix-${slug}-cause-r1.md`);
  return names;
}
// 名字被占时分两种：审查结论（-r{n}.md / -cause-r{n}.md）是别人签过字的证据，绝不
// 挪动，名字就此占住；红灯输出和交接文件只是半路死掉的运行留下的，归档让路。
// 这条界线和 host-handoff 对交接文件的规则是同一条：被审查消费过的不动，其余
// 让路但不删。交接文件不需要单独查回执——回执就是那份 -r{n}.md，它在就先被拦了。
const reviewEvidence=name=>/-(?:cause-)?r\d+\.md$/.test(name);
export function assertFixEvidenceNamesFree(archiveRoot,identity,configuration){
  const reviews=path.join(archiveRoot,'.reviews');
  const names=fixEvidenceNames(identity,configuration);
  const present=name=>{
    try{const stat=fs.lstatSync(path.join(reviews,name));need(stat.isFile()&&!stat.isSymbolicLink(),'unsupported_file');return true;}
    catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;throw error;}
  };
  // 先整体判定再动手：只要有一份审查结论在，什么都不挪，免得半做半停。
  for(const name of names)if(reviewEvidence(name))need(!present(name),'fix_evidence_name_taken');
  for(const name of names)if(!reviewEvidence(name)&&present(name))supersedeWorkflowFile(reviews,name);
}
