// Formal cm-ai host assembly. It adds no workflow, authorization, or completion path.
import {createCmAiConversationEntry} from './cm-ai-conversation-entry.mjs';
import {json,need,shape} from './effect-contract.mjs';
import {createTaskRunner} from './task-runner.mjs';

export function createCmAiHost(options) {
  need(arguments.length===1,'invalid_input');
  shape(options,['runner','entry']);
  const entryOptions=json(options.entry);
  need(!Object.hasOwn(entryOptions,'runner'),'invalid_input');
  const runner=createTaskRunner(options.runner);
  const entry=createCmAiConversationEntry({...entryOptions,runner});
  return Object.freeze({handle:entry.handle});
}
