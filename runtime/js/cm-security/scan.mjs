// Local scanner adapter: project content is data, never executable configuration.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {inspectBranchComparison} from '../cm-test/branch-impact.mjs';

const need=(condition,code)=>{if(!condition)throw new Error(code);};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const decode=value=>new TextDecoder('utf-8',{fatal:true}).decode(value);
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
const safe=file=>typeof file==='string'&&file.length>0&&!/[\x00-\x1f\\]/.test(file)
  &&!path.isAbsolute(file)&&file.split('/').every(p=>p&&p!=='.'&&p!=='..'&&p!=='.git');
const cleanPath=project=>(process.env.PATH??'').split(path.delimiter).filter(directory=>{
  if(!directory||!path.isAbsolute(directory))return false;
  try{return !inside(project,fs.realpathSync(directory));}catch{return false;}
}).join(path.delimiter);
const environment=(home,project)=>({PATH:cleanPath(project),HOME:home,USERPROFILE:home,
  TMPDIR:home,TMP:home,TEMP:home,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',
  ...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),
  GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',
  GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull});
const git=(project,args,optional=false)=>{
  // Git status/diff can run clean/process filters. Suppress every configured driver,
  // including required=true, in addition to fsmonitor, external diff and textconv.
  let boundary=project;
  for(let current=project;;current=path.dirname(current)){
    if(fs.existsSync(path.join(current,'.git'))){boundary=current;break;}
    if(path.dirname(current)===current)break;
  }
  const bin=executable('git',boundary);need(bin,'external_git_required');
  const env=environment(os.tmpdir(),boundary);
  const common=['--no-optional-locks','-c','core.fsmonitor=false','-C',project];
  const config=spawnSync(bin,[...common,'config','--name-only','--get-regexp','^filter\\..*\\.(clean|process|required)$'],
    {env,timeout:10000,maxBuffer:1024*1024});
  need(!config.error&&[0,1].includes(config.status),'git_config_read_failed');
  const disabled=[];
  for(const key of decode(config.stdout).split('\n').filter(Boolean)){
    need(/^filter\.[^\x00-\x1f]+\.(clean|process|required)$/.test(key),'unsafe_filter_config');
    disabled.push('-c',`${key}=${key.endsWith('.required')?'false':''}`);
  }
  const result=spawnSync(bin,[...common,...disabled,...args],{env,timeout:10000,maxBuffer:16*1024*1024});
  if(optional&&!result.error&&result.status!==0)return null;
  need(!result.error&&result.status===0,'git_read_failed');return result.stdout;
};
const paths=bytes=>decode(bytes).split('\0').filter(Boolean);
const protectedPath=file=>/(^|\/)(?:\.env(?:\..*)?|credentials[^/]*|id_rsa|id_ed25519)(\/|$)|\.(?:pem|key|p12|pfx)$/i.test(file);
const controlPath=file=>/(^|\/)(?:\.gitignore|\.gitleaks[^/]*|\.semgrep[^/]*|osv-scanner\.toml|\.gitmodules)$/.test(file);
const maps=['docs/architecture.md','docs/codebase-context/00-index.md','docs/codebase-context/07-business-logic.md'];
const locks=/(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Pipfile\.lock|requirements[^/]*\.txt|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|packages\.lock\.json)$/;

// Refuse symlink ancestors, even when their target happens to remain inside the project.
function workingFile(project,file){
  let current=project;
  for(const part of file.split('/')){
    current=path.join(current,part);
    let stat;try{stat=fs.lstatSync(current);}catch(error){if(error.code==='ENOENT')return {kind:'deleted'};throw error;}
    if(stat.isSymbolicLink())return {kind:'symlink'};
  }
  const stat=fs.lstatSync(current);
  if(!stat.isFile())return {kind:'non_regular'};
  if(stat.size>1024*1024)return {kind:'oversize'};
  const fd=fs.openSync(current,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{
    need(inside(project,fs.realpathSync(current)),'source_path_changed');
    const bytes=fs.readFileSync(fd);need(bytes.length<=1024*1024,'source_size_changed');
    return {kind:'file',bytes};
  }finally{fs.closeSync(fd);}
}

export function inventory(project,{all=false}={}){
  project=fs.realpathSync(project);
  need(fs.realpathSync(decode(git(project,['rev-parse','--show-toplevel'])).trim())===project,'project_root_required');
  const comparison=all?{head:decode(git(project,['rev-parse','HEAD'])).trim(),mode:'all'}:inspectBranchComparison(project,git);
  const index=new Map();
  for(const entry of paths(git(project,['ls-files','--stage','-z']))){
    const m=entry.match(/^(\d{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/);
    need(m&&safe(m[4]),'unsupported_git_path');need(m[3]==='0','unmerged_index');
    index.set(m[4],{mode:m[1],oid:m[2]});
  }
  const selected=all?[...index.keys()]:[...new Set([
    ...paths(git(project,['diff','--name-only','-z','--no-renames','--no-ext-diff','--no-textconv',comparison.base,comparison.head,'--'])),
    ...paths(git(project,['diff','--name-only','-z','--no-renames','--no-ext-diff','--no-textconv','HEAD','--'])),
    ...paths(git(project,['diff','--cached','--name-only','-z','--no-renames','--no-ext-diff','--no-textconv','HEAD','--']))])];
  need(selected.length<=2000,'scope_limit_2000');need(selected.every(safe),'unsupported_git_path');
  const files=[],gaps=[],state=[];let budget=50*1024*1024;
  for(const file of selected.sort()){
    const entry=index.get(file);
    state.push({file,index:entry??null});
    if(protectedPath(file)){gaps.push({path:file,reason:'protected_path_not_read'});continue;}
    const work=entry?workingFile(project,file):{kind:'deleted'};
    state.push({file,kind:work.kind,hash:work.bytes?hash(work.bytes):null});
    if(controlPath(file)){gaps.push({path:file,reason:'scanner_control_excluded_review_manually'});continue;}
    if(work.kind==='file'){
      budget-=work.bytes.length;need(budget>=0,'scope_limit_50mb');
      files.push({path:file,revision:'worktree',bytes:work.bytes,sha256:hash(work.bytes)});
    }else gaps.push({path:file,reason:work.kind==='deleted'?'deleted_review_baseline':work.kind});
    if(entry&&!['100644','100755'].includes(entry.mode)){
      gaps.push({path:file,reason:'index_non_regular'});continue;
    }
    if(entry){
      // Compare raw Git blob bytes, without invoking repository conversion filters.
      const oid=work.bytes?crypto.createHash(entry.oid.length===40?'sha1':'sha256')
        .update(`blob ${work.bytes.length}\0`).update(work.bytes).digest('hex'):null;
      if(oid===entry.oid)continue;
      const size=Number(decode(git(project,['cat-file','-s',entry.oid])).trim());
      if(size>1024*1024){gaps.push({path:file,reason:'index_oversize'});continue;}
      const bytes=git(project,['cat-file','blob',entry.oid]);
      if(!work.bytes||!bytes.equals(work.bytes)){
        budget-=bytes.length;need(budget>=0,'scope_limit_50mb');
        files.push({path:file,revision:'index',bytes,sha256:hash(bytes)});
      }
    }
  }
  const untracked=paths(git(project,['ls-files','--others','--exclude-standard','-z'])).length;
  const mapEvidence=maps.map(file=>{
    const tracked=index.get(file);
    if(!tracked||!['100644','100755'].includes(tracked.mode))return {path:file,status:'untracked_or_nonregular_excluded',sha256:null};
    const work=workingFile(project,file);
    return {path:file,status:work.kind,sha256:work.bytes?hash(work.bytes):null};
  });
  const identity={comparison:{...comparison,dirty:false},state,mapEvidence};
  return {project,comparison,selected,files,gaps,untracked,mapEvidence,digest:hash(JSON.stringify(identity))};
}

function executable(name,project){
  for(const directory of (process.env.PATH??'').split(path.delimiter)){
    if(!directory||!path.isAbsolute(directory))continue;
    for(const suffix of process.platform==='win32'?['.exe','']:['']){
      try{
        const file=fs.realpathSync(path.join(directory,name+suffix));
        if(inside(project,file)||!fs.statSync(file).isFile())continue;
        fs.accessSync(file,fs.constants.X_OK);return file;
      }catch{}
    }
  }
  return null;
}

function checkedConfig(file,project){
  const real=fs.realpathSync(file);
  need(!inside(project,real)&&fs.statSync(real).isFile(),'rules_must_be_external_regular_file');
  need(fs.statSync(real).size<=1024*1024,'rules_size_limit');return fs.readFileSync(real);
}

// Never retain scanner snippets, messages, secrets, stdout/stderr, or arbitrary result paths.
export function normalize(tool,data,files,root){
  const findings=[];
  const locate=(value,line=1)=>{
    need(typeof value==='string','invalid_result_path');
    const absolute=path.resolve(root,value);
    const relative=path.relative(root,absolute).split(path.sep).join('/');
    const match=files.find(f=>`${f.revision}/${f.path}`===relative);
    need(match&&Number.isInteger(line)&&line>0&&line<=match.bytes.toString('utf8').split('\n').length,'invalid_result_location');
    return {path:match.path,revision:match.revision,line};
  };
  const add=(location,rule,severity)=>{
    need(typeof rule==='string'&&/^[a-zA-Z0-9_.:/-]{1,200}$/.test(rule),'invalid_rule_id');
    findings.push({...location,tool,rule,severity,verification:'candidate'});
  };
  if(tool==='gitleaks'){
    need(Array.isArray(data),'invalid_gitleaks_json');
    for(const row of data)add(locate(row.File,row.StartLine),row.RuleID,'high');
  }else if(tool==='semgrep'){
    need(Array.isArray(data.results)&&Array.isArray(data.errors)&&data.paths&&Array.isArray(data.paths.scanned),'invalid_semgrep_json');
    need(data.errors.length===0,'semgrep_scan_errors');
    for(const row of data.results)add(locate(row.path,row.start?.line),row.check_id,
      ({ERROR:'high',WARNING:'medium',INFO:'low'})[row.extra?.severity]??'unknown');
    // All copied files must be accounted for; language/rule exclusions remain visible.
    const scanned=new Set(data.paths.scanned.map(f=>path.resolve(root,f)));
    return {findings,unscanned:files.filter(f=>!scanned.has(path.join(root,f.revision,f.path))).map(f=>({path:f.path,revision:f.revision}))};
  }else{
    need(Array.isArray(data.results),'invalid_osv_json');
    for(const result of data.results){
      need(Array.isArray(result.packages),'invalid_osv_packages');
      const location=locate(result.source?.path);
      for(const pkg of result.packages){
        need(Array.isArray(pkg.vulnerabilities),'invalid_osv_vulnerabilities');
        for(const item of pkg.vulnerabilities)add(location,item.id,'unknown');
      }
    }
  }
  return {findings,unscanned:[]};
}

function runTool(bin,args,options){
  const result=spawnSync(bin,args,{...options,detached:process.platform!=='win32',killSignal:'SIGKILL'});
  // On POSIX, also stop helper processes when a scanner times out or exits early.
  if(process.platform!=='win32'&&result.pid){try{process.kill(-result.pid,'SIGKILL');}catch{}}
  return result;
}

export function scan(project,options={}){
  const before=inventory(project,options);
  const report={schemaVersion:1,scope:options.all?'all-tracked':'branch-and-tracked-dirty',
    comparison:before.comparison,digest:before.digest,selected:before.selected,
    files:before.files.map(({bytes,...file})=>file),gaps:[...before.gaps],
    untrackedExcluded:before.untracked,businessMaps:before.mapEvidence,
    tools:[],findings:[],aiReview:'pending',coverage:'PARTIAL',result:'NO_FINDINGS',sourceUnchanged:null};
  if(options.inventoryOnly)return report;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cm-security-'));
  const root=path.join(temp,'source'),home=path.join(temp,'home');
  fs.mkdirSync(root);fs.mkdirSync(home);
  try{
    for(const file of before.files){
      const target=path.join(root,file.revision,file.path);
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.bytes,{mode:0o600});
    }
    for(const name of ['gitleaks','semgrep','osv-scanner']){
      const tool=name==='osv-scanner'?'osv':name;
      const row={tool,status:'NOT_RUN',reason:null};report.tools.push(row);
      if(!before.files.length){row.reason='no_scannable_files';continue;}
      const bin=executable(name,before.project);
      if(!bin){row.reason='tool_missing';continue;}
      const env={...environment(home,before.project),SEMGREP_SEND_METRICS:'off',SEMGREP_ENABLE_VERSION_CHECK:'0'};
      let args;
      if(tool==='gitleaks')args=['dir',root,'--redact=100','--no-banner','--no-color','--ignore-gitleaks-allow',
        '--report-format','json','--report-path',path.join(temp,'gitleaks.json')];
      if(tool==='semgrep'){
        if(!options.semgrepRules){row.reason='local_rules_required';continue;}
        const config=path.join(temp,'rules.yaml');
        const rules=checkedConfig(options.semgrepRules,before.project);row.rulesSha256=hash(rules);
        fs.writeFileSync(config,rules,{mode:0o600});
        args=['scan','--config',config,'--metrics=off','--disable-version-check','--no-git-ignore','--disable-nosem',
          '--json','--quiet','--no-rewrite-rule-ids','--timeout','10','--max-target-bytes','1048576',root];
      }
      if(tool==='osv'){
        if(!before.files.some(f=>locks.test(f.path))){row.reason='no_supported_lockfile_selected';continue;}
        if(!options.osvDb){row.reason='offline_database_required';continue;}
        const db=fs.realpathSync(options.osvDb);need(!inside(before.project,db)&&fs.statSync(db).isDirectory(),'external_database_required');
        env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=db;
        args=['scan','source','--offline','--format','json','--recursive',root];
      }
      const version=runTool(bin,tool==='gitleaks'?['version']:['--version'],{cwd:home,env,timeout:10000,maxBuffer:64*1024});
      row.version=version.stdout?.toString().match(/\b\d+\.\d+\.\d+\b/)?.[0]??'unknown';
      const result=runTool(bin,args,{cwd:home,env,timeout:options.timeoutMs??60000,maxBuffer:8*1024*1024,killSignal:'SIGKILL'});
      row.exitCode=result.status;
      if(result.error||![0,1].includes(result.status)){
        row.status='ERROR';row.reason=result.error?.code==='ETIMEDOUT'?'timeout':'execution_failed';continue;
      }
      try{
        const bytes=tool==='gitleaks'?fs.readFileSync(path.join(temp,'gitleaks.json')):result.stdout;
        need(bytes.length<=8*1024*1024,'report_size_limit');
        const parsed=normalize(tool,JSON.parse(bytes.toString('utf8')),before.files,root);
        need(result.status!==1||parsed.findings.length>0,'nonzero_without_findings');
        row.status=parsed.findings.length?'FINDINGS':'NO_FINDINGS';
        row.unscanned=parsed.unscanned;report.findings.push(...parsed.findings);
        if(parsed.unscanned.length)row.reason='unscanned_files';
        if(tool==='osv')row.reason='offline_database_freshness_and_ecosystem_coverage_unverified';
      }catch{
        row.status='ERROR';row.reason='invalid_or_incomplete_report';
      }
    }
    const after=inventory(before.project,options);
    report.sourceUnchanged=after.digest===before.digest;
    if(!report.sourceUnchanged)report.gaps.push({reason:'source_changed'});
    report.result=report.findings.length?'FINDINGS':'NO_FINDINGS';
    if(!report.sourceUnchanged)report.result='BLOCKED';
    if(report.sourceUnchanged&&!before.selected.length)report.result='NO_CHANGES';
    return report;
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
