#!/usr/bin/env node
// JavaScript authority for the existing CM test-cases.json contract.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const CASE_ID=/^TC-(\d{3,})$/;
const FEATURE=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REF_IDS={acIds:/^AC-\d{3,}$/,taskIds:/^T-\d{3,}$/};
const CASE_FIELDS=new Set(['id','origin','kind','blocking','acIds','taskIds','title','preconditions','steps','expected','cleanup']);
const STRING_LISTS=['acIds','taskIds','preconditions','steps','expected','cleanup'];
const pythonRepr=value=>`'${value.replaceAll('\\','\\\\').replaceAll("'","\\'")}'`;

function validateStringList(item,field,index,failures){
  const value=item[field];
  if(!Array.isArray(value)||value.some(entry=>typeof entry!=='string')){
    failures.push(`cases[${index}].${field} must be an array of strings`);return;
  }
  if(['steps','expected'].includes(field)&&value.length===0)failures.push(`cases[${index}].${field} must not be empty`);
  const pattern=REF_IDS[field];
  if(pattern)for(const entry of value)if(!pattern.test(entry))
    failures.push(`cases[${index}].${field} has invalid id: ${pythonRepr(entry)}`);
}

export function validateTestCases(data){
  if(data===null||typeof data!=='object'||Array.isArray(data))return ['root must be an object'];
  const failures=[];
  if(data.schemaVersion!=='1.0')failures.push('schemaVersion must equal "1.0"');
  if(typeof data.feature!=='string'||!FEATURE.test(data.feature))failures.push('feature must be a non-empty kebab-case string');
  if(!Array.isArray(data.cases)||data.cases.length===0){failures.push('cases must be a non-empty array');return failures;}
  const seen=new Set();
  data.cases.forEach((item,index)=>{
    if(item===null||typeof item!=='object'||Array.isArray(item)){failures.push(`cases[${index}] must be an object`);return;}
    const missing=[...CASE_FIELDS].filter(field=>!Object.hasOwn(item,field)).sort();
    if(missing.length)failures.push(`cases[${index}] missing fields: ${missing.join(', ')}`);
    const match=typeof item.id==='string'?item.id.match(CASE_ID):null;
    if(!match)failures.push(`cases[${index}].id must match TC-001`);
    else{
      if(BigInt(match[1])!==BigInt(index+1))failures.push(`cases[${index}].id must be TC-${String(index+1).padStart(3,'0')}`);
      if(seen.has(item.id))failures.push(`duplicate case id: ${item.id}`);seen.add(item.id);
    }
    if(!['user','generated','inferred'].includes(item.origin))failures.push(`cases[${index}].origin is invalid`);
    if(!['logic','browser'].includes(item.kind))failures.push(`cases[${index}].kind is invalid`);
    if(typeof item.blocking!=='boolean')failures.push(`cases[${index}].blocking must be boolean`);
    if(typeof item.title!=='string'||!item.title.trim())failures.push(`cases[${index}].title must be a non-empty string`);
    for(const field of STRING_LISTS)validateStringList(item,field,index,failures);
  });
  return failures;
}

export function validateFile(file){
  let data;
  try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(file)));}
  catch(error){return [`cannot parse JSON: ${error.message}`];}
  return validateTestCases(data);
}

export function main(argv=process.argv.slice(2)){
  if(argv.length!==1){const program=process.env.CM_COMPAT_PROGRAM||path.basename(process.argv[1]??'validate-test-cases.mjs');
    process.stderr.write(`Usage: ${program} TEST_CASES_JSON\n`);return 2;}
  const failures=validateFile(argv[0]);
  if(failures.length){for(const message of failures)process.stderr.write(`FAIL: ${message}\n`);
    process.stderr.write(`test-cases validation: FAILED (${failures.length})\n`);return 1;}
  process.stdout.write(`test-cases validation: PASSED (${argv[0]})\n`);return 0;
}

function isMain(entry){
  if(!entry)return false;
  try{return fs.realpathSync(entry)===fileURLToPath(import.meta.url);}catch{return path.resolve(entry)===fileURLToPath(import.meta.url);}
}
if(isMain(process.argv[1]))process.exitCode=main();
