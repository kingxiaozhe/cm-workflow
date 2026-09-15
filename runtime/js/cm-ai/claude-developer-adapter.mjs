// Trusted Claude conversation tools use the same developer/Learning contract.
// This adapter neither starts Claude nor implements an independent reviewer.
import {readDeveloperRequest,buildDeveloperPrompt,createDeveloperRun} from './developer-adapter.mjs';
export const readClaudeDeveloperRequest=raw=>readDeveloperRequest(raw,'claude');
export const buildClaudeDeveloperPrompt=raw=>buildDeveloperPrompt(raw,'claude');
export const createClaudeDeveloperRun=({worker,requestedModel})=>createDeveloperRun({worker,requestedModel,provider:'claude'});
