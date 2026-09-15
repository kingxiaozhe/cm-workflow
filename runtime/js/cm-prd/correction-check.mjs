// Durable single correction self-check evidence, not a task-state database.
import fs from 'node:fs';
import path from 'node:path';
import {TextDecoder} from 'node:util';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {writeImmutableWorkflowFile} from '../cm-ai/review-evidence-file.mjs';
import {need,json,shape,digest} from '../cm-ai/effect-contract.mjs';

export function correctionCheckStore({specs,feature,packageDigest,inputDigest}){
  need(path.isAbsolute(specs)&&fs.realpathSync(specs)===specs&&/^[1-9]\d*\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature)
    &&/^[a-f0-9]{64}$/.test(packageDigest)&&/^[a-f0-9]{64}$/.test(inputDigest),'prd_check_binding_invalid');
  const dir=path.join(specs,'.reviews'),prefix=`prd-${feature.replace(/^\d+\./,'')}-split-correction-check`;
  const start={version:1,feature,packageDigest,inputDigest},startDigest=digest(start);
  const permissions=file=>need((fs.lstatSync(file).mode&0o777)===0o600,'prd_check_permissions');
  const read=suffix=>{
    const name=prefix+suffix+'.json',bytes=readCmInitSource(specs,`.reviews/${name}`);
    if(bytes===null)return null;permissions(path.join(dir,name));
    const value=json(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)),128*1024);
    need(Buffer.from(JSON.stringify(value)+'\n').equals(bytes),'prd_check_record_invalid');return value;
  };
  const inspect=()=>{
    const prior=read('-start'),result=read('-result');
    need(prior!==null||result===null,'prd_check_result_without_start');
    if(prior!==null)need(digest(prior)===startDigest,'prd_check_inputs_changed');
    if(result!==null){
      shape(result,['version','startDigest','outcome','result']);
      need(result.version===1&&result.startDigest===startDigest
        &&['mechanical_failed','context_result'].includes(result.outcome),'prd_check_record_invalid');
    }
    return {status:result?'recorded':prior?'unknown':'not_started',result};
  };
  const write=(suffix,value,exclusive=false)=>writeImmutableWorkflowFile({reviewsDir:dir,name:prefix+suffix+'.json',
    bytes:Buffer.from(JSON.stringify(value)+'\n'),validate:permissions,exclusive});
  return Object.freeze({inspect,
    claim(){
      const existing=inspect();if(existing.status!=='not_started')return existing;
      try{write('-start',start,true);}catch(error){
        const after=inspect();if(after.status==='not_started')throw error;return after;
      }
      return {status:'claimed',result:null};
    },
    record(outcome,result){
      need(inspect().status==='unknown','prd_check_not_pending');
      const value=json({version:1,startDigest,outcome,result},128*1024);
      need(['mechanical_failed','context_result'].includes(outcome),'prd_check_record_invalid');
      write('-result',value,true);return inspect();
    }
  });
}
