#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installer = fileURLToPath(new URL('../install-codex.sh', import.meta.url));
const usage = 'Usage: cm-workflow install [--yes]\nInstalls or upgrades the Codex plugin on macOS. Requires Node.js 24.14+, Python 3.9+ and Codex plugin helpers.';

export function main(args, { platform = process.platform, nodeVersion = process.versions.node,
  run = spawnSync, out = console.log, error = console.error } = {}) {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    out(usage);
    return 0;
  }
  if (args[0] !== 'install' || args.length > 2 || (args.length === 2 && args[1] !== '--yes')) {
    error(usage);
    return 2;
  }
  if (platform !== 'darwin') {
    error('This npm installer currently supports macOS Codex only. See docs/installation.md for source installation paths.');
    return 1;
  }
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (!(major > 24 || (major === 24 && minor >= 14))) {
    error('Node.js 24.14+ is required for the default JS workflow.');
    return 1;
  }
  const result = run('/bin/bash', [installer, ...args.slice(1)], { stdio: 'inherit' });
  if (result.error) error(`Unable to start installer: ${result.error.message}`);
  else if (result.signal) error(`Installer interrupted (${result.signal}). Installation was not confirmed.`);
  return Number.isInteger(result.status) ? result.status : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
