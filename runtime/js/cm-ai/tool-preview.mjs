// Offline tool-surface probe. Local sink only: never proxies to a model service.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { commonArgs, cleanEnvironment, configFingerprint } from './codex-config.mjs';

export function previewPromptTransport(promptTransport, prompt) {
  if (!['argument', 'stdin'].includes(promptTransport)) throw new Error('invalid prompt transport');
  return promptTransport === 'stdin'
    ? { argument: '-', stdin: prompt, stdio: ['pipe', 'pipe', 'pipe'] }
    : { argument: prompt, stdin: null, stdio: ['ignore', 'pipe', 'pipe'] };
}

export function writePreviewPrompt(child, promptTransport, prompt, onFailure) {
  if (promptTransport === 'argument') return () => {};
  if (promptTransport !== 'stdin') throw new Error('invalid prompt transport');
  let active = true, failed = false;
  const fail = () => {
    if (!active || failed) return;
    failed = true; onFailure();
  };
  const input = child?.stdin;
  if (!input || typeof input.end !== 'function' || typeof input.on !== 'function') {
    fail(); return () => { active = false; };
  }
  input.on('error', fail);
  try { input.end(prompt); } catch { fail(); }
  return () => { active = false; input.removeListener?.('error', fail); };
}

export function requestTools(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.input)) return null;
  if (!Object.hasOwn(parsed, 'tools')) return [];
  return Array.isArray(parsed.tools) ? parsed.tools.map(tool => ({
    type: tool.type, name: tool.name ?? tool.function?.name ?? null,
  })) : null;
}

export function skillContext(parsed) {
  const texts = (Array.isArray(parsed?.input) ? parsed.input : []).flatMap(item =>
    (Array.isArray(item.content) ? item.content : []).map(c => c.text ?? '').filter(t => typeof t === 'string'));
  const aliases = new Map();
  for (const text of texts) {
    const plain = text.replaceAll('`', '');
    for (const match of plain.matchAll(/\b(r\d+)\s*=\s*(\/[^\n]+)/g)) aliases.set(match[1], match[2].trim());
  }
  const folders = new Set();
  for (const text of texts) for (const match of text.matchAll(/file:\s*([^\n)]+\/SKILL\.md)/g)) {
    let file = match[1];
    const alias = /^(r\d+)\/(.+)$/.exec(file);
    if (alias && aliases.has(alias[1])) file = path.join(aliases.get(alias[1]), alias[2]);
    if (path.isAbsolute(file)) folders.add(path.dirname(file));
  }
  const sections = texts.flatMap(text => [...text.matchAll(/### Available skills[^\n]*\n([\s\S]*?)(?=\n### |\n<\/skills_instructions>|$)/g)].map(m => m[1].trim()));
  const hasMarker = texts.some(text => /### Available skills|<skills_instructions>/.test(text));
  return { present: folders.size > 0 || (hasMarker && (!sections.length || sections.some(section => section.length > 0))),
    section_lengths: sections.map(s => s.length), folders: [...folders].sort() };
}

export async function previewTools({ cwd, model, fixtureResponse = false, disabledSkills = [],
  promptTransport = 'argument', cli = 'codex', allowCodeProject = false }) {
  cwd = fs.realpathSync(cwd);
  if (typeof allowCodeProject !== 'boolean' || !fs.statSync(cwd).isDirectory()) throw new Error('invalid code project');
  if (!allowCodeProject && !/^\/private\/tmp\/cm-js-b1-[A-Za-z0-9]+$/.test(cwd)) throw new Error('invalid fixture');
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('invalid model');
  const seen = [];
  const discoveredSkills = new Set();
  const server = http.createServer((request, response) => {
    let chunks = [], size = 0, tooLarge = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 1_000_000) { tooLarge = true; chunks = []; request.destroy(); }
      else if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) return;
      try {
        let body = Buffer.concat(chunks);
        if (request.headers['content-encoding'] === 'gzip') body = gunzipSync(body, { maxOutputLength: 1_000_000 });
        if (request.headers['content-encoding'] === 'zstd') body = zstdDecompressSync(body, { maxOutputLength: 1_000_000 });
        const parsed = JSON.parse(body.toString('utf8'));
        // Persist neither headers nor prompt/input. Only safe structural metadata.
        const tools = requestTools(parsed);
        const context = skillContext(parsed);
        for (const folder of context.folders) discoveredSkills.add(folder);
        seen.push({ method: request.method, path: request.url, model: parsed.model,
          tools, skill_catalog_present: context.present, skill_folder_count: context.folders.length,
          skill_section_lengths: context.section_lengths,
          top_level_keys: Object.keys(parsed),
          auth_header_present: Boolean(request.headers.authorization),
          auth_is_synthetic: request.headers.authorization === 'Bearer cm-js-synthetic-local-probe' });
      } catch { seen.push({ method: request.method, path: request.url, invalid_json: true,
        content_encoding: request.headers['content-encoding'] ?? null }); }
      if (fixtureResponse && request.method === 'POST' && request.url === '/v1/responses') {
        // Scripted transport fixture, never described as a model-generated answer.
        const text = '{"greeting":"CM 本机固定响应"}';
        const item = { id: 'msg_cm_fixture', type: 'message', role: 'assistant',
          status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        const events = [
          { type: 'response.created', response: { id: 'resp_cm_fixture', status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
          { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'resp_cm_fixture', status: 'completed', model,
            output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
              input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
        ];
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ sequence_number: i, ...e })}\n\n`).join(''));
      } else {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'CM_TOOL_PREVIEW_STOP', type: 'invalid_request_error' } }));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const loopbackBase = `http://${server.address().address}:${port}`;
  const previewPrompt = 'Return a greeting for synthetic task A-DEMO-001.';
  const transport = previewPromptTransport(promptTransport, previewPrompt);
  const args = [...commonArgs({ cwd, model, disabledSkills }),
    '-c', 'model_provider="cm_local_tool_preview"',
    '-c', `model_providers.cm_local_tool_preview={name="CM local tool preview",base_url="${loopbackBase}/v1",wire_api="responses",env_key="CM_JS_PROBE_AUTH",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`,
    transport.argument];
  const env = cleanEnvironment();
  env.CM_JS_PROBE_AUTH = 'cm-js-synthetic-local-probe';
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(cli, args, { cwd, env, stdio: transport.stdio });
      let stderr = '', timedOut = false, stdout = '', promptWriteFailed = false;
      let cleanPrompt = () => {};
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { if(stdout.length < 100000) stdout += chunk; });
      child.stderr.on('data', chunk => { if(stderr.length < 16000) stderr += chunk; });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20000);
      child.once('error', error => { clearTimeout(timer); cleanPrompt(); reject(error); });
      child.once('close', (code, signal) => {
        const events = stdout.trim().split('\n').filter(Boolean).map(line => {
          try {
            const e = JSON.parse(line);
            return { type: e.type, keys: Object.keys(e), item_keys: e.item ? Object.keys(e.item) : [],
              item_type: e.item?.type ?? null, item_kind: e.item?.item_type ?? null,
              fixture_diagnostic: fixtureResponse && e.item?.type === 'error'
                ? String(e.item.message).slice(0,500) : undefined };
          } catch { return { invalid_json: true }; }
        });
        clearTimeout(timer); cleanPrompt(); resolve({ code, signal, timedOut, promptWriteFailed, events,
          // Config/startup diagnostics only when no model request reached the sink.
          diagnostic: seen.length ? null : stderr.slice(-2500) });
      });
      cleanPrompt = writePreviewPrompt(child, promptTransport, previewPrompt, () => {
        promptWriteFailed = true;
        if (!child.killed) child.kill('SIGTERM');
      });
      if (promptWriteFailed) cleanPrompt();
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const posts = seen.filter(r => r.method === 'POST' && r.path === '/v1/responses');
  const passed = posts.length === 1 && posts[0].model === model
    && posts[0].tools?.length === 0 && posts[0].auth_is_synthetic
    && posts[0].skill_catalog_present === false
    && result.code === (fixtureResponse ? 0 : 1) && !result.timedOut && !result.promptWriteFailed;
  const receipt = { cli_model: model, config_fingerprint: configFingerprint({ cwd, model, disabledSkills }),
    passed, fixture_response: fixtureResponse, prompt_transport: promptTransport,
    real_model_requests: 0, local_requests: seen,
    disabled_skill_count: disabledSkills.length, process: result, listener_closed: true };
  Object.defineProperties(receipt, {
    discoveredSkillFolders: { value: [...discoveredSkills] },
    disabledSkillFolders: { value: [...disabledSkills] },
  });
  return receipt;
}

export async function previewIsolated(options) {
  const first = await previewTools(options);
  if (first.passed || !first.discoveredSkillFolders.length) return first;
  // Current CLI also needs SKILL.md paths; include both observed forms without
  // changing user-level skill settings or reading the skill contents.
  const disabledSkills = [...new Set(first.discoveredSkillFolders.flatMap(folder => {
    let canonical = folder;
    try { canonical = fs.realpathSync(folder); } catch { /* Missing stays blocked by the next preview. */ }
    return [folder, path.join(folder, 'SKILL.md'), canonical, path.join(canonical, 'SKILL.md')];
  }))];
  return previewTools({ ...options, disabledSkills });
}

export async function main() {
  const result = await previewIsolated({ cwd: process.argv[2], model: process.argv[3],
    fixtureResponse: process.argv[4] === '--fixture-response' });
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
