import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRuntimeMarks,normalizeRuntimeMarkBytes} from './cm-spec-manifest.mjs';
test('shared normalization preserves declaration, filename, fence and byte boundaries',()=>{
  for(const [name,declaration,other] of [['tasks.md','T-A.1:','[AC-001]'],['requirements.md','[AC-A.1]','T-001:']]){
    const lines=[`- [x] ${declaration} 中文`,`   -\t[X]\t${declaration} [CHANGED]`,
      `- [DROPPED] ${declaration} old`,`- [CHANGED] ${declaration} changed`,
      `text - [x] ${declaration} prose`,`- [x] ${other} wrong file`,'- [x] ordinary',
      `    - [x] ${declaration} code`,`\t- [x] ${declaration} code`,
      '```md',`- [x] ${declaration} fenced`,'```',
      '~~~~',`- [X] ${declaration} fenced`,'~~~~',`- [X] ${declaration} final`];
    for(const ending of ['\n','\r\n','\r']){
      const text=lines.join(ending),reset=indices=>{const expected=[...lines];
        for(const i of indices)expected[i]=expected[i].replace(/\[[xX]\]/,'[ ]');return expected.join(ending);};
      // tasks.md follows the shared declaration grammar: indented task lines are
      // declarations (as admission always read them); requirements.md is unchanged.
      assert.equal(normalizeRuntimeMarks(text,name),reset(name==='tasks.md'?[0,1,7,8,15]:[0,1,15]));
      assert.equal(normalizeRuntimeMarks(text,name,{legacy:true}),reset([0,1,15]));
      assert.equal(normalizeRuntimeMarkBytes(Buffer.from(text),name).toString(),normalizeRuntimeMarks(text,name));
      for(const otherName of ['design.md','test-cases.json','notes.md'])assert.equal(normalizeRuntimeMarks(text,otherName),text);
    }
  }
});
