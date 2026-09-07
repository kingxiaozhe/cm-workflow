import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { captureReviewBaseline } from './review-package.mjs';
import { createTaskRunner } from './task-runner.mjs';
import { openTaskExecutionStore } from './task-owner.mjs';
import { digest } from './effect-contract.mjs';
import { commitFixtureTask,observeFixtureCommit } from './task-commit.mjs';
import * as commits from './task-commit.mjs';

const repository=path.resolve(import.meta.dirname,'../..');
const checks=[{id:'unit',command:['node','fixture'],outcome:'passed',exitCode:0,evidence:'synthetic check'}];
async function fixture(fn,{attempt=1,bytes=Buffer.from('- [ ] T-001: 中文\r\n'),mode=0o640}={}) {
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-commit-')));
  const root=path.join(temp,'code'),specsRoot=path.join(temp,'specs'),dir=path.join(specsRoot,'login');
  fs.mkdirSync(root);fs.mkdirSync(dir,{recursive:true});
  const tasksPath=path.join(dir,'tasks.md');fs.writeFileSync(tasksPath,bytes,{mode});fs.chmodSync(tasksPath,mode);
  fs.writeFileSync(path.join(root,'a.js'),'old\n');fs.writeFileSync(path.join(root,'requirements.md'),'fixture\n');
  const identity={repositoryId:'fixture',runId:'commit',taskId:'T-001',attempt:1};
  const config={root,identity,scope:['a.js'],requirements:['requirements.md']};
  let baseline=captureReviewBaseline(config),reviewPackage,store;
  const terminal=(r,result)=>({version:1,invocationId:r.invocationId,contextId:r.contextId,provider:r.provider,
    effectiveModel:'fixture',status:'succeeded',accepted:true,result});
  const runner=createTaskRunner({...config,excludedContexts:['main'],timeoutMs:1000,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'dev',run:r=>{
      fs.writeFileSync(path.join(root,'a.js'),`new ${r.identity.attempt}\n`);return terminal(r,{outcome:'implemented'});}},
    reviewers:[{id:'review',provider:'claude',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review1','review2'],run:r=>{reviewPackage=r.payload.reviewPackage;
        const findings=attempt===2 && r.identity.attempt===1?[{id:'F1',severity:'P2',path:'a.js',message:'fixture issue',evidence:'fixture'}]:[];
        return terminal(r,{verdict:findings.length?'changes_requested':'approved',packageDigest:reviewPackage.packageDigest,
          examinedPaths:['a.js','requirements.md'],findings,summary:'synthetic independent review'});}}],
    check:()=>checks,commit:()=>{throw Error('must not call synthetic runner completion');}});
  try {
    for(let a=1;a<=attempt;a++)for(const kind of ['develop','review'])await runner.executeEffect({version:1,id:kind+a,identity:{...identity,attempt:a},kind});
    const status=runner.status();assert.equal(status.state,'approved');
    if(attempt===2){const {baselineDigest:old,...body}=baseline;const next={...body,identity:{...identity,attempt}};baseline={...next,baselineDigest:digest(next)};}
    const reviewsDir=path.join(specsRoot,'.reviews');fs.mkdirSync(reviewsDir);
    const py=`import runpy,sys\nfrom pathlib import Path\nm=runpy.run_path(sys.argv[1]);r=Path(sys.argv[2]);a=int(sys.argv[3])\nfor n in range(1,a+1):\n h=r/f'login-T-001-a{n}-handoff.json'\n m['write_handoff'](h,attempt=n)\n m['write_review'](r/f'login-T-001-r{n}.md',handoff=h,attempt=n,round_number=n,verdict='approved' if n==a else 'changes_requested')`;
    const made=childProcess.spawnSync('python3',['-c',py,path.join(repository,'scripts/test-task-gate.py'),reviewsDir,String(attempt)],{encoding:'utf8'});
    assert.equal(made.status,0,made.stderr);
    const options={tasksPath,feature:'login',specsRoot,identity:{repositoryId:'fixture',runId:'commit'},
      fingerprints:{workflow:digest('commit-v1'),config:digest('fixture'),inputs:digest('original')},create:true};
    const input={selectors:{tasksPath,feature:'login',reviewsDir,handoff:path.join(reviewsDir,`login-T-001-a${attempt}-handoff.json`)},
      root,identity:{...identity,attempt},baseline,reviewPackage,checks,receipt:status.receipt,
      registered:status.receipts.find(r=>r.id===status.receipt.id),execution:status.calls.find(c=>c.invocationId===status.receipt.id)};
    store=openTaskExecutionStore(options);
    return await fn({temp,root,dir,tasksPath,specsRoot,options,input,store,
      reopen:()=>{store.close();store=openTaskExecutionStore({...options,create:false});return store;}});
  }finally{store?.close();fs.rmSync(temp,{recursive:true,force:true});}
}

async function composedObservationFixture(fn){return fixture(async f=>{
  const terminal=(r,result)=>({version:1,invocationId:r.invocationId,contextId:r.contextId,provider:r.provider,
    effectiveModel:'fixture',status:'succeeded',accepted:true,result});
  const r=createTaskRunner({root:f.root,identity:f.input.identity,scope:['a.js'],requirements:['requirements.md'],excludedContexts:['main'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'observer-dev',run:q=>{
      fs.writeFileSync(path.join(f.root,'a.js'),'observer implementation\n');return terminal(q,{outcome:'implemented'});}},
    reviewers:[{id:'independent',provider:'claude',requestedModel:'fixture',allowed:true,available:true,contexts:['observer-r1','observer-r2'],run:q=>
      terminal(q,{verdict:'approved',packageDigest:q.payload.reviewPackage.packageDigest,examinedPaths:['a.js','requirements.md'],findings:[],summary:'fixture review'})}],
    check:()=>checks,persistence:{store:f.store,mode:'create',version:2},taskCompletion:{reviewsDir:f.input.selectors.reviewsDir,
      handoffs:[f.input.selectors.handoff,path.join(f.input.selectors.reviewsDir,'login-T-001-a2-handoff.json')]}});
  assert.equal((await r.run()).state,'fixture_completed');return fn({...f,runner:r});
});}

for(const stage of ['init','outer-intent','nested-intent','nested-result','outer-unknown','completed'])
test(`C3c observer separates image and history at ${stage}`,()=>composedObservationFixture(f=>{
  assert.equal(typeof commits.observeRunnerFixture,'function');
  const original=f.store.snapshot(),nested=original.records.find(r=>r.payload.type==='task-commit-intent');
  rewriteHistory(f,s=>{
    if(stage==='init')s.records=s.records.slice(0,1);
    if(stage==='outer-intent')s.records=s.records.slice(0,6);
    if(stage==='nested-intent')s.records=s.records.slice(0,7);
    if(stage==='nested-result')s.records=s.records.slice(0,8);
    if(stage==='outer-unknown'){const c=s.records.at(-1).payload.checkpoint;c.state='unknown';c.code='commit_unknown';
      c.cache.at(-1).result.state='unknown';c.cache.at(-1).result.code='commit_unknown';}
  });
  const before=f.store.snapshot(),image=fs.readFileSync(f.tasksPath),result=commits.observeRunnerFixture(f.store);
  assert.deepEqual(Object.keys(result).sort(),['version','protocol','identity','observedImage','recordedNativeOutcome','recordedRunnerState','recordedRunnerCode','taskCommit'].sort());
  assert(Object.isFrozen(result)&&Object.isFrozen(result.identity));assert.equal(result.version,1);assert.equal(result.protocol,'cm-runner-observation');
  assert.deepEqual(result.identity,f.input.identity);
  const noIntent=['init','outer-intent'].includes(stage);
  assert.equal(result.observedImage,noIntent?'not_observed':'observed_after');
  assert.equal(result.recordedNativeOutcome,['nested-result','outer-unknown','completed'].includes(stage)?'fixture_committed':null);
  assert.equal(result.recordedRunnerState,stage==='init'?'ready':stage==='completed'?'fixture_completed':'unknown');
  assert.equal(result.taskCommit?.intentDigest??null,noIntent?null:nested.digest);
  assert.deepEqual(commits.observeRunnerFixture(f.store),result);assert.deepEqual(f.store.snapshot(),before);assert.deepEqual(fs.readFileSync(f.tasksPath),image);
}));

for(const changed of ['before','bytes','mode','missing','symlink','hardlink','oversize'])
test(`C3c full image ${changed} is observation only`,()=>composedObservationFixture(f=>{
  const plan=f.store.snapshot().records[6].payload.commit.plan;
  if(changed==='before')fs.writeFileSync(f.tasksPath,Buffer.from(plan.beforeBase64,'base64'));
  if(changed==='bytes')fs.appendFileSync(f.tasksPath,'drift');
  if(changed==='mode')fs.chmodSync(f.tasksPath,0o600);
  if(changed==='missing')fs.unlinkSync(f.tasksPath);
  if(changed==='symlink'){fs.renameSync(f.tasksPath,f.tasksPath+'.saved');fs.symlinkSync(f.tasksPath+'.saved',f.tasksPath);}
  if(changed==='hardlink')fs.linkSync(f.tasksPath,f.tasksPath+'.link');
  if(changed==='oversize')fs.appendFileSync(f.tasksPath,Buffer.alloc(256*1024+1));
  const before=f.store.snapshot(),observed=commits.observeRunnerFixture(f.store);
  assert.equal(observed.observedImage,changed==='before'?'observed_before':'conflict');
  assert.equal(observed.recordedNativeOutcome,'fixture_committed');assert.equal(observed.recordedRunnerState,'fixture_completed');
  assert.deepEqual(f.store.snapshot(),before);
}));

test('C3c removed evidence and source files do not become fresh review checks',()=>composedObservationFixture(f=>{
  const plan=f.store.snapshot().records[6].payload.commit.plan;
  for(const e of plan.evidence)fs.unlinkSync(e.path);
  fs.unlinkSync(path.join(f.root,'a.js'));fs.unlinkSync(path.join(f.root,'requirements.md'));
  assert.equal(commits.observeRunnerFixture(f.store).observedImage,'observed_after');
}));
test('C3c missing code root cannot bypass full history parser',()=>composedObservationFixture(f=>{
  fs.renameSync(f.root,f.root+'.moved');assert.throws(()=>commits.observeRunnerFixture(f.store),{code:'runner_history_invalid'});
}));

for(const changed of ['run','owner','fingerprints','version','mixed','extra-record'])
test(`C3c refuses ${changed} history before returning an image`,()=>composedObservationFixture(f=>{
  rewriteHistory(f,s=>{const p=s.records[0].payload;
    if(changed==='run')p.config.identity.runId='wrong';
    if(changed==='owner')p.config.completion.owner.tasksPath=path.join(f.specsRoot,'tasks.md');
    if(changed==='fingerprints')p.config.completion.fingerprints.inputs='0'.repeat(64);
    if(changed==='version')p.version=1;
    if(changed==='mixed')s.records[3].payload.version=1;
    if(changed==='extra-record')s.records.push({...s.records[1],id:'extra'});
  });
  const realpath=fs.realpathSync;let rootReads=0;
  try{fs.realpathSync=(p,...rest)=>{if(p===f.root)rootReads++;return realpath(p,...rest);};
    assert.throws(()=>commits.observeRunnerFixture(f.store),{code:'runner_history_invalid'});
    if(['run','owner','fingerprints'].includes(changed))assert.equal(rootReads,0);
  }finally{fs.realpathSync=realpath;}
}));

test('C3c empty standalone raw copied and closed handles do not supply run observation',()=>fixture(f=>{
  assert.throws(()=>commits.observeRunnerFixture(f.store),{code:'runner_missing'});
  assert.throws(()=>commits.observeRunnerFixture({...f.store}),{code:'task_owner_required'});
  let calls=0;const proxy=new Proxy(f.store,{get(){calls++;throw Error('callback');}});
  assert.throws(()=>commits.observeRunnerFixture(proxy),{code:'task_owner_required'});assert.equal(calls,0);
  assert.throws(()=>commits.observeRunnerFixture(f.store,undefined),{code:'invalid_input'});
  commitFixtureTask(f.store,f.input);assert.throws(()=>commits.observeRunnerFixture(f.store),{code:'runner_history_invalid'});
  f.store.close();assert.throws(()=>commits.observeRunnerFixture(f.store),{code:'store_closed'});
}));

for(const observation of ['after','no-intent','conflict'])test(`C3c ${observation} cannot swallow changed store revision`,()=>composedObservationFixture(f=>{
  if(observation==='no-intent')rewriteHistory(f,s=>{s.records=s.records.slice(0,1);});
  if(observation==='conflict')fs.unlinkSync(f.tasksPath);
  const open=fs.openSync,realpath=fs.realpathSync,lstat=fs.lstatSync;let hit=false;
  const change=()=>{if(hit)return;hit=true;const s=f.store.snapshot();f.store.append({id:'external',kind:'cancel',payload:{},expectedRevision:s.revision});};
  try{
    fs.openSync=(p,...rest)=>{const fd=open(p,...rest);if(p===f.tasksPath)change();return fd;};
    fs.realpathSync=(p,...rest)=>{const r=realpath(p,...rest);if(observation==='no-intent'&&p===f.root)change();return r;};
    fs.lstatSync=(p,...rest)=>{if(observation==='conflict'&&p===f.tasksPath)change();return lstat(p,...rest);};
    assert.throws(()=>commits.observeRunnerFixture(f.store),{code:'commit_store_changed'});assert(hit);
  }finally{fs.openSync=open;fs.realpathSync=realpath;fs.lstatSync=lstat;}
}));

for(const composed of [false,true])test(`C3c ${composed?'composed':'standalone'} rechecks parent after target read`,()=>
(composed?composedObservationFixture:fixture)(f=>{
  if(!composed)commitFixtureTask(f.store,f.input);
  const open=fs.openSync;let hit=false;
  try{fs.openSync=(p,...rest)=>{const fd=open(p,...rest);if(p===f.tasksPath&&!hit){hit=true;fs.chmodSync(f.dir,(fs.statSync(f.dir).mode&0o777)^1);}return fd;};
    const result=composed?commits.observeRunnerFixture(f.store):observeFixtureCommit(f.store);
    assert(hit);assert.equal(composed?result.observedImage:result.observation,'conflict');
  }finally{fs.openSync=open;}
}));

test('C3c growing target and poisoned owner never report completion authority',()=>composedObservationFixture(f=>{
  const open=fs.openSync;let hit=false;
  try{fs.openSync=(p,...rest)=>{const fd=open(p,...rest);if(p===f.tasksPath&&!hit){hit=true;fs.appendFileSync(p,Buffer.alloc(256*1024+1));}return fd;};
    assert.equal(commits.observeRunnerFixture(f.store).observedImage,'conflict');assert(hit);
  }finally{fs.openSync=open;}
  const binding=path.join(f.dir,'.reviews/.cm-task-owner.json');fs.writeFileSync(binding,'invalid');
  assert.throws(()=>commits.observeRunnerFixture(f.store));assert.throws(()=>commits.observeRunnerFixture(f.store),{code:'store_poisoned'});
}));

for(const stage of ['completed','no-intent','conflict'])test(`C3c ${stage} repeated observation invokes no write or subprocess`,()=>composedObservationFixture(f=>{
  if(stage==='no-intent')rewriteHistory(f,s=>{s.records=s.records.slice(0,1);});
  if(stage==='conflict')fs.appendFileSync(f.tasksPath,'drift');
  const before=f.store.snapshot(),bytes=fs.readFileSync(f.tasksPath),originals=new Map(),py=childProcess.spawnSync;let writes=0,taskReads=0;
  const open=fs.openSync;
  try{
    for(const name of ['writeFileSync','writeSync','renameSync','unlinkSync','appendFileSync','fsyncSync','mkdirSync']){
      originals.set(name,fs[name]);fs[name]=()=>{writes++;assert.fail('observer mutation');};}
    fs.openSync=(p,flags,...rest)=>{if(p===f.tasksPath)taskReads++;assert.equal(flags&fs.constants.O_CREAT,0);return open(p,flags,...rest);};
    childProcess.spawnSync=()=>{writes++;assert.fail('observer subprocess');};
    const a=commits.observeRunnerFixture(f.store),b=commits.observeRunnerFixture(f.store);assert.deepEqual(a,b);
    assert.equal(writes,0);if(stage==='no-intent')assert.equal(taskReads,0);
  }finally{for(const [name,fn] of originals)fs[name]=fn;fs.openSync=open;childProcess.spawnSync=py;}
  assert.deepEqual(f.store.snapshot(),before);assert.deepEqual(fs.readFileSync(f.tasksPath),bytes);
}));

for(const attempt of [1,2])test(`C2b commits reviewed fixture attempt${attempt} once and observes without writes`,()=>fixture(f=>{
  const before=fs.readFileSync(f.tasksPath),result=commitFixtureTask(f.store,f.input);
  assert.equal(result.outcome,'fixture_committed');
  assert.deepEqual(fs.readFileSync(f.tasksPath),Buffer.from(before.toString().replace('[ ]','[x]')));
  assert.equal(fs.statSync(f.tasksPath).mode&0o7777,0o640);
  assert.equal(f.store.snapshot().records.length,2);const state=f.store.snapshot();
  assert.deepEqual(observeFixtureCommit(f.store),{observation:'observed_after',recordedOutcome:'fixture_committed',intentDigest:result.intentDigest,planDigest:result.planDigest});
  assert.deepEqual(f.store.snapshot(),state);
  assert.throws(()=>commitFixtureTask(f.store,f.input),{code:'commit_records_present'});
}, {attempt}));

test('C2b rejects missing review without creating intent or changing tasks',()=>fixture(f=>{
  const before=fs.readFileSync(f.tasksPath),input=structuredClone(f.input);input.registered=null;
  assert.throws(()=>commitFixtureTask(f.store,input));assert.equal(f.store.snapshot().records.length,0);
  assert.deepEqual(fs.readFileSync(f.tasksPath),before);
}));

for(const newline of ['\n','\r','\r\n',''])test(`C2b preserves complete newline/mode bytes ${JSON.stringify(newline)}`,()=>fixture(f=>{
  const before=fs.readFileSync(f.tasksPath);commitFixtureTask(f.store,f.input);
  assert.deepEqual(fs.readFileSync(f.tasksPath),Buffer.from(before.toString().replace('[ ]','[x]')));
  assert.equal(fs.statSync(f.tasksPath).mode&0o7777,0o600);
},{bytes:Buffer.from(`文档\r\n- [ ] T-001: 待完成${newline}`),mode:0o600}));

for(const bad of ['identity','attempt','target','feature','review-dir','handoff','code','requirements','checks','receipt','execution','registered','already-done','duplicate','utf8','oversize','symlink','hardlink'])
test(`C2b rejects ${bad} before intent`,()=>fixture(f=>{
  const v=structuredClone(f.input);
  if(bad==='identity')v.identity.runId='other';
  if(bad==='attempt')v.identity.attempt=2;
  if(bad==='target')v.selectors.tasksPath=path.join(f.specsRoot,'tasks.md');
  if(bad==='feature')v.selectors.feature='other';
  if(bad==='review-dir')v.selectors.reviewsDir=f.dir;
  if(bad==='handoff')fs.writeFileSync(v.selectors.handoff,'invalid');
  if(bad==='code')fs.writeFileSync(path.join(f.root,'a.js'),'unreviewed');
  if(bad==='requirements')fs.writeFileSync(path.join(f.root,'requirements.md'),'changed');
  if(bad==='checks')v.checks[0].evidence='different check run';
  if(bad==='receipt')v.receipt.result.verdict='blocked';
  if(bad==='execution')v.execution.contextId='forged';
  if(bad==='registered')v.registered=null;
  if(bad==='already-done')fs.writeFileSync(f.tasksPath,'- [X] T-001: done\n');
  if(bad==='duplicate')fs.appendFileSync(f.tasksPath,'- [ ] T-001: duplicate\n');
  if(bad==='utf8')fs.writeFileSync(f.tasksPath,Buffer.from([255]));
  if(bad==='oversize')fs.writeFileSync(f.tasksPath,'x'.repeat(256*1024+1));
  if(bad==='symlink'){fs.renameSync(f.tasksPath,f.tasksPath+'.retained');fs.symlinkSync(f.tasksPath+'.retained',f.tasksPath);}
  if(bad==='hardlink')fs.linkSync(f.tasksPath,f.tasksPath+'.retained');
  const before=fs.readFileSync(f.tasksPath);
  assert.throws(()=>commitFixtureTask(f.store,v));assert.equal(f.store.snapshot().records.length,0);
  assert.deepEqual(fs.readFileSync(f.tasksPath),before);assert(!fs.readdirSync(f.dir).some(n=>n.startsWith('.cm-task.')));
}));

test('C2b exact genuine owner required before reading caller input',()=>{
  let touched=0;const input=Object.defineProperty({},'selectors',{get(){touched++;throw Error('executed');}});
  assert.throws(()=>commitFixtureTask({},input),{code:'task_owner_required'});assert.equal(touched,0);
});
test('C2b rejects another genuine owner despite equal run IDs',()=>fixture(f=>fixture(g=>{
  assert.throws(()=>commitFixtureTask(g.store,f.input),{code:'task_owner_mismatch'});
  assert.equal(g.store.snapshot().records.length,0);assert.equal(f.store.snapshot().records.length,0);
})));

for(const kind of ['proxy','revoked-proxy','prototype-proxy','internal-accessor','own-accessor','missing-slot','subclass','too-many-keys'])
test(`C2b cancellation shape ${kind} refuses without callbacks or writes`,()=>fixture(f=>{
  let signal=new AbortController().signal,callbacks=0;
  const before=fs.readFileSync(f.tasksPath);
  const handler={get(target,key){callbacks++;return Reflect.get(target,key,target);}};
  if(kind==='proxy')signal=new Proxy(signal,handler);
  if(kind==='revoked-proxy'){const p=Proxy.revocable(signal,handler);p.revoke();signal=p.proxy;}
  if(kind==='prototype-proxy')signal=Object.create(new Proxy(signal,handler));
  if(kind==='internal-accessor'){
    const key=Object.getOwnPropertySymbols(signal).find(k=>String(k)==='Symbol(kAborted)');assert(key);
    Object.defineProperty(signal,key,{get(){callbacks++;return false;},configurable:true});
  }
  if(kind==='own-accessor')Object.defineProperty(signal,'custom',{get(){callbacks++;return false;}});
  if(kind==='missing-slot')delete signal[Object.getOwnPropertySymbols(signal)[0]];
  if(kind==='subclass')Object.setPrototypeOf(signal,Object.create(AbortSignal.prototype));
  if(kind==='too-many-keys')for(let i=0;i<65;i++)signal['key'+i]=i;
  assert.throws(()=>commitFixtureTask(f.store,f.input,signal),{code:'invalid_input'});
  assert.equal(callbacks,0);assert.equal(f.store.snapshot().records.length,0);
  assert.deepEqual(fs.readFileSync(f.tasksPath),before);
  assert(!fs.readdirSync(f.dir).some(n=>n.startsWith('.cm-task.')));
}));

test('C2b cancellation shape is revalidated after preparation without invoking changed getters',()=>fixture(f=>{
  const signal=new AbortController().signal,original=childProcess.spawnSync,before=fs.readFileSync(f.tasksPath);
  let callbacks=0,changed=false;
  try{childProcess.spawnSync=(command,args,opts)=>{
    const result=original(command,args,opts);
    if(args.includes('verify-mark-done-plan')){
      const key=Object.getOwnPropertySymbols(signal).find(k=>String(k)==='Symbol(kAborted)');assert(key);
      Object.defineProperty(signal,key,{get(){callbacks++;return false;},configurable:true});changed=true;
    }return result;
  };
    assert.throws(()=>commitFixtureTask(f.store,f.input,signal),{code:'commit_unknown'});
    assert(changed);assert.equal(callbacks,0);assert.equal(f.store.snapshot().records.length,1);
    assert.deepEqual(fs.readFileSync(f.tasksPath),before);
  }finally{childProcess.spawnSync=original;}
}));

for(const kind of ['controller','timeout','any','aborted','aborted-any'])
test(`C2b cancellation shape supports native ${kind}`,()=>fixture(f=>{
  const signal=kind==='controller'?new AbortController().signal:kind==='timeout'?AbortSignal.timeout(60000):
    kind==='any'?AbortSignal.any([new AbortController().signal]):kind==='aborted'?AbortSignal.abort():AbortSignal.any([AbortSignal.abort()]);
  if(kind.startsWith('aborted')){
    assert.throws(()=>commitFixtureTask(f.store,f.input,signal),{code:'cancelled'});
    assert.equal(f.store.snapshot().records.length,0);
  }else assert.equal(commitFixtureTask(f.store,f.input,signal).outcome,'fixture_committed');
}));

for(const bad of ['failed','timeout','overflow','utf8','json','shape','digest','base64'])
test(`C2b bounded subprocess ${bad} refuses before intent`,()=>fixture(f=>{
  const original=childProcess.spawnSync;let called=false;
  try {
    childProcess.spawnSync=(command,args,opts)=>{
      called=true;assert.equal(command,'python3');assert.equal(opts.timeout,10000);assert.equal(opts.maxBuffer,1024*1024);
      assert.equal(opts.killSignal,'SIGKILL');assert(!opts.shell);assert(!opts.env);
      if(bad==='failed')return {status:1,signal:null,stdout:Buffer.from('private error')};
      if(bad==='timeout')return {status:null,signal:'SIGKILL',error:Error('timeout'),stdout:Buffer.alloc(0)};
      if(bad==='overflow')return {status:0,signal:null,stdout:Buffer.alloc(1024*1024+1)};
      if(bad==='utf8')return {status:0,signal:null,stdout:Buffer.from([255])};
      if(bad==='json')return {status:0,signal:null,stdout:Buffer.from('{')};
      if(bad==='shape')return {status:0,signal:null,stdout:Buffer.from('{}')};
      const result=original(command,args,opts),p=JSON.parse(result.stdout);
      if(bad==='digest')p.planDigest='0'.repeat(64);
      if(bad==='base64'){p.beforeBase64+='=';const {planDigest,...data}=p;p.planDigest=digest(data);}
      return {...result,stdout:Buffer.from(JSON.stringify(p))};
    };
    assert.throws(()=>commitFixtureTask(f.store,f.input));assert(called);assert.equal(f.store.snapshot().records.length,0);
  }finally{childProcess.spawnSync=original;}
}));

for(const changed of ['tasks','evidence','code','requirements','temp-bytes','temp-mode','temp-replace','temp-hardlink','parent','cancel'])
test(`C2b final revalidation catches ${changed} and retains unknown`,()=>fixture(f=>{
  const original=childProcess.spawnSync,controller=new AbortController();let changedOnce=false;
  try {
    childProcess.spawnSync=(command,args,opts)=>{
      const result=original(command,args,opts);
      if(args.includes('verify-mark-done-plan')){
        changedOnce=true;const temporary=path.join(f.dir,fs.readdirSync(f.dir).find(n=>n.startsWith('.cm-task.')));
        if(changed==='tasks')fs.appendFileSync(f.tasksPath,'external edit\n');
        if(changed==='evidence')fs.writeFileSync(f.input.selectors.handoff,'changed');
        if(changed==='code')fs.writeFileSync(path.join(f.root,'a.js'),'changed');
        if(changed==='requirements')fs.writeFileSync(path.join(f.root,'requirements.md'),'changed');
        if(changed==='temp-bytes')fs.writeFileSync(temporary,'wrong');
        if(changed==='temp-mode')fs.chmodSync(temporary,0o600);
        if(changed==='temp-replace'){const b=fs.readFileSync(temporary);fs.renameSync(temporary,temporary+'.retained');fs.writeFileSync(temporary,b,{mode:0o640});}
        if(changed==='temp-hardlink')fs.linkSync(temporary,temporary+'.retained');
        if(changed==='parent')fs.chmodSync(f.dir,0o700);
        if(changed==='cancel')controller.abort();
      }
      return result;
    };
    assert.throws(()=>commitFixtureTask(f.store,f.input,controller.signal),{code:'commit_unknown'});assert(changedOnce);
    assert(!fs.readFileSync(f.tasksPath).includes(Buffer.from('[x]')));assert.equal(f.store.snapshot().records.length,1);
    assert(fs.readdirSync(f.dir).some(n=>n.startsWith('.cm-task.')));
  }finally{childProcess.spawnSync=original;}
}));

test('C2b delivered cancellation before intent leaves no record',()=>fixture(f=>{
  const c=new AbortController();c.abort();assert.throws(()=>commitFixtureTask(f.store,f.input,c.signal),{code:'cancelled'});
  assert.equal(f.store.snapshot().records.length,0);
}));

function interrupted(f) {
  const original=fs.fsyncSync;let hit=false;
  try{fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isFile() && fs.readFileSync(f.tasksPath).includes(Buffer.from('[x]'))){hit=true;throw Error('fixture result sync');}return original(fd);};
    assert.throws(()=>commitFixtureTask(f.store,f.input),{code:'commit_unknown'});assert(hit);
  }finally{fs.fsyncSync=original;}
}
for(const change of ['none','before','different','mode','missing','hardlink','symlink'])test(`C2b observation ${change} never writes or approves unknown`,()=>fixture(f=>{
  const before=fs.readFileSync(f.tasksPath);interrupted(f);const store=f.reopen();
  if(change==='before')fs.writeFileSync(f.tasksPath,before);
  if(change==='different')fs.appendFileSync(f.tasksPath,'different\n');
  if(change==='mode')fs.chmodSync(f.tasksPath,0o600);
  if(change==='missing')fs.renameSync(f.tasksPath,f.tasksPath+'.retained');
  if(change==='hardlink')fs.linkSync(f.tasksPath,f.tasksPath+'.retained');
  if(change==='symlink'){fs.renameSync(f.tasksPath,f.tasksPath+'.retained');fs.symlinkSync(f.tasksPath+'.retained',f.tasksPath);}
  const state=store.snapshot(),observed=observeFixtureCommit(store);
  assert.equal(observed.observation,change==='none'?'observed_after':change==='before'?'observed_before':'conflict');
  assert.equal(observed.recordedOutcome,null);assert.deepEqual(store.snapshot(),state);
  assert.throws(()=>commitFixtureTask(store,f.input),{code:'commit_records_present'});
}));

for(const kind of ['intent','result','cancel'])test(`C2b foreign ${kind} history cannot be used`,()=>fixture(f=>{
  f.store.append({id:'foreign',kind,payload:{},expectedRevision:f.store.snapshot().revision});
  assert.throws(()=>commitFixtureTask(f.store,f.input),{code:'commit_records_present'});
  assert.throws(()=>observeFixtureCommit(f.store),{code:'commit_history_invalid'});
}));

for(const point of ['intent','temp-create','temp-write','file-sync','rename','dir-sync','result-sync','result'])
test(`C2b actual SIGKILL at ${point} never retries or synthesizes completion`,()=>fixture(async f=>{
  f.store.close();
  const source=`import fs from 'node:fs';
    import {openTaskExecutionStore} from ${JSON.stringify(new URL('./task-owner.mjs',import.meta.url).href)};
    import {commitFixtureTask} from ${JSON.stringify(new URL('./task-commit.mjs',import.meta.url).href)};
    const options=JSON.parse(process.argv[1]),input=JSON.parse(process.argv[2]),point=process.argv[3];
    const store=openTaskExecutionStore({...options,create:false});let temporaryFd,renamed=false;const opened=new Map();
    const pause=()=>{console.log('held');fs.readSync(0,Buffer.alloc(1),0,1,null);};
    const open=fs.openSync;fs.openSync=function(p,flags,...rest){const fd=open(p,flags,...rest);opened.set(fd,String(p));
      if(String(p).includes('/.cm-task.') && (flags&fs.constants.O_CREAT)){temporaryFd=fd;if(point==='temp-create')pause();}return fd;};
    const write=fs.writeFileSync;fs.writeFileSync=function(fd,...rest){const value=write(fd,...rest);if(fd===temporaryFd && point==='temp-write')pause();return value;};
    const sync=fs.fsyncSync;fs.fsyncSync=function(fd){const value=sync(fd);
      if(fd===temporaryFd && point==='file-sync')pause();
      if(renamed && fs.fstatSync(fd).isDirectory() && point==='dir-sync')pause();
      if(point==='result-sync' && opened.get(fd)?.includes('/.state.') && JSON.parse(fs.readFileSync(opened.get(fd))).records.length===2)pause();
      return value;};
    const rename=fs.renameSync;fs.renameSync=function(a,b){const value=rename(a,b);
      if(String(b)===options.tasksPath){renamed=true;if(point==='rename')pause();}
      if(String(b).endsWith('/state.json')){const n=JSON.parse(fs.readFileSync(b)).records.length;if(point==='intent' && n===1 || point==='result' && n===2)pause();}
      return value;};
    commitFixtureTask(store,input);store.close();throw Error('missed kill point');`;
  const child=childProcess.spawn(process.execPath,['--input-type=module','-e',source,JSON.stringify(f.options),JSON.stringify(f.input),point],{stdio:['pipe','pipe','pipe']});
  const done=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));let output='',errors='';
  child.stderr.on('data',b=>errors+=b);
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('kill fixture deadline: '+errors)),10000);
      child.stdout.on('data',b=>{output+=b;if(output.includes('held\n')){clearTimeout(timer);resolve();}});
      child.once('close',()=>{clearTimeout(timer);reject(Error('kill fixture exited: '+errors));});
      child.once('error',e=>{clearTimeout(timer);reject(e);});
    });
    child.kill('SIGKILL');assert.equal((await done).signal,'SIGKILL');
    const store=f.reopen(),state=store.snapshot(),observed=observeFixtureCommit(store);
    assert.equal(observed.observation,['rename','dir-sync','result-sync','result'].includes(point)?'observed_after':'observed_before');
    assert.equal(observed.recordedOutcome,point==='result'?'fixture_committed':null);
    assert.deepEqual(store.snapshot(),state);assert.throws(()=>commitFixtureTask(store,f.input),{code:'commit_records_present'});
  }finally{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');await done;}
}));

test('C2b cancellation delivered after rename cannot undo committed bytes',()=>fixture(f=>{
  const original=fs.renameSync,c=new AbortController();let hit=false;
  try{fs.renameSync=(a,b)=>{original(a,b);if(b===f.tasksPath){hit=true;c.abort();}};
    assert.equal(commitFixtureTask(f.store,f.input,c.signal).outcome,'fixture_committed');assert(hit);
  }finally{fs.renameSync=original;}
}));

function rewriteHistory(f,mutate) {
  const p=path.join(f.specsRoot,'.reviews/.execution/commit/state.json'),s=JSON.parse(fs.readFileSync(p));mutate(s);
  let previousDigest=null;
  s.records=s.records.map((r,i)=>{const {digest:old,...data}=r;const next={...data,seq:i+1,previousDigest};
    const sealed={...next,digest:digest(next)};previousDigest=sealed.digest;return sealed;});
  const {revision:old,...data}=s;fs.writeFileSync(p,JSON.stringify({...data,revision:digest(data)})+'\n');
}
for(const size of [1024*1024,1024*1024+1])test(`C2b complete record envelope cap ${size}`,()=>fixture(f=>{
  interrupted(f);const store=f.reopen();
  rewriteHistory(f,s=>{
    const r=s.records[0];r.payload.proof.root='/source/';
    const remaining=size-Buffer.byteLength(JSON.stringify(r));assert(remaining>0);
    r.payload.proof.root+='a'.repeat(remaining);assert.equal(Buffer.byteLength(JSON.stringify(r)),size);
  });
  if(size===1024*1024)assert.equal(observeFixtureCommit(store).observation,'observed_after');
  else assert.throws(()=>observeFixtureCommit(store),{code:'commit_history_invalid'});
}));

for(const bad of ['version','protocol','owner','fingerprints','attempt','plan-digest','duplicate-evidence','temporary','parent','result-digest','third-record'])
test(`C2b exact history refuses ${bad}`,()=>fixture(f=>{
  commitFixtureTask(f.store,f.input);
  rewriteHistory(f,s=>{const p=s.records[0].payload;
    if(bad==='version')p.version=2;
    if(bad==='protocol')p.protocol='cm-task-runner';
    if(bad==='owner')p.owner.tasksPath=path.join(f.specsRoot,'tasks.md');
    if(bad==='fingerprints')p.fingerprints.inputs='0'.repeat(64);
    if(bad==='attempt')p.identity.attempt=2;
    if(bad==='plan-digest')p.plan.planDigest='0'.repeat(64);
    if(bad==='duplicate-evidence'){p.plan.evidence.push(p.plan.evidence[0]);const {planDigest,...body}=p.plan;p.plan.planDigest=digest(body);}
    if(bad==='temporary')p.temporaryName='../tasks.md';
    if(bad==='parent')p.parent.path=f.specsRoot;
    if(bad==='result-digest')s.records[1].payload.intentDigest='0'.repeat(64);
    if(bad==='third-record')s.records.push({...s.records[1],id:'unexpected'});
  });
  assert.throws(()=>observeFixtureCommit(f.store),{code:'commit_history_invalid'});
}));

test('C2b Python Unicode path ordering does not use JS UTF16 order',()=>fixture(f=>{
  interrupted(f);const store=f.reopen();
  rewriteHistory(f,s=>{
    const p=s.records[0].payload.plan;p.evidence=[{path:'/\ue000',revision:'0'.repeat(64)},{path:'/\u{10000}',revision:'1'.repeat(64)}];
    assert.notDeepEqual(p.evidence.map(e=>e.path),p.evidence.map(e=>e.path).sort());
    const {planDigest,...body}=p;p.planDigest=digest(body);
  });
  assert.equal(observeFixtureCommit(store).observation,'observed_after');
}));

for(const kind of ['task-growth','temp-growth','write','chmod','temp-sync','task-rename','parent-sync'])
test(`C2b file failure ${kind} retains unknown and bounded reads`,()=>fixture(f=>{
  const originals={open:fs.openSync,read:fs.readSync,write:fs.writeFileSync,chmod:fs.fchmodSync,sync:fs.fsyncSync,rename:fs.renameSync};
  const paths=new Map();let hit=false,renamed=false;
  const fail=()=>{hit=true;throw Object.assign(Error('fixture I/O failure'),{code:'EIO'});};
  try {
    fs.openSync=(p,...rest)=>{const fd=originals.open(p,...rest);paths.set(fd,String(p));return fd;};
    const isTemp=fd=>paths.get(fd)?.includes('/.cm-task.');
    fs.readSync=(fd,buf,offset,length,...rest)=>{
      if(!hit && (kind==='task-growth' && paths.get(fd)===f.tasksPath || kind==='temp-growth' && isTemp(fd))){
        hit=true;fs.appendFileSync(paths.get(fd),Buffer.alloc(256*1024+1));assert(length<=256*1024+1);}
      return originals.read(fd,buf,offset,length,...rest);
    };
    fs.writeFileSync=(fd,...rest)=>{if(kind==='write' && isTemp(fd))fail();return originals.write(fd,...rest);};
    fs.fchmodSync=(fd,...rest)=>{if(kind==='chmod' && isTemp(fd))fail();return originals.chmod(fd,...rest);};
    fs.fsyncSync=fd=>{
      if(kind==='temp-sync' && isTemp(fd))fail();
      if(isTemp(fd))assert.equal(fs.fstatSync(fd).mode&0o7777,0o640,'mode precedes file sync');
      if(kind==='parent-sync' && renamed && fs.fstatSync(fd).isDirectory())fail();
      return originals.sync(fd);
    };
    fs.renameSync=(a,b)=>{if(b===f.tasksPath){if(kind==='task-rename')fail();renamed=true;}return originals.rename(a,b);};
    assert.throws(()=>commitFixtureTask(f.store,f.input),{code:'commit_unknown'});assert(hit);
    const result=f.store.snapshot();assert.equal(result.records.length,1);
    assert.equal(fs.readFileSync(f.tasksPath).includes(Buffer.from('[x]')),kind==='parent-sync');
  }finally{fs.openSync=originals.open;fs.readSync=originals.read;fs.writeFileSync=originals.write;
    fs.fchmodSync=originals.chmod;fs.fsyncSync=originals.sync;fs.renameSync=originals.rename;}
}));

for(const change of ['binding','close','history'])test(`C2b final owner ${change} change prevents replacement`,()=>fixture(f=>{
  const original=childProcess.spawnSync;let hit=false;
  try{childProcess.spawnSync=(command,args,opts)=>{const r=original(command,args,opts);
    if(args.includes('verify-mark-done-plan')){hit=true;
      if(change==='binding')fs.writeFileSync(path.join(f.dir,'.reviews/.cm-task-owner.json'),'invalid');
      if(change==='close')f.store.close();
      if(change==='history')f.store.append({id:'foreign',kind:'cancel',payload:{},expectedRevision:f.store.snapshot().revision});
    }return r;};
    assert.throws(()=>commitFixtureTask(f.store,f.input),{code:'commit_unknown'});assert(hit);
    assert(!fs.readFileSync(f.tasksPath).includes(Buffer.from('[x]')));
    const s=JSON.parse(fs.readFileSync(path.join(f.specsRoot,'.reviews/.execution/commit/state.json')));
    assert.equal(s.records.length,change==='history'?2:1);
  }finally{childProcess.spawnSync=original;}
}));
