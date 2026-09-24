import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const selection={versionControl:'none',modules:[],analysis:'Fixture project'};
const targets=['AGENTS.md','.claude/CLAUDE.md','.claude/rules/coding-style.md',
  '.claude/rules/testing.md','.claude/rules/security.md'];
function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-drive-'))),project=path.join(dir,'project');
  fs.mkdirSync(project);fs.writeFileSync(path.join(project,'AGENTS.md'),'Original rule\n');
  const answers=path.join(dir,'answers');fs.mkdirSync(answers);
  const documents=targets.map((file,i)=>{const contentFile=`draft-${i}.md`;
    fs.writeFileSync(path.join(answers,contentFile),'# Fixture\nPreserve original rule\n');return {path:file,contentFile};});
  fs.writeFileSync(path.join(answers,'generate.json'),JSON.stringify({status:'generated',documents}));
  fs.writeFileSync(path.join(answers,'verify.json'),JSON.stringify({checks:Object.fromEntries(
    ['commands','globs','file_references','constraint_preservation','rule_applicability'].map(x=>[x,{status:'verified',evidence:'Fixture review'}])),constraintChanges:[]}));
  fs.writeFileSync(path.join(answers,'review.json'),JSON.stringify({reviewer:'codex-subagent',contextId:'independent-fixture',
    independent:true,at:new Date().toISOString(),result:{verdict:'approved',findings:[],summary:'Fixture verdict'}}));
  const sessionFile=path.join(dir,'session.json');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const plan=(over={})=>({project,sessionFile,mode:fs.existsSync(sessionFile)?'resume':'create',
    hostContext:'fixture-author',originalHostContext:fs.existsSync(sessionFile)?'fixture-author':undefined,
    answers,selection,...over});
  const drive=(value,operation='advance')=>{const file=path.join(dir,'plan.json');fs.writeFileSync(file,JSON.stringify(value));
    return spawnSync(process.execPath,[path.join(root,'scripts/cm-init-drive.mjs'),'--plan',file,operation],{encoding:'utf8'});};
  return {dir,project,answers,sessionFile,documents,plan,drive};
}
test('real init host: generated draft, resumed verification, review and actual scoped write',t=>{
  const f=fixture(t);let run=f.drive(f.plan());assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(run.stdout).result.status,'draft_generated');
  run=f.drive(f.plan());assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).result.stage,'review_required');
  const status=f.drive(f.plan({answers:undefined}),'status');assert.equal(status.status,0,status.stderr);
  assert.equal(JSON.parse(status.stdout).result.stage,'review_required');
  run=f.drive(f.plan());assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).result.stage,'reviewed_draft');
  run=f.drive(f.plan({allowWrite:true}));assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(run.stdout).result.stage,'rules_written');
  assert.equal(fs.readFileSync(path.join(f.project,'AGENTS.md'),'utf8'),'# Fixture\nPreserve original rule\n');
});
test('missing or malformed generated answer and out-of-scope edit refuse before session creation',t=>{
  const f=fixture(t),file=path.join(f.answers,'generate.json'),original=fs.readFileSync(file);
  fs.rmSync(file);let run=f.drive(f.plan());assert.equal(run.status,2);assert.match(run.stderr,/generate\.json/);
  fs.writeFileSync(file,'{}');run=f.drive(f.plan());assert.equal(run.status,2);assert.match(run.stderr,/答案格式错误/);
  const altered=JSON.parse(original);altered.documents[0].path='outside.md';fs.writeFileSync(file,JSON.stringify(altered));
  run=f.drive(f.plan());assert.equal(run.status,2);assert.match(run.stderr,/generate\.json/);
  assert.equal(fs.existsSync(f.sessionFile),false);
});
test('resume binding and missing write runner refuse before host launch',t=>{
  const f=fixture(t);assert.equal(f.drive(f.plan()).status,0);
  let run=f.drive(f.plan({originalHostContext:undefined}));assert.equal(run.status,2);assert.match(run.stderr,/originalHostContext/);
  assert.equal(f.drive(f.plan()).status,0);assert.equal(f.drive(f.plan()).status,0);
  const before=fs.readFileSync(f.sessionFile);
  fs.writeFileSync(path.join(f.answers,'init-write.json'),JSON.stringify({status:'written'}));
  run=f.drive(f.plan());assert.equal(run.status,2);assert.match(run.stderr,/init_write/);
  assert.deepEqual(fs.readFileSync(f.sessionFile),before);
});
