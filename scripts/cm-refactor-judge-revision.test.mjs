import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createCmRefactorHost} from '../runtime/js/cm-refactor/host.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {fixture,fullResponse,original,replacement} from './fixtures/cm-refactor.mjs';

const revisedJudge="import {calc} from './input.mjs'; console.log(JSON.stringify({cases:[-2,0,2,3].map((x,i)=>({id:String(i),input:x,output:calc(x)}))}));\n";
const regression=replacement.replace('if (x < 0)', 'if (x === 3) return 99; if (x < 0)');
const request={paths:['judge.mjs'],reason:'Add missing boundary input 3 to judge.mjs.'};
function scenario(t,{first=replacement,second=first,revision=request,edit,reviewVerdict='changes_requested',hook}={}){
  const value=fixture(t),{config,project}=value;config.testSetup={paths:['judge.mjs','baseline.mjs']};
  const calls=[],directory=path.join(project,'docs/refactors/extract');
  async function call(kind,payload){
    calls.push({kind,payload});const override=await hook?.(kind,payload);if(override!==undefined)return override;
    if(kind==='refactor_apply')return {...fullResponse(kind,payload),files:payload.files.map(file=>({...file,content:payload.attempt===1?first:second}))};
    if(kind==='refactor_revise_tests')return edit?edit(payload):{files:payload.assets.map(file=>({...file,content:revisedJudge}))};
    const result=fullResponse(kind,payload);
    if(kind==='refactor_review'&&payload.attempt===1){
      result.markdown=result.markdown.replace('verdict: approved',`verdict: ${reviewVerdict}`).replace('blocking_findings: 0',`blocking_findings: ${reviewVerdict==='approved'?0:1}`)+'\n'+request.reason+'\n';
      if(revision!==undefined&&revision!==false)result.judgeRevision=revision;
    }
    return result;
  }
  return {...value,directory,calls,call,host:createCmRefactorHost(config,{call})};
}
const rows=directory=>fs.readFileSync(path.join(directory,'execution.jsonl'),'utf8').trimEnd().split('\n').map(JSON.parse);
const report=(directory,name)=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8').replace(/^```json\n/,'').replace(/\n```\n$/,''));

test('round 2 revises declared judge assets and rebuilds original and refactored evidence',async t=>{
  const s=scenario(t);const result=await s.host.handle({operation:'start'});
  assert.equal(result.stage,'awaiting_finish',JSON.stringify(result));
  assert.equal(s.calls.filter(c=>c.kind==='refactor_revise_tests').length,1,'review-requested judge revision must run');
  const request=s.calls.find(c=>c.kind==='refactor_revise_tests').payload;
  assert.deepEqual(request.assets.map(a=>a.path),['judge.mjs']);
  assert.equal(fs.readFileSync(path.join(s.project,'judge.mjs'),'utf8'),revisedJudge);
  const old=report(s.directory,'judge-1-report.md'),fresh=report(s.directory,'a2-judge-1-report.md');
  assert.equal(old.judgeBefore.cases.length,3);assert.equal(fresh.judgeBefore.cases.length,4);
  assert.equal(fresh.judgeBefore.cases.at(-1).output,4);assert.equal(fresh.mutations.length,2);
  assert.ok(fresh.mutations.every(m=>m.detected));
  const comparison=report(s.directory,'a2-diff.md');assert.deepEqual(comparison.before,comparison.after);
  assert.deepEqual(comparison.before,fresh.judgeBefore);
  const reviewed=s.calls.find(c=>c.kind==='refactor_review'&&c.payload.attempt===2).payload;
  assert.ok(reviewed.files.some(f=>f.path==='judge.mjs'&&f.after===revisedJudge));
  assert.ok(reviewed.reports.includes(path.join(s.directory,'a2-judge-revision.md')));
  const history=fs.readFileSync(path.join(s.directory,'execution.jsonl'),'utf8');
  const evidence=Object.fromEntries(result.reports.map(file=>[file,fs.readFileSync(file,'utf8')]));
  const reopened=createCmRefactorHost(s.config,{call:async()=>{throw Error('must replay without another author/review');}});
  const resumed=await reopened.handle({operation:'resume'});assert.equal(resumed.stage,'awaiting_finish',JSON.stringify(resumed));
  assert.ok(fs.readFileSync(path.join(s.directory,'execution.jsonl'),'utf8').startsWith(history));
  for(const [file,bytes] of Object.entries(evidence))assert.equal(fs.readFileSync(file,'utf8'),bytes);
});

test('new boundary must not absorb a round-1 behavior regression into expected answers',async t=>{
  const s=scenario(t,{first:regression});const result=await s.host.handle({operation:'start'});
  assert.equal(result.reason,'refactor_behavior_changed');
  assert.equal(s.calls.filter(c=>c.kind==='refactor_review').length,1);
  assert.equal(report(s.directory,'a2-judge-1-report.md').judgeBefore.cases.at(-1).output,4);
  assert.equal(report(s.directory,'a2-diff.md').after.cases.at(-1).output,99);
  assert.equal(fs.readFileSync(path.join(s.project,'input.mjs'),'utf8'),original);
});

test('round 2 can repair a newly exposed business regression before comparison',async t=>{
  const s=scenario(t,{first:regression,second:replacement});const result=await s.host.handle({operation:'start'});
  assert.equal(result.stage,'awaiting_finish',JSON.stringify(result));
  assert.equal(result.differentialCount,4);
});

test('revised judge must repeat mutation self-validation on the original business version',async t=>{
  const s=scenario(t,{edit:payload=>({files:payload.assets.map(file=>({...file,content:"console.log(JSON.stringify({cases:[-2,0,2,3].map((x,i)=>({id:String(i),input:x,output:x<0?0:x+1}))}));\n"}))})});
  const result=await s.host.handle({operation:'start'});assert.equal(result.reason,'refactor_judge_missed_mutation');
  assert.equal(s.calls.filter(c=>c.kind==='refactor_review').length,1);
  assert.equal(fs.readFileSync(path.join(s.project,'input.mjs'),'utf8'),replacement);
});

for(const [label,revision] of [['business file',{...request,paths:['input.mjs']}],['undeclared asset',{...request,paths:['other.mjs']}],['duplicate path',{...request,paths:['judge.mjs','judge.mjs']}],['empty scope',{...request,paths:[]}],['missing reason',{paths:['judge.mjs'],reason:''}]]){
  test(`reject judge revision request: ${label}`,async t=>{
    const s=scenario(t,{revision});const result=await s.host.handle({operation:'start'});
    assert.equal(result.reason,'refactor_judge_revision_scope');assert.equal(s.calls.some(c=>c.kind==='refactor_revise_tests'),false);
  });
}
for(const [label,edit] of [
  ['outside declared subset',payload=>({files:[{path:'baseline.mjs',beforeDigest:digest(null),content:'bad'}]})],
  ['stale digest',payload=>({files:[{...payload.assets[0],beforeDigest:'stale',content:revisedJudge}]})],
  ['business file',()=>({files:[{path:'input.mjs',beforeDigest:digest(replacement),content:regression}]})]
])test(`reject judge text proposal: ${label}`,async t=>{
  const s=scenario(t,{edit});const before=fs.readFileSync(path.join(s.project,'judge.mjs'),'utf8');
  const result=await s.host.handle({operation:'start'});assert.equal(result.reason,'refactor_proposal_scope');
  assert.equal(fs.readFileSync(path.join(s.project,'judge.mjs'),'utf8'),before);
});

test('approved review cannot authorize judge revision',async t=>{
  const s=scenario(t,{reviewVerdict:'approved'});const result=await s.host.handle({operation:'start'});
  assert.equal(result.reason,'refactor_judge_revision_unavailable');assert.equal(s.calls.some(c=>c.kind==='refactor_revise_tests'),false);
});

test('interrupted judge author reconciles its original result and preserves history',async t=>{
  let pending;const s=scenario(t,{hook:(kind,payload)=>{if(kind==='refactor_revise_tests'){pending=payload;throw Error('lost judge author response');}}});
  const result=await s.host.handle({operation:'start'});assert.equal(result.reason,'lost judge author response');
  const history=fs.readFileSync(path.join(s.directory,'execution.jsonl'),'utf8');let recoveries=0;
  const reopened=createCmRefactorHost(s.config,{call:async(kind,payload)=>{
    if(kind==='refactor_recover'){recoveries++;assert.equal(payload.input.kind,'refactor_revise_tests');
      return {decision:'completed',evidence:'Synthetic original author response receipt',result:{durationMs:1,value:{files:pending.assets.map(a=>({...a,content:revisedJudge}))}}};}
    assert.notEqual(kind,'refactor_revise_tests');return s.call(kind,payload);
  }});
  const resumed=await reopened.handle({operation:'resume'});assert.equal(resumed.stage,'awaiting_finish',JSON.stringify(resumed));
  assert.equal(recoveries,1);assert.ok(fs.readFileSync(path.join(s.directory,'execution.jsonl'),'utf8').startsWith(history));
});

test('revised baseline must pass on the original business version',async t=>{
  const s=scenario(t,{first:regression,revision:{...request,paths:['judge.mjs','baseline.mjs']},edit:payload=>({files:payload.assets.map(a=>({...a,content:a.path==='judge.mjs'?revisedJudge:
    "import assert from 'node:assert/strict';import {calc} from './input.mjs';assert.equal(calc(3),99);\n"}))})});
  const result=await s.host.handle({operation:'start'});assert.equal(result.reason,'refactor_baseline_failed');
  assert.equal(s.calls.filter(c=>c.kind==='refactor_review').length,1);
  assert.equal(fs.readFileSync(path.join(s.project,'input.mjs'),'utf8'),regression);
});

test('judge author direct disk writes remain forbidden',async t=>{
  const s=scenario(t,{hook:(kind)=>{if(kind==='refactor_revise_tests')fs.appendFileSync(path.join(s.project,'judge.mjs'),'// outside controlled edit\n');}});
  const result=await s.host.handle({operation:'start'});assert.equal(result.reason,'refactor_source_changed');
  assert.equal(s.calls.filter(c=>c.kind==='refactor_review').length,1);
});

test('crash prefixes resume judge swaps, pending mutation and candidate restoration',async t=>{
  const s=scenario(t);const result=await s.host.handle({operation:'start'});
  assert.equal(result.stage,'awaiting_finish',JSON.stringify(result));
  const journalPath=path.join(s.directory,'execution.jsonl'),text=fs.readFileSync(journalPath,'utf8'),lines=text.trimEnd().split('\n'),all=rows(s.directory);
  const points=[
    ['write/a2/judge-revision/judge.mjs','before'],['write/a2/judge-revision/judge.mjs','after'],
    ['write/a2-judge-original/input.mjs','after'],['command/a2-judge-1/original','before'],
    ['command/a2-judge-1/mutant-0','before'],['write/a2-judge-candidate/input.mjs','after']
  ];
  for(const [key,side] of points){
    const index=all.findIndex(row=>row.type==='intent'&&row.key===key);assert.ok(index>=0,`missing durable effect ${key}`);
    const prefix=all.slice(0,index+1),context=all.find(row=>row.type==='context').value;
    const disk=new Map(Object.entries(context.original).map(([name,content])=>[path.join(s.project,name),content]));
    for(let i=0;i<prefix.length;i++)if(prefix[i].type==='intent'&&prefix[i].kind==='write'){
      const entry=prefix[i],completed=prefix.some(row=>row.type==='result'&&row.key===entry.key);
      disk.set(entry.input.target,completed||i===index&&side==='after'?entry.input.after:entry.input.before);
    }
    for(const [file,content] of disk){if(content===null)fs.rmSync(file,{force:true});else fs.writeFileSync(file,content);}
    const history=lines.slice(0,index+1).join('\n')+'\n';fs.writeFileSync(journalPath,history);
    let reconciled=0;
    const reopened=createCmRefactorHost(s.config,{call:async(kind,payload)=>{
      if(kind==='refactor_recover'){
        reconciled++;assert.equal(payload.kind,'command');
        // No command dispatch occurred at this synthetic cut. Replay must run against the correct swapped source.
        return {decision:'not_started',evidence:'Synthetic cut before command dispatch'};
      }
      return s.call(kind,payload);
    }});
    const resumed=await reopened.handle({operation:'resume'});assert.equal(resumed.stage,'awaiting_finish',`${key}: ${JSON.stringify(resumed)}`);
    assert.equal(reconciled,key.startsWith('command/')?1:0);assert.equal(fs.readFileSync(path.join(s.project,'input.mjs'),'utf8'),replacement);
    assert.ok(fs.readFileSync(journalPath,'utf8').startsWith(history));
    assert.equal(report(s.directory,'a2-diff.md').before.cases.at(-1).output,4);
  }
});


test('batch judge revision restores original additions and deletions before building answers',async t=>{
  const s=scenario(t,{hook:(kind,payload)=>{
    if(kind==='refactor_batch'||kind==='refactor_retrospective'){
      const result=fullResponse(kind,payload);
      if(payload.action==='generate')result.needs=[];
      if(kind==='refactor_retrospective'){result.learning={status:'no_new_lesson',candidates:[],reason:null};result.conventions=[];}
      return result;
    }
  }});
  fs.writeFileSync(path.join(s.project,'old.mjs'),'export const old = 1;\n');
  for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']]){
    const out=spawnSync('git',args,{cwd:s.project});assert.equal(out.status,0,out.stderr.toString());
  }
  s.config.scope=['input.mjs','new.mjs','old.mjs'];
  s.config.batch={assemblyFiles:[],cheapCommands:[],maxPasses:3};
  const host=createCmRefactorHost(s.config,{call:s.call}),result=await host.handle({operation:'start'});
  assert.equal(result.stage,'awaiting_finish',JSON.stringify(result));
  const events=rows(s.directory);
  for(const [name,content] of [['new.mjs',null],['old.mjs','export const old = 1;\n']]){
    const write=events.find(row=>row.key===`write/a2-judge-original/${name}`&&row.type==='intent');
    assert.ok(write,`must restore ${name} from startup snapshot`);assert.equal(write.input.after,content);
  }
  assert.equal(report(s.directory,'a2-judge-1-report.md').judgeBefore.cases.length,4);
  assert.equal(fs.existsSync(path.join(s.project,'old.mjs')),false);assert.ok(fs.existsSync(path.join(s.project,'new.mjs')));
});

test('original restoration includes legal business filenames starting with double underscore',async t=>{
  const s=scenario(t,{first:regression,edit:payload=>({files:payload.assets.map(a=>({...a,content:revisedJudge.replace('./input.mjs','./__input.mjs')}))})});
  fs.renameSync(path.join(s.project,'input.mjs'),path.join(s.project,'__input.mjs'));
  for(const name of ['judge.mjs','baseline.mjs']){
    const file=path.join(s.project,name);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('./input.mjs','./__input.mjs'));
  }
  s.config.scope=['__input.mjs'];s.config.mutations.forEach(m=>{m.path='__input.mjs';});
  const host=createCmRefactorHost(s.config,{call:s.call}),result=await host.handle({operation:'start'});
  assert.equal(result.reason,'refactor_behavior_changed');
  assert.equal(report(s.directory,'a2-judge-1-report.md').judgeBefore.cases.at(-1).output,4);
  assert.equal(s.calls.filter(c=>c.kind==='refactor_review').length,1);
  assert.equal(fs.readFileSync(path.join(s.project,'__input.mjs'),'utf8'),original);
});


function legacyBlocked(t){
  let attempts=0;
  const s=scenario(t,{revision:false,hook:(kind,payload)=>{
    if(kind==='refactor_apply'&&payload.attempt===2&&attempts++===0)
      return {...fullResponse(kind,payload),files:[{path:'judge.mjs',beforeDigest:digest(fs.readFileSync(path.join(s.project,'judge.mjs'),'utf8')),content:revisedJudge}]};
  }});
  return s;
}
for(const interrupted of [false,true])test(`legacy rejected judge proposal can register bounded revision and resume (interrupted=${interrupted})`,async t=>{
  const s=legacyBlocked(t);assert.equal((await s.host.handle({operation:'start'})).reason,'refactor_proposal_scope');
  const file=path.join(s.directory,'execution.jsonl'),history=fs.readFileSync(file,'utf8');
  const first=path.join(s.project,'docs/refactors/.reviews/refactor-extract-T-REFACTOR-extract-r1.md'),reviewBytes=fs.readFileSync(first,'utf8');
  const prepared=await s.host.handle({operation:'prepare_judge_revision',judgeRevision:request});
  assert.equal(prepared.stage,'judge_revision_prepared',JSON.stringify(prepared));
  const registered=fs.readFileSync(file,'utf8');
  assert.equal((await s.host.handle({operation:'prepare_judge_revision',judgeRevision:request})).stage,'judge_revision_prepared');
  assert.equal(fs.readFileSync(file,'utf8'),registered,'identical registration is read-only');
  if(interrupted){
    const lines=registered.trimEnd().split('\n'),index=lines.findIndex(line=>{const row=JSON.parse(line);return row.key==='judge-revision-registration'&&row.type==='intent';});
    assert.ok(index>=0);fs.writeFileSync(file,lines.slice(0,index+1).join('\n')+'\n');
  }
  const reopened=createCmRefactorHost(s.config,{call:s.call}),resumed=await reopened.handle({operation:'resume'});
  assert.equal(resumed.stage,'awaiting_finish',JSON.stringify(resumed));assert.equal(resumed.attempt,2);assert.equal(resumed.differentialCount,4);
  assert.ok(fs.readFileSync(file,'utf8').startsWith(history));assert.equal(fs.readFileSync(first,'utf8'),reviewBytes);
  const events=rows(s.directory),registration=events.find(row=>row.key==='judge-revision-registration'&&row.type==='intent');
  assert.equal(registration.input.supersededApply.key,'host/a2/apply');
  assert.ok(events.some(row=>row.key==='host/a2-after-judge-revision/apply'));
  assert.equal(events.filter(row=>row.key==='host/a2/apply'&&row.type==='intent').length,1);
  assert.equal(s.calls.filter(c=>c.kind==='refactor_review').length,2);
  const changed=await reopened.handle({operation:'prepare_judge_revision',judgeRevision:{...request,paths:['baseline.mjs']}});
  assert.equal(changed.reason,'refactor_judge_revision_conflict');
});

test('legacy revision registration rejects undeclared assets',async t=>{
  const s=legacyBlocked(t);await s.host.handle({operation:'start'});
  const result=await s.host.handle({operation:'prepare_judge_revision',judgeRevision:{...request,paths:['input.mjs']}});
  assert.equal(result.reason,'refactor_judge_revision_scope');assert.equal(rows(s.directory).some(row=>row.key==='judge-revision-registration'),false);
});

for(const reviewVerdict of ['approved','changes_requested'])test(`legacy revision registration refuses a consumed review stage (${reviewVerdict})`,async t=>{
  const s=scenario(t,{revision:false,reviewVerdict});assert.equal((await s.host.handle({operation:'start'})).stage,'awaiting_finish');
  const result=await s.host.handle({operation:'prepare_judge_revision',judgeRevision:request});
  assert.equal(result.reason,'refactor_judge_revision_unavailable');assert.equal(s.calls.some(c=>c.kind==='refactor_revise_tests'),false);
});

test('judge registration before start refuses without poisoning the future run',async t=>{
  const s=scenario(t,{revision:false,reviewVerdict:'approved'});
  assert.equal((await s.host.handle({operation:'prepare_judge_revision',judgeRevision:request})).reason,'refactor_not_started');
  const result=await s.host.handle({operation:'start'});
  assert.equal(result.stage,'awaiting_finish',JSON.stringify(result));
});
