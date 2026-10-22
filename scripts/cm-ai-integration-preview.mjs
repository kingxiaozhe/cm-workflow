#!/usr/bin/env node
// Read-only inspection. Does not construct a host or open the execution writer.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRunDefinition,controlLaunchTarget} from './cm-ai-run.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {readRunnerHistory,attemptBaseline} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {readIntegrationPlan,readIntegrationEvidence,previewReviewedIntegration} from '../runtime/js/cm-ai/reviewed-integration.mjs';
import {need} from '../runtime/js/cm-ai/effect-contract.mjs';

export function main(argv=process.argv.slice(2),output=process.stdout){
  try{
    const args=new Map();need(argv.length===4,'invalid_arguments');
    for(let i=0;i<argv.length;i+=2){
      need(['--run-definition','--plan','--evidence'].includes(argv[i])&&!args.has(argv[i])&&argv[i+1],'invalid_arguments');
      args.set(argv[i],argv[i+1]);
    }
    need(args.has('--run-definition')&&Number(args.has('--plan'))+Number(args.has('--evidence'))===1,'invalid_arguments');
    const definition=readRunDefinition(path.resolve(args.get('--run-definition')));
    let plan,review=null;
    if(args.has('--evidence'))({plan,review}=readIntegrationEvidence(path.resolve(args.get('--evidence'))));
    else{
      const file=path.resolve(args.get('--plan')),stat=fs.lstatSync(file);
      need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=128*1024&&fs.realpathSync(file)===file,'integration_plan_invalid');
      const bytes=fs.readFileSync(file),raw=JSON.parse(bytes);
      need(bytes.equals(Buffer.from(JSON.stringify(raw)+'\n')),'integration_plan_invalid');plan=readIntegrationPlan(raw);
    }
    const snapshot=readExecutionSnapshot({specsRoot:definition.specsDir,identity:{
      repositoryId:definition.identity.repositoryId,runId:definition.identity.runId}});
    const init=snapshot.records[0].payload,history=readRunnerHistory(snapshot.records,init.config,init.version);
    const result=previewReviewedIntegration({root:init.config.root,specsRoot:definition.specsDir,
      baseline:attemptBaseline(history.original,history.state.attempt),parentPackage:history.state.reviewPackage,
      records:snapshot.records,plan,review});
    output.write(JSON.stringify({...result,originalRevision:snapshot.revision,
      launchControlTarget:controlLaunchTarget(snapshot),productRecoveryExecuted:false})+'\n');
    return result.eligibleForAdoption?0:2;
  }catch(error){output.write(JSON.stringify({eligibleForAdoption:false,code:error.code??'integration_evidence_invalid',
    productRecoveryExecuted:false})+'\n');return 1;}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main();
