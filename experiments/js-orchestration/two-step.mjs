// Fixed C fixture, not a user-supplied workflow loader. No IO or parallel branches.
import { outputSchema } from './inspect-task.mjs';

export async function run(ctx) {
  if (ctx.args?.task_id !== 'C-DEMO-001' || Object.keys(ctx.args).length !== 1)
    throw new Error('input_out_of_scope');
  const first = await ctx.agent('first', { prompt: 'Synthetic C greeting.', outputSchema });
  const second = await ctx.agent('second', {
    prompt: `Synthetic C follow-up to: ${first.greeting}`, outputSchema,
  });
  return { first: first.greeting, second: second.greeting };
}
