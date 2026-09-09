import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {inspectPrdMaterialResults} from '../runtime/js/cm-prd/materials.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=source=>({path:source.path,sha256:source.sha256,format:'html',pages:[{url:'fixture://page',
  interactiveCount:1,evidence:'synthetic enumeration',elements:[{id:'save',action:'click',result:'no response',
    kind:'dead_zone',screenshot:'synthetic screenshot',question:'Should Save work?'}]}]});
test('hash and element coverage reject incomplete host material reports',()=>{
  const source={path:'docs/page.html',sha256:'a'.repeat(64),format:'html'};
  const report={status:'processed',records:[html(source)]};
  assert.equal(inspectPrdMaterialResults(report,[source]).independentVerification,false);
  for(const mutate of [x=>x.records[0].sha256='b'.repeat(64),x=>x.records[0].pages[0].interactiveCount=2,
    x=>x.records[0].pages[0].elements[0].question=null]){
    const copy=structuredClone(report);mutate(copy);assert.throws(()=>inspectPrdMaterialResults(copy,[source]));
  }
});
test('material processing precedes analysis; dead zones ask user and cache is reused',async t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-materials-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'docs'));
  fs.writeFileSync(path.join(dir,'docs/page.html'),'<button>Save</button>');
  fs.writeFileSync(path.join(dir,'docs/input.pdf'),'%PDF synthetic');
  let processed=0,analyzed=0;
  const host=createCmPrdAnalysis({input:{skillDir:path.join(root,'skills/cm-prd'),project:dir,specs:dir},
    runtime:'codex',record:async()=>{},processMaterials:async payload=>{
      processed++;return {status:'processed',records:payload.sources.map(source=>source.format==='html'?html(source):
        {path:source.path,sha256:source.sha256,format:'pdf',pageCount:1,
          pages:[{page:1,text:'Extracted synthetic requirement',evidence:'synthetic PDF tool result'}]})};
    },analyze:async payload=>{
      analyzed++;assert.equal(payload.messages.at(-1).text,'Yes, Save must work');
      assert.equal(payload.materialEvidence.records.length,2);
      return {status:'analyzed',summary:'Save supported',sourcePaths:['docs/page.html','docs/input.pdf'],openQuestions:[]};
    }});
  assert.equal((await host.advance('Analyze')).stage,'awaiting_user');assert.equal(analyzed,0);
  assert.equal((await host.advance('Yes, Save must work')).stage,'analysis_ready');
  assert.equal(processed,1);assert.equal(analyzed,1);
});
