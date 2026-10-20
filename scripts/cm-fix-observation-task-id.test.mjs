import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {startFixRun} from '../runtime/js/cm-fix/start.mjs';
import {publishFixObservationDossier,publishFixEscalationDossier,publishFixDossier} from '../runtime/js/cm-fix/dossier.mjs';

const learning={files:[],contextDigest:digest([]),application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'Synthetic fixture'}};
const diagnosis={status:'needs_evidence',rootCause:'Unknown',affectedPaths:['value.mjs'],plan:'Await evidence; no repair',crossLayer:false,affectedModules:['one']};

for(const mode of ['needs_evidence','not_reproduced'])
test(`existing observation identity closes without reproduction replay or completion: ${mode}`,async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-obs-task-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  const identity={repositoryId:'fixture',runId:'same-run',taskId:'T-OBS-original-identity',attempt:1};
  let diagnosisCalls=0;
  const configuration={hostContextId:'fixture-host',defect:'Busy; root unknown',reproduction:{cwd,command:[process.execPath,'-e',"require('node:fs').appendFileSync('visits','1');console.error('BUSY');process.exit("+(mode==='needs_evidence'?'1':'0')+")"],expectedFailure:{exitCode:1,outputIncludes:'BUSY'},timeoutMs:2000}};
  const options={specsRoot,identity,configuration,create:true};
  let owner=openFixExecution(options,{prepare:async()=>learning,bridge:{async call(kind){diagnosisCalls++;assert.equal(mode,'needs_evidence');assert.equal(kind,'fix_diagnose');return diagnosis;}}});
  try{
    startFixRun({specsRoot,identity,configuration});
    assert.equal((await owner.advance({authorized:true})).stage,'observation');
    const stateFile=path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json');
    const originalState=JSON.parse(fs.readFileSync(stateFile));
    const prefix=originalState.records;
    const frozen=({records,revision,...value})=>value;
    owner.close();owner=openFixExecution({...options,create:false});
    const result=owner.finish({authorized:true});
    assert.equal(result.observationRunEnded,true);assert.equal(result.completionEligible,false);
    assert.deepEqual(result.identity,identity);assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'1');
    assert.match(path.basename(result.dossier.path),/^\d{8}-obs\.original-identity\.md$/);
    const bytes=fs.readFileSync(result.dossier.path);assert(bytes.includes(Buffer.from(identity.taskId)));
    const finalState=JSON.parse(fs.readFileSync(stateFile));
    assert.deepEqual(finalState.records.slice(0,prefix.length),prefix);
    assert.deepEqual(frozen(finalState),frozen(originalState));
    assert.equal(diagnosisCalls,mode==='needs_evidence'?1:0);
    const log=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(log.filter(x=>x.event==='run_done'&&x.result==='observing').length,1);
    assert.equal(log.filter(x=>x.event==='task_done').length,0);assert(!fs.existsSync(path.join(specsRoot,'METRICS.md')));
    owner=openFixExecution({...options,create:false});
    assert.equal(owner.status().stage,'observation');assert.deepEqual(owner.status().identity,identity);
    assert.equal(owner.finish({authorized:true}).dossier.sha256,result.dossier.sha256);
    assert.deepEqual(fs.readFileSync(result.dossier.path),bytes);
    const reopenedLog=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(reopenedLog.filter(x=>x.event==='run_done').length,1);
    assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'1');
    fs.appendFileSync(result.dossier.path,'user content');
    owner.close();owner=openFixExecution({...options,create:false});
    assert.throws(()=>owner.finish({authorized:true}),{code:'review_file_conflict'});
  }finally{owner.close();fs.rmSync(root,{recursive:true,force:true});}
});

for(const taskId of ['T-OBS-../escape','T-OBS-UPPER','T-OTHER-safe','T-OBS-safe/escape','T-OBS-a--b','T-OBS-','T-OBS-foo.md','T-OBS-café','T-OBS-foo\\escape'])
test(`observation archive rejects malformed or unsupported id ${taskId}`,()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-obs-invalid-')));
  try{assert.throws(()=>publishFixObservationDossier({specsRoot:root,configuration:{reproduction:{cwd:root,command:[process.execPath,'-e',''],expectedFailure:{exitCode:1,outputIncludes:'BUSY'},timeoutMs:2000}},status:{stage:'observation',completionEligible:false,identity:{taskId},reproduction:{status:'not_reproduced',next:'observation',observation:{id:'reproduce',command:[process.execPath,'-e',''],outcome:'passed',exitCode:0,evidence:'Synthetic',signatureMatched:false}},diagnosis:null},registeredAt:0}),{code:'invalid_fix_dossier'});}
  finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('observation task id does not become a design escalation slug',()=>{
  assert.throws(()=>publishFixEscalationDossier({specsRoot:'/unused',configuration:{},status:{stage:'escalation_required',completionEligible:false,identity:{taskId:'T-OBS-original-identity'},diagnosis:{status:'design_change'},causeReview:{review:{verdict:'approved'}}},registeredAt:0}),{code:'invalid_fix_dossier'});
});

function archiveFixture(t,{bare=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-obs-publisher-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const command=[process.execPath,'-e',''];
  const configuration={...(bare?{archiveMode:'bare'}:{}),defect:'Synthetic observation',
    reproduction:{cwd:root,command,expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000}};
  const status={stage:'observation',completionEligible:false,
    identity:{repositoryId:'fixture',runId:'same-run',taskId:'T-OBS-safe',attempt:1},learning,
    reproduction:{status:'not_reproduced',next:'observation',observation:{id:'reproduce',command,
      outcome:'passed',exitCode:0,evidence:'Synthetic',signatureMatched:false}},diagnosis:null};
  return {root,options:{specsRoot:root,configuration,status,registeredAt:0}};
}

for(const bare of [false,true])
test(`archive publisher preserves identities and disjoint task filenames: bare=${bare}`,t=>{
  const {root,options}=archiveFixture(t,{bare});
  const expected=new Map([['T-FIX-safe','19700101-safe.md'],['T-FIX-obs-safe','19700101-obs-safe.md'],['T-FIX-t-obs-safe','19700101-t-obs-safe.md'],
    ['T-OBS-safe','19700101-obs.safe.md'],['T-OBS-obs-safe','19700101-obs.obs-safe.md']]);
  const paths=[];
  for(const [taskId,name]of expected){
    const status={...options.status,identity:{...options.status.identity,taskId}};
    const result=publishFixObservationDossier({...options,status});
    assert.equal(path.basename(result.path),name);
    assert.equal(path.dirname(result.path),bare?root:path.join(root,'fixes'));
    assert.equal(result.completionEligible,false);assert.equal(status.identity.taskId,taskId);
    assert(fs.readFileSync(result.path,'utf8').includes(`"taskId": "${taskId}"`));
    assert.equal(fs.statSync(result.path).mode&0o777,0o600);paths.push(result.path);
  }
  assert.equal(new Set(paths).size,expected.size);
  assert.equal(new Set(paths.map(file=>file.toLowerCase())).size,expected.size);
});

test('archive publisher preserves exact replay bytes and refuses foreign content',t=>{
  const {options}=archiveFixture(t);const first=publishFixObservationDossier(options);
  const bytes=fs.readFileSync(first.path);assert.deepEqual(publishFixObservationDossier(options),first);
  assert.deepEqual(fs.readFileSync(first.path),bytes);
  fs.appendFileSync(first.path,'user content');const foreign=fs.readFileSync(first.path);
  assert.throws(()=>publishFixObservationDossier(options),{code:'review_file_conflict'});
  assert.deepEqual(fs.readFileSync(first.path),foreign);
});

test('archive publisher refuses an escaped dossier directory without writing outside',t=>{
  const {root,options}=archiveFixture(t);const outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-obs-outside-')));
  t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.symlinkSync(outside,path.join(root,'fixes'));
  assert.throws(()=>publishFixObservationDossier(options),{code:'unsupported_path'});
  assert.deepEqual(fs.readdirSync(outside),[]);
});

test('archive publisher cannot turn observation identity into completed repair evidence',t=>{
  const {options}=archiveFixture(t);
  assert.throws(()=>publishFixObservationDossier({...options,status:{...options.status,completionEligible:true}}),
    {code:'fix_observation_unavailable'});
  assert.throws(()=>publishFixDossier({...options,status:{...options.status,stage:'closeout_required'}}),
    {code:'invalid_fix_dossier'});
});
