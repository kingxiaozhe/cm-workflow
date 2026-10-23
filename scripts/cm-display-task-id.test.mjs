import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {matchTaskDeclaration} from '../runtime/js/spec-task-line.mjs';

const root=new URL('../',import.meta.url);
const read=path=>readFileSync(new URL(path,root),'utf8');
const md=['- [x] T-001: done','- [ ] T-004a: suffix','- [ ] T-FIX-api：named','- [ ] T-002/a: malformed','- [ ] T-005 plain'].join('\n')+'\n';
const expected=['T-001','T-004a','T-FIX-api','T-005'];

test('display regexes accept the same task IDs as the core parser', ()=>{
  const core=md.split('\n').map(line=>matchTaskDeclaration(line)?.id).filter(Boolean);
  assert.deepEqual(core,expected);
});

for(const path of ['templates/pixel/cm-pixel.html','templates/pixel/dev/template.html']){
  test(`${path} counts suffixed and named task IDs`, ()=>{
    const source=read(path).match(/md\.match\(\/(.+?)\/gm\)/)[1];
    assert.equal(md.match(new RegExp(source,'gm')).length,expected.length);
  });
}

test('dashboard parseTasks keeps full task IDs', ()=>{
  const source=read('templates/dashboard/dashboard.html').match(/md\.matchAll\(\/(.+?)\/gm\)/)[1];
  assert.deepEqual([...md.matchAll(new RegExp(source,'gm'))].map(m=>m[2]),expected);
});

for(const path of ['templates/statusline/cm-statusline.sh','templates/pixel/cm-pixel.sh']){
  test(`${path} counts suffixed and named task IDs`, ()=>{
    const pattern=read(path).match(/re\.findall\(r"(.+?)", md, re\.M\)/)[1];
    const out=execFileSync('python3',['-c','import re,sys,json;print(json.dumps([t for _,t in re.findall(sys.argv[1],sys.argv[2],re.M)]))',pattern,md]).toString();
    assert.deepEqual(JSON.parse(out),expected);
  });
}
