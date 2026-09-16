// Fresh project-runner evidence, intersected with the selected Git diff.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {need,json,digest} from '../cm-ai/effect-contract.mjs';
import {createHostCheck} from '../cm-ai/host-check.mjs';
import {inspectDeclaredTestCommand} from './declared-command.mjs';
import {inspectBranchComparison} from './branch-impact.mjs';
import {inside,canonicalFuture,snapshotSource,sourceChanges,readSourceFiles} from './source-snapshot.mjs';

const relative=value=>typeof value==='string'&&value.length>0&&!value.includes('\\')&&!value.includes('\0')
  &&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
const git=(project,args)=>{
  const r=spawnSync('git',['--no-optional-locks','-C',project,...args],{encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024,
    env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'}});
  need(!r.error&&r.status===0,'coverage_git_failed');return r.stdout;
};
const count=value=>{need(Number.isSafeInteger(value)&&value>=0,'coverage_count_invalid');return value;};
const number=value=>{need(/^\d+$/.test(value),'coverage_count_invalid');return count(Number(value));};
const line=value=>{need(Number.isSafeInteger(value)&&value>0,'coverage_line_invalid');return value;};
const metric=(total,covered)=>({total,covered,percent:total?Math.round(covered/total*10000)/100:null});

export function parseUnitCoverage(text,format,project){
  const files=new Map();
  function get(name){
    need(typeof name==='string'&&!name.includes('\0'),'coverage_path_invalid');
    const full=path.resolve(project,name);
    if(!inside(project,full))return null;
    const key=path.relative(project,full).split(path.sep).join('/');
    need(relative(key),'coverage_path_invalid');
    if(!files.has(key))files.set(key,{lines:new Map(),branches:new Map(),branchData:true});return files.get(key);
  }
  const add=(map,key,hits)=>map.set(key,(map.get(key)??0)+count(hits));
  if(format==='lcov'){
    let current=null,record=false,declaredBranches=null,recordBranches=new Set();
    for(const row of text.split(/\r?\n/)){
      if(row.startsWith('SF:')){
        need(!record,'coverage_record_invalid');current=get(row.slice(3));record=true;declaredBranches=null;recordBranches=new Set();
      }else if(row==='end_of_record'){
        need(record,'coverage_record_invalid');
        if(current)current.branchData&&=declaredBranches===null?recordBranches.size>0:declaredBranches===recordBranches.size;
        record=false;current=null;
      }
      else if(row.startsWith('DA:')){
        need(record,'coverage_record_invalid');const parts=row.slice(3).split(',');need(parts.length>=2,'coverage_record_invalid');
        const n=line(number(parts[0])),hits=number(parts[1]);if(current)add(current.lines,n,hits);
      }else if(row.startsWith('BRDA:')){
        need(record,'coverage_record_invalid');const [n,block,branch,hits,...extra]=row.slice(5).split(',');
        need(extra.length===0&&block&&branch&&hits!==undefined,'coverage_record_invalid');
        const start=line(number(n)),value=hits==='-'?0:number(hits);
        const key=`${start}:${block}:${branch}`;recordBranches.add(key);if(current)add(current.branches,key,value);
      }else if(row.startsWith('BRF:')){
        need(record&&declaredBranches===null,'coverage_record_invalid');declaredBranches=number(row.slice(4));
      }
    }
    need(!record,'coverage_record_invalid');
  }else if(format==='istanbul'){
    const report=JSON.parse(text);need(report&&typeof report==='object'&&!Array.isArray(report),'coverage_report_invalid');
    for(const [name,item] of Object.entries(report)){
      need(item&&item.statementMap&&item.s&&item.branchMap&&item.b,'coverage_report_invalid');
      const file=get(item.path??name);if(!file)continue;
      for(const [id,statement] of Object.entries(item.statementMap)){
        const n=line(statement.start?.line),hits=count(item.s[id]);
        // Istanbul's line coverage uses the maximum statement hit on that line.
        file.lines.set(n,Math.max(file.lines.get(n)??0,hits));
      }
      for(const [id,branch] of Object.entries(item.branchMap)){
        need(Array.isArray(item.b[id])&&Array.isArray(branch.locations)&&item.b[id].length===branch.locations.length,'coverage_report_invalid');
        item.b[id].forEach((hits,index)=>add(file.branches,`${line(branch.line??branch.loc?.start?.line)}:${id}:${index}`,hits));
      }
    }
  }else need(false,'coverage_format_unsupported');
  need(files.size>0,'coverage_report_empty');return files;
}

export function changedUnitLines(project,{base,head,target='head',scope=[]}){
  need(['head','working-tree'].includes(target)&&Array.isArray(scope)&&scope.every(relative),'coverage_target_invalid');
  const revisions=target==='head'?[base,head]:[base];
  let names=git(project,['diff','--name-only','-z','--diff-filter=ACMRT','--no-renames','--ignore-submodules=none',...revisions,'--']).split('\0').filter(Boolean);
  if(target==='working-tree'){
    need(scope.length>0,'coverage_worktree_scope_required');
    const untracked=new Set(git(project,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean));
    names=[...new Set([...names.filter(file=>scope.includes(file)),...scope.filter(file=>untracked.has(file))])];
  }
  need(names.length<=2000&&names.every(relative),'coverage_diff_invalid');
  return names.map(file=>{
    const patch=git(project,['diff','--unified=0','--no-ext-diff','--no-textconv','--no-renames','--ignore-submodules=none',...revisions,'--',`:(literal)${file}`]);
    const lines=new Set();
    for(const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)){
      const start=Number(match[1]),size=Number(match[2]??1);need(size<=100000,'coverage_diff_limit');
      for(let n=start;n<start+size;n++)lines.add(n);
    }
    if(target==='working-tree'&&!patch){
      const full=path.join(project,file);need(fs.realpathSync(full)===full&&fs.lstatSync(full).isFile(),'coverage_source_invalid');
      const bytes=fs.readFileSync(full);need(bytes.length<=1024*1024&&!bytes.includes(0),'coverage_source_invalid');
      bytes.toString('utf8').split('\n').forEach((_,i)=>lines.add(i+1));
    }
    return {path:file,lines:[...lines].sort((a,b)=>a-b)};
  });
}

export function summarizeUnitCoverage(changes,files,exclusions=[]){
  need(Array.isArray(exclusions)&&exclusions.every(item=>relative(item.path)&&typeof item.reason==='string'&&item.reason.trim()),'coverage_exclusions_invalid');
  const rows=[];let total=0,covered=0,branches=0,coveredBranches=0;
  for(const change of changes){
    const exclusion=exclusions.find(item=>item.path===change.path);
    if(exclusion){rows.push({path:change.path,status:'excluded',reason:exclusion.reason});continue;}
    const measured=files.get(change.path);
    if(!measured){rows.push({path:change.path,status:'missing',changedLines:change.lines});continue;}
    const selected=change.lines.filter(n=>measured.lines.has(n));
    const missing=selected.filter(n=>measured.lines.get(n)===0),unmapped=change.lines.filter(n=>!measured.lines.has(n));
    const branchRows=[...measured.branches].filter(([key])=>change.lines.includes(Number(key.split(':')[0])));
    const uncoveredBranches=branchRows.filter(([,hits])=>hits===0).map(([key])=>key);
    total+=selected.length;covered+=selected.length-missing.length;branches+=branchRows.length;coveredBranches+=branchRows.length-uncoveredBranches.length;
    rows.push({path:change.path,status:unmapped.length||!measured.branchData?'partial':'measured',uncoveredLines:missing,unmappedLines:unmapped,
      branchStatus:!measured.branchData?'missing':branchRows.length?'measured':'not_applicable',
      lines:metric(selected.length,selected.length-missing.length),branches:metric(branchRows.length,branchRows.length-uncoveredBranches.length),uncoveredBranches});
  }
  const incomplete=rows.some(row=>['missing','partial'].includes(row.status));
  const branchGaps=rows.filter(row=>row.status==='missing'||row.branchStatus==='missing').map(row=>row.path);
  const branchMetric=metric(branches,coveredBranches);
  return {status:incomplete?'PARTIAL':total?'MEASURED':'NOT_APPLICABLE',lines:metric(total,covered),
    branches:{...branchMetric,percent:branchGaps.length?null:branchMetric.percent,measuredPercent:branchMetric.percent},branchGaps,files:rows,
    note:'Percentages cover mapped changed lines/branches only; missing files and unmapped lines are not proven covered. Branch percent is unknown when branch data is missing; measuredPercent is the measured subset only. Coverage is not business correctness.'};
}

function outputBoundary(project,relativeDir){
  need(relative(relativeDir)&&(relativeDir==='coverage'||relativeDir.startsWith('docs/test-reports/')),'coverage_output_invalid');
  const directory=path.join(project,relativeDir);need(canonicalFuture(directory)===directory,'coverage_output_invalid');
  need(!git(project,['ls-files','-z','--',`:(literal)${relativeDir}`]).trim(),'coverage_output_tracked');return directory;
}
const fingerprint=file=>{
  if(!fs.existsSync(file))return null;
  const stat=fs.lstatSync(file);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&fs.realpathSync(file)===file&&stat.size<=32*1024*1024,'coverage_report_invalid');
  return {hash:digest(fs.readFileSync(file).toString('base64')),mtime:stat.mtimeMs,ctime:stat.ctimeMs,ino:stat.ino};
};

export async function runUnitCoverage(config){
  const project=fs.realpathSync(config.project),comparison=inspectBranchComparison(project);
  const target=config.target??'head';
  if(config.comparison)need(config.comparison.base===comparison.base&&config.comparison.head===comparison.head,'coverage_comparison_changed');
  const selection={base:comparison.base,head:comparison.head,target,scope:config.scope??[]};
  const changes=changedUnitLines(project,selection);
  const common={schemaVersion:1,comparison,target,changes,completionAuthorized:false};
  if(!changes.length)return {...common,status:'NO_CHANGES',testsExecuted:false};
  if(!config.command)return {...common,status:'NOT_MEASURED',reason:'No existing declared unit-coverage command; do not estimate percentages or install tools.',testsExecuted:false};
  const outputDir=outputBoundary(project,config.outputDir);
  need(relative(config.report)&&inside(outputDir,path.join(project,config.report)),'coverage_report_path_invalid');
  const report=path.join(project,config.report),before=snapshotSource(project,outputDir);
  if(target==='head'){
    const dirty=git(project,['diff','--name-only','-z','--ignore-submodules=none',comparison.head,'--']).split('\0').filter(Boolean);
    const untracked=git(project,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
    const auditFiles=config.auditFiles??[];
    need(Array.isArray(auditFiles)&&auditFiles.length<=64&&auditFiles.every(file=>relative(file)
      &&/^docs\/test-reports\/.+\.(?:md|json|jsonl)$/.test(file)&&before.files[file]?.sha256),'coverage_audit_files_invalid');
    if(config.supplement){
      need(config.supplement.project===project,'unit_baseline_invalid');verifyUnitSupplement(config.supplement);
    }
    need(dirty.every(file=>config.supplement?.tests.includes(file)),'coverage_dirty_head');
    need(untracked.every(file=>inside(outputDir,path.join(project,file))||auditFiles.includes(file)
      ||config.supplement?.tests.includes(file)),'coverage_untracked_head');
  }
  const declaration=config.command.declaration;
  need(declaration&&relative(declaration.path),'coverage_declaration_required');
  const sources=readSourceFiles(project,[declaration.path],before);
  inspectDeclaredTestCommand(config.command,sources);
  const old=fingerprint(report),identity={repositoryId:'cm-test',runId:`unit-${randomUUID()}`,taskId:'coverage',attempt:1};
  const check=createHostCheck({cwd:project,commands:[{id:config.command.id,command:config.command.command}],timeoutMs:config.timeoutMs??60000});
  const [observed]=await check({identity},{signal:new AbortController().signal});
  outputBoundary(project,config.outputDir);
  const changed=sourceChanges(before,snapshotSource(project,outputDir));
  need(changed.length===0,'coverage_source_changed');
  const current=inspectBranchComparison(project);
  need(current.base===comparison.base&&current.head===comparison.head&&current.baseRef===comparison.baseRef,'coverage_comparison_changed');
  if(observed.outcome!=='passed')return {...common,status:observed.outcome==='failed'?'TESTS_FAILED':'BLOCKED',observed,testsExecuted:observed.exitCode!==null};
  const fresh=fingerprint(report);need(fresh&&digest(fresh)!==digest(old),'coverage_report_not_fresh');
  const format=config.format??(report.endsWith('.json')?'istanbul':'lcov');
  const result=summarizeUnitCoverage(changes,parseUnitCoverage(fs.readFileSync(report,'utf8'),format,project),config.exclusions??[]);
  return {...common,...result,observed,testsExecuted:true,report,reportDigest:fresh.hash,sourceDigest:before.digest};
}

// Test-only authoring is a separately authorized continuation, never implied by analysis.
export function prepareUnitSupplement(config){
  need(config.authorized===true,'unit_supplement_authorization_required');
  const project=fs.realpathSync(config.project),tests=config.tests;
  need(Array.isArray(tests)&&tests.length>0&&tests.length<=64&&new Set(tests).size===tests.length&&tests.every(file=>relative(file)
    &&/(^|\/)(?:tests?|__tests__)\/|(?:^|\/)test_[^/]+\.py$|(?:\.test|\.spec)\.[^/]+$|_test\.(?:go|rs)$/.test(file)
    &&!/(^|\/)(?:\.git|\.claude|\.codex|\.env[^/]*|AGENTS\.md|credentials[^/]*)(\/|$)/i.test(file)),'unit_test_scope_invalid');
  const outputDir=outputBoundary(project,config.outputDir??'coverage');
  for(const file of tests)need(canonicalFuture(path.join(project,file))===path.join(project,file)&&!inside(outputDir,path.join(project,file)),'unit_test_scope_invalid');
  const baseline={schemaVersion:1,project,tests,outputDir,before:snapshotSource(project,outputDir),completionAuthorized:false};
  return json({...baseline,baselineDigest:digest(baseline)},8*1024*1024);
}

export function verifyUnitSupplement(baseline){
  need(baseline.schemaVersion===1&&baseline.completionAuthorized===false,'unit_baseline_invalid');
  const {baselineDigest,...binding}=baseline;need(digest(binding)===baselineDigest,'unit_baseline_invalid');
  const after=snapshotSource(baseline.project,baseline.outputDir),changed=sourceChanges(baseline.before,after);
  need(after.gitState?.head===baseline.before.gitState?.head&&after.gitState?.index===baseline.before.gitState?.index,'unit_git_changed');
  need(changed.length>0&&changed.every(file=>baseline.tests.includes(file)),'unit_supplement_out_of_scope');
  // Existing tests may be extended; deletion is never a successful supplement.
  for(const file of changed)need(after.files[file]&&!after.files[file].missing&&fs.existsSync(path.join(baseline.project,file))
    &&fs.lstatSync(path.join(baseline.project,file)).isFile(),'unit_test_missing');
  return json({status:'REVIEW_REQUIRED',changedFiles:changed,sourceDigest:after.digest,completionAuthorized:false});
}
