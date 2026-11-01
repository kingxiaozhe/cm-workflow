import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseFeatureTaskText,validDependencies,identifyApprovedBootstrapFeature,approveCmAiSpecs} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {validateRunDefinition} from './cm-ai-run.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';

const entry=fileURLToPath(new URL('./cm-ai-admission.mjs',import.meta.url));
function fixture(run){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-product-admission-')));
  const specs=path.join(root,'specs'),code=path.join(root,'code'),feature=path.join(specs,'1.login');
  fs.mkdirSync(feature,{recursive:true});fs.mkdirSync(code);fs.writeFileSync(path.join(code,'README.md'),'existing\n');
  fs.writeFileSync(path.join(feature,'requirements.md'),'# Requirements\n');
  fs.writeFileSync(path.join(feature,'design.md'),'# Design\n');
  fs.writeFileSync(path.join(feature,'tasks.md'),'- [ ] T-001: implement login\n');
  try{return run({root,specs,code});}finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('product admission selects one approved task across every code project',()=>fixture(({root,specs,code})=>{
  const backend=path.join(root,'backend');fs.mkdirSync(backend);fs.writeFileSync(path.join(backend,'README.md'),'existing\n');
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.login'],testCases:[]}));
  const result=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,'--code-project',backend],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const admission=JSON.parse(result.stdout);
  assert.deepEqual(admission.nextTask,{feature:'1.login',id:'T-001',description:'implement login'});
  assert.deepEqual(admission.codeProjects,[code,backend]);
  assert.deepEqual(admission.projectAdmissions.map(item=>item.state),['ready','ready']);
}));

test('product admission reports generic continuation without approving or writing specs',()=>fixture(({root,specs,code})=>{
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'awaiting_review',features:['1.login'],testCases:[]}));
  const before=fs.readFileSync(path.join(specs,'.cm-specs-status'));
  const result=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,'--approval-response','继续'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).reason,'spec_approval_required');
  assert.deepEqual(fs.readFileSync(path.join(specs,'.cm-specs-status')),before);
  assert.equal(fs.readdirSync(root).length,2);
}));

test('spec approval accepts only normalized explicit start phrases',()=>fixture(({specs,code})=>{
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'awaiting_review',features:['1.login'],testCases:[]}));
  const run=reply=>{
    const result=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,'--approval-response',reply],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  for(const reply of ['开始','开始吧','可以开始','确认开始','开始执行','现在开始',' 开始吧。 ','现在开始！  ','可以开始!.～~ ']){
    const result=run(reply);assert.equal(result.approvalIntent,'explicit',reply);
    assert.equal(result.reason,'approval_write_required',reply);
  }
  for(const reply of ['继续','可以','好','好的','OK','按最优解处理','你看着办','行','开始开发','开始吧，请继续']){
    const result=run(reply);assert.equal(result.approvalIntent,'not_approval',reply);
    assert.equal(result.reason,'spec_approval_required',reply);
    assert.match(result.message,/回复.*开始/);
  }
}));
test('approve writes only after a whitelisted reply and preserves the original reply',()=>fixture(({specs,code})=>{
  const status=path.join(specs,'.cm-specs-status');
  fs.writeFileSync(status,JSON.stringify({status:'awaiting_review',features:['1.login'],testCases:[]}));
  const before=fs.readFileSync(status);
  const invoke=reply=>spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,
    '--approve','--approval-response',reply],{encoding:'utf8'});
  const rejected=invoke('好的');assert.equal(rejected.status,1);
  assert.equal(JSON.parse(rejected.stdout).approveRefused,'explicit_approval_required');
  assert.deepEqual(fs.readFileSync(status),before);
  const accepted=invoke('开始吧！');assert.equal(accepted.status,0,`stdout: ${accepted.stdout}\nstderr: ${accepted.stderr}`);
  assert.equal(JSON.parse(accepted.stdout).state,'ready');
  assert.equal(JSON.parse(fs.readFileSync(status,'utf8')).approval.response,'开始吧！');
}));

test('approve bound to a change proposal writes only for that saved proposal and its unchanged bytes',()=>fixture(({specs,code})=>{
  const status=path.join(specs,'.cm-specs-status'),digest='a'.repeat(64),other='b'.repeat(64);
  const saved=()=>fs.writeFileSync(status,JSON.stringify({status:'awaiting_review',revisionDigest:digest,
    features:['1.login'],specFiles:buildManifest(specs),testCases:[]}));
  const invoke=(...extra)=>spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,
    '--approve','--approval-response','开始',...extra],{encoding:'utf8'});
  const refused=(result,reason)=>{assert.equal(result.status,1,result.stderr);assert.equal(JSON.parse(result.stdout).approveRefused,reason);};
  saved();const before=fs.readFileSync(status);
  refused(invoke('--expect-revision-digest',other),'revision_digest_mismatch');
  assert.deepEqual(fs.readFileSync(status),before);
  // Bytes edited after the save are not the proposal the user confirmed.
  fs.appendFileSync(path.join(specs,'1.login','tasks.md'),'- [ ] T-002: unreviewed\n');
  refused(invoke('--expect-revision-digest',digest),'revision_files_changed');
  assert.deepEqual(fs.readFileSync(status),before);
  fs.writeFileSync(path.join(specs,'1.login','tasks.md'),'- [ ] T-001: implement login\n');
  // An unbound status (no revisionDigest) is refused rather than approved under the flag.
  fs.writeFileSync(status,JSON.stringify({status:'awaiting_review',features:['1.login'],specFiles:buildManifest(specs),testCases:[]}));
  refused(invoke('--expect-revision-digest',digest),'revision_digest_mismatch');
  // An approved status that only reopened because the feature list changed is not this proposal's save.
  fs.writeFileSync(status,JSON.stringify({status:'approved',revisionDigest:digest,features:['0.old'],
    specFiles:buildManifest(specs),testCases:[]}));
  refused(invoke('--expect-revision-digest',digest),'revision_digest_mismatch');
  saved();
  const accepted=invoke('--expect-revision-digest',digest);
  assert.equal(accepted.status,0,`stdout: ${accepted.stdout}\nstderr: ${accepted.stderr}`);
  assert.equal(JSON.parse(accepted.stdout).state,'ready');
  const approved=JSON.parse(fs.readFileSync(status,'utf8'));
  assert.equal(approved.status,'approved');assert.equal(approved.revisionDigest,digest);assert.equal(approved.approval.response,'开始');
  // Already approved: the same reply cannot approve again or rewrite the record.
  const once=fs.readFileSync(status),again=invoke('--expect-revision-digest',digest);
  assert.equal(again.status,1);assert.ok(JSON.parse(again.stdout).approveRefused);assert.deepEqual(fs.readFileSync(status),once);
  // The flag only binds an explicit approval; it never stands alone or takes a malformed digest.
  for(const args of [['--expect-revision-digest',digest],['--approve','--approval-response','开始','--expect-revision-digest','ABC']]){
    const result=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,...args],{encoding:'utf8'});
    assert.equal(result.status,2);assert.match(result.stderr,/--expect-revision-digest requires --approve/);
  }
}));

test('bound approve refuses changes made after its first check, before the approval is written',()=>fixture(({specs,code})=>{
  const status=path.join(specs,'.cm-specs-status'),digest='a'.repeat(64);
  const saved=(revision=digest)=>JSON.stringify({status:'awaiting_review',revisionDigest:revision,
    features:['1.login'],specFiles:buildManifest(specs),testCases:[]});
  const approve=beforeApprovalWrite=>approveCmAiSpecs({specsDir:specs,codeProjects:[code],approvalResponse:'开始',
    expectRevisionDigest:digest,beforeApprovalWrite});
  const requirements=path.join(specs,'1.login','requirements.md'),original=fs.readFileSync(requirements);
  const interleavings={
    'spec edited':()=>fs.appendFileSync(requirements,'unreviewed\n'),
    'another proposal saved':()=>fs.writeFileSync(status,saved('b'.repeat(64))),
    'duplicate approval landed':()=>assert.equal(approve().approveRefused,undefined)};
  for(const [name,interleave] of Object.entries(interleavings)){
    fs.writeFileSync(requirements,original);fs.writeFileSync(status,saved());
    let after;
    const result=approve(()=>{interleave();after=fs.readFileSync(status);});
    assert.equal(result.approveRefused,'revision_changed_during_approval',name);
    // The late writer never replaces what the interleaved writer left.
    assert.deepEqual(fs.readFileSync(status),after,name);
    assert.equal(fs.readdirSync(specs).filter(file=>file.startsWith('.cm-specs-status-')).length,0,name);
  }
  // Undisturbed, it approves with the manifest that was checked.
  fs.writeFileSync(requirements,original);fs.writeFileSync(status,saved());
  const checked=JSON.parse(fs.readFileSync(status,'utf8')).specFiles;
  assert.equal(approve().approveRefused,undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(status,'utf8')).specFiles,checked);
}));

test('bound approve compares against the exact status bytes it validated',()=>fixture(({specs,code})=>{
  const status=path.join(specs,'.cm-specs-status'),digest='a'.repeat(64);
  const saved=revision=>JSON.stringify({status:'awaiting_review',revisionDigest:revision,
    features:['1.login'],specFiles:buildManifest(specs),testCases:[]});
  const approve=()=>approveCmAiSpecs({specsDir:specs,codeProjects:[code],approvalResponse:'开始',expectRevisionDigest:digest});
  // Swap the status right after the bound check has parsed it (its first read of
  // the status in the approval), before anything else of the approval runs.
  const swapped={'another proposal saved':()=>fs.writeFileSync(status,saved('b'.repeat(64))),
    'duplicate approval landed':()=>assert.equal(approve().approveRefused,undefined)};
  const read=fs.readFileSync;
  for(const [name,swap] of Object.entries(swapped)){
    fs.writeFileSync(status,saved(digest));
    let reads=0,armed=true,after;
    fs.readFileSync=function(file,...rest){
      const result=read.call(this,file,...rest);
      // The inspections before the approval read the status too; count from the approval's own read.
      if(armed&&String(file).endsWith('.cm-specs-status')&&++reads===2){armed=false;swap();after=read(status);}
      return result;
    };
    let result;
    try{result=approveCmAiSpecs({specsDir:specs,codeProjects:[code],approvalResponse:'开始',expectRevisionDigest:digest});}
    finally{fs.readFileSync=read;}
    assert.equal(armed,false,name);
    assert.equal(result.approveRefused,'revision_changed_during_approval',name);
    assert.deepEqual(read(status),after,name);
  }
}));

test('standing authorization approves a bound scope-only change and nothing else',()=>fixture(({root,specs,code})=>{
  const status=path.join(specs,'.cm-specs-status'),digest='c'.repeat(64),home=path.join(root,'cm-home');
  fs.mkdirSync(home);
  const env={...process.env,CM_WORKFLOW_HOME:home};
  const read=name=>fs.readFileSync(path.join(specs,'1.login',name),'utf8');
  const requirements=read('requirements.md'),design=read('design.md');
  const archive=(over={})=>{fs.mkdirSync(path.join(specs,'.reviews'),{recursive:true});
    fs.writeFileSync(path.join(specs,'.reviews',`prd-change-${digest}.json`),JSON.stringify({version:1,
      before:{directories:['1.login'],files:{'1.login/requirements.md':requirements,'1.login/design.md':design,'1.login/tasks.md':'- [ ] T-001: old\n'}},
      proposal:{proposalDigest:digest,changedUserCases:[],removed:[],files:{'1.login/requirements.md':requirements,'1.login/design.md':design,
        '1.login/tasks.md':'- [ ] T-001: implement login\n'},...over},selected:['1.login']}));};
  const saved=()=>fs.writeFileSync(status,JSON.stringify({status:'awaiting_review',revisionDigest:digest,
    features:['1.login'],specFiles:buildManifest(specs),testCases:[]}));
  const invoke=(...extra)=>spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,'--approve',
    '--standing-authorization','--expect-revision-digest',digest,...extra],{encoding:'utf8',env});
  const refused=(result,reason)=>{assert.equal(result.status,1,result.stderr);assert.equal(JSON.parse(result.stdout).approveRefused,reason);};
  saved();archive();const before=fs.readFileSync(status);
  refused(invoke(),'standing_authorization_off');
  fs.writeFileSync(path.join(home,'autonomy.json'),JSON.stringify({version:1,mode:'until_fatal',response:'就按这份',at:'2026-11-01T00:00:00.000Z'}));
  for(const [over,why] of [[{files:{'1.login/requirements.md':'# changed\n','1.login/design.md':design,'1.login/tasks.md':'- [ ] T-001: implement login\n'}},/改了需求/],[{changedUserCases:[{id:'TC-001'}]},/用户用例/],
    [{proposalDigest:'d'.repeat(64)},/找不到/],[{files:[]},/不完整/]]){
    archive(over);const result=invoke();refused(result,'standing_authorization_not_applicable');
    assert.match(JSON.parse(result.stdout).approveReason,why);assert.deepEqual(fs.readFileSync(status),before);
  }
  // The archive must be what the specs hold: a requirement edited on disk, or an extra feature, is not this proposal.
  archive();
  fs.writeFileSync(path.join(specs,'1.login','requirements.md'),'# Requirements\nnew rule\n');saved();
  let result=invoke();refused(result,'standing_authorization_not_applicable');assert.match(JSON.parse(result.stdout).approveReason,/规格文件与提案不一致/);
  fs.writeFileSync(path.join(specs,'1.login','requirements.md'),requirements);
  const extra=path.join(specs,'2.new');fs.mkdirSync(extra);
  for(const name of ['requirements.md','design.md','tasks.md'])fs.writeFileSync(path.join(extra,name),'- [ ] T-001: x\n');
  fs.writeFileSync(status,JSON.stringify({status:'awaiting_review',revisionDigest:digest,features:['1.login','2.new'],specFiles:buildManifest(specs),testCases:[]}));
  result=invoke();refused(result,'standing_authorization_not_applicable');assert.match(JSON.parse(result.stdout).approveReason,/功能与提案不一致/);
  fs.rmSync(extra,{recursive:true});
  // A spec file the archive does not list (here a test contract with a user case) cannot ride along.
  fs.writeFileSync(path.join(specs,'1.login','test-cases.json'),JSON.stringify({schemaVersion:1,feature:'login',cases:[]}));saved();
  result=invoke();refused(result,'standing_authorization_not_applicable');assert.match(JSON.parse(result.stdout).approveReason,/规格文件与提案不一致/);
  fs.rmSync(path.join(specs,'1.login','test-cases.json'));saved();
  fs.rmSync(path.join(specs,'.reviews',`prd-change-${digest}.json`));
  refused(invoke(),'standing_authorization_not_applicable');
  // Standing authorization never mixes with a reply or stands alone without a bound proposal.
  for(const args of [['--approval-response','开始'],['--yes']]){
    const result=invoke(...args);assert.equal(result.status,2);assert.match(result.stderr,/--standing-authorization requires/);
  }
  const unbound=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,'--approve','--standing-authorization'],{encoding:'utf8',env});
  assert.equal(unbound.status,2);
  archive();
  const accepted=invoke();assert.equal(accepted.status,0,`stdout: ${accepted.stdout}\nstderr: ${accepted.stderr}`);
  const approved=JSON.parse(fs.readFileSync(status,'utf8'));
  assert.equal(approved.status,'approved');assert.equal(approved.revisionDigest,digest);
  assert.equal(approved.approval.response,'常设授权（2026-11-01T00:00:00.000Z）：就按这份');
}));

test('ready admission prints a directly valid run definition without writing the project',()=>fixture(({root,specs,code})=>{
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.login'],testCases:[]}));
  fs.writeFileSync(path.join(code,'package.json'),JSON.stringify({name:'login-app'}));
  const before=fs.readFileSync(path.join(specs,'.cm-specs-status'));
  const result=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,
    '--print-run-definition','--scope','src/a.js'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
  assert.equal(result.stdout.trim().split('\n').length,1);
  const definition=JSON.parse(result.stdout);
  assert.deepEqual(validateRunDefinition(definition),definition);
  assert.deepEqual(definition,{version:1,specsDir:specs,codeProject:code,feature:'1.login',
    identity:{repositoryId:'login-app',runId:'login-T-001',taskId:'T-001',attempt:1},scope:['src/a.js'],requirements:[]});
  assert.deepEqual(fs.readFileSync(path.join(specs,'.cm-specs-status')),before);
  assert.deepEqual(fs.readdirSync(root).sort(),['code','specs']);
  assert.deepEqual(fs.readdirSync(code).sort(),['README.md','package.json']);
  assert.deepEqual(fs.readdirSync(specs).sort(),['.cm-specs-status','1.login']);
}));

test('print-run-definition requires explicit scope and emits no draft when omitted',()=>fixture(({specs,code})=>{
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.login'],testCases:[]}));
  const result=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,
    '--print-run-definition'],{encoding:'utf8'});
  // Without a scope in tasks.md the session must still name the files.
  assert.equal(result.status,1);
  assert.equal(result.stdout,'');
  const error=JSON.parse(result.stderr).error;
  assert.equal(error.code,'scope_required');
  assert.match(error.reason,/--print-run-definition 需要 --scope：本任务允许修改的文件，相对代码根，逗号分隔/);
}));

test('print-run-definition takes the scope tasks.md declares and refuses a different --scope',()=>fixture(({specs,code})=>{
  fs.writeFileSync(path.join(specs,'1.login','tasks.md'),'- [ ] T-001: implement login\n  - 范围: `src/login.js`, `test/login.test.js`\n  - 测试文件: `test/login.test.js`\n');
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.login'],testCases:[]}));
  const run=(...extra)=>spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,'--print-run-definition',...extra],{encoding:'utf8'});
  const declared=run();
  assert.equal(declared.status,0,declared.stderr);
  assert.deepEqual(JSON.parse(declared.stdout).scope,['src/login.js','test/login.test.js']);
  // The same files in another order are the same scope.
  assert.equal(run('--scope','test/login.test.js,src/login.js').status,0);
  const different=run('--scope','src/login.js');
  assert.equal(different.status,1);assert.equal(different.stdout,'');
  assert.equal(JSON.parse(different.stderr).error.code,'task_scope_mismatch');
  // A malformed scope sub-item refuses instead of falling back to --scope.
  fs.writeFileSync(path.join(specs,'1.login','tasks.md'),'- [ ] T-001: implement login\n  - 范围: `src/*.js`\n');
  const invalid=run('--scope','src/login.js');
  assert.equal(invalid.status,1);assert.equal(JSON.parse(invalid.stderr).error.code,'task_scope_invalid');
}));

test('print-run-definition preserves non-ready admission output and exit status',()=>fixture(({specs,code})=>{
  const args=[entry,'--specs-dir',specs,'--code-project',code];
  for(const status of ['awaiting_review','invalid']){
    fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status,features:['1.login'],testCases:[]}));
    const original=spawnSync(process.execPath,args,{encoding:'utf8'});
    const printed=spawnSync(process.execPath,[...args,'--print-run-definition','--scope','src/a.js'],{encoding:'utf8'});
    assert.notEqual(JSON.parse(printed.stdout).state,'ready');
    assert.equal(printed.status,original.status);
    assert.equal(printed.stdout,original.stdout);assert.equal(printed.stderr,original.stderr);
    assert(!Object.hasOwn(JSON.parse(printed.stdout),'identity'));
  }
}));

function writeFeature(specs,name,source){
  const target=path.join(specs,name);fs.mkdirSync(target,{recursive:true});
  for(const file of ['requirements.md','design.md'])fs.writeFileSync(path.join(target,file),'# Fixture\n');
  fs.writeFileSync(path.join(target,'tasks.md'),source);
}

function admission(specs,code,names,exitCode=0){
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:names,testCases:[]}));
  const result=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code],{encoding:'utf8'});
  assert.equal(result.status,exitCode,result.stderr||result.stdout);
  return JSON.parse(result.stdout);
}

const threeTasks='- [x] T-001: first\n- [ ] T-002: second\n- [ ] T-003: third\n';

test('approved bootstrap identity accepts numbered scaffold and rejects ambiguous candidates',()=>fixture(({specs,code})=>{
  writeFeature(specs,'1.bootstrap','- [ ] T-001: 生成项目骨架 scaffold\n- [ ] T-002: 生成 AGENTS.md 和 .claude/ 规范\n');
  fs.rmSync(path.join(specs,'1.login'),{recursive:true});
  fs.rmSync(path.join(code,'README.md'));
  assert.equal(identifyApprovedBootstrapFeature(['1.bootstrap']),'1.bootstrap');
  assert.equal(identifyApprovedBootstrapFeature(['1.bootstrap-extra']),null);
  assert.equal(admission(specs,code,['1.bootstrap']).nextTask.feature,'1.bootstrap');
  assert.throws(()=>identifyApprovedBootstrapFeature(['0.bootstrap','1.bootstrap']),{code:'bootstrap_feature_ambiguous'});
  assert.throws(()=>identifyApprovedBootstrapFeature(['1.bootstrap','2.bootstrap']),{code:'bootstrap_feature_ambiguous'});
  for(const names of [['0.bootstrap','1.bootstrap'],['1.bootstrap','2.bootstrap']]){
    for(const name of names)if(!fs.existsSync(path.join(specs,name)))writeFeature(specs,name,'- [ ] T-001: scaffold\n');
    assert.equal(admission(specs,code,names,1).reason,'bootstrap_feature_ambiguous');
  }
}));

test('dependency parser accepts sentence punctuation per ID and preserves internal ID characters',()=>{
  for(const suffix of ['。','．','.','；',';','、',' 。 ．.；;、 \t']){
    const parsed=parseFeatureTaskText(threeTasks+`- T-002 依赖 T-001${suffix}\n- T-003 依赖 T-001${suffix}，T-002${suffix}\n`,
      {allowDependencyPunctuation:true});
    assert.equal(parsed.error,undefined);
    assert.deepEqual([...parsed.dependencies],[['T-002',['T-001']],['T-003',['T-001','T-002']]]);
    assert.equal(validDependencies(parsed.tasks,parsed.dependencies),true);
  }
  const parsed=parseFeatureTaskText('- [x] T-api.v1_beta-2: first\n- [ ] T-next: next\n- T-next 依赖 T-api.v1_beta-2。\n',
    {allowDependencyPunctuation:true});
  assert.deepEqual(parsed.dependencies.get('T-next'),['T-api.v1_beta-2']);
  assert.equal(validDependencies(parsed.tasks,parsed.dependencies),true);
});

test('shared parser defaults preserve cm-prd strict dependency validation',()=>{
  const source=threeTasks+'- T-002 依赖 T-001。\n';
  assert.equal(parseFeatureTaskText(source).error,'dependencies_invalid');
  const parsed=parseFeatureTaskText(source.replace('T-001。','T-001'));
  assert.equal(parsed.error,undefined);assert.equal(validDependencies(parsed.tasks,parsed.dependencies),true);
});

test('product admission selects the same task with single and multiple punctuated dependencies',()=>fixture(({specs,code})=>{
  const source=threeTasks+'- T-002 依赖 T-001。\n- T-003 依赖 T-001，T-002。\n';
  writeFeature(specs,'1.login',source);
  let result=admission(specs,code,['1.login']);
  assert.equal(result.state,'ready');assert.equal(result.nextTask.id,'T-002');
  writeFeature(specs,'1.login',source.replace('[ ] T-002','[x] T-002'));
  result=admission(specs,code,['1.login']);
  assert.equal(result.state,'ready');assert.equal(result.nextTask.id,'T-003');
}));

for(const [label,source,reason,line] of [
  ['internal punctuation',threeTasks+'- T-002 依赖 T-001。T-003\n','dependencies_invalid',4],
  ['punctuation only',threeTasks+'- T-002 依赖 。；\n','dependencies_invalid',4],
  ['punctuation-only second ID',threeTasks+'- T-002 依赖 T-001,。\n','dependencies_invalid',4],
  ['duplicate dependency',threeTasks+'- T-002 依赖 T-001。\n- T-002 依赖 T-003。\n','dependencies_invalid',5],
  ['unknown dependency',threeTasks+'- T-002 依赖 T-999。\n','dependencies_invalid',4],
  ['unknown dependent',threeTasks+'- T-999 依赖 T-001。\n','dependencies_invalid',4],
  ['self dependency',threeTasks+'- T-002 依赖 T-002。\n','dependencies_invalid',4],
  ['cycle',threeTasks+'- T-002 依赖 T-003。\n- T-003 依赖 T-002。\n','dependencies_invalid',4],
  ['duplicate task',threeTasks+`- [ ] T-002: ${'重复'.repeat(100)}\n`,'tasks_invalid',4],
  ['no tasks','\n# Empty task list\n','tasks_invalid',2],
  ['empty file','','tasks_invalid',1],
])test(`product admission locates ${label} and preserves earlier feature summaries`,()=>fixture(({specs,code})=>{
  writeFeature(specs,'1.login','- [x] T-001: historical completion\n');
  writeFeature(specs,'2.broken',source.replace(/\n/g,'\r\n'));
  writeFeature(specs,'3.later','- [ ] T-001: must not skip broken feature\n');
  const result=admission(specs,code,['1.login','2.broken','3.later'],1);
  assert.equal(result.state,'blocked');assert.equal(result.reason,reason);assert.equal(result.nextTask,null);
  assert.deepEqual(result.detail,{feature:'2.broken',line,text:source.split('\n')[line-1].slice(0,120)});
  assert(result.detail.text.length<=120);
  assert.deepEqual(result.features,[{name:'1.login',total:1,completed:1,dropped:0,pending:0}]);
  assert.equal(result.warnings.length,1);
}));

for(const source of [threeTasks+'- T-002 依赖 T-001。T-003\n',threeTasks+'- [ ] T-002: duplicate\n'])
test('bootstrap parse failures keep their diagnostic location in a non-empty project',()=>fixture(({specs,code})=>{
  writeFeature(specs,'0.bootstrap',source);
  const result=admission(specs,code,['0.bootstrap','1.login'],1);
  assert.equal(result.state,'blocked');assert.equal(result.nextTask,null);
  assert.equal(result.reason,source.includes('依赖')?'dependencies_invalid':'tasks_invalid');
  assert.deepEqual(result.detail,{feature:'0.bootstrap',line:4,text:source.split('\n')[3]});
}));

test('three punctuated historical features admit the new feature without changing selection order',()=>fixture(({specs,code})=>{
  const names=['1.login','2.profile','3.settings','4.todo-priority'];
  const historical='- [x] T-001: first\n- [x] T-002: second\n- [x] T-003: third\n'
    +'- T-002 依赖 T-001。\n- T-003 依赖 T-001，T-002。\n';
  for(const name of names.slice(0,3))writeFeature(specs,name,historical);
  writeFeature(specs,names[3],'- [ ] ~~T-000: removed~~ [DROPPED v2]\n'+threeTasks
    +'- T-002 依赖 T-001\n- T-003 依赖 T-001,T-002\n');
  let result=admission(specs,code,names);
  assert.equal(result.state,'ready');
  assert.deepEqual(result.nextTask,{feature:'4.todo-priority',id:'T-002',description:'second'});
  assert.deepEqual(result.features.map(item=>item.name),names);
  assert.equal(result.features[3].dropped,1);
  writeFeature(specs,'2.profile',historical.replace('[x] T-002','[ ] T-002'));
  result=admission(specs,code,names);
  assert.equal(result.state,'ready');
  assert.deepEqual(result.nextTask,{feature:'2.profile',id:'T-002',description:'second'});
  assert.deepEqual(result.features.map(item=>item.name),names.slice(0,2));
}));

test('parallel eligibility preserves nextTask and returns only dependency-ready members',()=>fixture(({specs,code})=>{
  fs.writeFileSync(path.join(specs,'1.login','tasks.md'),'- [ ] T-001: first\n- [ ] T-002: second\n- [ ] T-003: final\n\n- T-003 依赖 T-001, T-002\n');
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.login']}));
  const result=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const admission=JSON.parse(result.stdout);
  assert.equal(admission.nextTask.id,'T-001');
  assert.deepEqual(admission.eligibleTasks,[{feature:'1.login',id:'T-001'},{feature:'1.login',id:'T-002'}]);
}));

test('explicit task prints only a dependency-ready member and binds selection in the definition',()=>fixture(({specs,code})=>{
  fs.writeFileSync(path.join(specs,'1.login','tasks.md'),'- [ ] T-001: first\n- [ ] T-002: second\n- [ ] T-003: final\n\n- T-003 依赖 T-001, T-002\n');
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.login']}));
  const args=[entry,'--specs-dir',specs,'--code-project',code,'--print-run-definition','--scope','src/a.js'];
  const chosen=spawnSync(process.execPath,[...args,'--task','T-002'],{encoding:'utf8'});
  assert.equal(chosen.status,0,chosen.stderr);
  const definition=JSON.parse(chosen.stdout);
  assert.equal(definition.identity.taskId,'T-002');
  assert.deepEqual(definition.taskSelection,{version:1,taskId:'T-002'});
  assert.deepEqual(validateRunDefinition(definition),definition);
  for(const task of ['T-003','T-999']){
    const refused=spawnSync(process.execPath,[...args,'--task',task],{encoding:'utf8'});
    assert.equal(refused.status,1,refused.stderr);assert.equal(JSON.parse(refused.stderr).error.code,'task_selection_mismatch');
    assert.equal(refused.stdout,'');
  }
  const invalid=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,'--task','T-002'],{encoding:'utf8'});
  assert.equal(invalid.status,2);assert.match(invalid.stderr,/--print-run-definition/);
}));
