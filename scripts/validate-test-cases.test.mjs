import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateTestCases} from './validate-test-cases.mjs';

const js=fileURLToPath(new URL('./validate-test-cases.mjs',import.meta.url));
const python=fileURLToPath(new URL('./validate-test-cases.py',import.meta.url));
const valid={schemaVersion:'1.0',feature:'login',cases:[{id:'TC-001',origin:'user',kind:'logic',blocking:true,
  acIds:['AC-001'],taskIds:['T-001'],title:'登录成功',preconditions:[],steps:['提交'],expected:['成功'],cleanup:[]}]};

function fixture(run){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-cases-js-')));
  try{return run(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}

test('JS test contract accepts the existing valid shape through both CLIs',()=>fixture(root=>{
  const file=path.join(root,'test-cases.json');fs.writeFileSync(file,`${JSON.stringify(valid)}\n`);
  assert.deepEqual(validateTestCases(valid),[]);
  const direct=spawnSync(process.execPath,[js,file],{encoding:'utf8'}),compat=spawnSync(process.env.CM_PYTHON_BIN||'python3',[python,file],{encoding:'utf8'});
  assert.equal(direct.status,0);assert.equal(compat.status,0);assert.equal(compat.stdout,direct.stdout);
  const usage=spawnSync(process.env.CM_PYTHON_BIN||'python3',[python],{encoding:'utf8'});
  assert.equal(usage.status,2);assert.match(usage.stderr,/^Usage: validate-test-cases\.py TEST_CASES_JSON/);
}));

test('JS test contract preserves ordered failures for a malformed case',()=>{
  const malformed={schemaVersion:'2',feature:'Login Feature',cases:[{id:'TC-009',origin:'other',kind:'api',blocking:'yes',title:'',
    acIds:['AC-1'],taskIds:[],preconditions:[],steps:[],expected:[],cleanup:[]}]};
  assert.deepEqual(validateTestCases(malformed),[
    'schemaVersion must equal "1.0"','feature must be a non-empty kebab-case string','cases[0].id must be TC-001',
    'cases[0].origin is invalid','cases[0].kind is invalid','cases[0].blocking must be boolean',
    'cases[0].title must be a non-empty string',"cases[0].acIds has invalid id: 'AC-1'",
    'cases[0].steps must not be empty','cases[0].expected must not be empty',
  ]);
});
