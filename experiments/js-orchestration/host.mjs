import { randomUUID } from 'node:crypto';
import { meta, run } from './inspect-task.mjs';

export async function execute({ args, worker, signal = new AbortController().signal,
  emit = () => {}, runId = randomUUID() }) {
  let dispatched = false;
  let sequence = 0;
  const event = (type, detail = {}) => emit({ run_id: runId, sequence: ++sequence, type, ...detail });
  event('started', { workflow: meta.name });
  let result;
  try {
    result = await run({ args, signal,
      phase: name => {
        if (!meta.phases.includes(name)) throw new Error('unknown phase');
        event('phase', { name });
      },
      agent: async (stepId, request) => {
        if (dispatched) return { status: 'blocked', code: 'dispatch_limit' };
        if (signal.aborted) return { status: 'cancelled', code: 'cancelled_before_dispatch' };
        dispatched = true;
        event('worker_started', { step_id: stepId });
        const response = await worker(request, { signal, runId, stepId,
          onEvent: detail => event('worker_progress', { step_id: stepId, ...detail }) });
        event('worker_ended', { step_id: stepId, status: response.status });
        return response;
      },
    });
  } catch {
    result = { status: signal.aborted ? 'cancelled' : 'failed', code: 'execution_error' };
  }
  event('finished', { status: result.status, code: result.code ?? null });
  return { run_id: runId, result };
}
