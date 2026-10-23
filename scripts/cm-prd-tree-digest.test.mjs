import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {prdTreeFileDigest} from '../runtime/js/cm-prd/tree-digest.mjs';
import {readCmInitSource} from '../runtime/js/cm-init/draft-inspection.mjs';
import {inspectPrdChangeSnapshot,inspectPrdChangeProposal,applyPrdChange} from '../runtime/js/cm-prd/change.mjs';
import {loadConfig} from './cm-workflow-config.mjs';

test('PRD inventories large binary assets without widening document readers',t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-tree-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const feature=path.join(dir,'1.example');fs.mkdirSync(feature);
  for(const name of ['requirements.md','design.md','tasks.md'])fs.writeFileSync(path.join(feature,name),'content\n');
  const bytes=Buffer.alloc(1024*1024+17,0xfa),file=path.join(feature,'font.otf');fs.writeFileSync(file,bytes);
  const expected=createHash('sha256').update(bytes).digest('hex');
  assert.equal(prdTreeFileDigest(dir,'1.example/font.otf'),expected);
  assert.equal(inspectPrdChangeSnapshot(dir).trees['1.example'].find(row=>row.path.endsWith('font.otf')).sha256,expected);
  assert.throws(()=>readCmInitSource(feature,'font.otf'),{code:'init_draft_target_invalid'});
  fs.linkSync(file,path.join(feature,'hardlink.otf'));
  assert.throws(()=>prdTreeFileDigest(dir,'1.example/font.otf'),{code:'prd_change_asset_invalid'});
  fs.symlinkSync('tasks.md',path.join(feature,'link.md'));
  assert.throws(()=>prdTreeFileDigest(dir,'1.example/link.md'),{code:'prd_change_asset_invalid'});
  // A linked parent directory is refused too, not only a linked file.
  const outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-tree-out-')));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,'logo.png'),'same bytes');fs.symlinkSync(outside,path.join(feature,'assets'));
  assert.throws(()=>prdTreeFileDigest(dir,'1.example/assets/logo.png'),{code:'prd_change_asset_invalid'});
  for(const bad of ['../x','1.example/../x','/abs','1.example//x'])assert.throws(()=>prdTreeFileDigest(dir,bad),{code:'prd_change_asset_invalid'},bad);
});

test('exact PRD change saves and recovers with large original assets, rejects later asset drift',t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-asset-save-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const feature=path.join(dir,'1.example');fs.mkdirSync(feature);
  const version='\n| Date | Version | Change |\n| --- | --- | --- |\n| 2026-10-19 | v1 | original |\n';
  const original=[{path:'requirements.md',content:version+'\n- [ ] [AC-001] Keep asset\n'},
    {path:'design.md',content:version+'\nKeep original font\n'},
    {path:'tasks.md',content:version+'\n- [x] T-001: Original task\n'}];
  for(const d of original)fs.writeFileSync(path.join(feature,d.path),d.content);
  const asset=path.join(feature,'font.otf'),bytes=Buffer.alloc(1024*1024+13,0x92);fs.writeFileSync(asset,bytes);
  const before=inspectPrdChangeSnapshot(dir),selected=['1.example'];
  const documents=original.map(d=>({...d,content:d.content.replace('| 2026-10-19 | v1 | original |',
    '| 2026-10-19 | v1 | original |\n| 2026-10-22 | v2 | change |')+(d.path==='tasks.md'?'\n- [ ] T-004a: [NEW] Review task\n  - 范围: `README.md`\n':'\nClarification\n')}));
  const proposal=inspectPrdChangeProposal(before,{status:'draft',summary:'Clarify review ownership',removed:[],
    features:[{directory:'1.example',documents,testCasesReason:'no_observable_behavior'}]},selected,loadConfig({projectRoot:dir}));
  assert.equal(applyPrdChange({specs:dir,before,proposal,selected}).status,'awaiting_review');
  assert.deepEqual(fs.readFileSync(asset),bytes);
  assert.equal(applyPrdChange({specs:dir,before,proposal,selected}).status,'awaiting_review');
  fs.appendFileSync(asset,Buffer.from([1]));
  assert.throws(()=>applyPrdChange({specs:dir,before,proposal,selected}),{code:'prd_change_asset_changed'});
});

test('recovering a saved PRD change refuses an asset directory swapped for a link to identical bytes',t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-asset-link-')));
  const outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-asset-link-out-')));
  t.after(()=>{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
  const feature=path.join(dir,'1.example');fs.mkdirSync(path.join(feature,'assets'),{recursive:true});
  const version='\n| Date | Version | Change |\n| --- | --- | --- |\n| 2026-10-19 | v1 | original |\n';
  const original=[{path:'requirements.md',content:version+'\n- [ ] [AC-001] Keep asset\n'},
    {path:'design.md',content:version+'\nKeep original logo\n'},{path:'tasks.md',content:version+'\n- [x] T-001: Original task\n'}];
  for(const d of original)fs.writeFileSync(path.join(feature,d.path),d.content);
  const bytes=Buffer.from('logo bytes\n');fs.writeFileSync(path.join(feature,'assets','logo.png'),bytes);
  const before=inspectPrdChangeSnapshot(dir),selected=['1.example'];
  const documents=original.map(d=>({...d,content:d.content.replace('| 2026-10-19 | v1 | original |',
    '| 2026-10-19 | v1 | original |\n| 2026-10-22 | v2 | change |')+(d.path==='tasks.md'?'\n- [ ] T-002: [NEW] Next task\n  - 范围: `README.md`\n':'\nClarification\n')}));
  const proposal=inspectPrdChangeProposal(before,{status:'draft',summary:'Clarify logo use',removed:[],
    features:[{directory:'1.example',documents,testCasesReason:'no_observable_behavior'}]},selected,loadConfig({projectRoot:dir}));
  assert.equal(applyPrdChange({specs:dir,before,proposal,selected}).status,'awaiting_review');
  // Same bytes outside the specs tree, reached through a linked parent directory.
  fs.writeFileSync(path.join(outside,'logo.png'),bytes);
  fs.rmSync(path.join(feature,'assets'),{recursive:true});fs.symlinkSync(outside,path.join(feature,'assets'));
  assert.throws(()=>applyPrdChange({specs:dir,before,proposal,selected}),error=>['prd_change_asset_invalid','prd_change_symlink'].includes(error.code),'recovery refuses the linked parent');
});
