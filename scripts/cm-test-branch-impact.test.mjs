import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {inspectCmTestAdmission} from './cm-test-entry.mjs';
import {inspectBranchComparison,collectBranchImpact,inspectImpactAnalysis} from '../runtime/js/cm-test/branch-impact.mjs';
import {createCmTestHost} from '../runtime/js/cm-test/host.mjs';
import {openTestSession} from '../runtime/js/cm-test/session.mjs';
import {inspectCmTestRecovery} from '../runtime/js/cm-test/recovery.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
function fixture(t,main='main'){
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-impact-'))),project=path.join(temp,'project');
  fs.mkdirSync(project);t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const git=(...args)=>{
    const output=spawnSync('git',['-C',project,...args],{encoding:'utf8'});
    assert.equal(output.status,0,output.stderr);return output.stdout.trim();
  };
  const write=(file,content)=>{const target=path.join(project,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);};
  const commit=()=>{git('add','.');return git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');};
  git('init','-q','-b',main);write('src/input.mjs','export const valid = value => value !== null;\n');
  write('docs/architecture.md','# Map\nValidation: src/input.mjs -> request rejection.\n');commit();
  const config={skillDir:path.join(root,'skills/cm-test'),project,runtime:'codex',arguments:{},sources:[],commands:[],environment:null,logHome:path.join(temp,'logs')};
  const branch=()=>{git('checkout','-qb','topic');write('src/input.mjs','export const valid = value => value != null;\n');commit();};
  return {temp,project,git,write,commit,config,branch};
}
const reply=payload=>({summary:'Reject both null and undefined; regression: request validation and existing callers.',
  mapStatus:'verified',mapEvidence:[{revision:'head',path:'docs/architecture.md',line:2}],gaps:[],
  results:payload.changes.map(change=>({id:change.id,status:'analyzed',scenarios:['Request validation and callers'],
    regression:['P1: null, undefined and valid request inputs'],explanation:'Input -> validator -> request rejection',
    evidence:[...change.before?[{revision:'base',path:change.before.path,line:1}]:[],
      ...change.after?[{revision:'head',path:change.after.path,line:1}]:[]]}))});
const run=(config,call)=>createCmTestHost(config,{call}).handle({requestId:'run',operation:'start'});

test('bare admission detects local main/master; explicit test target retains old default all',t=>{
  for(const main of ['main','master']){
    const f=fixture(t,main);f.branch();
    const bare=inspectCmTestAdmission({skillDir:f.config.skillDir,project:f.project});
    assert.equal(bare.operation,'impact');assert.equal(bare.comparison.baseRef,`refs/heads/${main}`);
    assert.deepEqual(bare.requiredRoles,['tester']);assert.deepEqual(bare.modes,[]);
    const explicit=inspectCmTestAdmission({skillDir:f.config.skillDir,project:f.project,description:'Validation'});
    assert.deepEqual(explicit.modes,['logic','commands','browser']);assert.equal(explicit.operation,'execute');
    assert.throws(()=>inspectCmTestAdmission({skillDir:f.config.skillDir,project:f.project,logic:true}),/test_target_required/);
  }
});
test('remote default selects main unpushed commits; detached HEAD works; ambiguous/missing main fails',t=>{
  const f=fixture(t),base=f.git('rev-parse','HEAD');
  f.git('update-ref','refs/remotes/origin/main',base);f.git('symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/main');
  f.write('src/input.mjs','export const changed = true;\n');f.commit();
  const c=inspectBranchComparison(f.project);assert.equal(c.base,base);assert.equal(c.branchOnlyCommits,1);
  assert.equal(c.remoteFreshness,'local_tracking_ref_not_fetched');
  f.git('checkout','--detach','-q');assert.equal(inspectBranchComparison(f.project).branch,null);
  f.git('symbolic-ref','--delete','refs/remotes/origin/HEAD');f.git('update-ref','-d','refs/remotes/origin/main');
  f.git('branch','master');assert.throws(()=>inspectBranchComparison(f.project),/cm_test_main_ambiguous/);
  f.git('branch','-D','main','master');assert.throws(()=>inspectBranchComparison(f.project),/cm_test_main_missing/);
});
test('non-Git and unborn repositories do not fall back to whole-worktree analysis',t=>{
  const f=fixture(t);fs.rmSync(path.join(f.project,'.git'),{recursive:true});
  assert.throws(()=>inspectBranchComparison(f.project),/cm_test_git_required/);
  f.git('init','-q','-b','main');assert.throws(()=>inspectBranchComparison(f.project),/cm_test_head_required/);
});
test('two-tip diff includes main-only additions and tracks rename/deletion plus both committed sides',t=>{
  const f=fixture(t);f.write('old name.txt','old content\n');f.write('gone.txt','removed content\n');f.commit();
  f.git('checkout','-qb','topic');f.git('mv','old name.txt','新 name.txt');f.git('rm','gone.txt');f.commit();
  f.git('checkout','-q','main');f.write('main-only.txt','new on main\n');f.commit();f.git('checkout','-q','topic');
  f.write('新 name.txt','dirty text must not be used');
  const c=inspectBranchComparison(f.project),input=collectBranchImpact(f.project,c);
  assert.equal(c.mainOnlyCommits,1);assert.equal(c.branchOnlyCommits,1);assert.equal(c.dirty,true);
  assert.ok(input.changes.some(row=>row.status.startsWith('R')&&row.before.path==='old name.txt'&&row.after.path==='新 name.txt'));
  assert.ok(input.changes.some(row=>row.status==='D'&&row.before.path==='main-only.txt'));
  assert.ok(input.sources.some(row=>row.revision==='base'&&row.path==='gone.txt'));
  assert.equal(input.sources.find(row=>row.revision==='head'&&row.path==='新 name.txt').content,'old content\n');
  assert.ok(!JSON.stringify(input).includes('dirty text'));
});
test('binary, protected, symlink and large files remain in inventory with explicit material gaps',t=>{
  const f=fixture(t);f.write('credentials_prod.json','DO_NOT_READ_BASE');f.commit();f.git('checkout','-qb','topic');
  f.write('credentials_prod.json','DO_NOT_READ_HEAD');
  f.write('binary.dat',Buffer.from([0,1,2]));f.write('.env','DO_NOT_READ=fixture\n');f.write('credentials-prod.json','DO_NOT_READ');f.write('large.txt','x'.repeat(129*1024));
  fs.symlinkSync('src/input.mjs',path.join(f.project,'link'));f.commit();
  const input=collectBranchImpact(f.project,inspectBranchComparison(f.project));
  assert.equal(input.changes.length,6);assert.deepEqual(new Set(input.gaps.map(row=>row.reason)),new Set(['binary','protected_path','material_budget','non_regular_blob']));
  assert.ok(!JSON.stringify(input).includes('DO_NOT_READ'));
  assert.throws(()=>collectBranchImpact(f.project,input.comparison,['../escape']),/cm_test_sources_invalid/);
});
test('repository diff settings cannot hide changed submodule pointers from the inventory',t=>{
  const f=fixture(t),first=f.git('rev-parse','HEAD');f.write('version.txt','next\n');f.commit();const second=f.git('rev-parse','HEAD');
  f.write('.gitmodules','[submodule "module"]\npath = module\nurl = ../local-only\n');f.git('add','.gitmodules');
  f.git('update-index','--add','--cacheinfo',`160000,${first},module`);
  f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base submodule');
  f.git('checkout','-qb','topic');f.git('update-index','--cacheinfo',`160000,${second},module`);
  f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','changed submodule');
  for(const setting of ['diff.ignoreSubmodules','submodule.module.ignore']){
    f.git('config',setting,'all');
    const input=collectBranchImpact(f.project,inspectBranchComparison(f.project));
    assert.equal(input.changes.length,1);assert.equal(input.changes[0].before.path,'module');
    assert.equal(input.gaps.length,2);assert.ok(input.gaps.every(item=>item.reason==='non_regular_blob'));
    f.git('config','--unset',setting);
  }
});
test('verified map requires selected HEAD map evidence; ordinary source cannot substitute',t=>{
  const f=fixture(t);f.branch();const c=inspectBranchComparison(f.project),input=collectBranchImpact(f.project,c);
  const response=reply(input);response.mapEvidence=[{revision:'head',path:'src/input.mjs',line:1}];
  assert.throws(()=>inspectImpactAnalysis(input,response),/cm_test_map_evidence_required/);
  response.mapEvidence=[{revision:'base',path:'docs/architecture.md',line:1}];
  assert.throws(()=>inspectImpactAnalysis(input,response),/cm_test_map_evidence_required/);
  f.write('docs/custom-map.md','# Map\nValidation pipeline\n');f.commit();
  const custom=collectBranchImpact(f.project,inspectBranchComparison(f.project),[],['docs/custom-map.md']);
  const valid=reply(custom);valid.mapEvidence=[{revision:'head',path:'docs/custom-map.md',line:1}];
  assert.equal(inspectImpactAnalysis(custom,valid).mapStatus,'verified');
});
test('host returns NO_CHANGES without model or execution, logs close and historical recovery works',async t=>{
  const f=fixture(t);f.write('src/input.mjs','dirty user work');
  const result=await run(f.config,()=>assert.fail('no changes need no callback'));
  assert.equal(result.overall,'NO_CHANGES',JSON.stringify(result));assert.equal(result.executionPassed,0);
  assert.equal(result.impact.comparison.dirty,true);assert.equal(result.completionAuthorized,false);
  assert.equal(inspectCmTestRecovery(f.config,result).overall,'NO_CHANGES');
  assert.equal(fs.readFileSync(path.join(f.project,'src/input.mjs'),'utf8'),'dirty user work');
});
test('shared CLI dispatches impact for both runtimes; committed source, report, no execution',async t=>{
  for(const runtime of ['codex','claude']){
    const f=fixture(t);f.branch();f.config.runtime=runtime;f.write('src/input.mjs','dirty version');
    const configPath=path.join(f.temp,'config.json');fs.writeFileSync(configPath,JSON.stringify(f.config));
    const child=spawn(process.execPath,[path.join(root,'scripts/cm-test-host.mjs'),'serve','--config',configPath],{stdio:['pipe','pipe','pipe']});
    const closed=once(child,'close');t.after(()=>child.kill());let result,calls=0,stderr='';
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');child.stderr.on('data',data=>stderr+=data);
    for await(const line of createInterface({input:child.stdout})){
      const message=JSON.parse(line);
      if(message.type==='host_ready')send({requestId:'run',operation:'start'});
      else if(message.type==='host_request'){
        calls++;assert.equal(message.kind,'change_impact');assert.ok(!JSON.stringify(message.payload.sources).includes('dirty version'));
        send({type:'host_result',sessionId:message.sessionId,callId:message.callId,requestDigest:message.requestDigest,result:reply(message.payload)});
      }else if(message.requestId==='run'){result=message.result;child.stdin.end();}
    }
    assert.equal((await closed)[0],0,stderr);assert.equal(calls,1);assert.equal(result.overall,'ANALYZED',JSON.stringify(result));
    assert.equal(result.executionPassed,0);assert.equal(result.completionAuthorized,false);
    assert.equal(inspectCmTestRecovery(f.config,result).status,'recovered');
  }
});
test('missing/stale maps and untraced callers are partial; missing rows/false lines or moved refs block',async t=>{
  for(const mode of ['missing','stale','callers','coverage','line','ref','source','map-spoof']){
    const f=fixture(t);
    if(mode==='map-spoof'){f.git('rm','docs/architecture.md');f.commit();}
    f.branch();
    const result=await run(f.config,async(kind,payload)=>{
      assert.equal(kind,'change_impact');const response=reply(payload);
      if(['missing','stale'].includes(mode)){response.mapStatus=mode;response.mapEvidence=[];}
      if(mode==='callers')response.gaps=['Could not trace an indirect caller'];
      if(mode==='coverage')response.results=[];
      if(mode==='line')response.results[0].evidence[0].line=999;
      if(mode==='ref')f.git('update-ref','refs/heads/main',payload.comparison.head);
      if(mode==='source')f.write('src/input.mjs','concurrent user change');
      if(mode==='map-spoof')response.mapEvidence=[{revision:'head',path:'src/input.mjs',line:1}];
      return response;
    });
    assert.equal(result.overall,['missing','stale','callers'].includes(mode)?'PARTIAL':'BLOCKED',JSON.stringify(result));
    if(mode==='source')assert.equal(fs.readFileSync(path.join(f.project,'src/input.mjs'),'utf8'),'concurrent user change');
  }
});
test('impact refuses commands/environment and does not allow generated PASS replies',async t=>{
  const f=fixture(t);f.branch();
  assert.throws(()=>createCmTestHost({...f.config,commands:[{}]},{call:()=>{}}),/cm_test_impact_readonly/);
  assert.throws(()=>createCmTestHost({...f.config,environment:{}},{call:()=>{}}),/cm_test_impact_readonly/);
  assert.equal((await run(f.config,async()=>({overall:'PASS'}))).overall,'BLOCKED');
});
test('interrupted impact resumes original result and comparison; no callback replay or historical reanalysis',async t=>{
  const f=fixture(t);f.branch();const directory=path.join(f.temp,'session');let response;
  let session=openTestSession(directory,f.config);
  let host=createCmTestHost(f.config,{session,call:async(kind,payload)=>{response=reply(payload);throw Error('disconnect');}});
  const interrupted=await host.handle({requestId:'run',operation:'start'});assert.equal(interrupted.stage,'interrupted');session.close();
  session=openTestSession(directory,f.config);
  host=createCmTestHost(f.config,{session,call:()=>assert.fail('no callback replay')});
  const result=await host.handle({requestId:'resume',operation:'resume',resolution:{key:interrupted.pending.key,
    requestDigest:interrupted.pending.requestDigest,result:response,evidence:'Original synthetic receipt',cleanup:'completed'}});
  assert.equal(result.overall,'ANALYZED',JSON.stringify(result));session.close();
  session=openTestSession(directory,f.config);
  host=createCmTestHost(f.config,{session,call:()=>assert.fail()});
  assert.equal((await host.handle({requestId:'history',operation:'resume',resolution:null})).historical,true);session.close();
  f.git('update-ref','refs/heads/main',f.git('rev-parse','HEAD'));
  session=openTestSession(directory,f.config);
  assert.throws(()=>createCmTestHost(f.config,{session,call:()=>{}}),/cm_test_session_binding_changed/);session.close();
});
