// In-memory structural draft checks; not spec self-check, review or approval.
import fs from 'node:fs';
import {need,shape,json,digest} from '../cm-ai/effect-contract.mjs';
import {validateTestCases} from '../../../scripts/validate-test-cases.mjs';
export function prdFeatureInventory(specs){
  return fs.readdirSync(specs).filter(name=>/^\d+\./.test(name)).sort();
}
export function nextPrdFeatureIndex(inventory){
  const numbers=inventory.map(name=>Number(name.split('.')[0]));
  need(numbers.every(Number.isSafeInteger),'prd_feature_index_invalid');
  const next=Math.max(0,...numbers)+1;need(Number.isSafeInteger(next),'prd_feature_index_invalid');return next;
}
// Step 6-9 output deliberately excludes tasks and test contracts until design disposition.
export function inspectPrdDesignDraft(raw,{nextIndex}){
  const reply=json(raw,64*1024);shape(reply,['status','summary','features']);
  need(reply.status==='design'&&typeof reply.summary==='string'&&reply.summary.trim()
    &&Array.isArray(reply.features)&&reply.features.length>0,'prd_design_invalid');
  const seen=new Set();
  const features=reply.features.map((feature,index)=>{
    shape(feature,['name','documents']);
    need(typeof feature.name==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature.name)
      &&!seen.has(feature.name)&&Array.isArray(feature.documents),'prd_design_feature_invalid');
    seen.add(feature.name);const files=new Set();
    for(const document of feature.documents){
      shape(document,['path','content']);
      need(['requirements.md','design.md'].includes(document.path)&&!files.has(document.path)
        &&typeof document.content==='string'&&document.content.trim()
        &&Buffer.from(document.content,'utf8').toString('utf8')===document.content,'prd_design_document_invalid');
      files.add(document.path);
    }
    need(files.size===2&&Number.isSafeInteger(nextIndex)&&nextIndex>=1
      &&Number.isSafeInteger(nextIndex+index),'prd_design_documents_missing');
    return {...feature,directory:`${nextIndex+index}.${feature.name}`};
  });
  return json({summary:reply.summary,features,draftDigest:digest({summary:reply.summary,features}),
    checks:'design_structure_only',remaining:['design_review','design_disposition','task_generation','spec_self_check','split_review','human_approval'],
    writeAuthorized:false,completionAuthorized:false});
}
export function inspectPrdDraft(raw,{nextIndex,generateCases,userCasesProvided}){
  const reply=json(raw,64*1024);shape(reply,['status','summary','features']);
  need(reply.status==='draft'&&typeof reply.summary==='string'&&reply.summary.trim()
    &&Array.isArray(reply.features)&&reply.features.length>0,'prd_draft_invalid');
  const seen=new Set(),features=[];let userCases=0;
  for(const [index,feature] of reply.features.entries()){
    shape(feature,['name','documents','testCasesReason']);
    need(typeof feature.name==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature.name)
      &&!seen.has(feature.name)&&Array.isArray(feature.documents),'prd_draft_feature_invalid');seen.add(feature.name);
    const files=new Map();
    for(const document of feature.documents){
      shape(document,['path','content']);
      need(['requirements.md','design.md','tasks.md','test-cases.json'].includes(document.path)
        &&typeof document.content==='string'&&document.content.trim().length>0&&!files.has(document.path),'prd_draft_document_invalid');
      files.set(document.path,document.content);
    }
    need(['requirements.md','design.md','tasks.md'].every(file=>files.has(file)),'prd_draft_triad_missing');
    if(files.has('test-cases.json')){
      const cases=JSON.parse(files.get('test-cases.json'));
      need(validateTestCases(cases).length===0&&cases.feature===feature.name&&feature.testCasesReason===null,'prd_draft_cases_invalid');
      need(generateCases||cases.cases.every(item=>item.origin!=='generated'),'prd_generated_cases_disabled');
      userCases+=cases.cases.filter(item=>item.origin==='user').length;
    }else need(['no_observable_behavior','generation_disabled'].includes(feature.testCasesReason)
      &&(feature.testCasesReason!=='generation_disabled'||!generateCases),'prd_draft_cases_reason_missing');
    need(Number.isSafeInteger(nextIndex+index),'prd_feature_index_invalid');
    features.push({...feature,directory:`${nextIndex+index}.${feature.name}`});
  }
  need(!userCasesProvided||userCases>0,'prd_user_cases_missing');
  return json({summary:reply.summary,features,draftDigest:digest({summary:reply.summary,features}),
    checks:'structure_only',remaining:['spec_self_check','design_review_if_required','split_review','human_approval'],
    writeAuthorized:false,completionAuthorized:false});
}
