// Test-only command transport. It runs real fixture checks and protected-edits,
// but does NOT claim OS sandbox enforcement. Native tests retain the real CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {specsPermissionArgs} from '../../runtime/js/cm-ai/codex-config.mjs';

export function protocolSandboxBranch({codeProject,specsDir}) {
  return `if(process.argv[2]==='sandbox'){const {runProtocolSandbox}=await import(${JSON.stringify(import.meta.url)});process.exit(runProtocolSandbox(process.argv.slice(3),${JSON.stringify(codeProject)},${JSON.stringify(specsDir)}));}`;
}

export function runProtocolSandbox(args,cwd,specsRoot) {
  assert.equal(process.cwd(),cwd);
  if(args.length===1&&args[0]==='--help'){
    console.log('--allow-unix-socket');return 0;
  }
  const separator=args.indexOf('--'),grant=args.indexOf('--allow-unix-socket');
  assert(grant>0);assert.equal(separator,grant+2);
  assert.deepEqual(args.slice(0,grant),['-P','cm-specs','--include-managed-config','-C',cwd,
    ...specsPermissionArgs({cwd,specsRoot})]);
  const temporary=args[grant+1];
  assert.equal(fs.realpathSync(temporary),temporary);
  assert.equal(fs.statSync(temporary).mode&0o777,0o700);
  assert.match(path.basename(temporary),/^cmc-/);
  assert(!temporary.startsWith(cwd+path.sep));assert(!temporary.startsWith(specsRoot+path.sep));
  const command=args.slice(separator+1);
  assert.deepEqual(command.slice(0,3),['/usr/bin/env','TMPDIR='+temporary,process.execPath]);
  const result=spawnSync(command[0],command.slice(1),{cwd,stdio:'inherit'});
  assert.ifError(result.error);assert.equal(result.signal,null);
  return result.status;
}
