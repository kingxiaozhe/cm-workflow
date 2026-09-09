// One original Review baseline spanning test authoring and business repair.
// This is review visibility, never developer write authority or a new gate.
import {readReviewBaseline} from '../cm-ai/review-package.mjs';
import {inspectFixTestAuthor} from './test-author.mjs';
import {digest,need,shape,validIdentity} from '../cm-ai/effect-contract.mjs';

// Rebind only the round identity. Keep the original before images, including
// authored tests and any host-owned Learning scope already added by the owner.
export function continueFixReviewBaseline(raw,nextIdentity){
  const {baselineDigest,...body}=readReviewBaseline(raw);validIdentity(nextIdentity);
  need(body.identity.attempt===1&&nextIdentity.attempt===2
    &&['repositoryId','runId','taskId'].every(key=>body.identity[key]===nextIdentity[key]),'fix_review_baseline_mismatch');
  body.identity=nextIdentity;
  return readReviewBaseline({...body,baselineDigest:digest(body)});
}

export function composeFixReviewBaseline(options){
  shape(options,['authorBaseline','authorResult','repairBaseline']);
  const repair=readReviewBaseline(options.repairBaseline);
  if(options.authorBaseline===null){need(options.authorResult===null,'fix_review_baseline_mismatch');return repair;}
  const author=readReviewBaseline(options.authorBaseline);
  const result=inspectFixTestAuthor(options.authorResult,author);
  need(result.outcome==='authored'&&digest(author.identity)===digest(repair.identity)
    &&author.rootDigest===repair.rootDigest&&(author.specsPath??null)===(repair.specsPath??null),'fix_review_baseline_mismatch');
  need(author.scope.every(file=>!repair.scope.some(other=>other.toLowerCase()===file.toLowerCase())),'fix_review_scope_overlap');
  const before=new Map(author.files.map(file=>[file.path,file])),after=new Map(repair.files.map(file=>[file.path,file]));
  for(const file of new Set([...before.keys(),...after.keys()])){
    if(author.scope.includes(file))continue;
    need(digest(before.get(file)??null)===digest(after.get(file)??null),'fix_review_interstage_drift');
  }
  const authoredFiles=repair.files.filter(file=>author.scope.includes(file.path)).map(({contentBase64,...metadata})=>metadata);
  need(digest(authoredFiles)===digest(result.testFiles),'fix_review_interstage_drift');
  const {baselineDigest,...body}=author;
  body.scope=[...new Set([...author.scope,...repair.scope])].sort();
  body.requirements=[...new Set([...author.requirements,...repair.requirements])].sort();
  // Preserve exact pre-authoring files. Never reconstruct an old version from
  // today's tree or copy the post-authoring tests into their own before image.
  return readReviewBaseline({...body,baselineDigest:digest(body)});
}
