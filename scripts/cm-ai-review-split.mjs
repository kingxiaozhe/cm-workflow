#!/usr/bin/env node
// No serve/advance/dispatch operation exists in this preparation-only entry.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {prepareReviewOnlySplit,inspectReviewOnlySplit,registerReviewOnlySplit} from '../runtime/js/cm-ai/review-only-split.mjs';
export const usage=`cm-ai-review-split.mjs prepare|inspect|register --plan SPLIT_PLAN.json
prepare: read-only exact-input and capacity preflight; reports accepted separately from exit status.
inspect: read-only staged append progress and original call count.
register: append parent intent, three review-only provenance stores, parent committed.
Requires exact PRD confirmation, frozen source/config files, complete coverage and legal material.
Ordinary cm-ai advance is forbidden for these records. This entry never starts a worker.
Future send-review is unsupported; it requires separate authorization and an adapter. No new call allocation is granted.`;
export function main(argv=process.argv.slice(2)){
  if(argv.length===1&&['--help','-h'].includes(argv[0]))return {help:usage};
  if(argv.length!==3||argv[1]!=='--plan'||!['prepare','inspect','register'].includes(argv[0]))throw Object.assign(new Error('split_arguments'),{code:'split_arguments'});
  const plan=JSON.parse(fs.readFileSync(argv[2],'utf8'));
  const fn={prepare:prepareReviewOnlySplit,inspect:inspectReviewOnlySplit,register:registerReviewOnlySplit}[argv[0]];
  return fn(plan);
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{const result=main();process.stdout.write(result.help??JSON.stringify(result,null,2)+'\n');if(result.accepted===false)process.exitCode=2;}
  catch(error){process.stderr.write(JSON.stringify({code:error.code??'split_invalid'})+'\n');process.exitCode=2;}
}
