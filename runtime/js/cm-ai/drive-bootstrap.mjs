// Single-task driver support for the approved bootstrap rules task (host-bootstrap.mjs).
// init_generate returns the current session's documents; they come from a
// per-attempt answer file, validated before the host starts.
// init_verify has two parts. globs/file_references/constraint_preservation/
// rule_applicability and Learning are the session's own report (the host marks
// it host verification, not Review), so they come from a per-attempt answer file.
// The commands group is execution evidence: only commands this driver really
// runs produce it; an answer file can list commands but never their results.
// They run after the host accepted the launch (host_ready: every launch input,
// admission, task selection and the run store) and before any operation is sent
// (prepare): a failure is refused before the develop effect exists, because any
// init_verify failure inside the host leaves it unknown with no in-run recovery
// (host-bootstrap.mjs run()). Static refusals reuse the host's own readers and
// admission functions, and every file the preflight bound is re-read afterwards.
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {createHostCheck} from './host-check.mjs';
import {inspectCmAiAdmission,inspectCmAiBootstrapTask,matchesCmAiTaskSelection} from './cm-ai-admission.mjs';
import {readBootstrapConfiguration,readConversationProtection} from '../../../scripts/cm-ai-host.mjs';
import {mergeBootstrapAgents} from './host-bootstrap.mjs';
import {createCmAiTaskLearningApplication,createCmAiTaskLearningRetrospective} from './cm-ai-context-refresh.mjs';
import {cmInitRuleTargets,validateCmInitSelection} from '../cm-init/draft-generation.mjs';
import {inspectCmInitDraft,readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {stop,readJson,planCheckTimeout} from './drive-core.mjs';
import {need} from './effect-contract.mjs';

const CATEGORIES=['commands','globs','file_references','constraint_preservation','rule_applicability'];
const REPORTED=CATEGORIES.slice(1);
// cm-ai-host.mjs uses createHostToolBridge() defaults: one host_result is at most 64 KiB.
const RESPONSE_LIMIT=64*1024;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
const oneLine=(value,limit)=>nonempty(value)&&Buffer.byteLength(value,'utf8')<=limit&&!/[\r\n\0]/.test(value);
const refuse=(ok,line)=>{if(!ok)stop(2,line);};
const envelope=result=>Buffer.byteLength(JSON.stringify({type:'host_result',sessionId:'0'.repeat(36),
  callId:'0'.repeat(36),requestDigest:'0'.repeat(64),result}),'utf8');
const learningSection=source=>/^## 项目教训[ \t]*\r?$/gmu.test(source);
const sha=bytes=>bytes===null?null:createHash('sha256').update(bytes).digest('hex');

export function attemptAnswerName(root,name,attempt){
  if(attempt!==1)return `${name}-a${attempt}.json`;
  const legacy=fs.existsSync(path.join(root,`${name}.json`)),named=fs.existsSync(path.join(root,`${name}-a1.json`));
  if(legacy&&named)stop(2,`${name}.json 与 ${name}-a1.json 不能同时存在`);
  return named?`${name}-a1.json`:`${name}.json`;
}

// Returns {mode,gap}; gap is a refusal for a bootstrap case this driver does not support.
export function inspectDriverBootstrap({advance,definition,permissions}){
  if(!advance||!permissions.includes('--bootstrap-config'))return {mode:null,gap:null};
  let task;
  try{task=inspectCmAiBootstrapTask({specsDir:definition.specsDir,codeProject:definition.codeProject,
    taskId:definition.identity.taskId},true);}catch(error){
    return {mode:null,gap:`bootstrap 任务预检失败: ${error.code??'bootstrap_task_required'}；宿主未启动`};
  }
  if(task.mode!=='instructions')return {mode:task.mode,gap:null};
  const gap=line=>({mode:'instructions',gap:`${line}；可由当前 AI 会话用 cm-ai-host.mjs serve 应答 init_generate/init_verify`});
  if(permissions.includes('--protected-config'))return gap('规范任务不支持 --protected-config（provider 开发）驾驶');
  if(Object.hasOwn(definition,'codeProjects'))return gap('多代码根（codeProjects）规范任务驾驶员尚不支持');
  let selection;
  // The host's own reader: a regular, non-symlink file of at most 64 KiB with only selection.
  try{selection=validateCmInitSelection(readBootstrapConfiguration(permissions[permissions.indexOf('--bootstrap-config')+1]).selection);}
  catch(error){return {mode:'instructions',gap:`bootstrap-config 无效或缺少有效的 cm-init selection: ${error.code??error.message}；宿主未启动`};}
  const instructionPaths=cmInitRuleTargets(selection);
  const missing=instructionPaths.filter(file=>!definition.scope.includes(file));
  if(missing.length)return {mode:'instructions',gap:`规范任务 scope 缺少固定目标 ${missing.join(', ')}；宿主会以 bootstrap_scope_required 拒绝启动`};
  const business=definition.scope.filter(file=>!instructionPaths.includes(file));
  if(business.length)return gap(`规范任务 scope 含业务文件 ${business.join(', ')}：驾驶员只支持纯规范 scope，业务文件请拆成独立任务`);
  return {mode:'instructions',gap:null,selection,targets:cmInitRuleTargets(selection,definition.codeProject)};
}

function contentOf(root,local,label){
  refuse(nonempty(local)&&!path.isAbsolute(local)&&!local.split(/[\\/]/).includes('..'),`答案格式错误：${label} 路径无效`);
  const file=path.join(root,local);
  refuse(fs.existsSync(file)&&fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink()
    &&fs.realpathSync(file).startsWith(fs.realpathSync(root)+path.sep),`答案格式错误：${label} 缺少安全的内容文件 ${file}`);
  try{return new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(file));}
  catch{return stop(2,`答案格式错误：${label} 不是 UTF-8 文本 ${file}`);}
}
function inspected(project,documents,selection,label){
  let inspection;
  try{inspection=inspectCmInitDraft({project,documents,selection});}
  catch(error){stop(2,`${label} 无效: ${error.code??error.message}`);}
  refuse(inspection.status==='structurally_checked',
    `${label} 结构检查未通过: ${inspection.issues.map(issue=>`${issue.path}:${issue.code}`).join(', ')}`);
}
// Same decoding as host-bootstrap.mjs run(); throws on an unsafe path.
const agentsBefore=project=>readCmInitSource(project,'AGENTS.md')?.toString('utf8')??'';
function readTarget(project,file){
  try{return readCmInitSource(project,file);}
  catch(error){return stop(2,`无法安全读取当前 ${file}: ${error.code??error.message}`);}
}
// Host order: generateCmInitDraft inspects the raw documents, then AGENTS.md is
// merged with the current file and inspected again (host-bootstrap.mjs run()).
function readGenerate(root,name,{definition,bootstrap,learning}){
  const value=readJson(path.join(root,name),name);
  refuse(object(value)&&Object.keys(value).sort().join()==='documents,status',`答案格式错误：${name} 只允许 status 与 documents`);
  refuse(value.status==='generated',`答案格式错误：${name}.status 只能是 generated；无法生成时不要启动驾驶员，先报告缺口（宿主把 blocked 记为 unknown 开发步骤）`);
  const {targets}=bootstrap;
  refuse(Array.isArray(value.documents)&&value.documents.length===targets.length
    &&new Set(value.documents.map(item=>item?.path)).size===targets.length
    &&value.documents.every(item=>object(item)&&Object.keys(item).sort().join()==='contentFile,path'&&targets.includes(item.path)),
  `答案格式错误：${name}.documents 须逐项覆盖 targets（每项只有 path/contentFile）: ${targets.join(', ')}`);
  const documents=targets.map(file=>({path:file,content:contentOf(root,
    value.documents.find(item=>item.path===file).contentFile,`${name} ${file}`)}));
  inspected(definition.codeProject,documents,bootstrap.selection,name);
  refuse(envelope({status:'generated',documents})<=RESPONSE_LIMIT,
    `${name} 的正文合计超过宿主单次回复 64 KiB 上限；精简规范正文，不要截断`);
  // Same expectations as host-bootstrap.mjs run(): files this run already wrote are
  // bound to the journal's recorded evidence (revision or same-attempt retry);
  // without it only an AGENTS.md carrying a Learning section may pre-exist.
  const project=definition.codeProject,prior=learning?.bootstrap??null,writeback=learning?.writeback??null;
  for(const file of targets){
    const bytes=readTarget(project,file);
    if(prior===null)refuse(bytes===null||file==='AGENTS.md'&&learningSection(bytes.toString('utf8')),
      `规范目标已存在: ${file}；本运行尚未写入规范，只允许带「## 项目教训」段的 AGENTS.md，宿主不覆盖已有规则（bootstrap_instruction_conflict）`);
    else{
      const expected=file==='AGENTS.md'&&writeback?.outcome==='written'?writeback.agentsFile.sha256
        :prior.files.find(item=>item.path===file)?.afterSha256??null;
      refuse(sha(bytes)===expected,`规范目标 ${file} 与本运行已记录的写入不一致（期望 ${expected??'不存在'}，当前 ${sha(bytes)??'不存在'}）；`
        +'宿主会以 bootstrap_instruction_conflict 停在 unknown，先还原该文件');
    }
  }
  const existing=readTarget(project,'AGENTS.md')?.toString('utf8')??'';
  let merged;
  try{merged=mergeBootstrapAgents(existing,documents.find(item=>item.path==='AGENTS.md').content);}
  catch{stop(2,`${name} 的 AGENTS.md 必须逐字保留当前 AGENTS.md 中「## 项目教训」段以外的全部内容（宿主只把该段按原字节合入）；否则宿主以 bootstrap_instruction_conflict 停在 unknown`);}
  inspected(project,documents.map(item=>item.path==='AGENTS.md'?{path:item.path,content:merged}:item),
    bootstrap.selection,`${name}（合入当前 AGENTS.md 后）`);
  return documents;
}
function readVerify(root,name,{definition,plan,attempt}){
  const value=readJson(path.join(root,name),name);
  refuse(object(value),`答案格式错误：${name}`);
  refuse(!(object(value.checks)&&Object.hasOwn(value.checks,'commands')),
    `答案格式错误：${name}.checks 不能包含 commands；命令核验只由驾驶员实跑 ${name}.commands 得出，答案文件不能提供执行结果`);
  const keys=['commands','checks','constraintChanges','application','retrospective'];
  refuse(Object.keys(value).every(key=>[...keys,'commandsNotRun'].includes(key))&&keys.every(key=>Object.hasOwn(value,key)),
    `答案格式错误：${name} 需要 ${keys.join('、')}（可选 commandsNotRun）`);
  refuse(Array.isArray(value.commands)&&value.commands.length>0&&value.commands.length<=32,
    `答案格式错误：${name}.commands 须列出 1..32 条草稿里可安全实跑的命令 {id,command,timeoutMs?}；驾驶员不接受没有实跑的命令核验`);
  try{
    for(const item of value.commands){
      if(!object(item)||Object.keys(item).some(key=>!['id','command','timeoutMs'].includes(key)))throw Error('每项只允许 id、command、timeoutMs');
      planCheckTimeout(plan,item);
    }
    createHostCheck({cwd:definition.codeProject,commands:value.commands.map(({id,command})=>({id,command}))});
  }catch(error){stop(2,`答案格式错误：${name}.commands ${error.code??error.message}`);}
  refuse(value.commandsNotRun===undefined||value.commandsNotRun===null||oneLine(value.commandsNotRun,2048),
    `答案格式错误：${name}.commandsNotRun 须为 null 或单行说明（最多 2048 UTF-8 字节）`);
  refuse(object(value.checks)&&Object.keys(value.checks).sort().join()===[...REPORTED].sort().join(),
    `答案格式错误：${name}.checks 须恰好包含 ${REPORTED.join('、')}`);
  for(const category of REPORTED){
    const check=value.checks[category];
    refuse(object(check)&&Object.keys(check).sort().join()==='evidence,status'&&nonempty(check.evidence)
      &&Buffer.byteLength(check.evidence,'utf8')<=4096,`答案格式错误：${name}.checks.${category} 须为 {status,evidence}，evidence 非空且最多 4096 UTF-8 字节`);
    refuse(['verified','not_applicable'].includes(check.status),
      `${name}.checks.${category} 为 ${check.status}：宿主只接受 verified/not_applicable，未核验项会让开发步骤停在 unknown；先修正草稿或补齐证据`);
  }
  refuse(Array.isArray(value.constraintChanges)&&value.constraintChanges.length===0,
    `${name}.constraintChanges 必须为空：规范任务不支持改写既有约束的确认，宿主会以 bootstrap_constraint_confirmation_required 停在 unknown`);
  // The host binds feature/identity/learningDigest itself; the answer carries only the original fields.
  const binding={feature:definition.feature,identity:{...definition.identity,attempt},learningDigest:'0'.repeat(64)};
  const fields=(item,keys)=>object(item)&&Object.keys(item).sort().join()===keys;
  try{need(fields(value.application,'note,status'));createCmAiTaskLearningApplication({...binding,...value.application});}
  catch{stop(2,`答案格式错误：${name}.application 须为原 Learning 的 {status,note}`);}
  try{need(fields(value.retrospective,'candidates,reason,status'));createCmAiTaskLearningRetrospective({...binding,...value.retrospective});}
  catch{stop(2,`答案格式错误：${name}.retrospective 须为原 Learning 的 {status,candidates,reason}`);}
  return value;
}

// Only the attempt that starts from today's disk and journal is accepted. An
// advance that could review and then revise in one go is refused: the revision
// must answer findings that do not exist yet, and its commands would run before
// attempt 1 even writes.
// Early refusals with the host's own functions. The host checks the write grant
// only when the develop effect starts, and the task entry inside it
// (host-bootstrap.mjs run()), so both are required here; everything else the host
// checks at launch runs before host_ready, before any command.
function authorizeRulesLaunch({definition,plan,permissions}){
  const refusal='；驾驶员不运行 init-verify 命令、不启动宿主';
  refuse(permissions.includes('--allow-bootstrap-write'),
    `规范任务需要 --allow-bootstrap-write：宿主写规范前要求这一授权（bootstrap_write_authorization_required）${refusal}`);
  const protection=permissions.indexOf('--protected-conversation-config');
  if(protection!==-1)try{readConversationProtection(permissions[protection+1]);}
  catch(error){stop(2,`--protected-conversation-config 无效: ${error.code??error.message}（宿主以同一读取器拒绝启动）${refusal}`);}
  const where={specsDir:definition.specsDir,codeProject:definition.codeProject};
  if(plan.mode==='create'){
    // openControlRun: a new run needs a ready admission that selects this task.
    const admission=inspectCmAiAdmission(where);
    refuse(admission.state==='ready'&&matchesCmAiTaskSelection(admission,definition.feature,definition.identity.taskId,
      definition.taskSelection??null),`${definition.identity.taskId} 现在不能新建运行：admission ${admission.state}，`
      +`nextTask ${admission.nextTask?.id??'无'}（宿主以 task_selection_mismatch 等拒绝）${refusal}`);
  }
  // host-bootstrap.mjs run(): the rules effect only enters the admitted next task.
  let entry;
  try{entry=inspectCmAiBootstrapTask({...where,taskId:definition.identity.taskId}).admission.nextTask;}
  catch(error){return stop(2,`bootstrap 任务预检失败: ${error.code??error.message}${refusal}`);}
  refuse(entry?.feature===definition.feature&&entry.id===definition.identity.taskId,
    `${definition.identity.taskId} 不是当前可进入的 bootstrap 任务（nextTask ${entry?.id??'无'}，宿主以 bootstrap_task_required 拒绝）${refusal}`);
}

export function readBootstrapRulesAnswers({answers,operation,definition,plan,permissions,bootstrap,reachable}){
  const result=new Map(),slug=`.reviews/${definition.feature.replace(/^\d+\./,'')}-${definition.identity.taskId}`;
  const pair=attempt=>`answers/init-generate-a${attempt}.json 与 answers/init-verify-a${attempt}.json`;
  if(reachable.reviewAfterDevelop)
    stop(2,`规范任务的 advance 不能带 --allow-review-attempt 1 直接进入第 2 轮：修订答案须在读取首轮审查 findings 之后编写。请从 PLAN.permissions 移除 --allow-review-attempt 1，先 advance 到 awaiting_review；再用返回的 packageDigest 执行 decision，读取 ${slug}-r1.md 的 findings；若要求修改，写 ${pair(2)} 后 advance。`);
  if(reachable.reviewFirst)
    stop(2,`规范修订答案须在读取首轮审查 findings 之后编写：请先以 decision 和当前 packageDigest ${reachable.packageDigest} 单独运行审查，读取 ${slug}-r1.md 的 findings，写 ${pair(2)} 后再 advance（不要带 --allow-review-attempt 1 advance）`);
  if(reachable.attempts.length)authorizeRulesLaunch({definition,plan,permissions});
  for(const attempt of reachable.attempts){
    const names=['init-generate','init-verify'].map(name=>attemptAnswerName(answers??'',name,attempt));
    for(const name of names){
      const file=path.join(answers??'',name);
      if(answers&&fs.existsSync(file))continue;
      if(attempt>1)stop(2,`步骤 ${operation} 会进入第 ${attempt} 轮规范修订，但答案文件不存在: ${file}；读取 ${slug}-r${attempt-1}.md 的 findings 后写 ${pair(attempt)}（不会复用第 1 轮答案）`);
      stop(2,`步骤 ${operation} 会反问 ${name.startsWith('init-generate')?'init_generate':'init_verify'}，但答案文件不存在: ${file}`);
    }
    result.set(attempt,{generate:readGenerate(answers,names[0],{definition,bootstrap,learning:reachable.learning}),
      verify:readVerify(answers,names[1],{definition,plan,attempt}),verifyName:names[1]});
  }
  return result;
}

const documentMap=documents=>new Map(documents.map(item=>[item.path,item.content]));
// Everything the preflight validated or the host re-reads at launch: the fixed
// targets, the run definition and permission files, and the approved bootstrap specs.
function boundFiles({definition,bootstrap,watch}){
  const state=new Map(),mark=error=>`unreadable:${error.code??'error'}`;
  for(const file of bootstrap.targets){
    try{state.set(file,sha(readCmInitSource(definition.codeProject,file)));}catch(error){state.set(file,mark(error));}
  }
  const specs=['requirements.md','design.md','tasks.md'].map(name=>path.join(definition.specsDir,definition.feature,name));
  for(const file of [...watch,...specs,path.join(definition.specsDir,'.cm-specs-status')]){
    try{state.set(file,sha(fs.readFileSync(file)));}catch(error){state.set(file,error.code==='ENOENT'?null:mark(error));}
  }
  return state;
}
export function createBootstrapRulesResponder({definition,plan,bootstrap,answers,specsRoot=null,watch=[]}){
  let generated=null;const executed=new Map();
  // Bound at preflight time: a change before the host opened or during the commands both count.
  const before=boundFiles({definition,bootstrap,watch});
  const recovery=mode=>mode==='create'
    ?'宿主已按 create 建好运行（ready，未执行开发步骤）；修正后把 PLAN.mode 改为 resume 重试'
    :'运行存档不变；修正后原样重试';
  return {
    // Returns null when every listed command passed and left the bound files
    // unchanged, otherwise the refusal line.
    async prepare(mode='resume'){
      for(const [attempt,entry] of answers){
        const results=[],at=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
        for(const command of entry.verify.commands){
          const run=createHostCheck({cwd:definition.codeProject,commands:[{id:command.id,command:command.command}],
            timeoutMs:planCheckTimeout(plan,command),...(specsRoot===null?{}:{specsRoot}),
            onOutput:({stream,chunk})=>{process.stderr.write(`[drive init_verify ${command.id} ${stream}] ${chunk.toString('utf8')}`);}});
          const [item]=await run({identity:{...definition.identity,attempt}},{signal:new AbortController().signal});
          results.push(item);
          if(item.outcome!=='passed')break;
        }
        const passed=results.length===entry.verify.commands.length&&results.every(item=>item.outcome==='passed');
        const lines=results.map(item=>`${item.id}: ${item.outcome}（${item.evidence}）`);
        if(results.length<entry.verify.commands.length)
          lines.push(`未运行（前一条未通过）: ${entry.verify.commands.slice(results.length).map(item=>item.id).join(', ')}`);
        executed.set(attempt,{passed,lines,at,total:entry.verify.commands.length,ran:results.length});
        if(!passed)return `${entry.verifyName} 的命令在发送操作前实跑未通过：${lines.join('；')}。未发送操作，${recovery(mode)}（修正项目或草稿及答案）`;
      }
      const after=boundFiles({definition,bootstrap,watch});
      const changed=[...before.keys()].filter(file=>before.get(file)!==after.get(file));
      if(changed.length)return `预检已核对的文件在发送操作前被改动: ${changed.join(', ')}；未发送操作（否则宿主会以 bootstrap_instruction_conflict 等停在 unknown），`
        +`${recovery(mode)}。init-verify 命令须只读核验，还原这些文件后重试`;
      return null;
    },
    init_generate(row){
      const payload=row.payload,attempt=payload?.bootstrap?.identity?.attempt,entry=answers.get(attempt);
      if(!entry)throw Error(`init_generate 第 ${attempt} 轮未预检，拒绝复用其他轮答案`);
      if(payload.project!==definition.codeProject)throw Error('init_generate 项目根与运行定义不一致');
      if(!isDeepStrictEqual(payload.selection,bootstrap.selection))throw Error('init_generate selection 与 bootstrap-config 不一致');
      if(!isDeepStrictEqual([...payload.targets].sort(),[...bootstrap.targets].sort()))
        throw Error(`init_generate targets 与预检不一致: ${payload.targets.join(', ')}`);
      generated={attempt,documents:entry.generate};
      return {status:'generated',documents:entry.generate.map(({path:file,content})=>({path:file,content}))};
    },
    async init_verify(row){
      const payload=row.payload;
      if(generated===null)throw Error('本驾驶员尚未应答对应的 init_generate，拒绝核验未知草稿');
      const {attempt,documents}=generated;generated=null;
      const identity=payload.learningInput?.identity;
      if(identity?.attempt!==attempt)throw Error('init_verify 轮次与刚应答的 init_generate 不一致');
      if(payload.project!==definition.codeProject)throw Error('init_verify 项目根与运行定义不一致');
      if(!isDeepStrictEqual(payload.categories,CATEGORIES))throw Error('init_verify 核验分组与合同不一致');
      // The host verifies the final documents: current AGENTS.md lessons are merged in.
      const expected=documents.map(item=>item.path==='AGENTS.md'
        ?{path:item.path,content:mergeBootstrapAgents(agentsBefore(definition.codeProject),item.content)}:item);
      if(!Array.isArray(payload.documents)||!isDeepStrictEqual(documentMap(payload.documents),documentMap(expected)))
        throw Error('宿主核验的草稿与 init-generate 答案（含合入的项目教训段）不一致');
      const answer=answers.get(attempt).verify,run=executed.get(attempt);
      if(!run)throw Error('init_verify 的命令尚未由本驾驶员实跑，拒绝应答');
      const evidence=`驾驶员在发送本操作前实跑 ${run.ran}/${run.total} 条草稿命令（${run.at}）: ${run.lines.join('；')}`
        +(nonempty(answer.commandsNotRun)?`。未实跑（会话核对说明，不是执行证据）: ${answer.commandsNotRun}`:'');
      return {checks:{...answer.checks,commands:{status:run.passed?'verified':'failed',evidence}},
        constraintChanges:[],application:answer.application,retrospective:answer.retrospective};
    },
  };
}
