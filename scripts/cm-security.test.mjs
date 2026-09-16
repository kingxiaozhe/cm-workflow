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
