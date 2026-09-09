// Compatibility path; the shared runtime is authoritative.
export * from '../../runtime/js/cm-ai/tool-preview.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {main} from '../../runtime/js/cm-ai/tool-preview.mjs';
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
