import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {cmAiSessionBoundary,cmFixSessionBoundary,nextOpenTask} from '../runtime/js/session-boundary.mjs';

const specs=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-boundary-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'1.slug'));return root;};
const lines=block=>block.split('\n').slice(1);

test('cm-ai run_done names the next open task of the same feature',t=>{
  const root=specs(t);fs.writeFileSync(path.join(root,'1.slug','tasks.md'),'- [x] T-001: done\n- [ ] T-002: next\n- [ ] T-003: later\n');
  const block=cmAiSessionBoundary({workflow:'cm-ai',state:'run_done'},{specsDir:root,feature:'1.slug'});
  assert.deepEqual(lines(block),['会话边界：换新会话。','新会话里运行：$cm-ai（继续 1.slug 的 T-002）','原因：本运行已到 run_done，记录都已落盘，下一项是新单元。']);
  assert.match(block.split('\n')[0],/原样放在给用户回复的最后/);
});

test('cm-ai run_done with every task checked says there is nothing next',t=>{
  const root=specs(t);fs.writeFileSync(path.join(root,'1.slug','tasks.md'),'- [x] T-001: done\n');
  assert.equal(lines(cmAiSessionBoundary({workflow:'cm-ai',state:'run_done'},{specsDir:root,feature:'1.slug'}))[1],'新会话里运行：无，1.slug 的任务已全部完成');
});

test('cm-ai with an unreadable task list does not invent a next task',t=>{
  const root=specs(t);
  assert.equal(nextOpenTask(root,'1.slug'),undefined);
  assert.match(lines(cmAiSessionBoundary({workflow:'cm-ai',state:'run_done'},{specsDir:root,feature:'1.slug'}))[1],/未能读取任务清单/);
});

test('no verdict before run_done, for another workflow, or for an unfinished fix',()=>{
  assert.equal(cmAiSessionBoundary({workflow:'cm-ai',state:'fixture_completed'},{}),null);
  assert.equal(cmAiSessionBoundary({workflow:'cm-prd',state:'run_done'},{}),null);
  assert.equal(cmFixSessionBoundary({stage:'completed',completionEligible:false},'advance'),null);
  assert.equal(cmFixSessionBoundary({stage:'regression_required'},'advance'),null);
  assert.equal(cmFixSessionBoundary({stage:'completed',completionEligible:true},'status'),null,'a status query is not the closing boundary');
});

test('a finished cm-fix gets the three lines',()=>{
  assert.deepEqual(lines(cmFixSessionBoundary({stage:'completed',completionEligible:true},'advance')),
    ['会话边界：换新会话。','新会话里运行：无（有下一个缺陷时，在新会话里运行 $cm-fix）','原因：本缺陷已收口，记录都已落盘。']);
});

// The shared driver core prints the block to stderr after a final result,
// keeps stdout a single JSON result, and prints nothing for other results.
for(const [name,state,expect] of [['prints the verdict at run_done','run_done',true],['stays silent before run_done','fixture_completed',false]]){
  test(`driver core ${name}`,t=>{
    const root=specs(t),host=path.join(root,'host.mjs'),wrapper=path.join(root,'drive.mjs');
    fs.writeFileSync(path.join(root,'1.slug','tasks.md'),'- [x] T-001: done\n- [ ] T-002: next\n');
    fs.writeFileSync(host,`process.stdout.write(JSON.stringify({type:'host_ready',sessionId:'s'})+'\\n');
let text='';process.stdin.on('data',chunk=>{text+=chunk;let at;while((at=text.indexOf('\\n'))>=0){const line=text.slice(0,at);text=text.slice(at+1);
 if(!line)continue;const row=JSON.parse(line);if(row.requestId==='drive')process.stdout.write(JSON.stringify({requestId:'drive',result:{workflow:'cm-ai',state:${JSON.stringify(state)}}})+'\\n');}});`);
    fs.writeFileSync(wrapper,`import {driveHost} from ${JSON.stringify(new URL('../runtime/js/cm-ai/drive-core.mjs',import.meta.url).href)};
import {cmAiSessionBoundary} from ${JSON.stringify(new URL('../runtime/js/session-boundary.mjs',import.meta.url).href)};
driveHost({host:${JSON.stringify(host)},args:[],cwd:${JSON.stringify(root)},operation:'advance',answers:{},answerFor:()=>null,
  sessionBoundary:result=>cmAiSessionBoundary(result,{specsDir:${JSON.stringify(root)},feature:'1.slug'})});`);
    const run=spawnSync(process.execPath,[wrapper],{encoding:'utf8',timeout:10000});
    assert.equal(run.status,0,run.stderr);
    assert.equal(JSON.parse(run.stdout).result.state,state,'stdout stays one JSON result');
    assert.equal(run.stderr.includes('新会话里运行：$cm-ai（继续 1.slug 的 T-002）'),expect,run.stderr);
  });
}
