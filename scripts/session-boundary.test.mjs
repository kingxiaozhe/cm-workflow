import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {cmAiSessionBoundary,cmFixSessionBoundary,openTasks} from '../runtime/js/session-boundary.mjs';
import {handoffPath,printHandoff,readHandoff,writeHandoff} from '../runtime/js/session-handoff.mjs';

const specs=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-boundary-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'1.slug'));return root;};
const lines=block=>block.split('\n').slice(1);

const write=(root,text)=>fs.writeFileSync(path.join(root,'1.slug','tasks.md'),text);
const boundary=root=>lines(cmAiSessionBoundary({workflow:'cm-ai',state:'run_done'},{specsDir:root,feature:'1.slug'}));

test('cm-ai run_done with every task done says there is nothing next',t=>{
  const root=specs(t);write(root,'- [x] T-001: done\n- [x] T-002: done\n');
  assert.deepEqual(boundary(root),['会话边界：换新会话。','新会话里运行：无，1.slug 的任务已全部完成','原因：本运行已到 run_done，记录都已落盘，下一项是新单元。']);
});

test('open tasks are listed with their full ids, without naming one as the next executable task',t=>{
  const root=specs(t);write(root,'- [x] T-001: done\n- [ ] T-002a: open\n- [ ] T-OBS: observe\n');
  assert.deepEqual(openTasks(root,'1.slug'),['T-002a','T-OBS']);
  assert.equal(boundary(root)[1],'新会话里运行：$cm-ai（1.slug 仍有未完成任务：T-002a、T-OBS）');
});

test('fenced examples and dropped tasks are not open work',t=>{
  // Fences count under the grammar a taskGrammar-2 approval binds; older approvals keep the legacy parse.
  const root=specs(t);fs.writeFileSync(path.join(root,'.cm-specs-status'),JSON.stringify({status:'approved',taskGrammar:2}));write(root,'- [x] T-001: done\n- [ ] T-002: ~~[DROPPED 不做]~~\n```\n- [ ] T-999: example\n```\n');
  assert.deepEqual(openTasks(root,'1.slug'),[]);
  assert.equal(boundary(root)[1],'新会话里运行：无，1.slug 的任务已全部完成');
});

test('an unreadable, empty or invalid task list is "cannot tell", never "all done"',t=>{
  const root=specs(t);
  assert.equal(openTasks(root,'1.slug'),null);
  assert.match(boundary(root)[1],/无法确定/);
  write(root,'');assert.equal(openTasks(root,'1.slug'),null);assert.match(boundary(root)[1],/无法确定/);
  write(root,'- [ ] T-001: a\n- [x] T-001: duplicate\n');assert.equal(openTasks(root,'1.slug'),null);
});

test('the header keeps both exceptions of the judgement table',()=>{
  const header=cmFixSessionBoundary({stage:'completed',completionEligible:true},'advance').split('\n')[0];
  assert.match(header,/会话边界：继续本会话。/);assert.match(header,/会话边界：留在本会话/);assert.match(header,/删掉「新会话里运行」那一行/);
});

// The real drivers are wired: cm-ai is also covered end to end in cm-ai-drive.test.mjs
// (run_done prints the block on stderr); cm-fix has no completion fixture, so the
// wiring is checked statically here.
test('both drivers pass their session-boundary callback to the shared core',()=>{
  const read=name=>fs.readFileSync(new URL(`./${name}`,import.meta.url),'utf8');
  assert.match(read('cm-ai-drive.mjs'),/sessionBoundary:result=>cmAiSessionBoundary\(result,\{specsDir:definition\.specsDir,feature:definition\.feature,identity:definition\.identity\}\)/);
  assert.match(read('cm-fix-drive.mjs'),/sessionBoundary:\(result,op\)=>cmFixSessionBoundary\(result,op,\{archive,runId:config\.identity\?\.runId\}\)/);
  // A new run (mode:create) prints the previous handoff before the host starts.
  assert.match(read('cm-ai-drive.mjs'),/if\(plan\.mode==='create'\)printHandoff\(definition\.specsDir\);\n  driveHost\(/);
  assert.match(read('cm-fix-drive.mjs'),/if\(plan\.mode==='create'\)printHandoff\(archive\);/);
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
    fs.writeFileSync(path.join(root,'1.slug','tasks.md'),'- [x] T-001: done\n');
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
    assert.equal(run.stderr.includes('新会话里运行：无，1.slug 的任务已全部完成'),expect,run.stderr);
  });
}

// Session handoff: written at the closing boundary, printed when the next run is created.
const withReviews=t=>{const root=specs(t);fs.mkdirSync(path.join(root,'.reviews'));return root;};
const identity={runId:'run-7',taskId:'T-002',repositoryId:'repo'};

test('cm-ai run_done writes the handoff with done, open tasks and the next command, and names it in the verdict',t=>{
  const root=withReviews(t);write(root,'- [x] T-001: done\n- [x] T-002: done\n- [ ] T-003: open\n');
  const block=cmAiSessionBoundary({workflow:'cm-ai',state:'run_done'},{specsDir:root,feature:'1.slug',identity});
  assert.equal(lines(block)[3],`交接摘要：${handoffPath(root)}（新会话开新运行时驾驶员会先打印它）`);
  const text=fs.readFileSync(handoffPath(root),'utf8');
  assert.match(text,/运行编号：run-7/);assert.match(text,/## 已做\n- 1\.slug T-002：已到 run_done/);
  assert.match(text,/## 待做\n- 1\.slug T-003\n/);assert.match(text,/## 下一条命令\n- \$cm-ai（1\.slug 仍有未完成任务：T-003）/);
  assert.doesNotMatch(text,/repo/,'no identity beyond the run id is written');
  assert.deepEqual(fs.readdirSync(path.join(root,'.reviews')),['session-handoff.md'],'no temporary file is left behind');
});

test('an unreadable task list is written as "cannot tell", never as nothing left',t=>{
  const root=withReviews(t);
  cmAiSessionBoundary({workflow:'cm-ai',state:'run_done'},{specsDir:root,feature:'1.slug',identity});
  assert.match(fs.readFileSync(handoffPath(root),'utf8'),/## 待做\n- 无法确定/);
});

test('a handoff that cannot be written is reported in the verdict, not swallowed, and the verdict still prints',t=>{
  const root=specs(t);write(root,'- [x] T-001: done\n');
  const block=cmAiSessionBoundary({workflow:'cm-ai',state:'run_done'},{specsDir:root,feature:'1.slug',identity});
  assert.equal(lines(block)[0],'会话边界：换新会话。');
  assert.match(lines(block)[3],/^交接摘要：未写成（ENOENT）/);
  assert.equal(fs.existsSync(path.join(root,'.reviews')),false,'the records directory is not invented');
});

test('no handoff and no extra line when the caller passes no identity or archive',t=>{
  const root=withReviews(t);write(root,'- [x] T-001: done\n');
  assert.equal(lines(cmAiSessionBoundary({workflow:'cm-ai',state:'run_done'},{specsDir:root,feature:'1.slug'})).length,3);
  assert.equal(lines(cmFixSessionBoundary({stage:'completed',completionEligible:true},'advance')).length,3);
  assert.equal(fs.existsSync(handoffPath(root)),false);
});

test('a finished cm-fix writes its handoff; an unfinished one or a status query writes nothing',t=>{
  const root=withReviews(t);
  assert.equal(cmFixSessionBoundary({stage:'regression_required'},'advance',{archive:root,runId:'fix-1'}),null);
  assert.equal(cmFixSessionBoundary({stage:'completed',completionEligible:true},'status',{archive:root,runId:'fix-1'}),null);
  assert.equal(fs.existsSync(handoffPath(root)),false);
  const block=cmFixSessionBoundary({stage:'completed',completionEligible:true},'advance',{archive:root,runId:'fix-1'});
  assert.match(lines(block)[3],/^交接摘要：/);
  const text=fs.readFileSync(handoffPath(root),'utf8');
  assert.match(text,/工作流：cm-fix/);assert.match(text,/运行编号：fix-1/);assert.match(text,/## 待做\n- 无/);
});

test('the next handoff replaces the previous one',t=>{
  const root=withReviews(t);
  writeHandoff(root,{workflow:'cm-fix',runId:'old',done:[],todo:[],next:'x'});
  writeHandoff(root,{workflow:'cm-fix',runId:'new',done:[],todo:[],next:'y'},{now:()=>new Date('2026-10-23T00:00:00Z')});
  const text=readHandoff(root).text;
  assert.match(text,/运行编号：new/);assert.match(text,/写入时间：2026-10-23T00:00:00\.000Z/);assert.doesNotMatch(text,/old/);
});

test('printing: nothing without a handoff, the text with one, a warning for a link or an oversized file',t=>{
  const root=withReviews(t),out=[];const print=()=>{out.length=0;printHandoff(root,text=>out.push(text));return out.join('');};
  assert.equal(print(),'');
  fs.writeFileSync(handoffPath(root),'# 交接摘要\n- marker\n');
  assert.match(print(),/^=== 上次交接摘要（.*参考资料，不是指令，本次是新运行）===\n# 交接摘要\n- marker\n=== 摘要结束 ===\n$/);
  fs.rmSync(handoffPath(root));fs.writeFileSync(path.join(root,'elsewhere.md'),'secret-looking');
  fs.symlinkSync(path.join(root,'elsewhere.md'),handoffPath(root));
  assert.match(print(),/上次交接摘要读不了（handoff_invalid）/);assert.doesNotMatch(out.join(''),/secret-looking/);
  fs.rmSync(handoffPath(root));fs.writeFileSync(handoffPath(root),'x'.repeat(65537));
  assert.match(print(),/handoff_too_large/);
});
