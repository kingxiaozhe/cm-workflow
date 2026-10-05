#!/usr/bin/env node
// Reproducible, synthetic, offline only. Byte counts are not model tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {compactReviewData,expandReviewData} from '../runtime/js/cm-ai/review-presentation.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
const text=Buffer.from('Fixture AC-001 and interface contract: return all case results.\n'.repeat(1024));
const file={path:'fixture.txt',size:text.length,sha256:createHash('sha256').update(text).digest('hex'),contentBase64:text.toString('base64')};
const data={reviewPackage:{packageDigest:'a'.repeat(64),changes:[{path:file.path,before:file,after:file}],
  specification:{acceptanceCriteria:['AC-001'],interfaceContracts:['all case results'],systemContext:'Synthetic offline fixture'},
  checks:[{id:'cases',outcome:'passed',evidence:'All synthetic case records retained'}]},priorReview:null,examinedPaths:[file.path]};
const presented=compactReviewData(data);
if(digest(expandReviewData(presented))!==digest(data))throw Error('evidence changed');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-efficiency-offline-')));
try{
  const counts={};
  for(const enabled of [false,true]){
    const cwd=path.join(root,String(enabled));fs.mkdirSync(cwd);
    const command=[process.execPath,'-e',"require('node:fs').appendFileSync('physical-checks','x');console.log('synthetic check passed')"];
    const check=createHostCheck({cwd,reuseDeclared:enabled,commands:[{id:'original',command},{id:'declared-same',command,...(enabled?{sameExecutionAs:'original'}:{})}]});
    const phases=[];
    for(const stage of ['development','final-acceptance']){
      const rows=await check({identity:{repositoryId:'offline',runId:'offline-fixture',taskId:'T-001',attempt:1}},{signal:new AbortController().signal});
      if(rows.length!==2||rows.some(row=>row.outcome!=='passed'))throw Error('check coverage changed');
      phases.push({stage,coveredChecks:rows.length,physicalExecutionsSoFar:fs.readFileSync(path.join(cwd,'physical-checks'),'utf8').length});
    }
    counts[enabled?'enabled':'legacy']=phases;
  }
  process.stdout.write(JSON.stringify({kind:'synthetic-offline-experiment',version:1,
    presentation:{fullBytes:Buffer.byteLength(JSON.stringify(data)),compactBytes:Buffer.byteLength(JSON.stringify(presented)),exactRoundTrip:true},
    checks:counts,providerCalls:0,providerTokens:null,productionSavings:null},null,2)+'\n');
}finally{fs.rmSync(root,{recursive:true,force:true});}
