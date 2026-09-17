import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRuntimeMarks} from './cm-spec-manifest.mjs';
test('shared normalization preserves declaration, filename, fence and byte boundaries',()=>{
  for(const [name,declaration,other] of [['tasks.md','T-A.1:','[AC-001]'],['requirements.md','[AC-A.1]','T-001:']]){
    const lines=[`- [x] ${declaration} 中文`,`   -\t[X]\t${declaration} [CHANGED]`,
      `- [DROPPED] ${declaration} old`,`- [CHANGED] ${declaration} changed`,
      `text - [x] ${declaration} prose`,`- [x] ${other} wrong file`,'- [x] ordinary',
      `    - [x] ${declaration} code`,`\t- [x] ${declaration} code`,
      '```md',`- [x] ${declaration} fenced`,'```',
      '~~~~',`- [X] ${declaration} fenced`,'~~~~',`- [X] ${declaration} final`];
    for(const ending of ['\n','\r\n','\r']){
      const text=lines.join(ending),expected=[...lines];
      for(const i of [0,1,15])expected[i]=expected[i].replace(/\[[xX]\]/,'[ ]');
      assert.equal(normalizeRuntimeMarks(text,name),expected.join(ending));
      for(const otherName of ['design.md','test-cases.json','notes.md'])assert.equal(normalizeRuntimeMarks(text,otherName),text);
    }
  }
});
