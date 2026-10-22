#!/usr/bin/env node
// Offline candidate material preparation; never invokes or authorizes a provider.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareReviewSplitMaterials,verifySplitMaterial} from '../runtime/js/cm-ai/review-split-material.mjs';
const args=process.argv.slice(2),sha=b=>createHash('sha256').update(b).digest('hex');
try{
 if(args.length===0||args.includes('--help')){
  console.log('Usage: node scripts/cm-review-split-material.mjs prepare --package <ORIGINAL-PACKAGE.json> --inventory <PACKET-INVENTORY.json> --out <new-directory>\n       node scripts/cm-review-split-material.mjs verify --file <child.material.json>\nOffline self-contained candidates only. Does not register, grant, develop, review or install. Capacity failures remain blockers; no limit is increased.');
 }else if(args[0]==='verify'&&args.length===3&&args[1]==='--file'){
  console.log(JSON.stringify(verifySplitMaterial(path.resolve(args[2])),null,2));
 }else{
  const values={};if(args[0]!=='prepare'||args.length!==7)throw Object.assign(new Error(),{code:'split_material_cli'});
  for(let i=1;i<args.length;i+=2){if(!['--package','--inventory','--out'].includes(args[i])||values[args[i]])throw Object.assign(new Error(),{code:'split_material_cli'});values[args[i]]=path.resolve(args[i+1]);}
  if(Object.keys(values).length!==3)throw Object.assign(new Error(),{code:'split_material_cli'});
  const result=prepareReviewSplitMaterials({packageFile:values['--package'],inventoryFile:values['--inventory']});
  const output=values['--out'];fs.mkdirSync(output,{mode:0o700});
  const reports=[];
  for(const p of result.packets){
   const file=path.join(output,p.taskId+'.material.json'),v={version:1,kind:'cm-review-split-material',source:result.source,coverageDigest:result.coverageDigest,...p};
   const b=Buffer.from(JSON.stringify(v));fs.writeFileSync(file,b,{flag:'wx',mode:0o600});
   const report=verifySplitMaterial(file,{expectedSha256:sha(b),expectedSource:result.source,expectedCoverageDigest:result.coverageDigest});reports.push({...report,file});
  }
  const report={version:1,status:result.status,source:result.source,coverageDigest:result.coverageDigest,packets:reports};
  fs.writeFileSync(path.join(output,'REPORT.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  fs.writeFileSync(path.join(output,'COVERAGE.json'),JSON.stringify(result.coverage,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(report,null,2));
 }
}catch(e){console.error(JSON.stringify({ok:false,code:e.code??'split_material_failed'}));process.exitCode=1;}
