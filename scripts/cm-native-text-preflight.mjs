#!/usr/bin/env node
// Read-only attachment readiness. Never launches a host/model or publishes assets.
import {pathToFileURL} from 'node:url';
import {readModelJsonRecord} from '../runtime/js/cm-ai/model-configuration-file.mjs';
import {inspectNativeTextEvidence} from '../runtime/js/cm-ai/native-text-evidence.mjs';
import {inspectNativeReviewReadiness} from '../runtime/js/cm-ai/native-review-evidence.mjs';
export function main(argv){
 try{
  const names=new Set(['--manifest','--native-profile','--code-project','--specs-dir','--scope']),args={};
  for(let i=0;i<argv.length;i+=2){if(!names.has(argv[i])||!argv[i+1]||Object.hasOwn(args,argv[i]))throw new Error();args[argv[i]]=argv[i+1];}
  if(!args['--code-project']||!args['--specs-dir']||Boolean(args['--manifest'])===Boolean(args['--native-profile']))throw new Error();
  const context={codeProject:args['--code-project'],specsDir:args['--specs-dir']};let result;
  const read=file=>readModelJsonRecord(file).value;
  if(args['--native-profile']){
   if(!args['--scope'])throw new Error();context.scope=read(args['--scope']);
   result=inspectNativeReviewReadiness(read(args['--native-profile']),context);
  }else{
   if(args['--scope'])throw new Error();const manifest=read(args['--manifest']);
   result=inspectNativeTextEvidence(manifest,context);
  }
  process.stdout.write(JSON.stringify(result)+'\n');return result.ready&&result.transportReady!==false?0:2;
 }catch{process.stdout.write(JSON.stringify({readOnly:true,ready:false,issues:[{code:'native_text_preflight_input_invalid',fileId:null}]})+'\n');return 2;}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)process.exitCode=main(process.argv.slice(2));
