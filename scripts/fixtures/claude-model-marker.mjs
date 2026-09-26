#!/usr/bin/env node
// Synthetic CLI stderr fixture; no model request or host launch.
const args=process.argv.slice(2),model=args[args.indexOf('--model')+1];
if(model==='fixture-unrecognized-model')
  process.stderr.write(`[claude-code:unrecognized_model] ${JSON.stringify({model,query_source:'sdk'})}\n`);
process.stdout.write('{"type":"result","result":""}\n');
