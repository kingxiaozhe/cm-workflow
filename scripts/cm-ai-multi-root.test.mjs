import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {digest} from '../runtime/js/cm-ai/contracts.mjs';
import {captureReviewBaseline,createReviewPackage,verifyReviewPackage,readReviewBaseline,
  readReviewPackage,readReviewSourceFiles} from '../runtime/js/cm-ai/review-package.mjs';
import {codeProjectPaths,resolveCodeProjects,groupCodeProjectPaths,codeProjectInstructionPaths}
  from '../runtime/js/cm-ai/code-projects.mjs';
import {applyProtectedEdits,captureProtectedEdits,commitProtectedEdits} from '../runtime/js/cm-fix/protected-edits.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewResult,reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';

const identity={repositoryId:'multi-root-fixture',runId:'r3-fixture',taskId:'T-001',attempt:1};
const checks=[{id:'aggregate',command:['node','check.mjs'],outcome:'passed',exitCode:0,evidence:'Synthetic aggregate check'}];
const moduleURL=new URL('../runtime/js/cm-ai/review-package.mjs',import.meta.url).href;
function write(root,file,content){
  const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);
}
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-multi-root-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const prefix of ['apps/api','apps/web']){
    write(root,`${prefix}/AGENTS.md`,`# ${prefix} instructions\n`);
    write(root,`${prefix}/source.mjs`,'export const value = 1;\n');
    write(root,`${prefix}/requirement.md`,`Requirement for ${prefix}\n`);
    write(root,`${prefix}/.git`,'gitdir: deliberately unread pointer\n');
  }
  write(root,'AGENTS.md','# Workspace instructions\n');write(root,'apps/AGENTS.md','# Shared app instructions\n');
  write(root,'unrelated/.env','synthetic unrelated data');
  write(root,'specs/1.feature/tasks.md','- [ ] T-001: One task across both roots\n');
  const codeProjects=['apps/web','apps/api'].map(prefix=>path.join(root,prefix));
  const options={root,codeProjectPaths:['apps/web','apps/api'],specsRoot:path.join(root,'specs'),identity,
    scope:['apps/api/source.mjs','apps/web/source.mjs'],requirements:['apps/api/requirement.md','apps/web/requirement.md']};
  return {root,codeProjects,options};
}
function editBoth(root,codeProjects,scope){
  for(const group of groupCodeProjectPaths(root,codeProjects,scope)){
    const expected=captureProtectedEdits(group.codeProject,group.paths);
    applyProtectedEdits({cwd:group.codeProject,scope:group.paths,edits:group.paths.map(file=>({
      path:file,beforeSha256:expected[file],content:'export const value = 2;\n'}))});
  }
}
const resign=(value,key)=>{const {[key]:old,...body}=value;return {...body,[key]:digest(body)};};

test('visual check shape binds carriers without changing original command checks',t=>{
  const {root,codeProjects,options}=fixture(t),baseline=captureReviewBaseline(options);
  editBoth(root,codeProjects,options.scope);
  const before={path:path.join(root,'specs/before.png'),sha256:'a'.repeat(64),kind:'screenshot',description:'Synthetic before descriptor'};
  const after={...before,path:path.join(root,'specs/after.png'),sha256:'b'.repeat(64)};
  const visual={id:'visual',kind:'visual',outcome:'passed',evidence:'Synthetic shape validation only',before,after};
  for(const outcome of ['passed','failed','unavailable']){
    const result={...visual,outcome,after:outcome==='unavailable'?null:after};
    const pkg=createReviewPackage({root,baseline,checks:[...checks,result]});
    assert.deepEqual(readReviewPackage(pkg).checks,[...checks,result]);
  }
  for(const invalid of [{...visual,after:null},{...visual,outcome:'unavailable'},
    {...visual,command:['fake']},{...visual,before:{...before,path:'relative.png'}},
    {...visual,after:{...after,sha256:'bad'}},{...visual,after:{...after,description:' '}}])
    assert.throws(()=>createReviewPackage({root,baseline,checks:[invalid]}));
  assert.throws(()=>createReviewPackage({root,baseline,checks:[visual,visual]}));
  const pkg=createReviewPackage({root,baseline,checks:[visual]});
  assert.throws(()=>readReviewPackage({...pkg,checks:[{...visual,after:{...after,sha256:'c'.repeat(64)}}]}));
});

test('one aggregate baseline/package binds both roots and actual instructions, excluding unrelated siblings',t=>{
  const {root,codeProjects,options}=fixture(t),baseline=captureReviewBaseline(options);
  assert.deepEqual(baseline.codeProjectPaths,['apps/api','apps/web']);
  assert(!baseline.files.some(file=>file.path.startsWith('unrelated/')||file.path.startsWith('specs/')||file.path.endsWith('/.git')));
  const instructionPaths=['AGENTS.md','apps/AGENTS.md','apps/api/AGENTS.md','apps/web/AGENTS.md'];
  assert.deepEqual(codeProjectInstructionPaths(baseline.codeProjectPaths),instructionPaths);
  editBoth(root,codeProjects,options.scope);
  const pkg=createReviewPackage({root,baseline,checks});
  assert.deepEqual(pkg.identity,identity);assert.deepEqual(pkg.changes.map(change=>change.path),options.scope);
  assert.deepEqual(pkg.instructions.map(file=>file.path),instructionPaths);
  assert.deepEqual(readReviewBaseline(baseline),baseline);assert.deepEqual(readReviewPackage(pkg),pkg);
  const result={verdict:'approved',packageDigest:pkg.packageDigest,examinedPaths:reviewPaths(pkg),findings:[],summary:'Synthetic one-package review'};
  assert.equal(reviewResult(result,pkg).verdict,'approved');
  assert.throws(()=>reviewResult({...result,examinedPaths:result.examinedPaths.filter(file=>!file.startsWith('apps/web/'))},pkg),{code:'missing_material'});
  write(root,'unrelated/new.txt','outside declared roots');
  assert.equal(verifyReviewPackage({root,baseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}).outcome,'matched');
  write(root,'apps/web/AGENTS.md','# Changed web instructions\n');
  assert.throws(()=>verifyReviewPackage({root,baseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}),{code:'out_of_scope'});
});

test('missing, overlapping, aliased roots and scope outside selected roots fail before any edits',t=>{
  const {root,codeProjects,options}=fixture(t);
  for(const selected of [['missing'],['.'],['apps','apps/web'],['apps/web','apps/web'],['apps/web','apps/WEB']])
    assert.throws(()=>captureReviewBaseline({...options,codeProjectPaths:selected}));
  fs.symlinkSync('web',path.join(root,'apps/linked'));
  assert.throws(()=>resolveCodeProjects(root,[path.join(root,'apps/linked')]),{code:'unsupported_path'});
  for(const scope of [['unrelated/new.txt'],['apps/web'],['AGENTS.md']])
    assert.throws(()=>groupCodeProjectPaths(root,codeProjects,scope),{code:'out_of_scope'});
  assert.throws(()=>captureReviewBaseline({...options,scope:['unrelated/new.txt']}),{code:'out_of_scope'});
  assert.throws(()=>captureReviewBaseline({...options,requirements:['unrelated/new.txt']}),{code:'out_of_scope'});
  const baseline=captureReviewBaseline(options);editBoth(root,codeProjects,options.scope);
  write(root,'apps/web/extra.mjs','outside the task scope');
  assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:'out_of_scope'});
  assert.equal(fs.readFileSync(path.join(root,'AGENTS.md'),'utf8'),'# Workspace instructions\n');
});

test('persisted aggregate resumes in a new process and missing roots cannot become deletion-only success',t=>{
  const {root,codeProjects,options}=fixture(t),baseline=captureReviewBaseline(options);
  editBoth(root,codeProjects,options.scope);const pkg=createReviewPackage({root,baseline,checks});
  const saved=path.join(root,'specs/recovery.json');
  fs.writeFileSync(saved,JSON.stringify({root,baseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}));
  const source=`import fs from 'node:fs';import {verifyReviewPackage,readReviewBaseline} from ${JSON.stringify(moduleURL)};
    const saved=JSON.parse(fs.readFileSync(process.argv[1]));readReviewBaseline(saved.baseline);
    process.stdout.write(JSON.stringify(verifyReviewPackage(saved)));`;
  assert.equal(JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',source,saved],{encoding:'utf8'})).outcome,'matched');
  fs.renameSync(path.join(root,'apps/web'),path.join(root,'unrelated/saved-web'));
  assert.deepEqual(readReviewBaseline(baseline),baseline); // offline history remains readable
  assert.throws(()=>createReviewPackage({root,baseline,checks}));
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',source,saved],{stdio:'pipe'}));
  fs.symlinkSync('../unrelated/saved-web',path.join(root,'apps/web'));
  assert.throws(()=>createReviewPackage({root,baseline,checks}));
});

test('root metadata is sealed and workspace Learning remains separate from each root instructions',t=>{
  const {root,codeProjects,options}=fixture(t);
  const baseline=captureReviewBaseline({...options,scope:[...options.scope,'AGENTS.md']});
  editBoth(root,codeProjects,options.scope);write(root,'AGENTS.md','# Workspace instructions\nHost Learning entry\n');
  const pkg=createReviewPackage({root,baseline,checks});
  assert(pkg.changes.some(change=>change.path==='AGENTS.md'));
  const tampered=structuredClone(baseline);tampered.codeProjectPaths=['apps/api'];
  assert.throws(()=>readReviewBaseline(tampered),{code:'invalid_baseline'});
  assert.throws(()=>readReviewBaseline(resign(tampered,'baselineDigest')),{code:'invalid_baseline'});
  const changed=structuredClone(pkg);changed.instructions[0].contentBase64=Buffer.from('other').toString('base64');
  assert.throws(()=>readReviewPackage(resign(changed,'packageDigest')),{code:'invalid_package'});
  assert.deepEqual(codeProjectPaths(root,codeProjects),baseline.codeProjectPaths);
});

test('a selected root may contain protected specs but specs cannot be a selected code root',t=>{
  const {root,options}=fixture(t);write(root,'apps/api/specs/task.md','original host state');
  const specsRoot=path.join(root,'apps/api/specs');
  const baseline=captureReviewBaseline({...options,specsRoot});
  assert(!baseline.files.some(file=>file.path.startsWith('apps/api/specs/')));
  assert.throws(()=>captureReviewBaseline({...options,specsRoot,scope:['apps/api/specs/task.md']}),{code:'protected_specs'});
  assert.throws(()=>captureReviewBaseline({...options,specsRoot,codeProjectPaths:['apps/api/specs']}),{code:'protected_specs'});
});

test('original single-root baseline and package keep their exact default fields and digest shape',t=>{
  const {root}=fixture(t),single=path.join(root,'apps/api');
  const baseline=captureReviewBaseline({root:single,identity,scope:['source.mjs'],requirements:['requirement.md']});
  assert.deepEqual(Object.keys(baseline).sort(),['version','kind','identity','rootDigest','scope','requirements','files','baselineDigest'].sort());
  assert.deepEqual(baseline,resign(baseline,'baselineDigest'));
  write(single,'source.mjs','changed\n');const pkg=createReviewPackage({root:single,baseline,checks});
  assert.deepEqual(Object.keys(pkg).sort(),['version','kind','identity','rootDigest','baseIdentity','scope','changes','requirements','checks',
    'artifactDigest','requirementsDigest','checksDigest','packageDigest'].sort());
  assert.equal(verifyReviewPackage({root:single,baseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}).outcome,'matched');
});

test('bootstrap evidence permits empty code requirements, binds original req/design and ignores task checkbox changes',t=>{
  const {root,options}=fixture(t),specsRoot=options.specsRoot;
  write(specsRoot,'0.bootstrap/requirements.md','# Approved bootstrap requirements\n');
  write(specsRoot,'0.bootstrap/design.md','# Approved bootstrap design\n');
  write(specsRoot,'0.bootstrap/tasks.md','- [ ] T-001: Bootstrap both roots\n');
  const files=readReviewSourceFiles(specsRoot,['0.bootstrap/requirements.md','0.bootstrap/design.md']);
  const bootstrapRequirements={specsRoot,feature:'0.bootstrap',files};
  assert.throws(()=>captureReviewBaseline({...options,requirements:[]}));
  const baseline=captureReviewBaseline({...options,requirements:[],bootstrapRequirements});
  assert.deepEqual(baseline.requirements,[]);assert.deepEqual(readReviewBaseline(baseline),baseline);
  editBoth(root,options.codeProjectPaths.map(prefix=>path.join(root,prefix)),options.scope);const pkg=createReviewPackage({root,baseline,checks});
  assert.deepEqual(pkg.bootstrapRequirements.files,files);assert.deepEqual(readReviewPackage(pkg),pkg);
  write(specsRoot,'0.bootstrap/tasks.md','- [x] T-001: Bootstrap both roots\n');
  assert.equal(verifyReviewPackage({root,baseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}).outcome,'matched');
  const withTasks={...bootstrapRequirements,files:readReviewSourceFiles(specsRoot,['0.bootstrap/requirements.md','0.bootstrap/design.md','0.bootstrap/tasks.md'])};
  assert.throws(()=>captureReviewBaseline({...options,requirements:[],bootstrapRequirements:withTasks}));
  assert.throws(()=>captureReviewBaseline({...options,requirements:[],bootstrapRequirements:{...bootstrapRequirements,specsRoot:root}}),{code:'bootstrap_requirements_mismatch'});
  const empty=path.join(root,'empty');fs.mkdirSync(empty);
  const initial=captureReviewBaseline({root:empty,specsRoot,identity,scope:['AGENTS.md'],requirements:[],bootstrapRequirements});
  assert.deepEqual(readReviewBaseline(initial).files,[]);
  write(empty,'AGENTS.md','# Bootstrap-produced instructions\n');
  assert.deepEqual(readReviewPackage(createReviewPackage({root:empty,baseline:initial,checks})).bootstrapRequirements.files,files);
  write(specsRoot,'0.bootstrap/design.md','# Changed after approval\n');
  assert.deepEqual(readReviewBaseline(baseline),baseline);
  assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:'bootstrap_requirements_changed'});
});

test('native protected edits and real checks run per declared cwd and bind into one package',
  {skip:process.platform!=='darwin',timeout:30000},async t=>{
    const {root,codeProjects,options}=fixture(t),baseline=captureReviewBaseline(options),observed=[];
    const signal=new AbortController().signal;
    for(const [index,group] of groupCodeProjectPaths(root,codeProjects,options.scope).entries()){
      const expected=captureProtectedEdits(group.codeProject,group.paths);
      await commitProtectedEdits({cwd:group.codeProject,specsRoot:options.specsRoot,scope:group.paths,expected,identity,signal,timeoutMs:5000,
        edits:group.paths.map(file=>({path:file,beforeSha256:expected[file],content:'export const value = 2;\n'}))});
      const source=`const fs=require('node:fs'),assert=require('node:assert/strict');
        assert.equal(process.cwd(),${JSON.stringify(group.codeProject)});
        assert.match(fs.readFileSync('source.mjs','utf8'),/value = 2/);
        assert.throws(()=>fs.appendFileSync(${JSON.stringify(path.join(options.specsRoot,'1.feature/tasks.md'))},'forbidden'));
        assert.throws(()=>fs.appendFileSync('AGENTS.md','forbidden'));`;
      const run=createHostCheck({cwd:group.codeProject,specsRoot:options.specsRoot,timeoutMs:5000,
        commands:[{id:`root-${index}`,command:[process.execPath,'-e',source]}]});
      const results=await run({identity},{signal});assert(results.every(check=>check.outcome==='passed'),JSON.stringify(results));
      observed.push(...results.map(check=>({...check,evidence:`cwd=${group.codeProject}; ${check.evidence}`})));
    }
    const pkg=createReviewPackage({root,baseline,checks:observed});assert.equal(pkg.changes.length,2);assert.equal(pkg.checks.length,2);
    assert.equal(verifyReviewPackage({root,baseline,checks:observed,reviewPackage:pkg,expectedDigest:pkg.packageDigest}).outcome,'matched');
    assert.equal(fs.readFileSync(path.join(options.specsRoot,'1.feature/tasks.md'),'utf8'),'- [ ] T-001: One task across both roots\n');
  });

test('integrated original multi-root conversation completes one task and resumes without redispatch',
  {skip:process.platform!=='darwin'||Number(process.versions.node.split('.')[0])<24,timeout:45000},t=>{
    const {root,codeProjects,options}=fixture(t),specsDir=options.specsRoot;
    for(const name of ['requirements.md','design.md'])write(specsDir,`1.feature/${name}`,'# Approved synthetic two-root task\n');
    write(specsDir,'.cm-specs-status',JSON.stringify({status:'approved',features:['1.feature']}));
    write(root,'.cm-workflow.json',JSON.stringify({version:1,policies:{delivery:'diff'}}));
    const selected=resolveCodeProjects(root,codeProjects),definition={version:1,specsDir,codeProject:root,
      codeProjects:selected,feature:'1.feature',identity,scope:options.scope,requirements:options.requirements};
    const commands=selected.map((codeProject,index)=>({id:`root-${index}`,codeProject,
      command:[process.execPath,'-e',`const a=require('node:assert/strict');a.equal(process.cwd(),${JSON.stringify(codeProject)});import('./source.mjs').then(m=>a.equal(m.value,2));`]}));
    const protection={checkCommands:commands,timeoutMs:10000},workflow={documentationPaths:[],applicableAgentFiles:[],
      qa:{commands:commands.map(command=>({...command,caseIds:[]})),
        environment:{kind:'web',carrier:'browser',target:'http://127.0.0.1',scope:'local'}}};
    const configFile=path.join(specsDir,'integration.json'),bin=path.join(specsDir,'bin');
    write(specsDir,'integration.json',JSON.stringify({definition,protection,workflow}));fs.mkdirSync(bin);
    const fake=path.join(bin,'claude');
    fs.copyFileSync(new URL('./fixtures/claude-review-process.mjs',import.meta.url),fake);fs.chmodSync(fake,0o700);
    // Shadow only the synthetic reviewer process. Codex sandbox stays the actual installed binary.
    const env={...process.env,PATH:bin+path.delimiter+process.env.PATH};delete env.ANTHROPIC_API_KEY;
    const source=`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
      import {openControlRun,validateRunDefinition} from ${JSON.stringify(new URL('./cm-ai-run.mjs',import.meta.url).href)};
      import {createConversationExecution} from ${JSON.stringify(new URL('./cm-ai-host.mjs',import.meta.url).href)};
      import {claudeReviewFingerprint} from ${JSON.stringify(new URL('../runtime/js/cm-ai/worker-claude.mjs',import.meta.url).href)};
      const {definition:raw,protection,workflow}=JSON.parse(fs.readFileSync(process.argv[1]));
      const definition=validateRunDefinition(raw),mode=process.argv[2],calls=[];
      const bridge={async call(kind,payload){calls.push(kind);
        if(kind==='develop'){
          assert.equal(mode,'create');assert.deepEqual(payload.request.identity,definition.identity);
          assert.equal(payload.codeProject,definition.codeProject);assert.deepEqual(payload.codeProjects,definition.codeProjects);
          assert.deepEqual(payload.request.payload.scope,definition.scope);assert.equal(payload.editMode,'protected-text-v1');
          assert.deepEqual(payload.projectInstructions.map(row=>row.codeProject),definition.codeProjects);
          return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
            retrospective:{status:'no_new_lesson',candidates:[],reason:null}},edits:definition.scope.map(file=>({
              path:file,beforeSha256:payload.expected[file],content:'export const value = 2;\\n'}))};
        }
        if(kind==='qa_assess')return {scores:{scope:1,risk:1,accumulation:1,boundary:1},
          changes:{api:false,migration:false,authentication:false,authorization:false,payment:false}};
        assert.equal(kind,'documentation_inspect');
        for(const file of definition.scope)assert.equal(fs.readFileSync(path.join(definition.codeProject,file),'utf8'),'export const value = 2;\\n');
        const {syncId,identity,packageDigest,contextDigest}=payload;
        return {syncId,identity,packageDigest,contextDigest,status:'completed',reason:'Actual fixture roots read back',
          at:new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z')};
      }};
      const review={model:'fixture',disabledSkills:[],preflight:{passed:true,provider:'claude',cli_model:'fixture',prompt_transport:'stdin',
        config_fingerprint:claudeReviewFingerprint({cwd:definition.codeProject,model:'fixture'})}};
      const execution=createConversationExecution(definition,'multi-root-host',bridge,review,mode==='create'?null:1,
        workflow,true,'claude',{protection});
      const run=await openControlRun(definition,mode,execution);
      assert(run.host,JSON.stringify(run));
      try{const result=await run.host.handle({version:1,operation:'advance',requestId:'advance',identity:definition.identity});
        process.stdout.write(JSON.stringify({result,calls,checkpoint:run.checkpoint()}));}finally{run.close();}`;
    const invoke=mode=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',source,configFile,mode],
      {env,encoding:'utf8',timeout:18000,maxBuffer:2*1024*1024}));
    const first=invoke('create');assert.equal(first.result.state,'awaiting_review',JSON.stringify(first));
    assert.deepEqual(first.calls,['develop']);
    const stateFile=path.join(specsDir,'.reviews','.execution',identity.runId,'state.json');
    const state=()=>JSON.parse(fs.readFileSync(stateFile));
    const packages=value=>{
      if(!value||typeof value!=='object')return [];
      if(value.kind==='cm-review-package')return [value];
      return Object.values(value).flatMap(packages);
    };
    const initialPackages=packages(state());assert(initialPackages.length>0);
    const pkg=initialPackages.at(-1);
    assert.deepEqual(pkg.identity,identity);assert.deepEqual(pkg.codeProjectPaths,['apps/api','apps/web']);
    assert.deepEqual(pkg.changes.map(row=>row.path),options.scope);assert.equal(pkg.checks.length,2);
    for(const [index,codeProject] of selected.entries())assert(pkg.checks[index].evidence.includes(`cwd=${codeProject};`));
    assert.deepEqual(pkg.instructions.map(row=>row.path),['AGENTS.md','apps/AGENTS.md','apps/api/AGENTS.md','apps/web/AGENTS.md']);
    assert.match(fs.readFileSync(path.join(specsDir,'1.feature/tasks.md'),'utf8'),/\[ \]/);
    const completed=invoke('resume');assert.equal(completed.result.code,'run_done',JSON.stringify(completed));
    assert.deepEqual(completed.calls,['qa_assess','documentation_inspect']);
    const reopened=invoke('resume');assert.equal(reopened.result.code,'run_done',JSON.stringify(reopened));
    assert.deepEqual(reopened.calls,['documentation_inspect']);
    assert.equal(new Set(packages(state()).map(value=>value.packageDigest)).size,1);
    assert.equal(packages(state()).at(-1).packageDigest,pkg.packageDigest);
    assert.equal(state().records.filter(row=>row.payload.type==='review-invocation-registered').length,1);
    const tasks=fs.readFileSync(path.join(specsDir,'1.feature/tasks.md'),'utf8');
    assert.equal((tasks.match(/\[x\]/g)??[]).length,1);assert.equal((tasks.match(/T-001/g)??[]).length,1);
    const handoff=JSON.parse(fs.readFileSync(path.join(specsDir,'.reviews','feature-T-001-a1-handoff.json')));
    assert.deepEqual(handoff.changed_files,options.scope);
    const logs=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(logs.filter(row=>row.event==='run_done').length,1);
    assert.equal(logs.filter(row=>row.event==='test_run'&&row.phase==='start').length,1);
    assert.equal(logs.find(row=>row.event==='test_run'&&row.phase==='complete').result,'PASS');
  });
