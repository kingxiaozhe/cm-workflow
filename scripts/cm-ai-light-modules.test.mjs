// Light runtime modules are copied on their own into partial runtimes (for example
// scripts/cm-check-drive.test.mjs lists the files it copies). Their static import closure must
// stay inside the allowed set, or such a copy fails with ERR_MODULE_NOT_FOUND.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const closure=entry=>{
  const seen=new Set(),queue=[path.join(root,entry)];
  while(queue.length){
    const file=queue.pop();if(seen.has(file))continue;seen.add(file);
    const source=fs.readFileSync(file,'utf8');
    for(const match of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/gm)){
      if(match[1].startsWith('.'))queue.push(path.resolve(path.dirname(file),match[1]));
      else assert(match[1].startsWith('node:'),`${entry} imports package ${match[1]}`);
    }
    for(const match of source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm))queue.push(path.resolve(path.dirname(file),match[1]));
  }
  return [...seen].map(file=>path.relative(root,file)).sort();
};

const LIGHT={
  'runtime/js/cm-ai/review-dispatch-limits.mjs':['runtime/js/cm-ai/review-dispatch-limits.mjs'],
  'runtime/js/cm-ai/operator-guidance.mjs':['runtime/js/cm-ai/operator-guidance.mjs','runtime/js/cm-ai/review-dispatch-limits.mjs'],
};
for(const [entry,allowed] of Object.entries(LIGHT))
  test(`light module ${path.basename(entry)} keeps its static import closure inside the allowed set`,()=>{
    assert.deepEqual(closure(entry),allowed);
  });

test('every file a light module needs is in the partial runtime copied by cm-check-drive.test.mjs',()=>{
  const listing=fs.readFileSync(path.join(root,'scripts/cm-check-drive.test.mjs'),'utf8');
  for(const file of closure('runtime/js/cm-ai/operator-guidance.mjs'))assert(listing.includes(`'${file}'`),`${file} missing from the copy list`);
});
