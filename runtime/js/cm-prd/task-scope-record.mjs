// Whether a saved feature's tasks.md is held to the per-task scope check.
//
// A fresh draft and a change proposal are checked under the session's rule; the
// later re-checks of the saved files (split correction, disposition, summary) run
// outside that session and used to fall back to rule 1, so a correction could
// drop a task's scope unnoticed. The save now records, per feature and before any
// spec byte is written, whether the saved tasks.md carries scopes and which tasks
// may stay without one: only tasks an approval covered (approvedScopeExemptions),
// never tasks that merely appear in an unapproved draft. No record (a draft saved
// before this rule, or one without scopes) keeps the old behaviour.
// A save made under self-check rule 4 or later also records that rule
// (selfCheckRules), so the re-checks read its tasks.md as grammar 3 and keep the
// session-task checks; a record without it (an earlier rule, or an operation that
// began before operations recorded their rule) keeps the old behaviour.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {need} from '../cm-ai/effect-contract.mjs';
import {parseFeatureTaskText} from '../cm-ai/cm-ai-admission.mjs';
import {checkPrdDraftMechanics,PRD_SELF_CHECK_RULE_VERSIONS} from './self-check.mjs';
import {readPrdSessionFile,replaceSessionFile} from './session.mjs';
import {normalizeRuntimeMarkBytes} from '../../../scripts/cm-spec-manifest.mjs';

const SCOPE_CODES=new Set(['task_scope_invalid','task_scope_missing']);
const recordPath=directory=>`.reviews/prd-${directory.replace(/^\d+\./,'')}-task-scope.json`;

function taskIds(text,grammar){
  if(typeof text!=='string')return [];
  const parsed=parseFeatureTaskText(text,{grammar});
  return parsed.error?[]:parsed.tasks.map(task=>task.id).sort();
}
function parseRecord(raw){
  let value;try{value=JSON.parse(raw);}catch{value=null;}
  need(value!==null&&typeof value==='object'&&value.version===1&&typeof value.enforced==='boolean'
    &&Array.isArray(value.exempt)&&value.exempt.every(id=>typeof id==='string')
    &&(!Object.hasOwn(value,'selfCheckRules')||PRD_SELF_CHECK_RULE_VERSIONS.includes(value.selfCheckRules)&&value.selfCheckRules>=4)
    &&Object.keys(value).length===(Object.hasOwn(value,'selfCheckRules')?4:3),'prd_task_scope_record_invalid');
  return value;
}
// The record texts a change snapshot binds (only features that have one).
export function prdTaskScopeRecords(specs,directories){
  const records={};
  for(const directory of directories){const raw=readPrdSessionFile(specs,recordPath(directory));if(raw!==null)records[directory]=raw;}
  return records;
}
// {directory: {exempt}} for a change. A feature whose tasks.md is exactly the
// approved bytes exempts the tasks of that approval, read with its grammar. An
// unapproved state (a draft, or a change awaiting review) keeps what its own save
// recorded, which traces back to an approval or is empty.
export function approvedScopeExemptions(before,directories,grammar){
  let status=null;try{status=JSON.parse(before.status??'null');}catch{status=null;}
  const approved=status?.status==='approved'&&Array.isArray(status.specFiles)?status.specFiles:[];
  // Approval rows are semantic digests (runtime [x] marks reset), current or legacy rule.
  const digests=text=>[{},{legacy:true}].map(options=>
    createHash('sha256').update(normalizeRuntimeMarkBytes(Buffer.from(text),'tasks.md',options)).digest('hex'));
  return Object.fromEntries(directories.map(directory=>{
    const file=`${directory}/tasks.md`,text=before.files[file];
    if(typeof text==='string'&&approved.some(item=>item?.path===file&&digests(text).includes(item.sha256)))
      return [directory,{exempt:taskIds(text,grammar)}];
    const record=before.scopeRecords?.[directory];
    return [directory,{exempt:record===undefined?[]:parseRecord(record).exempt}];
  }));
}

// `exemptions` maps a directory to {exempt} (a change) or is empty (a new draft).
// `selfCheckRules` is the rule of the saving operation (session.mjs); only rule 4
// and later are written, since earlier rules add nothing beyond the scope record.
export function recordPrdTaskScopes(specs,features,exemptions={},{selfCheckRules=1}={}){
  need(PRD_SELF_CHECK_RULE_VERSIONS.includes(selfCheckRules),'prd_self_check_rules_invalid');
  const reviews=path.join(specs,'.reviews');
  try{fs.mkdirSync(reviews,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  need(fs.realpathSync(reviews)===reviews,'prd_task_scope_record_invalid');
  for(const feature of features){
    if(!feature.documents.some(doc=>doc.path==='tasks.md'))continue;
    const exempt=[...(exemptions[feature.directory]?.exempt??[])].sort();
    const report=checkPrdDraftMechanics({draftDigest:'task-scope-record',features:[feature]},
      {scopes:{[feature.directory]:{exempt}}});
    const enforced=!report.findings.some(item=>SCOPE_CODES.has(item.code));
    const relative=recordPath(feature.directory),bytes=JSON.stringify({version:1,enforced,exempt,
      ...(selfCheckRules>=4?{selfCheckRules}:{})})+'\n';
    const prior=readPrdSessionFile(specs,relative);
    if(prior!==bytes)replaceSessionFile(specs,relative,prior,bytes);
  }
}

// The checkPrdDraftMechanics options a re-check of saved features must use.
export function prdTaskScopeOptions(specs,directories){
  const scopes={},sessionTasks=[];
  for(const directory of typeof directories==='string'?[directories]:directories){
    const raw=readPrdSessionFile(specs,recordPath(directory));
    if(raw===null)continue;
    const value=parseRecord(raw);
    if(value.enforced)scopes[directory]={exempt:value.exempt};
    if(Object.hasOwn(value,'selfCheckRules'))sessionTasks.push(directory);
  }
  return {...(Object.keys(scopes).length?{scopes}:{}),...(sessionTasks.length?{sessionTasks}:{})};
}
