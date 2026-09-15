import fs from 'node:fs';
import path from 'node:path';
import { execute } from './host.mjs';
import { previewIsolated } from './tool-preview.mjs';
import { codexWorker } from './worker-codex.mjs';

const [mode, rawCwd, model] = process.argv.slice(2);
if (!['--preflight', '--live'].includes(mode)) throw new Error('choose --preflight or --live explicitly');
const cwd = fs.realpathSync(rawCwd);
if (!/^\/private\/tmp\/cm-js-b1-[A-Za-z0-9]+$/.test(cwd)) throw new Error('only B1 synthetic fixture allowed');
const preflight = await previewIsolated({ cwd, model });
console.log(JSON.stringify({ type: 'preflight', ...preflight }));
if (!preflight.passed) process.exitCode = 1;
else if (mode === '--live') {
  const schemaPath = path.join(cwd, 'greeting.schema.json');
  // This file is prepared explicitly by the host, never by the model.
  if (!fs.existsSync(schemaPath)) throw new Error('missing synthetic output schema');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const output = await execute({
      args: { task_id: 'A-DEMO-001', title: '生成一句问候' },
      worker: codexWorker({ cwd, model, schemaPath, preflight,
        disabledSkills: preflight.disabledSkillFolders }), signal: controller.signal,
      emit: event => console.log(JSON.stringify(event)),
    });
    console.log(JSON.stringify({ type: 'result', ...output }));
    if (output.result.status !== 'succeeded') process.exitCode = 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
