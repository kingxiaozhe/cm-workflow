// Formal cm-ai host assembly. It adds no workflow, authorization, or completion path.
import {createCmAiConversationEntry} from './cm-ai-conversation-entry.mjs';
import {json,need,shape} from './effect-contract.mjs';
import {createTaskRunner} from './task-runner.mjs';

export function createCmAiHost(options) {
  need(arguments.length===1,'invalid_input');
  shape(options,['runner','entry']);
  const keys=Object.keys(options.entry);shape(options.entry,keys);
  const {hostDecisionProvider,qaDecisionProvider,qaExecutor,documentationProvider,...data}=options.entry;
  const entryOptions=json(data);
  need(!Object.hasOwn(entryOptions,'runner'),'invalid_input');
  const runner=createTaskRunner(options.runner);
  const entry=createCmAiConversationEntry({...entryOptions,runner,
    ...(hostDecisionProvider===undefined?{}:{hostDecisionProvider}),
    ...(qaExecutor===undefined?{}:{qaExecutor}),
    ...(documentationProvider===undefined?{}:{documentationProvider}),
    ...(qaDecisionProvider===undefined?{}:{qaDecisionProvider})});
  return Object.freeze({handle:entry.handle,inspectFixAssociation:runner.inspectFixAssociation,acceptCompletedFix:runner.acceptCompletedFix});
}
