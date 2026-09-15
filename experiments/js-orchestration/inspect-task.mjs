export const meta = Object.freeze({
  name: 'cm-inspect-task',
  phases: ['Validate', 'Greet', 'Collect'],
});

export const outputSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: { greeting: { type: 'string' } }, required: ['greeting'],
});

export function validGreeting(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof value.greeting === 'string'
    && value.greeting.trim().length > 0 && value.greeting.length <= 200;
}

export async function run(ctx) {
  ctx.phase('Validate');
  const { args } = ctx;
  // B1 intentionally accepts one public synthetic fixture, not arbitrary source data.
  if (!args || args.task_id !== 'A-DEMO-001' || args.title !== '生成一句问候'
    || Object.keys(args).sort().join(',') !== 'task_id,title') {
    return { status: 'blocked', code: 'input_out_of_scope' };
  }
  if (ctx.signal.aborted) return { status: 'cancelled', code: 'cancelled_before_dispatch' };
  ctx.phase('Greet');
  const result = await ctx.agent('say-hello', {
    prompt: '合成测试 A-DEMO-001：生成一句简短中文问候。只返回 JSON 对象，唯一字段 greeting。',
    outputSchema,
  });
  if (ctx.signal.aborted) return { status: 'cancelled', code: 'cancelled_after_dispatch' };
  if (result.status !== 'succeeded') return result;
  ctx.phase('Collect');
  if (!validGreeting(result.value)) return { status: 'failed', code: 'invalid_output' };
  return { status: 'succeeded', task_id: args.task_id, greeting: result.value.greeting };
}
