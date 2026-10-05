import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
const identity={repositoryId:'fixture',runId:'efficiency',taskId:'T-001',attempt:1};
function fixture(t){const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-efficiency-check-')));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));return cwd;}
const control=()=>({signal:new AbortController().signal});
const command=[process.execPath,'-e',"require('node:fs').appendFileSync('executions','x');console.log('tests 3\\npass 3\\nfail 0')"];
test('declared adjacent identical checks share one execution; final acceptance executes again',async t=>{
  const cwd=fixture(t),output=[],progress=[];
  const check=createHostCheck({cwd,reuseDeclared:true,commands:[{id:'tests',command},{id:'ui',command,sameExecutionAs:'tests'}],
    onOutput:value=>{output.push(value.chunk.toString());},onProgress:value=>{progress.push(value);}});
  const rows=await check({identity},control());assert.equal(fs.readFileSync(path.join(cwd,'executions'),'utf8'),'x');
  assert.deepEqual(rows.map(r=>r.id),['tests','ui']);assert(rows.every(r=>r.outcome==='passed'));
  assert.match(rows[1].evidence,/same execution as tests;.*tests 3/);assert.equal(output.length,1);
  assert.equal(progress.filter(p=>p.phase==='start').length,1);
  await check({identity},control());assert.equal(fs.readFileSync(path.join(cwd,'executions'),'utf8'),'xx');
});
test('identical commands without explicit alias continue to execute twice',async t=>{
  const cwd=fixture(t),check=createHostCheck({cwd,reuseDeclared:true,commands:[{id:'one',command},{id:'two',command}]});
  await check({identity},control());assert.equal(fs.readFileSync(path.join(cwd,'executions'),'utf8'),'xx');
});
test('alias requires opt-in, same command, adjacent source and unique identity',t=>{
  const cwd=fixture(t),base=[{id:'one',command},{id:'two',command,sameExecutionAs:'one'}];
  assert.throws(()=>createHostCheck({cwd,commands:base}),/invalid_input/);
  for(const commands of [[base[1]], [base[0],{...base[1],command:[process.execPath,'--version']}],
    [base[0],{id:'other',command},base[1]], [base[0],{...base[1],id:'one'}]])
    assert.throws(()=>createHostCheck({cwd,reuseDeclared:true,commands}));
  assert(!fs.existsSync(path.join(cwd,'executions')));
});
test('failed original command is never recycled into a passed alias',async t=>{
  const cwd=fixture(t),fail=[process.execPath,'-e','process.exit(1)'];
  const check=createHostCheck({cwd,reuseDeclared:true,commands:[{id:'one',command:fail},{id:'two',command:fail,sameExecutionAs:'one'}]});
  const rows=await check({identity},control());assert.equal(rows.length,1);assert.equal(rows[0].outcome,'failed');
});
