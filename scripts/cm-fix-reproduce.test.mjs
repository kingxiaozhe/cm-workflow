import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFixReproduction,inspectFixReproduction} from '../runtime/js/cm-fix/reproduce.mjs';

import {publishFixObservationDossier} from '../runtime/js/cm-fix/dossier.mjs';

const identity={repositoryId:'fix-test',runId:'fix-run',taskId:'T-FIX-demo',attempt:1};
test('actual reproduction requires authorized command plus matching exit and defect signature',async()=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-repro-')));
  try{
    for(const [source,expected] of [
      ["process.stderr.write('BUG: value mismatch');process.exit(3)",'reproduced'],
      ["process.stderr.write('other error');process.exit(3)",'not_reproduced'],
      ["process.stderr.write('BUG: value mismatch');process.exit(2)",'not_reproduced'],
      ["process.stderr.write('BUG: value mismatch')",'not_reproduced'],
      ["process.stdout.write('BUG: value ');process.stderr.write('mismatch');process.exit(3)",'not_reproduced'],
    ]){
      const run=createFixReproduction({cwd,command:[process.execPath,'-e',source],
        expectedFailure:{exitCode:3,outputIncludes:'BUG: value mismatch'},timeoutMs:1000});
      const signal=new AbortController().signal;
      await assert.rejects(run({identity},{signal,authorized:false}),{code:'reproduction_authorization_required'});
      const result=await run({identity},{signal,authorized:true});assert.equal(result.status,expected);
      assert.equal(result.attempts.length,1);assert.equal(result.attempts[0].outcome,expected);
      assert.deepEqual(inspectFixReproduction(result,{command:[process.execPath,'-e',source],expectedFailure:{exitCode:3}}),result);
      assert(!result.observation.evidence.includes('BUG:'));
      await assert.rejects(run({identity},{signal,authorized:true}),{code:'reproduction_already_attempted'});
    }
    const missing=createFixReproduction({cwd,command:[path.join(cwd,'missing-command')],
      expectedFailure:{exitCode:3,outputIncludes:'BUG:'},timeoutMs:1000});
    const unavailable=await missing({identity},{signal:new AbortController().signal,authorized:true});
    assert.equal(unavailable.status,'blocked');assert.equal(unavailable.attempts[0].outcome,'unsupported');
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});

const config={command:['fixture'],expectedFailure:{exitCode:3}};
function result(status='reproduced'){
  return {status,next:status==='reproduced'?'diagnose':status==='blocked'?'resolve_execution':'observation',
    observation:{id:'reproduce',command:config.command,outcome:status==='blocked'?'unavailable':status==='reproduced'?'failed':'passed',
      exitCode:status==='blocked'?null:status==='reproduced'?3:0,evidence:'fixture evidence',signatureMatched:status==='reproduced'}};
}
const attempt=outcome=>({scenario:'empty input',dimension:'input',outcome});
test('legacy reproduction records without attempts remain readable for all outcomes',()=>{
  for(const status of ['reproduced','not_reproduced','blocked']){
    const legacy=result(status);assert.deepEqual(inspectFixReproduction(legacy,config),legacy);
  }
  assert.deepEqual(inspectFixReproduction({...result(),attempts:[]},config).attempts,[]);
});
test('observation requires at least one attempt; strict live validation also rejects missing attempts',()=>{
  assert.throws(()=>inspectFixReproduction({...result('not_reproduced'),attempts:[]},config),{code:'fix_reproduction_attempts_required'});
  assert.throws(()=>inspectFixReproduction(result('not_reproduced'),config,{requireAttempts:true}),{code:'fix_reproduction_attempts_required'});
  assert.equal(inspectFixReproduction({...result('not_reproduced'),attempts:[attempt('not_reproduced')]},config).next,'observation');
});
test('last attempt must match the evidence-backed overall conclusion',()=>{
  for(const [status,outcome] of [['reproduced','reproduced'],['not_reproduced','not_reproduced'],['blocked','unsupported']]){
    const value={...result(status),attempts:[attempt('not_reproduced'),attempt(outcome)]};
    assert.deepEqual(inspectFixReproduction(value,config),value);
    for(const other of ['reproduced','not_reproduced','unsupported'].filter(item=>item!==outcome)){
      assert.throws(()=>inspectFixReproduction({...value,attempts:[attempt(other)]},config),{code:'fix_reproduction_attempts_mismatch'});
    }
  }
  assert.throws(()=>inspectFixReproduction({...result('not_reproduced'),status:'reproduced',next:'diagnose',attempts:[attempt('reproduced')]},config),{code:'reproduction_mismatch'});
});
test('attempts reject invalid outcomes and malformed scenario records',()=>{
  for(const outcome of ['passed','failed','',null,1]){
    assert.throws(()=>inspectFixReproduction({...result(),attempts:[attempt(outcome)]},config),{code:'invalid_fix_reproduction_attempts'});
  }
  for(const attempts of [null,{},[null],[{...attempt('reproduced'),scenario:''}],[{...attempt('reproduced'),dimension:''}],[{scenario:'x',dimension:'input'}]]){
    assert.throws(()=>inspectFixReproduction({...result(),attempts},config));
  }
});

test('observation dossier rejects empty attempts, including diagnosis needing evidence',()=>{
  for(const status of ['reproduced','not_reproduced']){
    const reproduction={...result(status),attempts:[]};
    assert.throws(()=>publishFixObservationDossier({configuration:{reproduction:config},
      status:{stage:'observation',completionEligible:false,reproduction,diagnosis:{status:'needs_evidence'}}}),
      {code:'fix_reproduction_attempts_required'});
  }
});
