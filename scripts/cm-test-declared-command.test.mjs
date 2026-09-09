import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectDeclaredTestCommand} from '../runtime/js/cm-test/declared-command.mjs';
const sources=[{path:'package.json',sha256:'fixture-digest',content:JSON.stringify({scripts:{test:'node --test',
  pretest:'node scripts/prepare.mjs',posttest:'node scripts/cleanup.mjs',typecheck:'tsc --noEmit'}})}];
const item=command=>({command,declaration:{path:'package.json',line:1}});
test('package script declarations preserve original argv and disclose lifecycle scripts',()=>{
  for(const manager of ['npm','pnpm','yarn','bun'])for(const argv of [...(manager==='bun'?[]:[[manager,'test']]),[manager,'run','test'],[manager,'run','typecheck','--','--pretty','false']]){
    const before=[...argv],result=inspectDeclaredTestCommand(item(argv),sources);
    assert.equal(result.kind,'package-script');assert.deepEqual(argv,before);
    if(result.script==='test')assert.deepEqual(Object.keys(result.lifecycle),['pretest','test','posttest']);
  }
});
test('package declaration cannot authorize install, missing scripts, prefix/workspace or if-present flags',()=>{
  for(const argv of [['npm','install'],['pnpm','dlx','vitest'],['npm','--prefix','/tmp','test'],['npm','run','missing'],
    ['npm','run','test','--if-present'],['bun','test'],['yarn','workspace','other','test'],['sh','-c','npm test']])
    assert.throws(()=>inspectDeclaredTestCommand(item(argv),sources));
});
