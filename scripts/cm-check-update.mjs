#!/usr/bin/env node
// Upgrade preflight only. The check host and mechanical checker remain read-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const PACKAGE = '@aibyzero/cm-workflow';
const REGISTRY = 'https://registry.npmjs.org/';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;
export function compareVersions(a, b) {
  if (!stable.test(a) || !stable.test(b)) throw new Error('Expected a stable X.Y.Z version');
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

export function latestVersion() {
  return new Promise((resolve, reject) => {
    const request = https.get(`${REGISTRY}@aibyzero%2fcm-workflow/latest`, response => {
      let data = '';
      if (response.statusCode !== 200) {
        response.resume(); reject(new Error('Registry query failed')); return;
      }
      response.setEncoding('utf8');
      response.on('data', chunk => {
        data += chunk;
        if (Buffer.byteLength(data) > 1024 * 1024) request.destroy(new Error('Registry response too large'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const value = JSON.parse(data);
          if (value.name !== PACKAGE || !stable.test(value.version)) throw new Error('Invalid package metadata');
          resolve(value.version);
        } catch (error) { reject(error); }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('Registry query timed out')), 10000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
  });
}

function versionAt(root, runtime) {
  const file = path.join(root, runtime === 'claude' ? 'templates/cm-VERSION' : 'VERSION');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Version file must be an owned regular file');
  const version = fs.readFileSync(file, 'utf8').trim();
  compareVersions(version, version);
  return version;
}

function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Expected an owned regular file');
}

function optionalRegularFile(file) {
  try { regularFile(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Reject redirected installation trees, including a redirected ancestor below HOME.
function ownedDirectory(dir, home, allowMissing = false) {
  const relative = path.relative(home, dir);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Automatic upgrade requires an installation inside HOME');
  }
  let cursor = home;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory()) throw new Error('Installation path must not contain symlinks');
  }
}

export async function updateInstallation({skillDir, runtime}, {
  env = process.env, platform = process.platform, query = latestVersion, run = spawnSync,
} = {}) {
  let root, current, latest, lock, temporary;
  const result = (status, reason, workflowRoot = root, installed = current) =>
    ({status, reason, current, latest, installed, workflowRoot});
  try {
    if (!['codex', 'claude'].includes(runtime) || !path.isAbsolute(skillDir)) throw new Error('Invalid invocation');
    root = fs.realpathSync(path.resolve(skillDir, '../..'));
    if (fs.realpathSync(skillDir) !== path.join(root, 'skills/cm-check')) throw new Error('Invalid Skill root');
    regularFile(path.join(root, 'skills/cm-check/SKILL.md'));
    // Source checkouts use VERSION even when invoked from Claude.
    const versionRuntime = fs.existsSync(path.join(root, 'VERSION')) ? 'codex' : runtime;
    current = versionAt(root, versionRuntime);
    try { latest = await query(); compareVersions(latest, latest); }
    catch { return result('offline', 'Cannot confirm the latest npm version; continue local checks with this limitation.'); }

    for (const key of ['HOME', runtime === 'codex' ? 'CODEX_HOME' : 'CLAUDE_HOME']) {
      if (env[key] && !path.isAbsolute(env[key])) throw new Error(`${key} must be an absolute path`);
    }
    const home = fs.realpathSync(env.HOME || os.homedir());
    const target = runtime === 'codex' ? path.join(home, 'plugins/cm-workflow') :
      path.resolve(env.CLAUDE_HOME || path.join(home, '.claude'));
    const codexHome = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
    const cache = path.join(codexHome, 'plugins/cache');
    const cacheParts = path.relative(cache, root).split(path.sep);
    const marketplaceFile = path.join(home, '.agents/plugins/marketplace.json');
    let marketplaceName;
    if (runtime === 'codex') {
      ownedDirectory(codexHome, home, true);
      ownedDirectory(path.dirname(marketplaceFile), home, true);
    }
    if (runtime === 'codex' && optionalRegularFile(marketplaceFile)) {
      marketplaceName = JSON.parse(fs.readFileSync(marketplaceFile, 'utf8')).name;
    }
    const knownCache = runtime === 'codex' && cacheParts.length === 3 &&
      typeof marketplaceName === 'string' && cacheParts[0] === marketplaceName && cacheParts[1] === 'cm-workflow';
    if (fs.existsSync(path.join(root, '.git')) || (root !== target && !knownCache)) {
      return result('unmanaged', 'Source checkout or another package manager: report available version without replacing this installation.');
    }
    ownedDirectory(root, home);
    ownedDirectory(target, home);
    if (fs.existsSync(path.join(target, '.git'))) throw new Error('Managed destination contains a source checkout');
    const installed = versionAt(target, runtime);
    if (compareVersions(installed, current) < 0) throw new Error('Managed installation is older than the active Skill; refuse downgrade');
    if (compareVersions(installed, latest) >= 0) {
      return result(installed === latest ? 'current' : 'ahead', 'Using the verified managed installation.', target, installed);
    }
    if (platform === 'win32' || (runtime === 'codex' && platform !== 'darwin')) {
      return result('blocked', 'Automatic npm upgrade supports macOS Codex and POSIX Claude; use the documented platform installer.');
    }
    // A second cm-check must not race an installation. Never remove another run's lock.
    const lockPath = `${target}.cm-check-update.lock`;
    fs.mkdirSync(lockPath); lock = lockPath;
    ownedDirectory(target, home);
    if (fs.existsSync(path.join(target, '.git'))) throw new Error('Managed destination contains a source checkout');
    const lockedVersion = versionAt(target, runtime);
    if (compareVersions(lockedVersion, current) < 0) throw new Error('Managed version changed; refuse downgrade');
    if (compareVersions(lockedVersion, latest) >= 0) {
      return result(lockedVersion === latest ? 'current' : 'ahead', 'Installation changed before locking; using its newer version.', target, lockedVersion);
    }
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-check-update-'));
    const installEnv = {...env, HOME: home,
      ...(runtime === 'codex' ? {CODEX_HOME: codexHome} : {CLAUDE_HOME: target})};
    const npmEnv = Object.fromEntries(Object.entries(installEnv).filter(([key]) => !/^npm_config_/i.test(key)));
    const config = path.join(temporary, 'user.npmrc'), globalConfig = path.join(temporary, 'global.npmrc');
    fs.writeFileSync(config, ''); fs.writeFileSync(globalConfig, '');
    const downloaded = run('npm', ['install', `${PACKAGE}@${latest}`, '--prefix', temporary,
      '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--package-lock=false',
      `--registry=${REGISTRY}`, `--@aibyzero:registry=${REGISTRY}`,
      `--userconfig=${config}`, `--globalconfig=${globalConfig}`, '--cache', path.join(temporary, 'cache')],
    {cwd: temporary, env: npmEnv, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024});
    if (downloaded.error || downloaded.signal || downloaded.status !== 0) throw new Error('npm package download failed; installation was not started');
    const source = path.join(temporary, 'node_modules/@aibyzero/cm-workflow');
    const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    if (metadata.name !== PACKAGE || metadata.version !== latest || versionAt(source, 'codex') !== latest) {
      throw new Error('Downloaded package identity/version mismatch');
    }
    const installer = path.join(source, runtime === 'codex' ? 'install-codex.sh' : 'install.sh');
    regularFile(installer);
    ownedDirectory(target, home);
    if (fs.existsSync(path.join(target, '.git')) || versionAt(target, runtime) !== lockedVersion) {
      throw new Error('Installation changed during download; rerun the check');
    }
    if (runtime === 'codex') {
      ownedDirectory(codexHome, home, true);
      ownedDirectory(path.dirname(marketplaceFile), home, true);
      optionalRegularFile(marketplaceFile);
    }
    const installedResult = run('/bin/bash', [installer, '--yes'], {cwd: source, env: installEnv, stdio: ['ignore', 2, 2]});
    if (installedResult.error || installedResult.signal || installedResult.status !== 0) {
      throw new Error('Installer failed; inspect installer output and its rollback result');
    }
    ownedDirectory(target, home);
    if (versionAt(target, runtime) !== latest) throw new Error('Installer exited successfully but installed version does not match');
    regularFile(path.join(target, 'scripts/cm-check-host.mjs'));
    regularFile(path.join(target, 'skills/cm-check/SKILL.md'));
    return result('updated', 'Upgrade verified; check the returned root and start a new session for other Skills.', target, latest);
  } catch (error) {
    return result('blocked', error.message);
  } finally {
    if (temporary) fs.rmSync(temporary, {recursive: true, force: true});
    if (lock) fs.rmdirSync(lock);
  }
}

const ownFile = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--skill-dir' || args[2] !== '--runtime' ||
      path.resolve(args[1], '../../scripts/cm-check-update.mjs') !== ownFile) {
    console.error('Usage: node cm-check-update.mjs --skill-dir ABS --runtime codex|claude (from that installation)');
    process.exitCode = 2;
  } else {
    const report = await updateInstallation({skillDir: args[1], runtime: args[3]});
    console.log(JSON.stringify(report));
    process.exitCode = report.status === 'blocked' ? 1 : 0;
  }
}
