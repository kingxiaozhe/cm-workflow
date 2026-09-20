import assert from 'node:assert/strict';
import test from 'node:test';

import {executionDiagnostic,failureCode,reportExecutionCollapse} from '../runtime/js/cm-ai/effect-contract.mjs';

const collapse=error=>{let out='';reportExecutionCollapse(error,value=>{out+=value;});return out;};
const named=(message,fields)=>Object.assign(new Error(message),fields);

test('a filesystem collapse names the syscall and both paths', () => {
  const line=collapse(named('EEXIST: file already exists, link a -> b',
    {code:'EEXIST',syscall:'link',path:'/specs/.reviews/.cm-initial-handoff-1',dest:'/specs/.reviews/x-a1-handoff.json'}));
  assert.equal(line.endsWith('\n'),true);
  assert.deepEqual(JSON.parse(line),{diagnostic:'execution_error',code:'EEXIST',syscall:'link',
    path:'/specs/.reviews/.cm-initial-handoff-1',dest:'/specs/.reviews/x-a1-handoff.json'});
});

test('an internal contract collapse carries its code alone', () => {
  assert.deepEqual(JSON.parse(collapse(named('store_missing',{code:'store_missing'}))),
    {diagnostic:'execution_error',code:'store_missing'});
});

test('the raw message is never emitted', () => {
  const line=collapse(named('secret token sk-live-0123456789 leaked from provider output',{code:'EPERM'}));
  assert.equal(line.includes('sk-live'),false);
  assert.equal(line.includes('secret'),false);
  assert.deepEqual(JSON.parse(line),{diagnostic:'execution_error',code:'EPERM'});
});

test('fields that are absent, oversized or control-bearing are dropped', () => {
  assert.equal(executionDiagnostic(named('x',{code:'EBADF',path:'a'.repeat(1025)})).path,undefined);
  assert.equal(executionDiagnostic(named('x',{code:'EBADF',syscall:`open${String.fromCharCode(0)}rm`})).syscall,undefined);
  assert.equal(executionDiagnostic(named('x',{code:'EBADF',dest:''})).dest,undefined);
  assert.deepEqual(executionDiagnostic(named('x',{code:'EBADF'})),{code:'EBADF'});
});

test('an error with no usable field still produces a line', () => {
  assert.deepEqual(JSON.parse(collapse(new Error('no code at all'))),
    {diagnostic:'execution_error',detail:'unavailable'});
  assert.equal(executionDiagnostic(new Error('no code at all')),null);
});

test('an allowlisted code returns unchanged and emits nothing', () => {
  let emitted=false;
  const original=process.stderr.write;
  process.stderr.write=(...args)=>{emitted=true;return original.apply(process.stderr,args);};
  try{assert.equal(failureCode(named('invalid_input',{code:'invalid_input'})),'invalid_input');}
  finally{process.stderr.write=original;}
  assert.equal(emitted,false);
});

test('an unlisted code collapses and emits exactly one line', () => {
  const lines=[];
  const original=process.stderr.write;
  process.stderr.write=value=>{lines.push(String(value));return true;};
  try{assert.equal(failureCode(named('EEXIST: x',{code:'EEXIST',syscall:'link'})),'execution_error');}
  finally{process.stderr.write=original;}
  assert.equal(lines.length,1);
  assert.deepEqual(JSON.parse(lines[0]),{diagnostic:'execution_error',code:'EEXIST',syscall:'link'});
});

test('an error whose code cannot be read still collapses without throwing', () => {
  const hostile={};
  Object.defineProperty(hostile,'code',{get(){throw new Error('trap');}});
  const original=process.stderr.write;
  process.stderr.write=()=>true;
  try{assert.equal(failureCode(hostile),'execution_error');}
  finally{process.stderr.write=original;}
});
