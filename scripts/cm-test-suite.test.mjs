import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {nativeTests, inventory, selectTests} from './cm-test-suite.mjs';
import {assignShards, readWeights} from './ci-test-shards.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function cliEnv(env) {
  const copy = {...env};
  delete copy.NODE_TEST_CONTEXT; // The CLI starts an independent node --test invocation.
  return copy;
}
const cli = (args, cwd = root, env = process.env) => spawnSync(process.execPath,
  [path.join(cwd, 'scripts/cm-test-suite.mjs'), ...args], {cwd, env: cliEnv(env), encoding: 'utf8'});

function fixture(t, source = 'import test from "node:test"; test("fixture",()=>{});') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-suite-fixture-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'experiments/js-orchestration'), {recursive: true});
  for (const name of ['cm-test-suite.mjs', 'ci-test-shards.mjs', 'ci-test-weights.json'])
    fs.copyFileSync(path.join(root, 'scripts', name), path.join(dir, 'scripts', name));
  for (const file of nativeTests) fs.writeFileSync(path.join(dir, file), '');
  fs.writeFileSync(path.join(dir, 'scripts/example.test.mjs'), source);
  fs.writeFileSync(path.join(dir, 'experiments/js-orchestration/history.test.mjs'), source);
  return dir;
}

test('approved native inventory is fixed, complete and disjoint from ordinary tests', () => {
  assert.equal(nativeTests.length, 9);
  // Approval fingerprint prevents additions, omissions and substitutions without a reviewed change.
  assert.equal(createHash('sha256').update(nativeTests.join('\n')).digest('hex'), 'e036b229f15e0acca13f43c29a35a2cbc830b1dcdd812b1f379b46253f3eadce');
  const groups = inventory(root);
  const discovered = fs.readdirSync(path.join(root, 'scripts'))
    .filter(name => name.endsWith('.test.mjs')).map(name => `scripts/${name}`).sort();
  assert.deepEqual([...groups.ordinary, ...groups.native].sort(), discovered);
  assert.equal(new Set([...groups.ordinary, ...groups.native]).size, discovered.length);
  assert.deepEqual(groups.native, nativeTests);
});

test('listing every group is install-free and ordinary shards reuse the existing assignment', () => {
  for (const group of ['ordinary', 'native', 'history']) {
    const run = cli(['list', group]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.stdout.trim().split('\n'), inventory(root)[group]);
  }
  const groups = inventory(root);
  const shards = assignShards(groups.ordinary, 4, readWeights());
  for (let index = 0; index < 4; index++)
    assert.deepEqual(selectTests(groups, 'ordinary', {shards: 4, index}), shards[index].files);
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), groups.ordinary);
});

test('new ordinary tests are included and missing native members stop the CLI', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'scripts/new.test.mjs'), '');
  assert.match(cli(['list', 'ordinary'], dir).stdout, /scripts\/new.test.mjs/);
  fs.unlinkSync(path.join(dir, nativeTests[0]));
  const run = cli(['check'], dir);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing native test/);
});

test('runner isolates both CM homes and cleans up after success', t => {
  const dir = fixture(t, `import test from 'node:test'; import assert from 'node:assert/strict';
    import fs from 'node:fs';
    test('isolation',()=>{
      assert.notEqual(process.env.CM_WORKFLOW_HOME, process.env.CALLER_HOME);
      assert.notEqual(process.env.CM_WORKFLOW_LOG_HOME, process.env.CALLER_LOG_HOME);
      assert(fs.statSync(process.env.CM_WORKFLOW_HOME).isDirectory());
      assert(fs.statSync(process.env.CM_WORKFLOW_LOG_HOME).isDirectory());
      fs.writeFileSync(process.env.CAPTURE, JSON.stringify([process.env.CM_WORKFLOW_HOME,process.env.CM_WORKFLOW_LOG_HOME]));
    });`);
  const capture = path.join(dir, 'capture.json');
  const callerHome = path.join(dir, 'caller-home'), callerLogs = path.join(dir, 'caller-logs');
  const run = cli(['run', 'ordinary', '--concurrency', '1'], dir,
    {...process.env, CM_WORKFLOW_HOME: callerHome, CM_WORKFLOW_LOG_HOME: callerLogs,
      CALLER_HOME: callerHome, CALLER_LOG_HOME: callerLogs, CAPTURE: capture});
  assert.equal(run.status, 0, run.stderr + run.stdout);
  for (const item of JSON.parse(fs.readFileSync(capture))) assert.equal(fs.existsSync(item), false);
  assert.equal(fs.existsSync(callerHome), false);
  assert.equal(fs.existsSync(callerLogs), false);
});

test('explicit concurrency reaches the Node runner', t => {
  const source = `import test from 'node:test'; import fs from 'node:fs'; import assert from 'node:assert/strict';
    test('overlap',async()=>{
      fs.writeFileSync(process.env.CAPTURE+'/'+process.pid,'ready');
      const deadline=Date.now()+5000;
      while(fs.readdirSync(process.env.CAPTURE).length<2 && Date.now()<deadline)
        await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(fs.readdirSync(process.env.CAPTURE).length,2,'both test files must run concurrently');
    });`;
  const dir = fixture(t, source), capture = path.join(dir, 'parallel');
  fs.mkdirSync(capture);
  fs.writeFileSync(path.join(dir, 'scripts/second.test.mjs'), source);
  const run = cli(['run', 'ordinary', '--concurrency', '2'], dir, {...process.env, CAPTURE: capture});
  assert.equal(run.status, 0, run.stderr + run.stdout);
});

test('failed tests fail exactly once in ordinary and historical groups', t => {
  const dir = fixture(t, `import test from 'node:test'; import fs from 'node:fs';
    test('fail',()=>{fs.appendFileSync(process.env.CAPTURE,'attempt\\n');throw new Error('intentional fixture failure');});`);
  for (const group of ['ordinary', 'history']) {
    const capture = path.join(dir, `${group}.txt`);
    const run = cli(['run', group], dir, {...process.env, CAPTURE: capture});
    assert.equal(run.status, 1, run.stderr + run.stdout);
    assert.equal(fs.readFileSync(capture, 'utf8'), 'attempt\n');
  }
});

test('invalid arguments fail before running tests', t => {
  const dir = fixture(t, 'throw new Error("must not execute");');
  for (const args of [['run', 'unknown'], ['run', 'ordinary', '--concurrency', '0'],
    ['run', 'ordinary', '--shards', '4'], ['list', 'ordinary', '--index', '0'],
    ['run', 'ordinary', '--shards', '2', '--index', '2'], ['run', 'ordinary', '--retry']]) {
    const run = cli(args, dir);
    assert.notEqual(run.status, 0);
    assert.doesNotMatch(run.stdout + run.stderr, /must not execute/);
  }
});

test('parent signals reach tests, preserve failure and remove temporary homes', {skip: process.platform === 'win32'}, async t => {
  const dir = fixture(t, `import fs from 'node:fs';
    process.on('SIGTERM',()=>{fs.writeFileSync(process.env.SIGNAL_CAPTURE,'received'); process.exit(0);});
    fs.writeFileSync(process.env.CAPTURE, process.env.CM_WORKFLOW_HOME);
    setInterval(()=>{},1000);`);
  const capture = path.join(dir, 'ready'), signalCapture = path.join(dir, 'signal');
  const child = spawn(process.execPath, [path.join(dir, 'scripts/cm-test-suite.mjs'), 'run', 'ordinary'],
    {cwd: dir, env: cliEnv({...process.env, CAPTURE: capture, SIGNAL_CAPTURE: signalCapture}), stdio: 'ignore'});
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({code, signal})));
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(capture) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert(fs.existsSync(capture), 'test child did not become ready');
  child.kill('SIGTERM');
  let timer;
  const result = await Promise.race([closed, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('signal not propagated')), 10000);
  })]).finally(() => clearTimeout(timer));
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(fs.readFileSync(signalCapture, 'utf8'), 'received');
  assert.equal(fs.existsSync(fs.readFileSync(capture, 'utf8')), false);
});

test('CI and release smoke consume the same entrypoint without a second exclusion list', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const release = fs.readFileSync(path.join(root, 'scripts/cm-release-smoke.sh'), 'utf8');
  assert.match(ci, /node scripts\/cm-test-suite\.mjs check/);
  assert.match(ci, /node scripts\/cm-test-suite\.mjs run ordinary --shards 4 --index \$\{\{ matrix\.shard \}\}/);
  assert.match(ci, /node scripts\/cm-test-suite\.mjs run history --concurrency 4/);
  assert.match(release, /node "\$ROOT\/scripts\/cm-test-suite\.mjs" run native/);
  for (const file of nativeTests) {
    assert(!ci.includes(path.basename(file, '.test.mjs')), 'CI duplicated the native inventory');
    assert(!release.includes(file), 'release duplicated the native inventory');
  }
});
