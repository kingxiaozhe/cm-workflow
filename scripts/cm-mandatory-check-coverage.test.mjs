import assert from 'node:assert/strict';
import test from 'node:test';
import {mandatoryCheckCoverage} from '../runtime/js/check-coverage.mjs';

const xcode = (...selection) => ['/usr/bin/xcodebuild', 'test', '-scheme', 'App', ...selection];
const coverage = (requiredTests, ...commands) => mandatoryCheckCoverage({requiredTests, commands});

test('frozen Xcode test selection rejects omitted classes and skipped methods', () => {
  const required = ['AppUITests/OldTests', 'AppUITests/NewTests'];
  assert.deepEqual(coverage(required, xcode('-only-testing:AppUITests/NewTests')),
    {satisfied: false, missing: required, unverifiable: ['AppUITests/NewTests']});
  assert.deepEqual(coverage(required, xcode('-only-testing:AppUITests')),
    {satisfied:false,missing:required,unverifiable:required});
  assert.equal(coverage(['AppUITests/OldTests'], xcode('-only-testing:AppUITests', '-skip-testing:AppUITests/OldTests/testExisting')).satisfied, false);
  assert.deepEqual(coverage(['AppUITests/OldTests'], ['/usr/bin/xcrun', 'xcodebuild', ...xcode('-only-testing:AppUITests/OldTests').slice(1)]),
    {satisfied:false,missing:['AppUITests/OldTests'],unverifiable:['AppUITests/OldTests']});
});

test('build, enumeration and values named test are not execution selection', () => {
  for (const command of [xcode('-enumerate-tests'), xcode('-showBuildSettings'),
    ['/usr/bin/xcodebuild', '-resultBundlePath', 'test', 'build-for-testing']])
    assert.equal(coverage(['AppUITests/OldTests'], command).satisfied, false, JSON.stringify(command));
  assert.deepEqual(coverage(['AppUITests/OldTests'], xcode('-only-testing', 'AppUITests/OldTests')).unverifiable,
    ['AppUITests/OldTests']);
});

test('a wrapper mentioning a test or xcodebuild cannot prove mandatory coverage', () => {
  for (const command of [['bash', 'checks.sh', 'AppUITests/OldTests'],
    ['echo', 'xcodebuild', 'test'], [process.execPath, 'wrapper.js', 'AppUITests/OldTests']]) {
    const result = coverage(['AppUITests/OldTests'], command);
    assert.deepEqual(result, {satisfied: false, missing: ['AppUITests/OldTests'], unverifiable: ['AppUITests/OldTests']});
  }
});

test('direct Node test files and explicit node --test files are supported without substring matches', () => {
  assert.equal(coverage(['test/a.test.js'], [process.execPath, 'test/a.test.js']).satisfied, true);
  assert.equal(coverage(['test/a.test.js', 'test/b.test.js'], [process.execPath, '--test', './test/a.test.js', 'test/b.test.js']).satisfied, true);
  assert.deepEqual(coverage(['test/a.test.js', 'test/b.test.js'], [process.execPath, '--test', 'test/a.test.js']),
    {satisfied: false, missing: ['test/b.test.js'], unverifiable: []});
  assert.equal(coverage(['test/a.test.js'], [process.execPath, '--test', 'test/a.test.js.bak']).satisfied, false);
});

test('Node filters, discovery, globs and unmodeled options remain unverifiable', () => {
  for (const args of [['--test'], ['--test', 'test/*.test.js'], ['--test', '--test-name-pattern=easy', 'test/a.test.js'],
    ['--test', '--test-shard=1/2', 'test/a.test.js'], ['--test', '--test-only', 'test/a.test.js'],
    ['--eval', "require('./test/a.test.js')"]])
    assert.deepEqual(coverage(['test/a.test.js'], [process.execPath, ...args]),
      {satisfied: false, missing: ['test/a.test.js'], unverifiable: ['test/a.test.js']}, JSON.stringify(args));
});

test('commands from another test family cannot satisfy a frozen test identifier', () => {
  assert.deepEqual(coverage(['test/a.test.js'], xcode()).unverifiable, ['test/a.test.js']);
  assert.deepEqual(coverage(['AppUITests/OldTests.swift'], xcode()).unverifiable, ['AppUITests/OldTests.swift']);
  assert.deepEqual(coverage(['AppUITests/OldTests'], [process.execPath, 'AppUITests/OldTests']).unverifiable, ['AppUITests/OldTests']);
});

test('approved subsets are respected; no contract obligations does not expand the gate', () => {
  assert.deepEqual(coverage(['AppUITests/NewTests'], xcode('-only-testing:AppUITests/NewTests')),
    {satisfied:false,missing:['AppUITests/NewTests'],unverifiable:['AppUITests/NewTests']});
  assert.deepEqual(coverage([], ['bash', 'unknown.sh']), {satisfied: true, missing: [], unverifiable: []});
  assert.deepEqual(coverage(['test/a.js']), {satisfied: false, missing: ['test/a.js'], unverifiable: []});
});

test('invalid frozen test identities are rejected and input is never mutated', () => {
  for (const requiredTests of [null, [''], ['a', 'a'], ['../a'], ['/a'], ['a\0b']])
    assert.throws(() => mandatoryCheckCoverage({requiredTests, commands: []}), {code: 'mandatory_check_contract_invalid'});
  const requiredTests = Object.freeze(['test/a.test.js']);
  const commands = Object.freeze([Object.freeze([process.execPath, '--test', 'test/a.test.js'])]);
  assert.equal(mandatoryCheckCoverage({requiredTests, commands}).satisfied, true);
});

test('a program basename or PATH lookup is not a trusted test engine identity', () => {
  for (const binary of ['node', './node', '/project/node'])
    assert.deepEqual(coverage(['test/a.test.js'], [binary, '--test', 'test/a.test.js']).unverifiable, ['test/a.test.js']);
  for (const binary of ['xcodebuild', '/project/xcodebuild'])
    assert.deepEqual(coverage(['AppUITests/OldTests'], [binary, 'test']).unverifiable, ['AppUITests/OldTests']);
});
test('unmodeled Xcode configuration selectors and future flags remain unverifiable',()=>{
  for(const args of [['-only-test-configuration','SmokeOnly'],['-skip-test-configuration','FullTests'],
    ['-testPlan','Subset'],['-future-filter','Easy'],['SWIFT_ACTIVE_COMPILATION_CONDITIONS=OMIT_TESTS']])
    assert.deepEqual(coverage(['AppTests/ImportantTests'],xcode(...args)).unverifiable,['AppTests/ImportantTests']);
});
