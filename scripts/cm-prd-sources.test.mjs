import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-sources-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'docs/nested'),{recursive:true});
  const write=(file,content)=>fs.writeFileSync(path.join(dir,file),content);
  const run=(inspect=true,extra=[])=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/cm-prd-entry.mjs'),
      ...(inspect?['--inspect-sources']:[]),'--skill-dir',path.join(root,'skills/cm-prd'),
      '--project',dir,'--specs',dir,...extra],{encoding:'utf8'});
    return {code:result.status,body:JSON.parse(result.stdout||result.stderr)};
  };
  return {dir,write,run};
}

test('real CLI inventories nested mixed sources without writing or claiming analysis',t=>{
  const {dir,write,run}=fixture(t);
  const content='需求：保留用户内容。\n';
  write('docs/nested/product.md',content);
  assert.equal(run(false).body.requirementsSourceCount,1);
  write('docs/prototype.HTML','<button>save</button>');
  write('docs/document.pdf','%PDF-1.7 synthetic');
  write('docs/image.png',Buffer.from([0,255,1]));
  write('docs/.env','synthetic hidden input');
  write('cases.md','user cases');
  const before=fs.readdirSync(dir,{recursive:true});
  const result=run(true,['--cases',path.join(dir,'cases.md')]);
  assert.equal(result.code,0);
  const report=result.body.sourceInspection;
  assert.equal(report.sources.length,4);
  const text=report.sources.find(source=>source.format==='text');
  assert.equal(text.content,content);
  assert.equal(text.sha256,createHash('sha256').update(content).digest('hex'));
  assert.deepEqual(report.sources.map(source=>source.requiredAction).sort(),
    ['analyze_text','extract_pdf','inspect_interactions_in_authorized_browser','resolve_unsupported_source'].sort());
  assert.equal(report.completeAnalysis,false);
  assert.equal(report.prototypeInteractionVerified,false);
  assert.equal(report.casesInspected,true);
  assert.equal(report.userCases.content,'user cases');
  assert.equal(report.userCases.path,path.join(dir,'cases.md'));
  assert.equal(report.userCases.origin,'user');
  assert.equal(result.body.writeAuthorized,false);
  assert.deepEqual(fs.readdirSync(dir,{recursive:true}),before);
  assert.equal(fs.readFileSync(path.join(dir,text.path),'utf8'),content);
});

test('real CLI refuses links, invalid text and oversized sources explicitly',t=>{
  const {dir,write,run}=fixture(t);
  write('docs/input.md','valid');
  fs.symlinkSync(path.join(dir,'docs/input.md'),path.join(dir,'docs/link.md'));
  assert.equal(run().body.reason,'source_path_invalid');
  fs.unlinkSync(path.join(dir,'docs/link.md'));
  write('docs/input.md',Buffer.from([255]));
  assert.equal(run().body.reason,'source_text_encoding_invalid');
  write('docs/input.md',Buffer.alloc(1048577));
  assert.equal(run().code,2);
  assert.equal(fs.statSync(path.join(dir,'docs/input.md')).size,1048577);
});

test('default admission remains read-only and source mode does not replace change analysis',t=>{
  const {dir,write,run}=fixture(t);
  assert.equal(run(false).body.reason,'requirements_source_missing');
  fs.mkdirSync(path.join(dir,'1.sample'));
  for(const file of ['requirements.md','design.md','tasks.md'])write(`1.sample/${file}`,'existing');
  assert.equal(run(false,['--change','1']).body.next,'change_analysis');
  assert.equal(run(true,['--change','1']).body.reason,'source_inspection_new_only');
});
