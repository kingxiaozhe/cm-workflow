// Final report authority lives here; model input supplies path reviews, never verdicts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {inventory} from './scan.mjs';
import {validBlockedReason} from '../cm-ai/effect-contract.mjs';

const need=(ok,code)=>{if(!ok)throw new Error(code);};
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const shape=(value,required,optional=[])=>need(object(value)&&required.every(k=>Object.hasOwn(value,k))
  &&Object.keys(value).every(k=>[...required,...optional].includes(k)),'invalid_report_shape');
const list=(value,max)=>need(Array.isArray(value)&&value.length<=max,'report_array_limit');
const hex=value=>need(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),'invalid_digest');
const choice=(value,choices)=>need(choices.includes(value),'invalid_report_value');
const text=value=>{try{validBlockedReason(value);}catch{throw new Error('invalid_review_string');}};
const safePath=value=>{text(value);need(!path.isAbsolute(value)&&!/[\x00-\x1f\\]/.test(value)
  &&value.split('/').every(p=>p&&p!=='.'&&p!=='..'&&p!=='.git'),'invalid_report_path');};
const integer=value=>need(Number.isSafeInteger(value)&&value>=0,'invalid_report_number');
const revision=value=>choice(value,['worktree','index']);
const redacted='[redacted]';
const reasons=['protected_path_not_read','scanner_control_excluded_review_manually','deleted_review_baseline',
  'symlink','non_regular','oversize','index_non_regular','index_oversize','source_changed',
  'no_scannable_files','tool_missing','local_rules_required','no_supported_lockfile_selected',
  'offline_database_required','timeout','execution_failed','unscanned_files',
  'offline_database_freshness_and_ecosystem_coverage_unverified','invalid_or_incomplete_report'];

function readExternal(project,file){
  need(typeof file==='string','finalize_inputs_required');
  const absolute=path.resolve(file),real=fs.realpathSync(absolute);
  need(!inside(project,absolute)&&!inside(project,real)&&fs.lstatSync(absolute).isFile(),
    'report_must_be_external_regular_file');
  const fd=fs.openSync(real,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{
    const stat=fs.fstatSync(fd);need(stat.isFile(),'report_must_be_external_regular_file');
    need(stat.size<=32*1024*1024,'report_size_limit');
    const bytes=fs.readFileSync(fd);need(bytes.length<=32*1024*1024,'report_size_limit');
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    catch{throw new Error('invalid_report_json');}
  }finally{fs.closeSync(fd);}
}

// Accept only scanner metadata, never arbitrary nested tool output or source bytes.
function validateScan(scan){
  shape(scan,['schemaVersion','scope','comparison','digest','selected','files','gaps','untrackedExcluded',
    'businessMaps','tools','findings','aiReview','coverage','result','sourceUnchanged']);
  need(scan.schemaVersion===1&&scan.aiReview==='pending'&&scan.coverage==='PARTIAL','invalid_scan_report');
  choice(scan.scope,['all-tracked','branch-and-tracked-dirty']);hex(scan.digest);
  choice(scan.result,['BLOCKED','FINDINGS','NO_FINDINGS','NO_CHANGES']);
  need(typeof scan.sourceUnchanged==='boolean','completed_scan_required');
  const c=scan.comparison;
  if(scan.scope==='all-tracked'){shape(c,['head','mode']);choice(c.mode,['all']);}
  else{
    shape(c,['baseRef','base','head','branch','comparison','mergeBase','mainOnlyCommits','branchOnlyCommits',
      'shallow','dirty','remoteFreshness']);
    safePath(c.baseRef);if(c.branch!==null)safePath(c.branch);
    for(const v of [c.base,c.mergeBase])if(v!==null)need(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v),'invalid_comparison');
    choice(c.comparison,['base-tree-to-head-tree']);
    choice(c.remoteFreshness,['local_tracking_ref_not_fetched','local_branch_only']);
    integer(c.mainOnlyCommits);integer(c.branchOnlyCommits);
    need(typeof c.shallow==='boolean'&&typeof c.dirty==='boolean','invalid_comparison');
  }
  need(typeof c.head==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(c.head),'invalid_comparison');
  list(scan.selected,2000);scan.selected.forEach(safePath);
  const selected=new Set(scan.selected);need(selected.size===scan.selected.length,'duplicate_selected_path');
  const selectedPath=value=>{safePath(value);need(selected.has(value),'invalid_scan_path');};
  list(scan.files,4000);
  for(const row of scan.files){shape(row,['path','revision','sha256']);selectedPath(row.path);revision(row.revision);hex(row.sha256);}
  list(scan.gaps,10000);
  for(const row of scan.gaps){shape(row,['reason'],['path']);choice(row.reason,reasons);if(row.path!==undefined)selectedPath(row.path);}
  integer(scan.untrackedExcluded);list(scan.businessMaps,3);
  for(const row of scan.businessMaps){
    shape(row,['path','status','sha256']);choice(row.path,['docs/architecture.md','docs/codebase-context/00-index.md','docs/codebase-context/07-business-logic.md']);
    choice(row.status,['untracked_or_nonregular_excluded','file','deleted','symlink','non_regular','oversize']);
    if(row.sha256!==null)hex(row.sha256);
  }
  list(scan.tools,3);need(scan.tools.length===3,'completed_scan_required');const seen=new Set();
  for(const row of scan.tools){
    shape(row,['tool','status','reason'],['rulesSha256','version','exitCode','unscanned']);
    choice(row.tool,['gitleaks','semgrep','osv']);need(!seen.has(row.tool),'duplicate_scan_tool');seen.add(row.tool);
    choice(row.status,['NOT_RUN','ERROR','FINDINGS','NO_FINDINGS']);if(row.reason!==null)choice(row.reason,reasons);
    if(row.rulesSha256!==undefined)hex(row.rulesSha256);
    if(row.version!==undefined)need(typeof row.version==='string'&&/^(?:unknown|\d+\.\d+\.\d+)$/.test(row.version),'invalid_tool_version');
    if(row.exitCode!==undefined&&row.exitCode!==null)integer(row.exitCode);
    if(row.unscanned!==undefined){list(row.unscanned,4000);for(const item of row.unscanned){shape(item,['path','revision']);selectedPath(item.path);revision(item.revision);}}
  }
  list(scan.findings,100000);
  for(const row of scan.findings){
    shape(row,['path','revision','line','tool','rule','severity','verification']);selectedPath(row.path);revision(row.revision);
    integer(row.line);need(row.line>0,'invalid_finding_line');choice(row.tool,['gitleaks','semgrep','osv']);
    need(typeof row.rule==='string'&&/^[a-zA-Z0-9_.:/-]{1,200}$/.test(row.rule),'invalid_rule_id');
    choice(row.severity,['high','medium','low','unknown']);choice(row.verification,['candidate']);
  }
  need(scan.sourceUnchanged||scan.result==='BLOCKED','invalid_scan_result');
  return scan;
}

function validateReview(review,scan){
  shape(review,['version','scanDigest','paths']);need(review.version===1,'invalid_review_version');
  hex(review.scanDigest);need(review.scanDigest===scan.digest,'review_digest_mismatch');list(review.paths,2000);
  const selected=new Set(scan.selected),seen=new Set();let count=0;
  const paths=review.paths.map(row=>{
    shape(row,['path','status'],['findings','reason']);safePath(row.path);
    need(selected.has(row.path),'review_path_unknown');need(!seen.has(row.path),'review_path_duplicate');seen.add(row.path);
    choice(row.status,['reviewed','not_reviewed']);
    if(row.status==='not_reviewed'){
      shape(row,['path','status','reason']);text(row.reason);
      // Preserve analyst prose, including reasons, under the boundary below.
      return {path:row.path,status:row.status,reason:row.reason};
    }
    shape(row,['path','status','findings']);list(row.findings,200);count+=row.findings.length;
    need(count<=2000,'review_findings_limit');
    const findings=row.findings.map(finding=>{
      shape(finding,['severity','location','attacker','vector','existingControls','impact','confidence','recommendation']);
      Object.values(finding).forEach(text);choice(finding.severity,['high','medium','low']);
      choice(finding.confidence,['static-inference','observed']);
      need(finding.location.startsWith(row.path+':')&&/^[1-9]\d*$/.test(finding.location.slice(row.path.length+1)),
        'invalid_review_location');
      // Redaction applies to raw tool output and literal secrets, not analyst conclusions.
      // Preserve validated prose verbatim. The model must not paste secrets or source
      // into findings or reasons; JavaScript cannot verify that semantic obligation.
      return {...finding};
    });
    return {path:row.path,status:row.status,findings};
  });
  for(const file of scan.selected)if(!seen.has(file))paths.push({path:file,status:'not_reviewed',reason:'not_reported'});
  return {version:1,scanDigest:review.scanDigest,paths};
}

export function finalize(project,{scanFile,reviewFile}={}){
  project=fs.realpathSync(project);
  const scan=validateScan(readExternal(project,scanFile));
  const reviewInput=readExternal(project,reviewFile);
  const review=validateReview(reviewInput,scan);
  const suppliedReasons=new Set(reviewInput.paths.filter(row=>row.status==='not_reviewed').map(row=>row.path));
  // Reuse the exact scope resolver and hardened Git reader. Comparison identity is
  // part of inventory's digest, so branch/base movement is drift too.
  const current=inventory(project,{all:scan.scope==='all-tracked'});
  const unchanged=current.digest===scan.digest;
  const gaps=[...scan.gaps];
  if(!unchanged)gaps.push({reason:'source_changed_during_review'});
  const summaryGaps=[...gaps];
  for(const row of review.paths)if(row.status==='not_reviewed'){
    gaps.push({path:row.path,reason:row.reason});
    summaryGaps.push({path:row.path,reason:suppliedReasons.has(row.path)?redacted:row.reason});
  }
  const coverage=review.paths.every(row=>row.status==='reviewed')&&!gaps.length
    &&scan.tools.every(row=>['FINDINGS','NO_FINDINGS'].includes(row.status)&&!row.reason)?'FULL':'PARTIAL';
  const findingsCount=scan.findings.length+review.paths.reduce((sum,row)=>sum+(row.findings?.length??0),0);
  // Even FULL coverage with no findings means only "nothing found this round".
  // REVIEWED_PARTIAL is intentional: there is no clean/safe verdict vocabulary.
  const result=scan.result==='BLOCKED'||!unchanged?'BLOCKED':findingsCount?'FINDINGS':!scan.selected.length?'NO_CHANGES':'REVIEWED_PARTIAL';
  const sourceUnchanged=scan.sourceUnchanged&&unchanged;
  const report={...scan,review,gaps,coverage,result,aiReview:'completed',findingsCount,sourceUnchanged,
    sourceWindows:{scan:{sourceUnchanged:scan.sourceUnchanged},review:{sourceUnchanged:unchanged,digest:current.digest}}};
  // Resolve/check TMPDIR before creating anything: the output must remain external.
  const tempRoot=fs.realpathSync(os.tmpdir());need(!inside(project,tempRoot),'external_temp_directory_required');
  const directory=fs.mkdtempSync(path.join(tempRoot,'cm-security-final-'));
  const reportPath=path.join(directory,'report.json');
  try{fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});}
  catch(error){fs.rmSync(directory,{recursive:true,force:true});throw error;}
  // Summary stdout excludes analyst prose; the private report retains it verbatim.
  return {result,coverage,reportPath,gaps:summaryGaps,findingsCount,sourceUnchanged};
}
