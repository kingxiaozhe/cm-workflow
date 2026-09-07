// Test-only handoff/review builders; production gates remain the authority.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {implementationSha256} from '../../scripts/cm-task-gate.mjs';

export function writeHandoff(file,root,files,attempt=1){
  fs.writeFileSync(file,JSON.stringify({schema_version:1,task_id:'T-001',attempt,status:'ready_for_review',
    changed_files:files,implementation_sha256:implementationSha256(root,files),
    verification:[{command:'fixture',status:'passed',evidence:'synthetic check'}],
    evidence:['synthetic check'],blockers:[],scope_deviation:[]}));
}
export function writeReview(file,handoff,attempt=1,verdict='approved'){
  const payload=JSON.parse(fs.readFileSync(handoff));
  const sha=createHash('sha256').update(fs.readFileSync(handoff)).digest('hex');
  const body=verdict==='approved'?'Zero findings.':'Changes required.';
  fs.writeFileSync(file,`---\nat: 2026-09-07T00:00:00Z\nreviewer: codex-subagent\nindependent: true\ntask: T-001\nattempt: ${attempt}\nround: ${attempt}\nverdict: ${verdict}\nblocking_findings: ${verdict==='approved'?0:1}\nhandoff: ${path.basename(handoff)}\nhandoff_sha256: ${sha}\nscope:\n${payload.changed_files.map(p=>`  - ${p}`).join('\n')}\n---\n\n${body} Synthetic review.\n`);
}
