#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {scan} from '../runtime/js/cm-security/scan.mjs';
import {finalize} from '../runtime/js/cm-security/finalize.mjs';

export function main(argv){
  let project=process.cwd();const options={};const seen=new Set();
  for(let i=0;i<argv.length;i++){
    const key=argv[i];
    if(key==='--help')return {help:'cm-security.mjs [--project PATH] [--all] [--inventory] [--semgrep-rules EXTERNAL_FILE] [--osv-db EXTERNAL_CACHE_DIR] | [--project PATH] --finalize --scan EXTERNAL_JSON --review EXTERNAL_JSON'};
    if(seen.has(key))throw new Error('duplicate_argument');seen.add(key);
    if(key==='--all')options.all=true;
    else if(key==='--inventory')options.inventoryOnly=true;
    else if(key==='--finalize')options.finalize=true;
    else if(['--project','--semgrep-rules','--osv-db','--scan','--review'].includes(key)){
      const value=argv[++i];if(!value||value.startsWith('--'))throw new Error('argument_value_required');
      if(key==='--project')project=value;
      else options[({'--semgrep-rules':'semgrepRules','--osv-db':'osvDb','--scan':'scanFile','--review':'reviewFile'})[key]]=value;
    }else throw new Error('unknown_argument');
  }
  if(options.finalize){
    if(options.all||options.inventoryOnly||options.semgrepRules||options.osvDb)throw new Error('finalize_mode_conflict');
    if(!options.scanFile||!options.reviewFile)throw new Error('finalize_inputs_required');
    return finalize(fs.realpathSync(project),options);
  }
  if(options.scanFile||options.reviewFile)throw new Error('finalize_mode_required');
  return scan(fs.realpathSync(project),options);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const result=main(process.argv.slice(2));console.log(JSON.stringify(result,null,2));
    process.exitCode=result.help?0:result.result==='BLOCKED'?2:(result.findingsCount||result.findings?.length)?1:result.result==='NO_CHANGES'?0:3;
  }catch(error){
    // Do not echo paths, input values, source snippets or scanner stderr from exceptions.
    console.log(JSON.stringify({result:'BLOCKED',coverage:'PARTIAL',reason:/^[a-z0-9_]+$/.test(error.message)?error.message:'scan_failed'}));
    process.exitCode=2;
  }
}
