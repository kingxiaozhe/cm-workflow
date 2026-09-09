// Read-only source guard. Hashes stay local; only explicitly selected source text
// is sent to the current host. A report exclusion never expands to its parent.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {need,digest} from '../cm-ai/effect-contract.mjs';

export const inside=(root,target)=>target===root||target.startsWith(root+path.sep);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const ignored=new Set(['.git','node_modules','.venv','venv','dist','build','.next','.cache','coverage','__pycache__']);

export function canonicalFuture(target){
  target=path.resolve(target);
  try{return fs.realpathSync(target);}catch(error){
    if(error.code!=='ENOENT')throw error;
    // A dangling link must not be treated as a missing directory.
    try{fs.lstatSync(target);need(false,'cm_test_report_path_invalid');}catch(cause){if(cause.code!=='ENOENT')throw cause;}
    const parent=path.dirname(target);need(parent!==target,'cm_test_report_path_invalid');
    return path.join(canonicalFuture(parent),path.basename(target));
  }
}

export function selectReportDirectory(admission,runId){
  const {project,specs}=admission;
  const selected=canonicalFuture(admission.requestedReportDir??(specs?path.join(specs,'.reviews'):
    path.join(project,'docs','test-reports',runId)));
  need(!inside(selected,project),'cm_test_report_path_invalid');
  if(inside(project,selected))need(inside(path.join(project,'docs','test-reports'),selected)
    ||(specs!==null&&inside(path.join(specs,'.reviews'),selected)),'cm_test_report_path_invalid');
  // Never exclude a whole specs tree, even when specs is outside the project.
  if(specs)need(!inside(selected,specs),'cm_test_report_path_invalid');
  return selected;
}

export function snapshotSource(project,reportDir,depth=0){
  need(depth<=8,'cm_test_submodule_depth');
  need(fs.realpathSync(project)===project&&canonicalFuture(reportDir)===reportDir,'cm_test_path_changed');
  const git=args=>spawnSync('git',['-C',project,...args],{encoding:'buffer',timeout:10000,maxBuffer:32*1024*1024,
    env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
  const head=git(['rev-parse','--verify','HEAD']);
  const files={},submodules={};let paths=[];
  if(head.status===0){
    const index=git(['ls-files','--stage','-z','--','.']);
    need(index.status===0&&!index.error,'cm_test_snapshot_failed');
    for(const row of index.stdout.toString('utf8').split('\0').filter(Boolean)){
      const match=/^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(row);
      need(match,'cm_test_snapshot_failed');
      if(match[1]==='160000'){
        need(match[3]==='0','cm_test_submodule_conflict');submodules[match[4]]=match[2];
      }
    }
    const listing=git(['ls-files','--cached','--others','--exclude-standard','-z','--','.']);
    need(listing.status===0&&!listing.error,'cm_test_snapshot_failed');
    paths=[...new Set(listing.stdout.toString('utf8').split('\0').filter(Boolean))];
  }else{
    const walk=relative=>{
      for(const item of fs.readdirSync(path.join(project,relative),{withFileTypes:true})){
        const name=path.join(relative,item.name),target=path.join(project,name);
        if(inside(reportDir,target)||ignored.has(item.name))continue;
        if(item.isDirectory())walk(name);else paths.push(name);
      }
    };walk('');
  }
  need(paths.length<=100000,'cm_test_snapshot_limit');
  for(const name of paths.sort()){
    const target=path.resolve(project,name);
    need(inside(project,target),'cm_test_source_path_invalid');
    if(inside(reportDir,target))continue;
    if(Object.hasOwn(submodules,name)){
      need(fs.existsSync(target)&&fs.lstatSync(target).isDirectory()&&fs.realpathSync(target)===target,
        'cm_test_submodule_uninitialized');
      const top=spawnSync('git',['-C',target,'rev-parse','--show-toplevel'],{encoding:'utf8',timeout:10000,
        env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
      need(top.status===0&&fs.realpathSync(top.stdout.trim())===target,'cm_test_submodule_uninitialized');
      const child=snapshotSource(target,reportDir,depth+1);
      need(child.gitState!==null,'cm_test_submodule_uninitialized');
      files[name]={gitlink:submodules[name],digest:child.digest};
      for(const [file,value] of Object.entries(child.files))files[`${name}/${file}`]=value;
      need(Object.keys(files).length<=100000,'cm_test_snapshot_limit');
      continue;
    }
    let stat;try{stat=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT'){files[name]={missing:true};continue;}throw error;}
    if(stat.isSymbolicLink()){files[name]={link:fs.readlinkSync(target)};continue;}
    // Only registered initialized gitlinks may be traversed as directories.
    need(stat.isFile()&&fs.realpathSync(target)===target,'cm_test_snapshot_unsupported_file');
    const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),sum=createHash('sha256');
    try{const chunk=Buffer.alloc(64*1024);let n;while((n=fs.readSync(fd,chunk,0,chunk.length,null))>0)sum.update(chunk.subarray(0,n));}
    finally{fs.closeSync(fd);}
    files[name]={sha256:sum.digest('hex'),mode:stat.mode&0o777};
  }
  let gitState=null;
  if(head.status===0){
    const relative=path.relative(project,reportDir).split(path.sep).join('/');
    const filters=['--','.',...(inside(project,reportDir)?[`:(exclude,literal)${relative}`]:[])];
    const diff=git(['diff','--no-ext-diff','--no-textconv','--binary','HEAD',...filters]);
    const status=git(['status','--porcelain=v1','-z','--untracked-files=all',...filters]);
    need(diff.status===0&&status.status===0&&!diff.error&&!status.error,'cm_test_snapshot_failed');
    const index=git(['ls-files','--stage','-z',...filters]);
    need(index.status===0&&!index.error,'cm_test_snapshot_failed');
    gitState={head:head.stdout.toString().trim(),diff:hash(diff.stdout),status:hash(status.stdout),index:hash(index.stdout)};
  }
  return {files,gitState,digest:digest({files,gitState}),method:gitState?'git-head-diff-and-files':'file-manifest'};
}

export function sourceChanges(before,after){
  const changes=[...new Set([...Object.keys(before.files),...Object.keys(after.files)])]
    .filter(name=>digest(before.files[name]??null)!==digest(after.files[name]??null));
  if(digest(before.gitState)!==digest(after.gitState)&&changes.length===0)changes.push('[Git index/HEAD/status changed]');
  return changes;
}

export function readSourceFiles(project,names,snapshot){
  need(Array.isArray(names)&&names.length>0&&names.length<=64&&new Set(names).size===names.length,'cm_test_sources_required');
  let bytes=0;
  return names.map(name=>{
    need(typeof name==='string'&&!path.isAbsolute(name)&&!name.includes('\\')
      &&name.split('/').every(part=>part&&part!=='.'&&part!=='..')
      &&!/(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key|p12)|credentials[^/]*|id_rsa)$/i.test(name),'cm_test_source_path_invalid');
    const file=path.join(project,name),stat=fs.lstatSync(file);
    need(stat.isFile()&&!stat.isSymbolicLink()&&fs.realpathSync(file)===file&&stat.size<=256*1024,'cm_test_source_path_invalid');
    const data=fs.readFileSync(file);bytes+=data.length;need(bytes<=512*1024,'cm_test_source_limit');
    need(snapshot.files[name]?.sha256===hash(data),'cm_test_source_changed');
    const content=new TextDecoder('utf-8',{fatal:true}).decode(data);
    need(!content.includes('\0'),'cm_test_source_not_text');
    return {path:name,sha256:hash(data),content};
  });
}

export function checkSourceEvidence(rows,sources){
  for(const row of rows)for(const item of row.evidence){
    const source=sources.find(file=>file.path===item.path);
    need(source&&Number.isSafeInteger(item.line)&&item.line>=1&&item.line<=source.content.split('\n').length,
      'cm_test_source_evidence_invalid');
  }
}
