#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {runUnitCoverage,prepareUnitSupplement,verifyUnitSupplement} from '../runtime/js/cm-test/unit-coverage.mjs';
try{
  const [operation,flag,file]=process.argv.slice(2);
  if(operation==='--help')console.log('cm-unit-coverage.mjs run|prepare|verify --config ABS_JSON\nrun: project, target head|working-tree, optional comparison/scope/command/report/format/outputDir/exclusions. command requires id, argv in command, declaration. prepare: authorized:true, project, tests, outputDir. verify: immutable prepare output. JSON stdout is evidence, never review approval.');
  else{
    if(!['run','prepare','verify'].includes(operation)||flag!=='--config'||!path.isAbsolute(file)||process.argv.length!==5)throw Error('invalid_arguments');
    const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw Error('invalid_config');
    const config=JSON.parse(fs.readFileSync(file,'utf8'));
    const result=operation==='run'?await runUnitCoverage(config):operation==='prepare'?prepareUnitSupplement(config):verifyUnitSupplement(config);
    console.log(JSON.stringify(result));
    if(['TESTS_FAILED','BLOCKED'].includes(result.status))process.exitCode=2;
  }
}catch(error){console.error(JSON.stringify({status:'BLOCKED',reason:error.code??error.message,completionAuthorized:false}));process.exitCode=2;}
