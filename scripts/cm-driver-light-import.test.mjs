import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CHECK_DRIVE_COPIED_FILES} from './cm-check-drive-files.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
test('R1 B1 shared driver imports from the original check-only runtime without runner dependencies',t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-light-driver-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const file of CHECK_DRIVE_COPIED_FILES){
    const target=path.join(dir,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,file),target);
  }
  for(const file of ['completion-summary.mjs','delivery-evidence.mjs','task-runner.mjs'])
    assert.equal(fs.existsSync(path.join(dir,'runtime/js/cm-ai',file)),false,'test uses the original partial runtime inventory');
  const source=`import {driveHost} from ${JSON.stringify(pathToFileURL(path.join(dir,'runtime/js/cm-ai/drive-core.mjs')).href)};
    import {completionLines,deliveryLines} from ${JSON.stringify(pathToFileURL(path.join(dir,'runtime/js/cm-ai/operator-guidance.mjs')).href)};
    if(typeof driveHost!=='function'||completionLines(null).length!==0||deliveryLines({}).length!==2)process.exitCode=1;`;
  const run=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:dir,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);assert.equal(run.stdout,'');
});

test('R1 B1 legacy formatter exports reuse the exact lightweight formatting functions',async()=>{
  const light=await import('../runtime/js/cm-ai/operator-guidance.mjs');
  const completion=await import('../runtime/js/cm-ai/completion-summary.mjs');
  const delivery=await import('../runtime/js/cm-ai/delivery-evidence.mjs');
  assert.equal(typeof light.completionLines,'function');assert.equal(typeof light.deliveryLines,'function');
  assert.equal(completion.completionLines,light.completionLines);assert.equal(delivery.deliveryLines,light.deliveryLines);
});
