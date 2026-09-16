// Compare pinned Git trees. No checkout, fetch, external diff, or working-tree text.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {need,json,shape,digest} from '../cm-ai/effect-contract.mjs';

const decode=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
const git=(project,args,optional=false)=>{
  const result=spawnSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-C',project,...args],{
    env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'},timeout:10000,maxBuffer:8*1024*1024});
  if(optional&&!result.error&&result.status!==0)return null;
  need(!result.error&&result.status===0,'cm_test_git_unavailable');return result.stdout;
};
const line=(project,args,optional=false)=>{
  const bytes=git(project,args,optional);return bytes===null?null:decode(bytes).trim();
};
const commit=(project,ref)=>line(project,['rev-parse','--verify',`${ref}^{commit}`],true);
const text=value=>typeof value==='string'&&value.trim().length>0;
const safePath=value=>text(value)&&!value.includes('\0')&&!value.includes('\\')
  &&value.split('/').every(part=>part&&part!=='.'&&part!=='..');

export function inspectBranchComparison(project,readGit=git){
  // Security consumers may inject a reader with a stricter executable/config boundary.
  const git=readGit;
  const line=(root,args,optional=false)=>{
    const bytes=git(root,args,optional);return bytes===null?null:decode(bytes).trim();
  };
  const commit=(root,ref)=>line(root,['rev-parse','--verify',`${ref}^{commit}`],true);
  const top=line(project,['rev-parse','--show-toplevel'],true);
  need(top!==null,'cm_test_git_required');
  need(fs.realpathSync(top)===project,'cm_test_project_root_required');
  const head=commit(project,'HEAD');need(head!==null,'cm_test_head_required');
  const branch=line(project,['symbolic-ref','--quiet','--short','HEAD'],true);
  const refs=line(project,['for-each-ref','--format=%(refname)','refs/heads/','refs/remotes/']).split('\n');
  let baseRef=line(project,['symbolic-ref','--quiet','refs/remotes/origin/HEAD'],true);
  if(!baseRef){
    const defaults=refs.filter(ref=>ref.startsWith('refs/remotes/')&&ref.endsWith('/HEAD'))
      .map(ref=>line(project,['symbolic-ref','--quiet',ref],true)).filter(Boolean);
    need(defaults.length<=1,'cm_test_main_ambiguous');baseRef=defaults[0]??null;
  }
  if(!baseRef){
    for(const prefix of ['refs/remotes/origin/','refs/heads/']){
      const candidates=['main','master'].map(name=>prefix+name).filter(ref=>refs.includes(ref));
      need(candidates.length<=1,'cm_test_main_ambiguous');
      if(candidates.length){baseRef=candidates[0];break;}
    }
  }
  need(baseRef!==null,'cm_test_main_missing');
  const base=commit(project,baseRef);need(base!==null,'cm_test_main_missing');
  const counts=line(project,['rev-list','--left-right','--count',`${base}...${head}`]).split(/\s+/).map(Number);
  const mergeBase=line(project,['merge-base',base,head],true);
  const shallow=line(project,['rev-parse','--is-shallow-repository'])==='true';
  const dirty=git(project,['status','--porcelain=v1','-z','--untracked-files=normal']).length>0;
  return json({baseRef,base,head,branch,comparison:'base-tree-to-head-tree',mergeBase,
    mainOnlyCommits:counts[0],branchOnlyCommits:counts[1],shallow,dirty,
    remoteFreshness:baseRef.startsWith('refs/remotes/')?'local_tracking_ref_not_fetched':'local_branch_only'});
}

export function assertBranchComparison(project,expected){
  const current=inspectBranchComparison(project);
  // Audit reports can make a clean worktree dirty; Git identity must not move.
  const identity=value=>({...value,dirty:false});
  need(digest(identity(current))===digest(identity(expected)),'cm_test_comparison_changed');
}

const protectedPath=file=>/(^|\/)(?:\.env(?:\..*)?|\.git|credentials[^/]*|id_rsa|id_ed25519)(\/|$)|\.(?:pem|key|p12|pfx)$/i.test(file);
const mapPaths=['docs/architecture.md','docs/codebase-context/00-index.md','docs/codebase-context/07-business-logic.md'];

export function collectBranchImpact(project,comparison,contextPaths=[],customMapPaths=[]){
  for(const paths of [contextPaths,customMapPaths])
    need(Array.isArray(paths)&&paths.length<=64&&paths.every(safePath),'cm_test_sources_invalid');
  assertBranchComparison(project,comparison);
  const tokens=decode(git(project,['diff','--raw','-z','--no-abbrev','--find-renames','--no-ext-diff','--no-textconv','--ignore-submodules=none',
    comparison.base,comparison.head,'--'])).split('\0');
  const changes=[];
  for(let i=0;i<tokens.length-1;){
    const header=tokens[i++].match(/^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z]\d*)$/);
    need(header,'cm_test_diff_invalid');
    const [,oldMode,newMode,oldOid,newOid,status]=header;
    const oldPath=tokens[i++],newPath=/^[RC]/.test(status)?tokens[i++]:oldPath;
    need(safePath(oldPath)&&safePath(newPath),'cm_test_diff_path_invalid');
    changes.push({id:`C${changes.length+1}`,status,
      before:oldMode==='000000'?null:{path:oldPath,mode:oldMode,oid:oldOid},
      after:newMode==='000000'?null:{path:newPath,mode:newMode,oid:newOid}});
  }
  need(changes.length<=2000,'cm_test_diff_limit');
  const sources=[],gaps=[],seen=new Set();let budget=384*1024;
  function load(revision,entry){
    const key=`${revision}:${entry.path}`;if(seen.has(key))return;seen.add(key);
    let reason=null,content=null;
    if(protectedPath(entry.path))reason='protected_path';
    else if(!['100644','100755'].includes(entry.mode))reason='non_regular_blob';
    else{
      const size=Number(line(project,['cat-file','-s',entry.oid]));
      if(size>128*1024||size>budget||sources.length>=128)reason='material_budget';
      else{
        const bytes=git(project,['cat-file','blob',entry.oid]);
        try{content=decode(bytes);if(content.includes('\0'))reason='binary';}catch{reason='non_utf8';}
        if(!reason){budget-=bytes.length;sources.push({revision,...entry,content});}
      }
    }
    if(reason)gaps.push({revision,path:entry.path,reason});
  }
  // Maps first, then complete changed-file inventory and explicitly selected callers/tests.
  const selectedMaps=customMapPaths.length?[...new Set(customMapPaths)]:mapPaths;
  const contexts=[...new Set([...selectedMaps,...contextPaths])];
  for(const revision of ['base','head'])for(const file of contexts){
    const raw=git(project,['ls-tree','-z',comparison[revision],'--',`:(literal)${file}`]);
    for(const item of decode(raw).split('\0').filter(Boolean)){
      const match=item.match(/^(\d{6}) (blob|commit|tree) ([a-f0-9]+)\t([\s\S]+)$/);
      need(match&&match[4]===file,'cm_test_context_file_required');
      load(revision,{mode:match[1],oid:match[3],path:file});
    }
  }
  for(const change of changes){if(change.before)load('base',change.before);if(change.after)load('head',change.after);}
  assertBranchComparison(project,comparison);
  return json({comparison,changes,sources,gaps,mapPaths:selectedMaps});
}

export function inspectImpactAnalysis(input,response){
  shape(response,['summary','mapStatus','mapEvidence','results','gaps']);
  need(text(response.summary)&&['verified','partial','missing','stale','unverified'].includes(response.mapStatus)
    &&Array.isArray(response.gaps)&&response.gaps.every(text),'cm_test_impact_result_invalid');
  const evidence=items=>{
    need(Array.isArray(items),'cm_test_impact_evidence_invalid');
    for(const item of items){
      shape(item,['revision','path','line']);
      const source=input.sources.find(file=>file.revision===item.revision&&file.path===item.path);
      need(source&&Number.isInteger(item.line)&&item.line>0&&item.line<=source.content.split('\n').length,
        'cm_test_impact_evidence_invalid');
    }
  };
  evidence(response.mapEvidence);
  if(response.mapStatus==='verified')need(response.mapEvidence.some(item=>item.revision==='head'
    &&input.mapPaths.includes(item.path)),'cm_test_map_evidence_required');
  need(Array.isArray(response.results)&&response.results.length===input.changes.length,'cm_test_impact_coverage_invalid');
  const seen=new Set();
  for(const row of response.results){
    shape(row,['id','status','scenarios','regression','evidence','explanation']);
    const change=input.changes.find(item=>item.id===row.id);
    need(change&&!seen.has(row.id)&&['analyzed','unknown'].includes(row.status)&&text(row.explanation)
      &&Array.isArray(row.scenarios)&&row.scenarios.every(text)&&Array.isArray(row.regression)&&row.regression.every(text),
      'cm_test_impact_coverage_invalid');seen.add(row.id);evidence(row.evidence);
    if(row.status==='analyzed'){
      need(row.scenarios.length>0&&row.regression.length>0,'cm_test_impact_coverage_invalid');
      for(const [revision,entry] of [['base',change.before],['head',change.after]])if(entry){
        need(row.evidence.some(item=>item.revision===revision&&item.path===entry.path),'cm_test_impact_evidence_required');
      }
    }
  }
  return json(response,192*1024);
}
