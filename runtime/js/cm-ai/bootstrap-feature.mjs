import {readSpecsStatus} from '../specs-status.mjs';

// One feature-name decision. A specs path reads its approved manifest;
// data-only replay callers pass their already-bound feature list.
export function identifyApprovedBootstrapFeature(source){
  const status=typeof source==='string'?readSpecsStatus(source):null;
  if(status&&!(status.kind==='valid'&&status.value.status==='approved'))
    throw Object.assign(new Error('bootstrap_approval_required'),{code:'bootstrap_approval_required'});
  const features=status?status.value.features:source;
  if(!Array.isArray(features)||!features.every(name=>typeof name==='string'))
    throw Object.assign(new Error('bootstrap_approval_required'),{code:'bootstrap_approval_required'});
  const candidates=features.filter(name=>/^\d+\.bootstrap$/.test(name));
  if(candidates.length>1)throw Object.assign(new Error('bootstrap_feature_ambiguous'),{code:'bootstrap_feature_ambiguous'});
  return candidates[0]??null;
}
