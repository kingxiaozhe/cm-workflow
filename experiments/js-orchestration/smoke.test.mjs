import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from './host.mjs';
import { previewPromptTransport, requestTools, skillContext, writePreviewPrompt } from './tool-preview.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { configFingerprint } from './codex-config.mjs';
import { preflightMatches, codexWorker } from './worker-codex.mjs';

const args = { task_id: 'A-DEMO-001', title: '生成一句问候' };
test('one fixed workflow produces ordered correlated events and greeting', async () => {
  const events = []; let calls = 0;
  const output = await execute({ args, runId: 'fixture-run', emit: e => events.push(e),
    worker: async () => { calls++; return { status: 'succeeded', value: { greeting: '你好，世界！' } }; } });
  assert.equal(output.result.greeting, '你好，世界！'); assert.equal(calls, 1);
  assert.deepEqual(events.filter(e => e.type === 'phase').map(e => e.name), ['Validate','Greet','Collect']);
  assert.ok(events.every((e, i) => e.run_id === 'fixture-run' && e.sequence === i + 1));
  assert.equal(events.at(-1).status, 'succeeded');
});
test('out-of-scope input dispatches nothing', async () => {
  let calls = 0;
  const output = await execute({ args: { ...args, source: 'private' }, worker: async () => { calls++; } });
  assert.equal(output.result.code, 'input_out_of_scope'); assert.equal(calls, 0);
});
for (const value of [null, {}, [], { greeting: '' }, { greeting: ' ' }, { greeting: 4 },
  { greeting: 'ok', extra: true }, { greeting: 'x'.repeat(201) }]) {
  test(`invalid result rejected: ${JSON.stringify(value)}`, async () => {
    const output = await execute({ args, worker: async () => ({ status: 'succeeded', value }) });
    assert.equal(output.result.code, 'invalid_output');
  });
}
test('worker failure is not converted into success', async () => {
  const output = await execute({ args, worker: async () => ({ status: 'failed', code: 'fixture_error' }) });
  assert.equal(output.result.code, 'fixture_error');
});
test('cancellation before dispatch calls no worker', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const output = await execute({ args, signal: controller.signal, worker: async () => { calls++; } });
  assert.equal(output.result.status, 'cancelled'); assert.equal(calls, 0);
});
test('late success after cancellation remains cancelled', async () => {
  const controller = new AbortController();
  const output = await execute({ args, signal: controller.signal, worker: async () => {
    controller.abort(); return { status: 'succeeded', value: { greeting: 'late' } };
  } });
  assert.equal(output.result.status, 'cancelled');
});
test('missing tools differs from malformed tools or a non-request', () => {
  assert.deepEqual(requestTools({ input: [] }), []);
  assert.deepEqual(requestTools({ input: [], tools: [] }), []);
  assert.equal(requestTools({ input: [], tools: null }), null);
  assert.equal(requestTools({}), null);
  assert.equal(requestTools({ input: [], tools: [{ type: 'function', name: 'read' }] }).length, 1);
});
test('receipt must match exact common config', () => {
  const options = { cwd: '/fixture', model: 'fixture-model' };
  const receipt = { passed: true, cli_model: options.model, config_fingerprint: configFingerprint(options) };
  assert.equal(preflightMatches(receipt, options), true);
  assert.equal(preflightMatches(receipt, { ...options, model: 'different' }), false);
  assert.equal(preflightMatches(receipt, { ...options, cwd: '/other' }), false);
  assert.equal(preflightMatches({ ...receipt, passed: false }, options), false);
  assert.equal(preflightMatches(receipt,{...options,promptTransport:'stdin'}),false);
  assert.equal(preflightMatches({...receipt,prompt_transport:'stdin'},{...options,promptTransport:'stdin'}),true);
  assert.equal(preflightMatches({...receipt,prompt_transport:'argument'},{...options,promptTransport:'stdin'}),false);
});
test('missing preflight blocks real process creation', async () => {
  const worker = codexWorker({ cwd: '/unused', model: 'fixture', schemaPath: '/unused', cli: '/must-not-run' });
  const result = await worker({}, { signal: new AbortController().signal, onEvent() {} });
  assert.equal(result.code, 'tool_preflight_missing');
});

test('skill catalog is detected and root aliases resolve without reading files', () => {
  const input = [{ content: [{ text: '### Skill roots\n- `r0` = `/synthetic/skills`\n### Available skills\n- example (file: r0/example/SKILL.md)' }] }];
  const found = skillContext({ input });
  assert.equal(found.present, true); assert.deepEqual(found.folders, ['/synthetic/skills/example']);
  assert.equal(skillContext({ input: [{ content: [{ text: 'synthetic greeting' }] }] }).present, false);
});
test('empty catalog shell is not a personal catalog; unresolved entries still block', () => {
  const context = text => skillContext({ input: [{ content: [{ text }] }] });
  assert.equal(context('### Available skills\n\n### How to use skills\nRules').present, false);
  assert.equal(context('<skills_instructions>unknown format').present, true);
  assert.equal(context('### Available skills\n- x (file: r99/x/SKILL.md)').present, true);
  assert.equal(context('- x (file: /synthetic/x/SKILL.md)').present, true);
});
test('tool preview transport keeps argument mode and moves opt-in stdin prompts off argv', () => {
  assert.deepEqual(previewPromptTransport('argument', 'preview prompt'), {
    argument: 'preview prompt', stdin: null, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.deepEqual(previewPromptTransport('stdin', 'preview prompt'), {
    argument: '-', stdin: 'preview prompt', stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.throws(() => previewPromptTransport('fallback', 'preview prompt'), /invalid prompt transport/);
});
test('tool preview stdin writer is exact and fails closed once without an argument fallback', () => {
  let touched = false;
  const untouched = writePreviewPrompt({ get stdin() { touched = true; throw new Error('must not read'); } },
    'argument', 'preview prompt', () => assert.fail('argument mode cannot fail stdin'));
  untouched(); assert.equal(touched, false);

  const stdin = new EventEmitter(); let written = null, failures = 0;
  stdin.end = value => { written = value; };
  const clean = writePreviewPrompt({ stdin }, 'stdin', 'preview prompt', () => { failures++; });
  assert.equal(written, 'preview prompt'); assert.equal(failures, 0);
  stdin.emit('error', Object.assign(new Error('synthetic EPIPE'), { code: 'EPIPE' }));
  stdin.emit('error', new Error('late duplicate'));
  assert.equal(failures, 1); clean();

  writePreviewPrompt({}, 'stdin', 'preview prompt', () => { failures++; });
  assert.equal(failures, 2);
  const throwing = new EventEmitter(); throwing.end = () => { throw new Error('sync write failure'); };
  writePreviewPrompt({ stdin: throwing }, 'stdin', 'preview prompt', () => { failures++; });
  assert.equal(failures, 3);
});

function fakeProcess(events, { exitCode = 0, pending = false, error = false, finalNewline = true } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    let closed = false;
    const close = (code, signal = null) => {
      if (closed) return; closed = true;
      child.stdout.end(); child.stderr.end(); child.emit('close', code, signal);
    };
    child.kill = signal => { child.killed = true; queueMicrotask(() => close(null, signal)); return true; };
    queueMicrotask(() => {
      if (error) { child.emit('error', new Error('synthetic spawn failure')); close(-2); return; }
      const bytes = Buffer.from(events.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + (finalNewline ? '\n' : ''));
      // Exercise multibyte JSON text split at every byte boundary.
      for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
      if (!pending) close(exitCode);
    });
    return child;
  };
}
function makeWorker(events, fakeOptions) {
  const options = { cwd: '/fixture', model: 'fixture-model' };
  return codexWorker({ ...options, schemaPath: '/fixture/schema', timeoutMs: 10,
    preflight: { passed: true, cli_model: options.model, config_fingerprint: configFingerprint(options) },
    spawnProcess: fakeProcess(events, fakeOptions) });
}
function capturedProcess(events,seen) {
  return (cli,args,options)=>{
    seen.cli=cli;seen.args=args;seen.options=options;seen.stdin='';
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.killed=false;
    child.stdin.setEncoding('utf8');child.stdin.on('data',chunk=>{seen.stdin+=chunk;});
    child.kill=signal=>{child.killed=true;queueMicrotask(()=>child.emit('close',null,signal));return true;};
    queueMicrotask(()=>{
      for(const event of events)child.stdout.write(`${JSON.stringify(event)}\n`);
      child.stdout.end();child.stderr.end();child.emit('close',0,null);
    });
    return child;
  };
}
const start = [{ type: 'thread.started', thread_id: 'fixture-thread' }, { type: 'turn.started' }];
const message = { type: 'item.completed', item: { type: 'agent_message', text: '{"greeting":"你好"}' } };
const context = () => ({ signal: new AbortController().signal, onEvent() {} });
test('CLI adapter handles successful chunked UTF-8 and refuses a second dispatch', async () => {
  const worker = makeWorker([...start, message, { type: 'turn.completed' }]);
  assert.equal((await worker({ prompt: 'fixture' }, context())).value.greeting, '你好');
  assert.equal((await worker({ prompt: 'fixture' }, context())).code, 'worker_dispatch_limit');
});
test('CLI adapter normalizes duplicate provider failure terminals and still records process close', async () => {
  const events = [];
  const worker = makeWorker([...start, { type: 'error' }, { type: 'turn.failed' }], { exitCode: 1 });
  assert.deepEqual(await worker({ prompt: 'fixture' }, {
    ...context(), onEvent: event => events.push(event),
  }), { status: 'failed', code: 'provider_failed' });
  assert.deepEqual(events, [
    { event: 'thread.started', provider_thread: 'fixture-thread' },
    { event: 'turn.started', item_type: null },
    { event: 'error', item_type: null },
    { event: 'process_closed', exit_code: 1, signal: null, timed_out: false },
  ]);
  assert.equal((await worker({ prompt: 'fixture' }, context())).code, 'worker_dispatch_limit');
});
test('reviewer prompt can use explicit stdin without changing the default argv mode',async()=>{
  const options={cwd:'/fixture',model:'fixture-model'},preflight={passed:true,cli_model:options.model,
    config_fingerprint:configFingerprint(options)},events=[...start,message,{type:'turn.completed'}];
  const stdinSeen={},stdinWorker=codexWorker({...options,schemaPath:'/fixture/schema',preflight:{...preflight,prompt_transport:'stdin'},
    promptTransport:'stdin',spawnProcess:capturedProcess(events,stdinSeen)});
  assert.equal((await stdinWorker({prompt:'review package'},context())).status,'succeeded');
  assert.equal(stdinSeen.args.at(-1),'-');assert(!stdinSeen.args.includes('review package'));
  assert.equal(stdinSeen.options.stdio[0],'pipe');assert.equal(stdinSeen.stdin,'review package');

  const argvSeen={},argvWorker=codexWorker({...options,schemaPath:'/fixture/schema',preflight,
    spawnProcess:capturedProcess(events,argvSeen)});
  assert.equal((await argvWorker({prompt:'legacy fixture'},context())).status,'succeeded');
  assert.equal(argvSeen.args.at(-1),'legacy fixture');assert.equal(argvSeen.options.stdio[0],'ignore');
  assert.equal(argvSeen.stdin,'');
});
test('stdin write failure stops one process without argv fallback or redispatch',async()=>{
  const options={cwd:'/fixture',model:'fixture-model'},preflight={passed:true,cli_model:options.model,
    config_fingerprint:configFingerprint(options),prompt_transport:'stdin'};let spawns=0,args;
  const spawnProcess=(_cli,spawnArgs)=>{
    spawns++;args=spawnArgs;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new PassThrough();child.killed=false;
    child.kill=signal=>{child.killed=true;queueMicrotask(()=>child.emit('close',null,signal));return true;};
    queueMicrotask(()=>child.stdin.emit('error',Object.assign(new Error('synthetic EPIPE'),{code:'EPIPE'})));
    return child;
  };
  const worker=codexWorker({...options,schemaPath:'/fixture/schema',preflight,promptTransport:'stdin',spawnProcess});
  assert.deepEqual(await worker({prompt:'review package'},context()),{status:'failed',code:'prompt_write_failed'});
  assert.equal(spawns,1);assert.equal(args.at(-1),'-');assert(!args.includes('review package'));
  assert.equal((await worker({prompt:'review package'},context())).code,'worker_dispatch_limit');assert.equal(spawns,1);
});
test('CLI diagnostic is classified and never silently ignored', async () => {
  const result = await makeWorker([...start, { type: 'item.completed', item: { type: 'error', message: 'synthetic diagnostic' } }])({}, context());
  assert.equal(result.code, 'cli_diagnostic');
});
test('unexpected tool event remains blocked', async () => {
  const result = await makeWorker([...start, { type: 'item.started', item: { type: 'command_execution' } }])({}, context());
  assert.equal(result.code, 'unexpected_tool_or_item');
});
test('no terminal completion is not a successful result', async () => {
  assert.equal((await makeWorker([...start, message])({}, context())).code, 'incomplete_result');
});
test('malformed JSON fails closed', async () => {
  assert.equal((await makeWorker(['bad-json'])({}, context())).code, 'invalid_event');
});
const invalidEvents = [
  null, [], true, 0, 'primitive', {},
  { type: null }, { type: 3 }, { type: '' }, { type: ' ' },
  ...[undefined, null, {}, [], 3, '', ' '].map(thread_id => ({ type: 'thread.started', thread_id })),
  ...[undefined, null, [], {}, { type: null }, { type: '' }].map(item => ({ type: 'item.completed', item })),
  ...[undefined, null, 3, {}].map(text => ({ type: 'item.completed', item: { type: 'agent_message', text } })),
  { type: 'item.started' }, { type: 'item.updated', item: [] }, { type: 'turn.started', item: false },
];
for (const invalid of invalidEvents) {
  test(`invalid event shape returns one host failure: ${JSON.stringify(invalid)}`, { timeout: 1000 }, async () => {
    const events = [];
    // Include valid late output to prove malformed events cannot become success.
    const worker = makeWorker([JSON.stringify(invalid), ...start, message, { type: 'turn.completed' }]);
    const output = await execute({ args, worker, runId: 'invalid-shape-run', emit: e => events.push(e) });
    assert.deepEqual(output.result, { status: 'failed', code: 'invalid_event' });
    assert.equal(events.filter(e => e.type === 'worker_started').length, 1);
    assert.equal(events.filter(e => e.type === 'worker_ended').length, 1);
    assert.equal(events.filter(e => e.type === 'finished').length, 1);
    assert.equal(events.at(-1).status, 'failed');
    assert.ok(!events.some(e => e.type === 'phase' && e.name === 'Collect'));
    assert.ok(events.every((e, i) => e.run_id === 'invalid-shape-run' && e.sequence === i + 1));
  });
}
test('invalid unterminated event is rejected during process closure', { timeout: 1000 }, async () => {
  const result = await makeWorker([...start, message, { type: 'turn.completed' }, 'null'], { finalNewline: false })({}, context());
  assert.deepEqual(result, { status: 'failed', code: 'invalid_event' });
});
test('valid consumed events allow unrelated provider metadata', async () => {
  const result = await makeWorker([
    { ...start[0], extra: { compatible: true } }, start[1],
    { type: 'item.started', item: { type: 'reasoning', text: 'synthetic' } },
    { type: 'item.updated', item: { type: 'reasoning', text: 'synthetic' } },
    message, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ])({}, context());
  assert.equal(result.status, 'succeeded');
  assert.equal(result.value.greeting, '你好');
});
test('process timeout is explicit and fake child closes', async () => {
  assert.equal((await makeWorker(start, { pending: true })({}, context())).code, 'timeout');
});
test('spawn failure settles without a second event after closure', async () => {
  const events = [];
  const result = await makeWorker([], { error: true })({}, { ...context(), onEvent: e => events.push(e) });
  assert.equal(result.code, 'spawn_failed'); assert.equal(events.length, 0);
});
