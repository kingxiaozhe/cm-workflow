#!/usr/bin/env node
// Qualification only: no writer, source edits, command execution or provider.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectFixCommandCorrection} from '../runtime/js/cm-fix/execution.mjs';
import {need} from '../runtime/js/cm-ai/effect-contract.mjs';
export function main(argv=process.argv.slice(2),{output=process.stdout,error=process.stderr}={}){
 try{
  need(argv.length===4&&argv[0]==='--config'&&argv[2]==='--jest-config','invalid_arguments');
  const stat=fs.lstatSync(argv[1]);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024,'invalid_fix_config');
  const c=JSON.parse(fs.readFileSync(argv[1],'utf8')),specsRoot=fs.realpathSync(c.specsRoot??path.join(c.reproduction.cwd,'docs/fixes'));
  const expected=inspectFixCommandCorrection({specsRoot,identity:{repositoryId:c.identity.repositoryId,runId:c.identity.runId},declaration:{kind:'jest-config-path',path:argv[3]}});
  output.write(JSON.stringify({eligible:true,expected})+'\n');return 0;
 }catch(e){const code=/^[a-z_]{1,64}$/.test(e?.code??'')?e.code:'fix_command_correction_unavailable';error.write(JSON.stringify({eligible:false,code})+'\n');return 1;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main();
