import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectCmAiAdmission } from './cm-ai-admission.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const write = (target,value) => {fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);};
const testContract = featureName => `${JSON.stringify({
  schemaVersion:'1.0',
  feature:featureName,
  cases:[{
    id:'TC-001',origin:'generated',kind:'logic',blocking:true,acIds:[],taskIds:['T-001'],
    title:'implements the approved behavior',preconditions:[],steps:['run the behavior'],
    expected:['observe the result'],cleanup:[],
  }],
})}\n`;
const feature = (specs,name,tasks='- [ ] T-001: implement\n',extra={}) => {
  const root=path.join(specs,name);fs.mkdirSync(root,{recursive:true});
  write(path.join(root,'requirements.md'),'# Requirements\n');
  write(path.join(root,'design.md'),'# Design\n');
  write(path.join(root,'tasks.md'),tasks);
  if(extra.testCases!==undefined)write(path.join(root,'test-cases.json'),extra.testCases);
  return root;
};
const snapshot = root => {
  const result=[];
  const walk=current=>{for(const entry of fs.readdirSync(current,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
    const target=path.join(current,entry.name),relative=path.relative(root,target);
    if(entry.isDirectory())walk(target);else result.push([relative,hash(fs.readFileSync(target))]);
  }};walk(root);return result;
};
const fixture = fn => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-admission-'));
  const specs=path.join(root,'specs'),codeProject=path.join(root,'app');
  fs.mkdirSync(specs);fs.mkdirSync(codeProject);write(path.join(codeProject,'README.md'),'existing project\n');
  try{return fn({root,specs,codeProject});}finally{fs.rmSync(root,{recursive:true,force:true});}
};
const status = (specs,value) => write(path.join(specs,'.cm-specs-status'),JSON.stringify(value));
const symlink = (t,target,link) => {
  try{fs.symlinkSync(target,link);return true;}
  catch(error){
    if(error&&['EPERM','EACCES'].includes(error.code)){t.skip(`symlink unavailable: ${error.code}`);return false;}
    throw error;
  }
};

test('N1: generic continuation is not specification approval and admission stays read-only',()=>fixture(({root,specs,codeProject})=>{
  feature(specs,'1.login');status(specs,{status:'awaiting_review',at:'2026-09-03T00:00:00Z',features:['1.login'],testCases:[]});
  const before=snapshot(root);
  const result=inspectCmAiAdmission({specsDir:specs,codeProject,approvalResponse:'继续'});
  assert.equal(result.state,'awaiting_spec_approval');
  assert.equal(result.reason,'spec_approval_required');
  assert.equal(result.approvalIntent,'not_approval');
  assert.equal(result.nextTask,null);
  assert.deepEqual(snapshot(root),before);
}));

test('N2: approved specs select the first eligible task from tasks.md',()=>fixture(({specs,codeProject})=>{
  feature(specs,'1.login',[
    '- [x] T-001: completed setup',
    '- [ ] ~~T-002: removed branch~~ [DROPPED v2]',
    '- [ ] T-003: changed implementation [CHANGED]',
    '- [ ] T-004: dependent follow-up',
    '',
    '## 依赖关系',
    '- T-004 依赖 T-003',
    '',
  ].join('\n'));
  status(specs,{status:'approved',at:'2026-09-03T00:00:00Z',features:['1.login']});
  const before=snapshot(specs);

  const result=inspectCmAiAdmission({specsDir:specs,codeProject});

  assert.equal(result.state,'ready');
  assert.equal(result.reason,'task_selected');
  assert.deepEqual(result.nextTask,{feature:'1.login',id:'T-003',description:'changed implementation [CHANGED]'});
  assert.deepEqual(result.features,[{name:'1.login',total:4,completed:1,dropped:1,pending:2}]);
  assert.deepEqual(snapshot(specs),before);
}));

test('N1: explicit approval intent is reported without writing approval state',()=>fixture(({root,specs,codeProject})=>{
  feature(specs,'1.login');
  const before=snapshot(root);

  const byResponse=inspectCmAiAdmission({specsDir:specs,codeProject,approvalResponse:'  开始  '});
  const byFlag=inspectCmAiAdmission({specsDir:specs,codeProject,assumeYes:true});

  for(const result of [byResponse,byFlag]){
    assert.equal(result.state,'awaiting_spec_approval');
    assert.equal(result.reason,'approval_write_required');
    assert.equal(result.approvalIntent,'explicit');
  }
  assert.deepEqual(snapshot(root),before);
}));

test('N1: approved test-case bytes must still match the recorded SHA-256',()=>fixture(({specs,codeProject})=>{
  const testCases=testContract('login');
  const root=feature(specs,'1.login','- [ ] T-001: implement\n',{testCases});
  status(specs,{
    status:'approved',
    at:'2026-09-03T00:00:00Z',
    features:['1.login'],
    testCases:[{path:'1.login/test-cases.json',sha256:hash(testCases)}],
  });
  assert.equal(inspectCmAiAdmission({specsDir:specs,codeProject}).state,'ready');

  write(path.join(root,'test-cases.json'),'{"cases":[]}\n');
  const changed=inspectCmAiAdmission({specsDir:specs,codeProject});
  assert.equal(changed.state,'awaiting_spec_approval');
  assert.equal(changed.reason,'test_cases_changed');
  assert.equal(changed.nextTask,null);
}));

test('N1: an approved test-case inventory cannot omit an existing contract',()=>fixture(({specs,codeProject})=>{
  feature(specs,'1.login','- [ ] T-001: implement\n',{testCases:testContract('login')});
  status(specs,{
    status:'approved',
    at:'2026-09-03T00:00:00Z',
    features:['1.login'],
    testCases:[],
  });

  const result=inspectCmAiAdmission({specsDir:specs,codeProject});

  assert.equal(result.state,'awaiting_spec_approval');
  assert.equal(result.reason,'test_cases_changed');
}));

test('R1 High: approved feature inventory cannot silently expand from disk',()=>fixture(({specs,codeProject})=>{
  feature(specs,'1.approved','- [x] T-001: completed approved work\n');
  feature(specs,'2.unapproved','- [ ] T-001: newly added work\n');
  status(specs,{
    status:'approved',
    at:'2026-09-03T00:00:00Z',
    features:['1.approved'],
    testCases:[],
  });

  const result=inspectCmAiAdmission({specsDir:specs,codeProject});

  assert.equal(result.state,'awaiting_spec_approval');
  assert.equal(result.reason,'spec_features_changed');
  assert.equal(result.nextTask,null);
}));

test('R1 High: prose-only task mentions do not satisfy test-contract references',()=>fixture(({specs,codeProject})=>{
  const root=feature(specs,'1.login','- [ ] T-001: actual task\n',{
    testCases:testContract('login').replace('T-001','T-999'),
  });
  write(path.join(root,'design.md'),'# Design\nHistorical prose mentions T-999, but it is not a task declaration.\n');
  status(specs,{status:'approved',at:'2026-09-03T00:00:00Z',features:['1.login']});

  const result=inspectCmAiAdmission({specsDir:specs,codeProject});

  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'test_cases_invalid');
  assert.equal(result.nextTask,null);
}));

test('R1 High: required feature files cannot escape specs through symlinks',t=>fixture(({root,specs,codeProject})=>{
  const featureRoot=feature(specs,'1.login');
  const outside=path.join(root,'outside-tasks.md');
  write(outside,'- [ ] T-777: outside specs\n');
  fs.rmSync(path.join(featureRoot,'tasks.md'));
  try{fs.symlinkSync(outside,path.join(featureRoot,'tasks.md'));}
  catch(error){
    if(error&&['EPERM','EACCES'].includes(error.code)){t.skip(`symlink unavailable: ${error.code}`);return;}
    throw error;
  }
  status(specs,{status:'approved',at:'2026-09-03T00:00:00Z',features:['1.login']});

  const result=inspectCmAiAdmission({specsDir:specs,codeProject});

  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'feature_contract_invalid');
  assert.equal(result.nextTask,null);
}));

test('successor High: specification approval cannot come from outside specs',t=>fixture(({root,specs,codeProject})=>{
  feature(specs,'1.login');
  const outside=path.join(root,'outside-approval.json');
  write(outside,JSON.stringify({status:'approved',features:['1.login']}));
  if(!symlink(t,outside,path.join(specs,'.cm-specs-status')))return;

  const result=inspectCmAiAdmission({specsDir:specs,codeProject});

  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'spec_status_invalid');
  assert.equal(result.nextTask,null);
}));

test('successor High: legacy test contract cannot escape its feature',t=>fixture(({root,specs,codeProject})=>{
  const featureRoot=feature(specs,'1.login');
  const outside=path.join(root,'outside-test-cases.json');
  write(outside,testContract('login'));
  if(!symlink(t,outside,path.join(featureRoot,'test-cases.json')))return;
  status(specs,{status:'approved',features:['1.login']});

  const result=inspectCmAiAdmission({specsDir:specs,codeProject});

  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'test_cases_invalid');
  assert.equal(result.nextTask,null);
}));

test('successor High: recorded test contract cannot come from another feature',t=>fixture(({specs,codeProject})=>{
  const login=feature(specs,'1.login');
  const profile=feature(specs,'2.profile');
  const bytes=testContract('login');
  const foreign=path.join(profile,'login-contract.json');
  write(foreign,bytes);
  if(!symlink(t,foreign,path.join(login,'test-cases.json')))return;
  status(specs,{
    status:'approved',features:['1.login','2.profile'],
    testCases:[{path:'1.login/test-cases.json',sha256:hash(bytes)}],
  });

  const result=inspectCmAiAdmission({specsDir:specs,codeProject});

  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'spec_status_invalid');
  assert.equal(result.nextTask,null);
}));

test('N2: impossible dependencies block instead of selecting a later task',()=>fixture(({specs,codeProject})=>{
  feature(specs,'1.login',[
    '- [ ] T-001: blocked task',
    '- [ ] T-002: apparently free task',
    '',
    '## 依赖关系',
    '- T-001 依赖 T-999',
    '',
  ].join('\n'));
  status(specs,{status:'approved',at:'2026-09-03T00:00:00Z',features:['1.login']});

  const result=inspectCmAiAdmission({specsDir:specs,codeProject});

  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'dependencies_invalid');
  assert.equal(result.nextTask,null);
}));

test('N1: bootstrap is required for an empty project and rejected when T-001 is pending in a non-empty project',()=>{
  fixture(({specs,codeProject})=>{
    feature(specs,'0.bootstrap');
    feature(specs,'1.login');
    status(specs,{status:'approved',at:'2026-09-03T00:00:00Z',features:['0.bootstrap','1.login']});
    const result=inspectCmAiAdmission({specsDir:specs,codeProject});
    assert.equal(result.state,'blocked');
    assert.equal(result.reason,'bootstrap_conflict');
  });
  fixture(({specs,codeProject})=>{
    fs.rmSync(path.join(codeProject,'README.md'));
    feature(specs,'1.login');
    status(specs,{status:'approved',at:'2026-09-03T00:00:00Z',features:['1.login']});
    const result=inspectCmAiAdmission({specsDir:specs,codeProject});
    assert.equal(result.state,'blocked');
    assert.equal(result.reason,'bootstrap_required');
  });
  fixture(({specs,codeProject})=>{
    fs.rmSync(path.join(codeProject,'README.md'));
    feature(specs,'0.bootstrap');
    feature(specs,'1.login');
    status(specs,{status:'approved',at:'2026-09-03T00:00:00Z',features:['0.bootstrap','1.login']});
    const result=inspectCmAiAdmission({specsDir:specs,codeProject});
    assert.equal(result.state,'ready');
    assert.equal(result.nextTask.feature,'0.bootstrap');
    assert.equal(result.nextTask.id,'T-001');
  });
});

test('N2: completed tasks without review evidence remain terminal but emit a visible compatibility warning',()=>fixture(({specs,codeProject})=>{
  feature(specs,'1.login',[
    '- [x] T-001: historical completion',
    '- [ ] ~~T-002: removed~~ [DROPPED v2]',
    '',
  ].join('\n'));
  status(specs,{status:'approved',at:'2026-09-03T00:00:00Z',features:['1.login']});

  const missing=inspectCmAiAdmission({specsDir:specs,codeProject});
  assert.equal(missing.state,'complete');
  assert.deepEqual(missing.warnings,['⚠ 凭证缺失: T-001（存量欠账,如实留档,恢复起严格执行）']);

  write(path.join(specs,'.reviews','login-T-001-r1.md'),'review evidence\n');
  const reconciled=inspectCmAiAdmission({specsDir:specs,codeProject});
  assert.equal(reconciled.state,'complete');
  assert.deepEqual(reconciled.warnings,[]);
}));

test('R1 Medium: review evidence is bound to both feature and task',()=>fixture(({specs,codeProject})=>{
  feature(specs,'1.login','- [x] T-001: login complete\n');
  feature(specs,'2.profile','- [x] T-001: profile complete\n');
  write(path.join(specs,'.reviews','login-T-001-r1.md'),'review only for login\n');
  status(specs,{status:'approved',at:'2026-09-03T00:00:00Z',features:['1.login','2.profile']});

  const result=inspectCmAiAdmission({specsDir:specs,codeProject});

  assert.equal(result.state,'complete');
  assert.deepEqual(result.warnings,['⚠ 凭证缺失: T-001（存量欠账,如实留档,恢复起严格执行）']);
}));

test('successor Medium: review identity rejects duplicate feature slugs',()=>fixture(({specs,codeProject})=>{
  feature(specs,'1.login','- [x] T-001: first login complete\n');
  feature(specs,'2.login','- [x] T-001: second login complete\n');
  write(path.join(specs,'.reviews','login-T-001-r1.md'),'one review\n');
  status(specs,{status:'approved',features:['1.login','2.login']});

  const result=inspectCmAiAdmission({specsDir:specs,codeProject});

  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'feature_contract_invalid');
  assert.equal(result.nextTask,null);
}));

test('successor R1 Medium: review identity rejects full-name and slug collisions',()=>fixture(({specs,codeProject})=>{
  feature(specs,'1.login','- [x] T-001: first login complete\n');
  feature(specs,'2.1.login','- [x] T-001: nested-looking login complete\n');
  write(path.join(specs,'.reviews','1.login-T-001-r1.md'),'one ambiguous review\n');
  status(specs,{status:'approved',features:['1.login','2.1.login']});

  const result=inspectCmAiAdmission({specsDir:specs,codeProject});

  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'feature_contract_invalid');
  assert.equal(result.nextTask,null);
}));

test('successor Medium: review evidence directory cannot escape specs',t=>fixture(({root,specs,codeProject})=>{
  feature(specs,'1.login','- [x] T-001: historical completion\n');
  const outside=path.join(root,'outside-reviews');
  write(path.join(outside,'login-T-001-r1.md'),'outside review\n');
  if(!symlink(t,outside,path.join(specs,'.reviews')))return;
  status(specs,{status:'approved',features:['1.login']});

  const result=inspectCmAiAdmission({specsDir:specs,codeProject});

  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'review_evidence_invalid');
  assert.equal(result.nextTask,null);
}));

test('N1: missing feature contracts and malformed legacy test cases block admission',()=>{
  fixture(({specs,codeProject})=>{
    const root=feature(specs,'1.login');
    fs.rmSync(path.join(root,'design.md'));
    status(specs,{status:'approved',at:'2026-09-03T00:00:00Z',features:['1.login']});
    const result=inspectCmAiAdmission({specsDir:specs,codeProject});
    assert.equal(result.state,'blocked');
    assert.equal(result.reason,'feature_contract_missing');
  });
  fixture(({specs,codeProject})=>{
    feature(specs,'1.login','- [ ] T-001: implement\n',{testCases:'not-json\n'});
    status(specs,{status:'approved',at:'2026-09-03T00:00:00Z',features:['1.login']});
    const result=inspectCmAiAdmission({specsDir:specs,codeProject});
    assert.equal(result.state,'blocked');
    assert.equal(result.reason,'test_cases_invalid');
  });
  fixture(({specs,codeProject})=>{
    feature(specs,'1.login','- [ ] T-001: implement\n',{testCases:'{"cases":[]}\n'});
    status(specs,{status:'approved',at:'2026-09-03T00:00:00Z',features:['1.login']});
    const result=inspectCmAiAdmission({specsDir:specs,codeProject});
    assert.equal(result.state,'blocked');
    assert.equal(result.reason,'test_cases_invalid');
  });
  fixture(({specs,codeProject})=>{
    feature(specs,'1.login','- [ ] T-001: implement\n',{testCases:testContract('login').replace('T-001','T-999')});
    status(specs,{status:'approved',at:'2026-09-03T00:00:00Z',features:['1.login']});
    const result=inspectCmAiAdmission({specsDir:specs,codeProject});
    assert.equal(result.state,'blocked');
    assert.equal(result.reason,'test_cases_invalid');
  });
});
