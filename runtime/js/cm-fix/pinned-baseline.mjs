// V2/V6 for cm-fix write steps redone after an abandonment or a blocked rerun:
// the redo registers the baseline its first intent captured (journaled), so the
// earlier attempt's residue is reviewed instead of becoming the "before" image.
import {readReviewBaseline} from '../cm-ai/review-package.mjs';
import {digest,need} from '../cm-ai/effect-contract.mjs';

const metadata=file=>{if(!file)return null;const {contentBase64,...rest}=file;return rest;};
// The pinned baseline must bind exactly what a fresh capture would bind now
// (identity, root, scope, requirements); only file images may differ.
export function readPinned(raw,fresh){
  const pinned=readReviewBaseline(raw);
  for(const key of ['identity','rootDigest','specsPath','scope','requirements','version'])
    need(digest(pinned[key]??null)===digest(fresh[key]??null),'fix_pinned_baseline_mismatch');
  return pinned;
}
// Paths whose current image differs from the pinned one where it may not:
// outside the step scope always; inside it too in protected mode.
export function pinnedResidue(baseline,now,scope,protectedMode){
  const before=new Map(baseline.files.map(file=>[file.path,metadata(file)])),after=new Map(now.files.map(file=>[file.path,metadata(file)]));
  const changed=[...new Set([...before.keys(),...after.keys()])].filter(file=>digest(before.get(file)??null)!==digest(after.get(file)??null));
  const refused=changed.filter(file=>protectedMode||!scope.includes(file)).sort();
  if(refused.length)throw Object.assign(new Error(`fix_pinned_residue: ${refused.slice(0,20).join(', ')}`),{code:protectedMode?'fix_protected_residue':'fix_pinned_residue',paths:refused});
  return changed;
}
