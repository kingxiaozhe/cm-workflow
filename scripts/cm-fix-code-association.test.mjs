import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {inspectFixCodeAssociation} from '../runtime/js/cm-ai/fix-code-association.mjs';

for(const mode of ['matched','unexplained file','before mismatch'])test(`fix code composition: ${mode}`,()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-composition-')));
  const write=(file,value)=>fs.writeFileSync(path.join(root,file),value);
  const identity={repositoryId:'fixture',runId:'parent',taskId:'T-001',attempt:1};
  const checks=[{id:'unit',command:['node','test.mjs'],outcome:'passed',exitCode:0,evidence:'synthetic'}];
  try{
    write('value.mjs','0');write('requirements.md','value 2');write('untouched.txt','original');
    const baseline=captureReviewBaseline({root,identity,scope:['value.mjs'],requirements:['requirements.md']});
    write('value.mjs','1');
    const parentPackage=createReviewPackage({root,baseline,checks});
    if(mode==='before mismatch')write('value.mjs','unreviewed');
    if(mode==='unexplained file')write('untouched.txt','unreviewed');
    const fixBase=captureReviewBaseline({root,identity:{...identity,runId:'child'},scope:['value.mjs'],requirements:['requirements.md']});
    write('value.mjs','2');
    const fixPackage=createReviewPackage({root,baseline:fixBase,checks});
    const inspect=()=>inspectFixCodeAssociation({root,baseline,parentPackage,fixPackage});
    if(mode==='matched'){
      assert.equal(inspect().fixPackageDigest,fixPackage.packageDigest);
      const secondBase=captureReviewBaseline({root,identity:{...identity,runId:'second-child'},scope:['value.mjs'],requirements:['requirements.md']});
      write('value.mjs','3');
      const second=createReviewPackage({root,baseline:secondBase,checks});
      const chain=fixPackages=>inspectFixCodeAssociation({root,baseline,parentPackage,fixPackages});
      assert.equal(chain([fixPackage,second]).fixPackageDigest,second.packageDigest);
      assert.throws(()=>chain([second,fixPackage]),{code:'fix_before_mismatch'});
      assert.throws(()=>chain([fixPackage,fixPackage]),{code:'fix_chain_invalid'});
      write('value.mjs','later drift');
      assert.throws(inspect,{code:'fix_current_code_unexplained'});
    }else assert.throws(inspect,{code:mode==='before mismatch'?'fix_before_mismatch':'fix_current_code_unexplained'});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
