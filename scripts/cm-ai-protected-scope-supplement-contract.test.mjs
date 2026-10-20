import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createProtectedScopeSupplement,validateProtectedScopeSupplement,projectProtectedScopeCommands} from '../runtime/js/cm-ai/protected-scope-supplement.mjs';

function fixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-scope-supplement-')));
  try{
    const definition={version:1,specsDir:path.join(root,'specs'),codeProject:path.join(root,'project'),feature:'1.fixture',
      identity:{repositoryId:'fixture',runId:'scope',taskId:'T-001',attempt:1},scope:['code.js'],requirements:['requirements.md']};
    const definitionFile=path.join(root,'run.json');fs.writeFileSync(definitionFile,JSON.stringify(definition)+'\n');
    const statement=`const scope=new Set(JSON.parse(fs.readFileSync('${definitionFile}','utf8')).scope);`;
    const script=`const fs=require('node:fs');${statement}for(const [p,h]of Object.entries(baseline.protectedFiles)){if(!scope.has(p)&&hash(p)!==h)throw Error('protected drift: '+p)}assertContrast(4.5);runAllChecks();`;
    const protection=[{id:'regression',command:['node','-e',script]}];
    const qa=[{id:'qa-regression',command:['node','-e',script],caseIds:['TC-001']}];
    const material={definition,execution:{kind:'cm-current-conversation-v1',definitionDigest:digest(definition),hostContextId:'fixture-host',
      controlPolicy:{version:2,development:'conversation',bootstrap:'disabled',qa:'run',qaFix:'disabled'},
      protection:{checkCommands:protection,timeoutMs:900000},workflow:{qa:{commands:qa,environment:{target:'fixture'}}}}};
    const scope=['code.js','settings.spec.tsx'],raw={version:1,definitionFile,checkIds:['regression','qa-regression']};
    const fingerprint=digest(material),make=()=>createProtectedScopeSupplement(raw,{material,configFingerprint:digest(material),scope});
    return fn({root,definition,definitionFile,statement,script,material,scope,raw,fingerprint,make,protection,qa});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
const invalid='scope_check_supplement_invalid',drift='scope_check_supplement_drift',unsupported='scope_check_reference_unsupported';
test('builder freezes the exact original material and definition file without changing original bytes',()=>fixture(f=>{
  const bytes=fs.readFileSync(f.definitionFile),original=JSON.stringify(f.material),s=f.make();
  assert.equal(digest(s.material),f.fingerprint);assert.deepEqual(s.material,f.material);assert.equal(s.definitionFile.size,bytes.length);
  assert.equal(JSON.stringify(f.material),original);assert.deepEqual(fs.readFileSync(f.definitionFile),bytes);assert(Object.isFrozen(s.material.execution.protection));
  assert.deepEqual(validateProtectedScopeSupplement(JSON.parse(JSON.stringify(s)),{configFingerprint:f.fingerprint,scope:f.scope,originalScope:f.definition.scope}),s);
}));
test('projection only replaces the proven Set argument and preserves every other command byte and QA field',()=>fixture(f=>{
  const s=f.make(),result=projectProtectedScopeCommands(f.protection,s,f.scope);
  assert.equal(result[0].command[2],f.script.replace(`JSON.parse(fs.readFileSync('${f.definitionFile}','utf8')).scope`,JSON.stringify(f.scope)));
  assert.equal(f.protection[0].command[2],f.script);assert(result[0].command[2].includes('assertContrast(4.5);runAllChecks();'));
  const qa=projectProtectedScopeCommands(f.qa,s,f.scope);assert.deepEqual(qa[0].caseIds,['TC-001']);assert.equal(qa[0].id,'qa-regression');
}));
test('pure replay validation needs no live definition file, but execution rechecks exact bytes and mode',()=>fixture(f=>{
  const s=f.make();fs.unlinkSync(f.definitionFile);
  assert.equal(validateProtectedScopeSupplement(s,{configFingerprint:f.fingerprint,scope:f.scope,originalScope:f.definition.scope}).version,1);
  assert.throws(()=>projectProtectedScopeCommands(f.protection,s,f.scope),{code:drift});
  assert.equal(projectProtectedScopeCommands(f.protection,s,f.scope,{recheck:false})[0].command[1],'-e');
}));
test('definition newline-only drift, mode drift, link and hardlink all fail closed',()=>fixture(f=>{
  const s=f.make(),bytes=fs.readFileSync(f.definitionFile),mode=fs.statSync(f.definitionFile).mode&0o7777;
  fs.appendFileSync(f.definitionFile,'\n');assert.throws(()=>projectProtectedScopeCommands(f.protection,s,f.scope),{code:drift});fs.writeFileSync(f.definitionFile,bytes);
  fs.chmodSync(f.definitionFile,mode===0o644?0o600:0o644);assert.throws(()=>projectProtectedScopeCommands(f.protection,s,f.scope),{code:drift});fs.chmodSync(f.definitionFile,mode);
  const other=path.join(f.root,'other.json');fs.linkSync(f.definitionFile,other);assert.throws(()=>f.make(),{code:drift});fs.unlinkSync(other);
  fs.renameSync(f.definitionFile,other);fs.symlinkSync(other,f.definitionFile);assert.throws(()=>f.make(),{code:drift});
}));
test('supplement rejects changed material, identity scope, unsafe extra capability fields and non-additive scopes',()=>fixture(f=>{
  const s=f.make(),validate=(v,extra={})=>validateProtectedScopeSupplement(v,{configFingerprint:f.fingerprint,scope:f.scope,originalScope:f.definition.scope,...extra});
  const changed=structuredClone(s);changed.material.execution.protection.timeoutMs++;assert.throws(()=>validate(changed),{code:invalid});
  assert.throws(()=>validate(s,{originalScope:['other.js']}),{code:invalid});
  for(const scope of [['settings.spec.tsx'],f.definition.scope,['code.js','requirements.md'],['code.js','AGENTS.md'],['code.js','a.js','A.js']])
    assert.throws(()=>validate(s,{scope}),{code:invalid});
  assert.throws(()=>createProtectedScopeSupplement({...f.raw,commands:[]},{material:f.material,configFingerprint:f.fingerprint,scope:f.scope}),{code:invalid});
}));
test('unsupported execution modes cannot gain a supplement by hashing their own configuration',()=>fixture(f=>{
  for(const change of [m=>{m.execution.providerDevelopment={model:'fixture'};},m=>{m.execution.parallelMember='member';},
    m=>{m.parallelSelection={version:1};},m=>{m.bootstrap={};},m=>{m.execution.controlPolicy.version=1;},
    m=>{m.execution.controlPolicy.development='provider';},m=>{m.definition.codeProjects=[m.definition.codeProject];},
    m=>{m.execution.kind='other';},m=>{m.execution.definitionDigest='0'.repeat(64);},
    m=>{m.execution.protection.binaryAssets={version:1,paths:['font.ttf'],sourceRoot:'/tmp/fixture-assets'};}]){
    const m=structuredClone(f.material);change(m);assert.throws(()=>createProtectedScopeSupplement(f.raw,{material:m,configFingerprint:digest(m),scope:f.scope}),{code:invalid});
  }
}));
test('commands cannot be removed, modified, duplicated or newly added, and checkIds are fixed',()=>fixture(f=>{
  const s=f.make();for(const commands of [[],[...f.protection,...f.protection],[{...f.protection[0],command:['node','-e','fakePass()']}],
    [{...f.protection[0],env:{SKIP:'1'}}]])assert.throws(()=>projectProtectedScopeCommands(commands,s,f.scope),{code:invalid});
  for(const checkIds of [['regression','regression'],['missing']])assert.throws(()=>createProtectedScopeSupplement({...f.raw,checkIds},{material:f.material,configFingerprint:f.fingerprint,scope:f.scope}),{code:invalid});
}));
test('exact double quoted scope reference is supported without changing other bytes',()=>fixture(f=>{
  const script=f.script.replace(f.statement,`const scope=new Set(JSON.parse(fs.readFileSync("${f.definitionFile}","utf8")).scope);`);
  for(const row of [f.material.execution.protection.checkCommands[0],f.material.execution.workflow.qa.commands[0]])row.command[2]=script;
  const s=f.make();assert(projectProtectedScopeCommands(f.protection,s,f.scope)[0].command[2].includes(`new Set(${JSON.stringify(f.scope)})`));
}));
test('string, comment, nested, ambiguous or modified references cannot manufacture the selected scope declaration',()=>fixture(f=>{
  for(const script of [`const fake=${JSON.stringify(f.statement)};`, `/* ${f.statement} */runAllChecks();`,
    `// ${f.statement}\nrunAllChecks();`,`function f(){${f.statement}}`,`${f.statement}${f.statement}`,
    f.statement.replace('readFileSync','readFile'),f.statement.replace(f.definitionFile,f.definitionFile+'.changed'),
    `${f.statement}const r=/scope/;`,`${f.statement}const value=\`template\`;`,`${f.statement}broken(`]){
    const m=structuredClone(f.material);m.execution.protection.checkCommands[0].command[2]=script;m.execution.workflow.qa.commands[0].command[2]=script;
    assert.throws(()=>createProtectedScopeSupplement(f.raw,{material:m,configFingerprint:digest(m),scope:f.scope}),{code:unsupported});
  }
}));
test('definition source is bounded and parsed data must equal the complete original definition',()=>fixture(f=>{
  fs.writeFileSync(f.definitionFile,JSON.stringify({...f.definition,identity:{...f.definition.identity,taskId:'T-002'}}));
  assert.throws(()=>f.make(),{code:drift});
  const fd=fs.openSync(f.definitionFile,'w');fs.ftruncateSync(fd,256*1024+1);fs.closeSync(fd);assert.throws(()=>f.make(),{code:drift});
}));
test('strict JSON refuses accessor capabilities without invoking them',()=>fixture(f=>{
  let called=0;const raw={...f.raw};Object.defineProperty(raw,'checkIds',{enumerable:true,get(){called++;return ['regression'];}});
  assert.throws(()=>createProtectedScopeSupplement(raw,{material:f.material,configFingerprint:f.fingerprint,scope:f.scope}),{code:invalid});assert.equal(called,0);
}));

test('explicit empty checkIds binds scope recovery while preserving every frozen command and guard',()=>fixture(f=>{
  const s=createProtectedScopeSupplement({...f.raw,checkIds:[]},{material:f.material,configFingerprint:f.fingerprint,scope:f.scope});
  assert.deepEqual(s.checkIds,[]);
  assert.deepEqual(projectProtectedScopeCommands(f.protection,s,f.scope),f.protection);
  assert.deepEqual(projectProtectedScopeCommands(f.qa,s,f.scope),f.qa);
  assert.equal(projectProtectedScopeCommands(f.protection,s,f.scope)[0].command[2],f.script,
    'even an existing scope guard is never rewritten or skipped by empty checkIds');
  assert.throws(()=>projectProtectedScopeCommands([],s,f.scope),{code:invalid});
  assert.throws(()=>projectProtectedScopeCommands([{...f.protection[0],command:['node','-e','fakePass()']}],s,f.scope),{code:invalid});
  fs.appendFileSync(f.definitionFile,'\n');
  assert.throws(()=>projectProtectedScopeCommands(f.protection,s,f.scope),{code:drift});
}));
