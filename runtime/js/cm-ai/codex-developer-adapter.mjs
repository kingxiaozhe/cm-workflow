// Stable Codex exports over the shared developer contract.
import {readDeveloperRequest,buildDeveloperPrompt,createDeveloperRun} from './developer-adapter.mjs';
export const readCodexDeveloperRequest=raw=>readDeveloperRequest(raw,'codex');
export const buildCodexDeveloperPrompt=raw=>buildDeveloperPrompt(raw,'codex');
export const createCodexDeveloperRun=({worker,requestedModel})=>createDeveloperRun({worker,requestedModel,provider:'codex'});
