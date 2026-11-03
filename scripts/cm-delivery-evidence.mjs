#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {need} from '../runtime/js/cm-ai/effect-contract.mjs';
import {previewDelivery,recordDelivery,deliveryCandidate,deliveryProjection,deliveryLines,readDeliveryRecords} from '../runtime/js/cm-ai/delivery-evidence.mjs';

const usage=`Usage: cm-delivery-evidence.mjs preview|record|status|history --specs DIR
  preview/record/status: --repository ID --run ID --feature NAME --artifact FILE
  preview/record: --kind acceptance|deployment --actor NAME --environment NAME --note TEXT --report FILE
  acceptance: --outcome accepted|rejected|revoked
  deployment: --execution succeeded|failed --verification passed|failed|unknown [--verification-report FILE]
  --json is allowed for read-only commands. record always requires an interactive terminal.
  Records are local human declarations, not authenticated identity or remote verification.`;
export async function deliveryMain(argv,{input=process.stdin,output=process.stdout,error=process.stderr}={}){
  try{
    if(argv.length===1&&argv[0]==='--help'){output.write(usage+'\n');return 0;}
    const operation=argv[0];need(['preview','record','status','history'].includes(operation),'delivery_invalid_arguments');
    const values={},flags=new Set(['specs','repository','run','feature','artifact','kind','actor','environment','note','report','outcome','execution','verification','verification-report']);
    let asJson=false;
    for(let i=1;i<argv.length;i++){
      if(argv[i]==='--json'){need(!asJson,'delivery_invalid_arguments');asJson=true;continue;}
      const name=argv[i]?.slice(2);need(argv[i]?.startsWith('--')&&flags.has(name)&&!Object.hasOwn(values,name)
        &&typeof argv[i+1]==='string'&&!argv[i+1].startsWith('--'),'delivery_invalid_arguments');values[name]=argv[++i];
    }
    need(typeof values.specs==='string','delivery_invalid_arguments');
    const specsDir=path.resolve(values.specs);
    const needed=operation==='history'?['specs']:['specs','repository','run','feature','artifact'];
    if(['preview','record'].includes(operation))needed.push('kind','actor','environment','note','report',
      ...(values.kind==='acceptance'?['outcome']:['execution','verification']));
    const allowed=new Set([...needed,...(values.kind==='deployment'&&['preview','record'].includes(operation)?['verification-report']:[])]);
    need(needed.every(key=>Object.hasOwn(values,key))&&Object.keys(values).every(key=>allowed.has(key)),'delivery_invalid_arguments');
    if(operation==='record')need(!asJson&&input.isTTY===true&&output.isTTY===true,'delivery_interactive_terminal_required');
    let value;
    if(operation==='history')value=readDeliveryRecords(specsDir);
    else {
      const options={specsDir,repositoryId:values.repository,runId:values.run,feature:values.feature,artifact:path.resolve(values.artifact)};
      if(operation==='status'){
        const candidate=deliveryCandidate(options);
        value=deliveryProjection({...options,identity:candidate.identity,packageDigest:candidate.packageDigest,specificationDigest:candidate.specificationDigest,artifactSha256:candidate.artifact.sha256});
      }else{
        Object.assign(options,{kind:values.kind,statement:{actor:values.actor,environment:values.environment,note:values.note,
          ...(values.kind==='acceptance'?{outcome:values.outcome}:{execution:values.execution,verification:values.verification})},
          report:path.resolve(values.report),verificationReport:values['verification-report']?path.resolve(values['verification-report']):null});
        if(operation==='preview')value=previewDelivery(options);
        else value=await recordDelivery(options,{confirm:async(preview,phrase)=>{
          output.write(JSON.stringify(preview,null,2)+'\n此操作仅记录上述声明，不执行部署，也不证明声明者身份。\n');
          const rl=createInterface({input,output});
          try{return await rl.question(`请由验收/部署负责人核对后输入完整确认串：\n${phrase}\n> `);}finally{rl.close();}
        }});
      }
    }
    if(operation==='status'&&!asJson)output.write(deliveryLines(value).join('\n')+'\n');
    else output.write(JSON.stringify(value,null,asJson?0:2)+'\n');
    return 0;
  }catch(e){const code=typeof e?.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(e.code)?e.code:'delivery_evidence_unavailable';
    error.write(JSON.stringify({error:{code}})+'\n');return 2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await deliveryMain(process.argv.slice(2));
