// Child of the cross-process race test: scan, pause on a file barrier, then try to take the lock.
import fs from 'node:fs';
import path from 'node:path';
import {controlLaunchTarget} from './cm-ai-run.mjs';
import {prepareReviewedEvidenceSupersession} from '../runtime/js/cm-ai/reviewed-evidence-supersede.mjs';

const input=JSON.parse(process.argv[2]);
const holds=[];
const pause=()=>{
  fs.writeFileSync(path.join(input.barrier,'scanned'),'');
  const cell=new Int32Array(new SharedArrayBuffer(4));
  for(let i=0;i<400&&!fs.existsSync(path.join(input.barrier,'go'));i++)Atomics.wait(cell,0,0,50);
  // A missing release signal must fail the scenario, not silently carry on out of order.
  if(!fs.existsSync(path.join(input.barrier,'go')))throw Object.assign(new Error('barrier_timeout'),{code:'barrier_timeout'});
};
let result;
try{
  prepareReviewedEvidenceSupersession({specsDir:input.specsDir,codeProject:input.codeProject,feature:input.feature,
    identity:{repositoryId:input.repositoryId,runId:input.runId,taskId:input.taskId,attempt:1},reason:input.reason,
    tasksPath:path.join(input.specsDir,input.feature,'tasks.md'),expectedPredecessor:input.target,
    predecessorTarget:controlLaunchTarget,holds,afterDiscovery:pause});
  result={ok:true};
}catch(error){result={ok:false,code:error.code??null,reason:String(error.reason??error.message??'').slice(0,300)};}
for(const held of holds)held.close();
process.stdout.write(JSON.stringify(result)+'\n');
