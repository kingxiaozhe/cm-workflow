// Sessions created by origin/main 0b3040e (before batch 3 changed the bound
// cm-init and cm-test documents) keep working under their original binding;
// any other drift still refuses. Fixtures carry the exact 0b3040e binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {LEGACY_INIT_POLICIES,LEGACY_TEST_POLICIES,POLICY_DOC_SUCCESSORS,legacyInitBindings,sha256} from '../runtime/js/policy-binding-compat.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const legacyInit=LEGACY_INIT_POLICIES[0],legacyTest=LEGACY_TEST_POLICIES[0];

test('legacy digests are exactly the 0b3040e policy documents (when that commit is available)',t=>{
  const show=file=>{const out=spawnSync('git',['show',`0b3040e:${file}`],{cwd:root,encoding:'utf8'});return out.status===0?out.stdout:undefined;};
  if(show('skills/cm-init/SKILL.md')===undefined){t.skip('0b3040e not in this clone');return;}
  const files=Object.keys(legacyInit.files);
  assert.equal(digest(files.map(file=>[file,show(file)])),legacyInit.policyDigest);
  for(const file of files)assert.equal(sha256(show(file)),legacyInit.files[file],file);
  assert.equal(digest(show('skills/cm-test/references/js-host.md')),legacyTest.policy);
});

test('the current bound documents are listed as known successors (update the list when they change)',()=>{
  for(const [file,list] of Object.entries(POLICY_DOC_SUCCESSORS))
    assert.ok(list.includes(sha256(fs.readFileSync(path.join(root,file),'utf8'))),`${file} changed: add its digest to POLICY_DOC_SUCCESSORS`);
});

test('legacy init binding is offered only when every other bound file is byte-identical',()=>{
  const files=Object.keys(legacyInit.files).map(file=>[file,fs.readFileSync(path.join(root,file),'utf8')]);
  assert.equal(legacyInitBindings({project:'/p',workflowRoot:'/w',files}).length,1);
  assert.deepEqual(legacyInitBindings({project:'/p',workflowRoot:'/w',files:files.map(([file,content])=>[file,file.endsWith('testing.md')?content+'x':content])}),[]);
  assert.deepEqual(legacyInitBindings({project:'/p',workflowRoot:'/w',files:files.map(([file,content])=>[file,file===legacyInit.changed?content+'x':content])}),[]);
  assert.deepEqual(legacyInitBindings({project:'/p',workflowRoot:'/w',files:files.slice(1)}),[]);
});

async function serve(args,{cwd,operations}){
  const child=spawn(process.execPath,args,{cwd,stdio:['pipe','pipe','pipe']});let stderr='',sessionId,index=0;const results=[];
  child.stderr.on('data',chunk=>{stderr+=chunk;});const closed=once(child,'close');
  for await(const line of createInterface({input:child.stdout})){const message=JSON.parse(line);
    if(message.type==='host_ready'){sessionId=message.sessionId;}
    else if(message.requestId)results.push(message.result??message.error);
    if(message.type==='host_ready'||message.requestId){
      if(index<operations.length)child.stdin.write(JSON.stringify({requestId:`r${++index}`,...operations[index-1]})+'\n');
      else child.stdin.write(JSON.stringify({type:'host_close',sessionId})+'\n');}
  }
  const [code]=await closed;return {code,results,stderr};
}

test('real cm-init host: a session bound by 0b3040e opens, reports status and keeps its binding; other digests refuse',{timeout:30000},async t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-policy-compat-'))),project=path.join(dir,'project'),file=path.join(dir,'init.json');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(project);fs.writeFileSync(path.join(project,'README.md'),'# Synthetic\n');
  const args=[path.join(root,'scripts/cm-init-host.mjs'),'serve','--skill-dir',path.join(root,'skills/cm-init'),'--project',project,
    '--host-context','author-a','--session-file',file];
  // The fixture is the exact shape 0b3040e wrote for a fresh session at this workflow root.
  const legacy={version:1,workflow:'cm-init',binding:{project,workflowRoot:root.replace(/\/$/,''),policyDigest:legacyInit.policyDigest},
    checkpoint:{stage:'ready',result:null,verification:null,selection:null,confirmation:null,review:null,writeResult:null,reviewPackage:null,
      reviewEvidence:null,analysisResult:null,revisionHistory:[],authorContexts:['author-a'],authorContextId:'author-a'},pending:null,cancelled:false};
  fs.writeFileSync(file,JSON.stringify(legacy),{mode:0o600});
  let run=await serve(args,{cwd:project,operations:[{operation:'status'},{operation:'cancel'}]});
  assert.equal(run.code,0,run.stderr);assert.equal(run.results[0].stage,'ready');assert.equal(run.results[1].stage,'cancelled');
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).binding.policyDigest,legacyInit.policyDigest,'the original binding is kept');
  fs.writeFileSync(file,JSON.stringify({...legacy,binding:{...legacy.binding,policyDigest:'0'.repeat(64)}}),{mode:0o600});
  run=await serve(args,{cwd:project,operations:[]});
  assert.notEqual(run.code,0);assert.match(run.stderr,/idea_session_binding_changed/);
});

test('real cm-test host: a journal bound by 0b3040e opens and replays; another policy digest refuses',{timeout:30000},async t=>{
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-policy-compat-test-'))),project=path.join(temp,'project');
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));fs.mkdirSync(project);
  fs.writeFileSync(path.join(project,'input.mjs'),'export const valid = value => value !== null;\n');fs.writeFileSync(path.join(project,'AGENTS.md'),'Synthetic\n');
  const contract={schemaVersion:'1.0',feature:'example',cases:[{id:'TC-001',kind:'logic',origin:'user',blocking:true,acIds:[],taskIds:[],
    title:'Synthetic',preconditions:[],steps:['Observe'],expected:['Expected'],cleanup:[]}]};
  const cases=path.join(temp,'cases.json');fs.writeFileSync(cases,JSON.stringify(contract));
  const config={skillDir:path.join(root,'skills/cm-test'),project,runtime:'codex',arguments:{cases,logic:true},sources:['input.mjs','AGENTS.md'],
    commands:[],environment:{scope:'local',kind:'web',carrier:'browser',target:'http://127.0.0.1:3000'},logHome:path.join(temp,'logs')};
  const configPath=path.join(temp,'config.json'),session=path.join(temp,'session');fs.writeFileSync(configPath,JSON.stringify(config));
  const args=[path.join(root,'scripts/cm-test-host.mjs'),'serve','--config',configPath,'--session-dir',session];
  // Create a run whose qa_logic answer is lost, then rebind its context to the 0b3040e policy (re-chaining hashes).
  const child=spawn(process.execPath,args,{stdio:['pipe','pipe','pipe']});const closed=once(child,'close');
  createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);
    if(message.type==='host_ready')child.stdin.write(JSON.stringify({requestId:'s',operation:'start'})+'\n');
    if(message.type==='host_request')child.kill('SIGKILL');});
  await closed;
  const journal=path.join(session,'execution.jsonl');
  const rebind=policy=>{let previous=null;const rows=fs.readFileSync(journal,'utf8').trimEnd().split('\n').map(line=>JSON.parse(line)).map(({hash,...row})=>{
    const body={...row,...(row.type==='context'?{value:{...row.value,binding:{...row.value.binding,policy}}}:{}),previous};
    previous=digest(body);return {...body,hash:previous};});
    fs.writeFileSync(journal,rows.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});};
  rebind(legacyTest.policy);
  let run=await serve(args,{cwd:temp,operations:[{operation:'status'}]});
  assert.equal(run.code,0,run.stderr);assert.equal(run.results[0].stage,'interrupted');assert.equal(run.results[0].recovery.unknown[0].callKind,'qa_logic');
  rebind('1'.repeat(64));
  run=await serve(args,{cwd:temp,operations:[]});
  assert.notEqual(run.code,0);assert.match(run.stderr,/cm_test_session_binding_changed/);
});
