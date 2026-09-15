// Read-only preparation around the original single-attempt PRD review gate.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inspectPrdReview} from '../../../scripts/cm-prd-review-gate.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {need,json,digest} from '../cm-ai/effect-contract.mjs';
const sha=text=>createHash('sha256').update(text).digest('hex');
function sections(text,pattern){
  const parts=text.split(/(?=^##\s+)/m);
  return parts.filter(part=>pattern.test(part.split('\n')[0])).join('\n').trim();
}
export function preparePrdReview({specs,draft,stage,feature}){
  need(['design','split'].includes(stage),'prd_review_stage_invalid');
  need(fs.realpathSync(specs)===specs,'prd_review_root_invalid');
  const target=draft.features.find(item=>item.directory===feature);
  need(target&&draft.features.filter(item=>item.name===target.name).length===1,'prd_review_feature_invalid');
  // A second directory with the same slug would share the historic r1 filename.
  need(!fs.readdirSync(specs).some(name=>/^\d+\./.test(name)&&name!==feature
    &&name.replace(/^\d+\./,'')===target.name),'prd_review_slug_collision');
  const reviews=path.join(specs,'.reviews');
  try{need(fs.lstatSync(reviews).isDirectory()&&!fs.lstatSync(reviews).isSymbolicLink()
    &&fs.realpathSync(reviews)===reviews,'prd_review_path_invalid');}catch(error){if(error.code!=='ENOENT')throw error;}
  const prefix=`prd-${target.name}-${stage}`;
  const args={stage,feature:target.name,evidence:path.join(reviews,`${prefix}-r1.md`),
    receipt:path.join(reviews,`${prefix}-disposition.json`)};
  // Reject unsafe local files before letting the compatibility inspector read them.
  for(const suffix of ['-r1.md','-r2.md','-disposition.json'])readCmInitSource(specs,`.reviews/${prefix}${suffix}`);
  const gate=inspectPrdReview(args);
  if(['resume_disposition','completed'].includes(gate.outcome))for(const document of target.documents){
    const current=readCmInitSource(specs,`${feature}/${document.path}`);
    need(current!==null&&current.equals(Buffer.from(document.content)),'prd_review_draft_disk_mismatch');
  }
  const files=new Map(target.documents.map(document=>[document.path,document.content]));
  const requirements=files.get('requirements.md'),design=files.get('design.md');
  if(stage==='split')need(sections(design,/^##\s+(方案摘要|概述|功能模块设计|架构.*|summary|design summary|overview|architecture.*)\s*$/i),
    'prd_review_design_summary_missing');
  const content=stage==='design'?{requirements,design}:{
    requirementsFunctions:sections(requirements,/^##\s+(功能需求|Functional requirements)\s*$/i),
    tasks:files.get('tasks.md'),designSummary:sections(design,/^##\s+.*(方案摘要|概述|架构|功能模块|技术|接口|数据|波及|安全|summary|overview|architecture|decision|contract|data|impact|security)/i)};
  need(Object.values(content).every(value=>typeof value==='string'&&value.trim()),'prd_review_sections_missing');
  const reviewPackage=json({workflow:'cm-prd',stage,feature,draftDigest:draft.draftDigest,content,
    artifacts:target.documents.map(document=>({path:`${feature}/${document.path}`,sha256:sha(document.content)})),
    instructions:stage==='design'?'Apply original Step 9.5 only when its risk triggers were established. Read relevant project rules and changed-module context plus steelman-review. No second attempt.':
      'Apply original Step 10.6 to the functional requirements, complete task list and selected design sections. Respect prior design review and do not repeat it. No second attempt.'});
  if(gate.package_sha256!==undefined)need(gate.package_sha256===digest(reviewPackage),'prd_review_dispatch_package_changed');
  return json({gate,paths:args,reviewPackage,packageDigest:digest(reviewPackage),
    stageSelection:'caller_must_apply_original_risk_rules',dispatchAuthorized:false,writeAuthorized:false,completionAuthorized:false});
}
