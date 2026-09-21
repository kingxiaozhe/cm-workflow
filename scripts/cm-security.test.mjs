import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync,execFileSync} from 'node:child_process';
import {inventory,scan,normalize} from '../runtime/js/cm-security/scan.mjs';
import {main} from './cm-security.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const gitBin=execFileSync('/bin/sh',['-c','command -v git'],{encoding:'utf8'}).trim();
function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'cm-security-test-'));
  const project=path.join(base,'project with spaces');fs.mkdirSync(project);
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const git=(...args)=>execFileSync(gitBin,['-c','core.fsmonitor=false','-C',project,...args],{stdio:['ignore','pipe','pipe']}).toString();
  const put=(file,text)=>{fs.mkdirSync(path.dirname(path.join(project,file)),{recursive:true});fs.writeFileSync(path.join(project,file),text);};
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');
  put('app.py','print("base")\n');git('add','.');git('commit','-m','base');git('switch','-c','feature');
  return {base,project,git,put};
}
function isolatedPath(t,f,programs={}){
  const old=process.env.PATH,bin=path.join(f.base,'bin');fs.mkdirSync(bin);
  fs.symlinkSync(gitBin,path.join(bin,'git'));
  for(const [name,body] of Object.entries(programs))fs.writeFileSync(path.join(bin,name),`#!${process.execPath}\n${body}`,{mode:0o700});
  process.env.PATH=bin;t.after(()=>{process.env.PATH=old;});
}
const fakeLeak=(body='')=>`
const fs=require('fs'),path=require('path'),args=process.argv.slice(2);
if(args.includes('--version')){console.log('9.0.0');process.exit(0);}
${body}
`;

test('scope includes branch commits, working/index differences, deletes and renames; excludes untracked',t=>{
  const f=fixture(t);f.put('app.py','print("feature")\n');f.put('renamed.py','ok\n');f.git('add','.');f.git('commit','-m','change');
  f.git('mv','renamed.py','new name.py');f.put('app.py','print("staged")\n');f.git('add','app.py');f.put('app.py','print("worktree")\n');
  f.put('untracked-private.txt','DO NOT READ');
  const result=inventory(f.project);
  assert.deepEqual(result.selected,['app.py','new name.py','renamed.py']);
  assert.equal(result.untracked,1);assert.ok(!result.files.some(v=>v.path==='untracked-private.txt'));
  assert.deepEqual(result.files.filter(v=>v.path==='app.py').map(v=>v.revision),['worktree','index']);
  assert.ok(result.gaps.some(v=>v.path==='renamed.py'&&v.reason==='deleted_review_baseline'));
});

test('full scope works without main; ambiguous/missing branch base blocks default',t=>{
  const f=fixture(t);f.git('branch','master');assert.throws(()=>inventory(f.project),/main_ambiguous/);
  assert.equal(inventory(f.project,{all:true}).files.length,1);
  f.git('branch','-D','main','master');assert.throws(()=>inventory(f.project),/main_missing/);
  assert.equal(inventory(f.project,{all:true}).files.length,1);
});

test('no change is distinct from partial and missing tools do not pass',t=>{
  const f=fixture(t);isolatedPath(t,f);
  assert.equal(scan(f.project).result,'NO_CHANGES');f.put('app.py','changed\n');
  const r=scan(f.project);assert.equal(r.coverage,'PARTIAL');assert.equal(r.sourceUnchanged,true);
  assert.ok(r.tools.every(v=>v.reason==='tool_missing'));assert.equal(r.aiReview,'pending');
});

// .env.example and friends are committed placeholder files meant to be copied.
// Treating them as real secret files hid exactly the case worth scanning: a real
// key pasted into the example. Only these four explicit suffixes are readable.
test('committed env examples are scanned while real env files stay protected',t=>{
  const f=fixture(t);
  for(const name of ['.env.example','.env.sample','.env.template','.env.dist'])f.put(name,'API_KEY=replace-me\n');
  f.put('nested/.env.example','TOKEN=replace-me\n');
  for(const name of ['.env','.env.local','.env.production','.env.example.bak'])f.put(name,'API_KEY=real\n');
  f.git('add','.');
  const r=inventory(f.project,{all:true});
  const gap=name=>r.gaps.some(v=>v.path===name&&v.reason==='protected_path_not_read');
  const read=name=>r.files.some(v=>v.path===name);
  for(const name of ['.env.example','.env.sample','.env.template','.env.dist','nested/.env.example']){
    assert.equal(read(name),true,`${name} 应当被扫描`);
    assert.equal(gap(name),false,`${name} 不应记为受保护跳过`);
  }
  // Real secret files keep their existing protection, including a suffix that
  // merely contains "example" rather than ending with it.
  for(const name of ['.env','.env.local','.env.production','.env.example.bak']){
    assert.equal(gap(name),true,`${name} 应当仍被保护`);
    assert.equal(read(name),false,`${name} 不应被读取`);
  }
});

test('symlink ancestor, protected files and scanner controls are visible gaps',t=>{
  const f=fixture(t);f.put('dir/file.py','ok');f.put('.env','private fixture');f.put('.gitleaks.toml','malicious rule');f.git('add','.');
  fs.renameSync(path.join(f.project,'dir'),path.join(f.base,'outside'));
  fs.symlinkSync(path.join(f.base,'outside'),path.join(f.project,'dir'));
  const r=inventory(f.project,{all:true});
  assert.ok(r.gaps.some(v=>v.path==='dir/file.py'&&v.reason==='symlink'));
  assert.ok(r.gaps.some(v=>v.path==='.env'&&v.reason==='protected_path_not_read'));
  assert.ok(r.gaps.some(v=>v.reason==='scanner_control_excluded_review_manually'));
  assert.ok(!r.files.some(v=>v.path==='.env'||v.path==='.gitleaks.toml'));
  assert.ok(!r.files.some(v=>v.path==='dir/file.py'&&v.revision==='worktree'));
});

test('source/config limits and malformed CLI are blocked',t=>{
  const f=fixture(t);f.put('large.py',Buffer.alloc(1024*1024+1));f.git('add','.');
  assert.ok(inventory(f.project).gaps.some(v=>v.reason==='oversize'));
  assert.throws(()=>main(['--all','--all']),/duplicate/);
  assert.throws(()=>main(['--project']),/required/);
  assert.throws(()=>main(['--untrusted-shell-command']),/unknown/);
});

test('Git fsmonitor configuration never executes during main-ref or scope reads',t=>{
  const f=fixture(t),marker=path.join(f.base,'called');
  const monitor=path.join(f.base,'monitor');fs.writeFileSync(monitor,`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o700});
  f.git('config','core.fsmonitor',monitor);inventory(f.project);assert.ok(!fs.existsSync(marker));
});

test('normalization strips secrets and rejects foreign file/line references',()=>{
  const files=[{path:'a.py',revision:'worktree',bytes:Buffer.from('a\nb\n')}];const base='/snapshot';
  const r=normalize('gitleaks',[{File:'worktree/a.py',StartLine:1,RuleID:'generic-api-key',Secret:'DO_NOT_OUTPUT',Match:'DO_NOT_OUTPUT'}],files,base);
  assert.equal(r.findings.length,1);assert.ok(!JSON.stringify(r).includes('DO_NOT_OUTPUT'));
  for(const [File,StartLine] of [['../../outside',1],['worktree/a.py',99]]){
    assert.throws(()=>normalize('gitleaks',[{File,StartLine,RuleID:'rule'}],files,base),/location/);
  }
  assert.throws(()=>normalize('semgrep',{results:[],errors:[{}],paths:{scanned:[]}},files,base),/errors/);
  const s=normalize('semgrep',{results:[],errors:[],paths:{scanned:[]}},files,base);assert.equal(s.unscanned.length,1);
  const o=normalize('osv',{results:[{source:{path:'worktree/a.py'},packages:[{vulnerabilities:[{id:'CVE-2099-1234',details:'DO_NOT_OUTPUT'}]}]}]},files,base);
  assert.equal(o.findings[0].rule,'CVE-2099-1234');assert.ok(!JSON.stringify(o).includes('DO_NOT_OUTPUT'));
});

test('adapter clears secrets/config environment and returns safe findings',t=>{
  const f=fixture(t);f.put('app.py','new\n');
  const prior=process.env.GITLEAKS_CONFIG,priorSecret=process.env.CM_TEST_PRIVATE_VALUE;
  process.env.GITLEAKS_CONFIG='malicious';process.env.CM_TEST_PRIVATE_VALUE='private';
  t.after(()=>{if(prior===undefined)delete process.env.GITLEAKS_CONFIG;else process.env.GITLEAKS_CONFIG=prior;
    if(priorSecret===undefined)delete process.env.CM_TEST_PRIVATE_VALUE;else process.env.CM_TEST_PRIVATE_VALUE=priorSecret;});
  isolatedPath(t,f,{gitleaks:fakeLeak(`
if(process.env.GITLEAKS_CONFIG||process.env.CM_TEST_PRIVATE_VALUE)process.exit(8);
if(!args.includes('--redact=100')||!args.includes('--ignore-gitleaks-allow'))process.exit(9);
fs.writeFileSync(args[args.indexOf('--report-path')+1],JSON.stringify([{File:'worktree/app.py',StartLine:1,RuleID:'fixture-rule',Secret:'PRIVATE_VALUE'}]));
console.error('PRIVATE_VALUE');process.exit(1);`)});
  const r=scan(f.project);assert.equal(r.result,'FINDINGS');assert.equal(r.findings.length,1);
  assert.equal(r.sourceUnchanged,true);assert.ok(!JSON.stringify(r).includes('PRIVATE_VALUE'));
});

for(const [name,body,reason] of [
  ['malformed',`fs.writeFileSync(args[args.indexOf('--report-path')+1],'{bad');`,'invalid_or_incomplete_report'],
  ['empty-nonzero',`fs.writeFileSync(args[args.indexOf('--report-path')+1],'[]');process.exit(1);`,'invalid_or_incomplete_report'],
  ['error',`console.error('sensitive-error');process.exit(2);`,'execution_failed'],
  ['timeout',`while(true){}`,'timeout'],
])test(`scanner ${name} cannot become a clean result`,t=>{
  const f=fixture(t);f.put('app.py','new');isolatedPath(t,f,{gitleaks:fakeLeak(body)});
  const r=scan(f.project,{timeoutMs:name==='timeout'?100:5000});
  assert.equal(r.tools[0].status,'ERROR');assert.equal(r.tools[0].reason,reason);
  assert.equal(r.coverage,'PARTIAL');assert.ok(!JSON.stringify(r).includes('sensitive-error'));
});

test('source mutation by a faulty external scanner blocks the result',t=>{
  const f=fixture(t);f.put('app.py','new');
  isolatedPath(t,f,{gitleaks:fakeLeak(`fs.writeFileSync(${JSON.stringify(path.join(f.project,'app.py'))},'changed again');fs.writeFileSync(args[args.indexOf('--report-path')+1],'[]');`)});
  const r=scan(f.project);assert.equal(r.result,'BLOCKED');assert.equal(r.sourceUnchanged,false);
});

test('optional scanners require explicit local inputs and OSV remains offline',t=>{
  const f=fixture(t);f.put('package-lock.json','{}\n');f.git('add','.');
  const rules=path.join(f.base,'rules.yaml');fs.writeFileSync(rules,'rules: []');const db=path.join(f.base,'db');fs.mkdirSync(db);
  isolatedPath(t,f,{
    semgrep:fakeLeak(`if(!args.includes('--metrics=off')||!args.includes('--disable-nosem'))process.exit(8);console.log(JSON.stringify({results:[],errors:[],paths:{scanned:[]}}));`),
    'osv-scanner':fakeLeak(`if(!args.includes('--offline')||!process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY)process.exit(8);console.log(JSON.stringify({results:[]}));`),
  });
  let r=scan(f.project);assert.equal(r.tools[1].reason,'local_rules_required');assert.equal(r.tools[2].reason,'offline_database_required');
  r=scan(f.project,{semgrepRules:rules,osvDb:db});assert.equal(r.tools[1].reason,'unscanned_files');
  assert.equal(r.tools[2].reason,'offline_database_freshness_and_ecosystem_coverage_unverified');
  f.put('rules.yaml','rules: []');assert.throws(()=>scan(f.project,{semgrepRules:path.join(f.project,'rules.yaml')}),/external/);
});

test('installed Gitleaks smoke: synthetic key, negative control, source unchanged, no raw secret',t=>{
  const probe=spawnSync('gitleaks',['version'],{encoding:'utf8'});
  if(probe.error||probe.status!==0){t.skip('Gitleaks not installed; adapter fixtures still run');return;}
  const f=fixture(t),secret='gh'+'p_'+crypto.createHash('sha256').update('cm-security-inert-example').digest('hex').slice(0,36);
  f.put('fixture.txt',`value = "${secret}"\n`);f.put('safe.py','import os\nvalue = os.getenv("ACCESS_TOKEN")\n');f.git('add','.');
  const r=scan(f.project);
  assert.equal(r.tools[0].status,'FINDINGS');assert.ok(r.findings.some(v=>v.path==='fixture.txt'));
  assert.ok(!r.findings.some(v=>v.path==='safe.py'));assert.ok(!JSON.stringify(r).includes(secret));assert.equal(r.sourceUnchanged,true);
});

test('CLI returns a machine-readable blocked result without echoing bad arguments',()=>{
  const r=spawnSync(process.execPath,[path.join(root,'scripts/cm-security.mjs'),'--arbitrary-sensitive-value'],{encoding:'utf8'});
  assert.equal(r.status,2);assert.equal(JSON.parse(r.stdout).result,'BLOCKED');assert.ok(!r.stdout.includes('sensitive-value'));
});

test('clean/process filters cannot execute and required filters are disabled',t=>{
  const f=fixture(t),marker=path.join(f.base,'filter-called');
  const driver=path.join(f.base,'driver');fs.writeFileSync(driver,`#!/bin/sh\ntouch '${marker}'\ncat\n`,{mode:0o700});
  f.put('.gitattributes','app.py filter=probe\n');f.git('add','.');f.git('commit','-m','attributes');
  f.put('app.py','modified raw content\n');
  f.git('config','filter.probe.clean',driver);f.git('config','filter.probe.required','true');
  assert.ok(inventory(f.project).selected.includes('app.py'));assert.ok(!fs.existsSync(marker));
  f.git('config','filter.probe.process',driver);
  assert.ok(inventory(f.project).selected.includes('app.py'));assert.ok(!fs.existsSync(marker));
});

test('Git lookup skips project binaries and child PATH excludes project directories',t=>{
  const f=fixture(t),marker=path.join(f.base,'git-called');
  f.put('bin/git',`#!/bin/sh\ntouch '${marker}'\nexec '${gitBin}' "$@"\n`);fs.chmodSync(path.join(f.project,'bin/git'),0o700);
  const old=process.env.PATH;process.env.PATH=path.join(f.project,'bin')+path.delimiter+old;t.after(()=>{process.env.PATH=old;});
  inventory(f.project);assert.ok(!fs.existsSync(marker));
  fs.mkdirSync(path.join(f.project,'nested'));
  assert.throws(()=>inventory(path.join(f.project,'nested')),/root_required/);
  assert.ok(!fs.existsSync(marker));
});

test('untracked and ignored business maps are never read or hashed',t=>{
  const f=fixture(t);f.put('docs/architecture.md','private map');
  let r=inventory(f.project,{all:true});assert.equal(r.mapEvidence[0].sha256,null);
  assert.equal(r.mapEvidence[0].status,'untracked_or_nonregular_excluded');
  f.put('.gitignore','docs/architecture.md\n');r=inventory(f.project,{all:true});assert.equal(r.mapEvidence[0].sha256,null);
});

test('deleted tracked paths cannot pull same-name untracked private content into a scan',t=>{
  const f=fixture(t);f.git('rm','--cached','app.py');f.put('app.py','NEW_UNTRACKED_PRIVATE');
  let r=inventory(f.project);assert.equal(r.untracked,1);assert.ok(!r.files.some(v=>v.path==='app.py'));
  assert.ok(r.gaps.some(v=>v.path==='app.py'&&v.reason==='deleted_review_baseline'));
  f.git('commit','-m','remove');r=inventory(f.project);assert.ok(!r.files.some(v=>v.path==='app.py'));
  assert.ok(!JSON.stringify(r).includes('NEW_UNTRACKED_PRIVATE'));
});

test('empty initial scope never overrides concurrent source drift with NO_CHANGES',t=>{
  const f=fixture(t);isolatedPath(t,f);
  const original=fs.mkdtempSync;
  fs.mkdtempSync=(...args)=>{const result=original(...args);f.put('app.py','changed during scan');return result;};
  try{const r=scan(f.project);assert.equal(r.sourceUnchanged,false);assert.equal(r.result,'BLOCKED');}
  finally{fs.mkdtempSync=original;}
});

// Controlled scanner metadata makes FULL reachable without installed scanners or
// pretending that the real OSV freshness/coverage gap has been resolved.
function finalizeFixture(t,{all=true}={}){
  const f=fixture(t);isolatedPath(t,f);
  f.put('other.py','other\n');f.git('add','.');f.git('commit','-m','second path');
  if(!all){f.git('switch','main');}
  const report=scan(f.project,{all});
  report.tools=report.tools.map(row=>({...row,status:'NO_FINDINGS',reason:null}));
  const review={version:1,scanDigest:report.digest,paths:report.selected.map(file=>({path:file,status:'reviewed',findings:[]}))};
  const scanFile=path.join(f.base,'scan.json'),reviewFile=path.join(f.base,'review.json');
  const run=(r=review,s=report,{cli=false}={})=>{
    fs.writeFileSync(scanFile,JSON.stringify(s));fs.writeFileSync(reviewFile,JSON.stringify(r));
    const args=['--project',f.project,'--finalize','--scan',scanFile,'--review',reviewFile];
    let value,code,stdout;
    if(cli){const child=spawnSync(process.execPath,[path.join(root,'scripts/cm-security.mjs'),...args],{encoding:'utf8'});
      code=child.status;stdout=child.stdout;value=JSON.parse(stdout);
    }else value=main(args);
    const output=value.reportPath?JSON.parse(fs.readFileSync(value.reportPath,'utf8')):null;
    if(value.reportPath)t.after(()=>fs.rmSync(path.dirname(value.reportPath),{recursive:true,force:true}));
    return {value,output,code,stdout};
  };
  return {...f,report,review,run,scanFile,reviewFile};
}

test('finalize coverage requires every selected path and rejects unknown or malformed review input',t=>{
  const f=finalizeFixture(t);
  assert.equal(f.run().value.coverage,'FULL');
  const missing={...f.review,paths:f.review.paths.slice(1)};
  let r=f.run(missing);assert.equal(r.value.coverage,'PARTIAL');
  assert.ok(r.value.gaps.some(row=>row.path==='app.py'&&row.reason==='not_reported'));
  assert.equal(r.output.aiReview,'completed');
  r=f.run({...f.review,paths:[{path:'app.py',status:'not_reviewed',reason:'SOURCE_OR_SECRET_SENTINEL'},f.review.paths[1]]});
  assert.equal(r.value.coverage,'PARTIAL');assert.ok(!JSON.stringify(r.value).includes('SOURCE_OR_SECRET_SENTINEL'));assert.equal(r.output.review.paths[0].reason,'SOURCE_OR_SECRET_SENTINEL');
  for(const mutate of [
    r=>r.paths.push({path:'unknown.py',status:'reviewed',findings:[]}),
    r=>r.paths.push(r.paths[0]),r=>{r.result='NO_CHANGES';},r=>{r.aiReview='completed';},
    r=>{r.scanDigest='0'.repeat(64);},r=>{r.paths[0].reason='not allowed';},
    r=>{r.paths[0]={path:'app.py',status:'not_reviewed'};},
    r=>{r.paths[0]={path:'app.py',status:'not_reviewed',reason:'\0'};},
    r=>{r.paths[0]={path:'app.py',status:'not_reviewed',reason:'界'.repeat(334)};},
    r=>{r.paths=Array(2001).fill(r.paths[0]);},
  ]){
    const input=structuredClone(f.review);mutate(input);
    assert.throws(()=>f.run(input),/review_path_unknown|review_path_duplicate|invalid_report_shape|review_digest_mismatch|invalid_review_string|report_array_limit/);
  }
  const unknown=f.run({...f.review,paths:[{path:'unknown.py',status:'reviewed',findings:[]}]},f.report,{cli:true});
  assert.equal(unknown.code,2);assert.equal(unknown.value.reason,'review_path_unknown');
  for(const update of [s=>{s.gaps.push({path:'app.py',reason:'index_oversize'});},
    s=>{s.tools[0].reason='unscanned_files';},s=>{s.tools[0].status='ERROR';}]){
    const s=structuredClone(f.report);update(s);assert.equal(f.run(f.review,s).value.coverage,'PARTIAL');
  }
  assert.throws(()=>f.run(f.review,{...f.report,rawOutput:'SOURCE_OR_SECRET_SENTINEL'}),/invalid_report_shape/);
  f.run();f.put('inside.json',JSON.stringify(f.review));
  assert.throws(()=>main(['--project',f.project,'--finalize','--scan',f.scanFile,'--review',path.join(f.project,'inside.json')]),/external_regular/);
  const link=path.join(f.base,'linked.json');fs.symlinkSync(f.reviewFile,link);
  assert.throws(()=>main(['--project',f.project,'--finalize','--scan',f.scanFile,'--review',link]),/external_regular/);
  assert.throws(()=>main(['--project',f.project,'--finalize','--scan',f.scanFile,'--review',f.base]),/external_regular/);
  assert.throws(()=>main(['--finalize','--all','--scan',f.scanFile,'--review',f.reviewFile]),/mode_conflict/);
  assert.throws(()=>main(['--finalize']),/inputs_required/);
  assert.throws(()=>main(['--scan',f.scanFile]),/mode_required/);
});

test('finalize detects the second drift window and retains the original scan window',t=>{
  const f=finalizeFixture(t);f.put('app.py','changed after scan\n');
  let r=f.run(f.review,f.report,{cli:true});
  assert.equal(r.code,2);assert.equal(r.value.result,'BLOCKED');assert.equal(r.value.coverage,'PARTIAL');
  assert.equal(r.value.sourceUnchanged,false);assert.ok(r.value.gaps.some(g=>g.reason==='source_changed_during_review'));
  assert.equal(r.output.sourceWindows.scan.sourceUnchanged,true);assert.equal(r.output.sourceWindows.review.sourceUnchanged,false);
  f.put('app.py','print("base")\n');
  const blocked={...f.report,result:'BLOCKED',sourceUnchanged:false,gaps:[{reason:'source_changed'}]};
  r=f.run(f.review,blocked,{cli:true});assert.equal(r.code,2);
  assert.equal(r.output.sourceWindows.scan.sourceUnchanged,false);assert.equal(r.output.sourceWindows.review.sourceUnchanged,true);
  assert.equal(r.value.sourceUnchanged,false);assert.ok(r.value.gaps.some(g=>g.reason==='source_changed'));
  f.git('branch','-m','renamed-feature');
  // all-tracked binds HEAD, not branch name. Default scope binds its comparison too.
  const defaultScan=scan(f.project),review={version:1,scanDigest:defaultScan.digest,paths:defaultScan.selected.map(file=>({path:file,status:'reviewed',findings:[]}))};
  f.git('branch','-m','another-feature');r=f.run(review,defaultScan,{cli:true});assert.equal(r.code,2);
  assert.ok(r.value.gaps.some(g=>g.reason==='source_changed_during_review'));
});

test('finalize verdicts stay conservative, finding prose stays in the private report, and empty scope is NO_CHANGES',t=>{
  const f=finalizeFixture(t);let r=f.run(f.review,f.report,{cli:true});
  assert.equal(r.code,3);assert.equal(r.value.result,'REVIEWED_PARTIAL');assert.equal(r.value.coverage,'FULL');
  assert.deepEqual(Object.keys(r.value).sort(),['result','coverage','reportPath','gaps','findingsCount','sourceUnchanged'].sort());
  assert.ok(path.relative(f.project,r.value.reportPath).startsWith('..'+path.sep));
  if(process.platform!=='win32')assert.equal(fs.statSync(r.value.reportPath).mode&0o777,0o600);
  const finding={severity:'high',location:'app.py:1',attacker:'SOURCE_OR_SECRET_SENTINEL',vector:'SOURCE_OR_SECRET_SENTINEL',
    existingControls:'SOURCE_OR_SECRET_SENTINEL',impact:'SOURCE_OR_SECRET_SENTINEL',confidence:'static-inference',recommendation:'SOURCE_OR_SECRET_SENTINEL'};
  const review=structuredClone(f.review);review.paths[0].findings=[finding];
  r=f.run(review,f.report,{cli:true});assert.equal(r.code,1);assert.equal(r.value.result,'FINDINGS');assert.equal(r.value.findingsCount,1);
  assert.ok(!r.stdout.includes('SOURCE_OR_SECRET_SENTINEL'));assert.deepEqual(r.output.review.paths[0].findings[0],finding);
  for(const patch of [{extra:'secret'},{severity:'critical'},{confidence:'guessed'},{location:'other.py:1'},{impact:'\u0001'},{impact:' '}]){
    const bad=structuredClone(review);Object.assign(bad.paths[0].findings[0],patch);assert.throws(()=>f.run(bad));
  }
  const many=structuredClone(review);many.paths[0].findings=Array(201).fill(finding);assert.throws(()=>f.run(many),/report_array_limit/);
  const toolFinding={path:'app.py',revision:'worktree',line:1,tool:'gitleaks',rule:'fixture-rule',severity:'high',verification:'candidate'};
  r=f.run(f.review,{...f.report,result:'FINDINGS',findings:[toolFinding]},{cli:true});assert.equal(r.code,1);assert.equal(r.value.findingsCount,1);
  for(let i=0;i<9;i++)f.put(`extra${i}.py`,'fixture\n');
  f.git('add','.');f.git('commit','-m','finding count fixture');
  const largeScan=scan(f.project,{all:true});
  const tooMany={version:1,scanDigest:largeScan.digest,paths:largeScan.selected.map(file=>({path:file,status:'reviewed',
    findings:Array.from({length:182},()=>({...finding,location:`${file}:1`}))}))};
  assert.throws(()=>f.run(tooMany,largeScan),/review_findings_limit/);
  f.git('switch','main');const empty=scan(f.project),emptyReview={version:1,scanDigest:empty.digest,paths:[]};
  r=f.run(emptyReview,empty,{cli:true});assert.equal(r.code,0);assert.equal(r.value.result,'NO_CHANGES');
  assert.equal(r.value.coverage,'PARTIAL');assert.equal(r.output.aiReview,'completed');
  f.put('app.py','drift from empty scope\n');r=f.run(emptyReview,empty,{cli:true});assert.equal(r.code,2);assert.equal(r.value.result,'BLOCKED');
});
