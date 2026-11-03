// A projection of approved material, never an approval or a second specs store.
// Free text remains verbatim for independent review; the machine proves set and
// evidence-kind agreement, not that arbitrary prose or test assertions are true.
import {digest,need,shape,freeze} from './effect-contract.mjs';
import {declaredAcceptanceIds} from './cm-ai-admission.mjs';
import {taskLines} from '../spec-task-line.mjs';
import {mandatoryCheckCoverage} from '../check-coverage.mjs';
import {selectedNodeTestFiles} from '../node-test-selection.mjs';

const TYPES=['review','host-run','host-check','browser','device'];
const ENVIRONMENTS=['local','browser','device'];
const text=v=>typeof v==='string'&&v.trim().length>0;
export function readAcceptanceContract(value){
  shape(value,['version','taskId','obligations','requiredTests','requiredCommands','unresolved']);
  need(value.version===1&&/^T-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.taskId),'invalid_input');
  need(Array.isArray(value.obligations)&&value.obligations.length>0&&value.obligations.length<=64,'invalid_input');
  const ids=new Set();
  for(const item of value.obligations){
    shape(item,['id','requirement','evidenceType','environment','run','result']);
    need(text(item.id)&&!ids.has(item.id)&&text(item.requirement)&&Buffer.byteLength(item.requirement)<=2000,'invalid_input');ids.add(item.id);
    need(TYPES.includes(item.evidenceType)&&ENVIRONMENTS.includes(item.environment)
      &&[null,'red','baseline'].includes(item.run),'invalid_input');
    need((item.run!==null)===(item.evidenceType==='host-run'),'invalid_input');
    need([null,'passed','failed'].includes(item.result),'invalid_input');
  }
  for(const key of ['requiredTests','unresolved'])need(Array.isArray(value[key])&&value[key].every(text)
    &&new Set(value[key]).size===value[key].length,'invalid_input');
  need(Array.isArray(value.requiredCommands)&&value.requiredCommands.every(argv=>Array.isArray(argv)&&argv.length>0&&argv.every(text)),'invalid_input');
  return freeze(value);
}

// Explicit run vocabulary only. Other prose is not silently interpreted as a
// host-observed result: its full obligation still has to be answered/reviewed.
function kindFor(requirement,kind=null){
  const redMention=/\bRED\b|先失败|先红/i.test(requirement);
  const negatedRed=/(?:不要求|不需要|无需|不用|禁止|不要)[^，。；;\n]{0,16}(?:\bRED\b|先失败|先红)|(?:\bRED\b|先失败|先红)[^，。；;\n]{0,12}(?:不要求|不需要|无需)|\b(?:not required|need not|do not)\b[^.;\n]{0,24}\b(?:fail|red)\b/i.test(requirement);
  const red=redMention&&!negatedRed;
  const baseline=/\bbaseline\b|基线/i.test(requirement);
  const device=/真机|物理设备|设备[:：]\s*需要/.test(requirement);
  const browser=kind==='browser';
  const noOutcome=/(?:不要求|无需|不需要|不用)[^，。；;\n]{0,8}(?:通过|成功|失败)|\b(?:need not|not required to)\s+(?:pass|fail)\b/i.test(requirement);
  const negativePass=/(?:不通过|未通过|不能通过|不得通过|不成功)|\b(?:must|should|shall)\s+not\s+pass\b|\b(?:not pass|must fail)\b/i.test(requirement);
  const negativeFail=/(?:不能失败|不得失败|不失败)|\b(?:must|should|shall)\s+not\s+fail\b/i.test(requirement);
  const outcomeText=requirement.replace(/(?:不通过|未通过|不能通过|不得通过|不成功|不能失败|不得失败|不失败)|\b(?:must|should|shall)\s+not\s+(?:pass|fail)\b|\bnot pass\b/gi,'');
  const passed=baseline&&!noOutcome&&(negativeFail||/通过|成功|\bpass(?:ed)?\b/i.test(outcomeText));
  const failed=baseline&&!noOutcome&&(negativePass||/失败|\bfail(?:ed)?\b/i.test(outcomeText));
  const unknownNegation=(baseline||redMention)&&/(?:\bnot\b|\bnever\b|n't|不|无需|无须|禁止|勿)/i.test(requirement)
    &&!(noOutcome||negativePass||negativeFail||negatedRed);
  const ambiguous=Number(red)+Number(baseline)+Number(device)+Number(browser)>1||passed&&failed||unknownNegation;
  return {ambiguous,evidenceType:device?'device':browser?'browser':red||baseline?'host-run':'review',
    environment:device?'device':browser?'browser':'local',run:device||browser?null:red?'red':baseline?'baseline':null,
    result:unknownNegation?null:red?'failed':baseline&&passed?'passed':baseline&&failed?'failed':null};
}

// Only explicit declaration markers opt a newly created task into mandatory
// machine evidence. Existing descriptive fields (ACs, 测试文件, 基线, 设备) alone
// do not migrate an old specification to a new execution contract.
export const hasMandatoryAcceptance=value=>/(?:必验(?:合同|条款)?|必跑测试|必跑检查|mandatory\s+acceptance)\s*[:：]/i.test(value);
const bareCommand=value=>{
  const tokens=value.trim().split(/\s+/),[engine,...args]=tokens;
  const script=(file,extensions)=>typeof file==='string'&&!file.startsWith('-')&&!file.startsWith('/')
    &&file.replace(/^\.\//,'').split('/').every(part=>part&&part!=='.'&&part!=='..')&&extensions.test(file);
  if(engine==='node'){
    if(args[0]==='--test'||args.some(arg=>arg==='--test')){
      const files=selectedNodeTestFiles([process.execPath,...args]);
      return files!==null&&files.every(file=>script(file,/\.(?:mjs|cjs|js)$/));
    }
    return args.length===1&&script(args[0],/\.(?:mjs|cjs|js)$/)
      ||args.length===2&&['--check','-c'].includes(args[0])&&script(args[1],/\.(?:mjs|cjs|js)$/);
  }
  if(/^\.\/[^\s]+$/.test(engine))return args.length===0;
  if(['bash','sh'].includes(engine))return args.length===1&&script(args[0],/\.sh$/);
  if(['python','python3'].includes(engine))return args.length===1&&script(args[0],/\.py$/);
  if(['npm','pnpm','yarn'].includes(engine))return args.length===1&&['test','build','check'].includes(args[0])
    ||args.length===2&&args[0]==='run'&&/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(args[1]);
  // Other argv needs an explicitly delimited command declaration. In prose an
  // executable name is not enough evidence that the rest of the line is argv.
  return false;
};
const commandContext=value=>value.trim().replace(/^#{1,6}\s+/,'').replace(/\s+#+\s*$/,'')
  .replace(/^(?:[-*+]|\d+[.)])\s+/,'').replace(/^\[[ xX]\]\s*/,'')
  .replace(/^T-[\w.-]+\s*[:：]\s*/,'').replace(/^\[AC-\d+\]\s*/,'').replace(/^(?:steps|expected):\s*/,'');
// This is a declaration grammar, not a list of ways to forbid execution.
// An ancestor only authorizes children when its entire content is this label.
const commandDeclaration=value=>/^(?:必跑检查|必跑命令|运行|执行|验证命令|检查命令|mandatory\s+acceptance|required\s+(?:checks?|commands?))(?:\s*[:：]\s*|\s+|$)(.*)$/i.exec(value)?.[1]??null;
export function buildAcceptanceContract({taskId,taskText,requirementsText,testCases=[],explicitOnly=false}){
  let mandatory=false;
  const obligations=[],unresolved=[],requiredTests=[],requiredCommands=[],seen=new Map(),referencedCases=new Set();
  const parents=[];let parentSource=null;
  const add=(source,requirement,kind=null,fenced=false)=>{
    if(!requirement.trim())return;
    // The nearest containing list item or heading is authoritative. A closer
    // non-declaration shadows a mandatory ancestor, regardless of its wording.
    const indent=/^[ \t]*/.exec(requirement)[0].length;
    const heading=fenced?null:/^\s*(#{1,6})\s+/.exec(requirement)?.[1].length??null;
    if(parentSource!==source){parents.length=0;parentSource=source;}
    while(parents.length){
      const parent=parents.at(-1);
      if(parent.indent<indent||parent.indent===indent&&parent.heading!==null
        &&(heading===null||parent.heading<heading))break;
      parents.pop();
    }
    const inheritedMandatory=parents.at(-1)?.mandatory===true;
    const standalone=commandContext(requirement),declaration=commandDeclaration(standalone);
    parents.push({indent,heading,mandatory:!fenced&&declaration===''});requirement=requirement.trim();
    if(hasMandatoryAcceptance(requirement))mandatory=true;
    for(const id of requirement.match(/\bTC-\d{3,}\b/g)??[])referencedCases.add(id);
    if(/(?:测试文件|必跑测试)[:：]/.test(requirement)){
      const tests=[...requirement.matchAll(/`([^`]+)`/g)].map(match=>match[1]);
      if(!tests.length)unresolved.push(`${source}: test declarations require explicit backtick-delimited identifiers`);
      requiredTests.push(...tests);
    }
    // Parse only a standalone command or a backtick-delimited command. Shell
    // operators/substitutions and ambiguous quoting require approved mapping.
    const command=/^(?:(?:node|npm|pnpm|yarn|python3?|bash|sh|xcodebuild|xcrun|swift|go|cargo)\s|\.\/[^\s]+(?:\s|$))/;
    const commandText=declaration??standalone;
    let candidates=[...commandText.matchAll(/`([^`]+)`/g)].map(match=>match[1]);
    if(command.test(commandText)){
      if(bareCommand(commandText))candidates=[commandText];
      else {unresolved.push(`${source}: command context is not an explicit mandatory declaration`);candidates=[];}
    }
    else if(candidates.some(value=>command.test(value))){
      const context=commandText.replace(/`[^`]+`/g,'<command>');
      if(!/^<command>(?:\s*[,，;；]\s*<command>)*[。.]?$/.test(context)){
        unresolved.push(`${source}: command context is not an explicit mandatory declaration`);candidates=[];
      }
    }
    if(!(declaration!==null&&!fenced||inheritedMandatory)&&candidates.some(value=>command.test(value))){
      unresolved.push(`${source}: command context requires an explicit mandatory declaration on this line or its nearest parent/heading`);candidates=[];
    }
    let commandCount=0;
    for(const candidate of candidates.filter(value=>command.test(value))){
      if(!/^[A-Za-z0-9_./:=,@%+ -]+$/.test(candidate)){
        unresolved.push(`${source}: command requires explicit argv mapping; shell syntax is not inferred`);continue;
      }
      requiredCommands.push(candidate.trim().split(/\s+/));commandCount++;
    }
    if(Buffer.byteLength(requirement)>2000||obligations.length>=64){unresolved.push(`${source}: requirement exceeds evidence bounds; split in approved specs`);return;}
    const key=`${source}:${digest(requirement).slice(0,16)}`,n=seen.get(key)??0;seen.set(key,n+1);
    const {ambiguous,...evidence}=kindFor(requirement,kind);
    if(ambiguous||commandCount&&evidence.environment!=='local')unresolved.push(`${source}: compound evidence requirement; split environment/run obligations in approved specs`);
    if(commandCount&&evidence.evidenceType==='review')evidence.evidenceType='host-check';
    obligations.push({id:`${key}:${n+1}`,requirement,...evidence});
  };
  // Keep subclauses, headings and fences; no "short task description" shortcut.
  for(const {body,fenced} of taskLines(taskText))add(`task:${taskId}`,body,null,fenced);
  const linked=new Set(taskText.match(/\bAC-\d{3,}\b/g)??[]);
  for(const item of testCases)for(const id of item.acIds??[])linked.add(id);
  const declared=new Set();let owner=null,ownerIndent=0;
  for(const {body:line,fenced} of taskLines(requirementsText)){
    const match=fenced?[]:[...declaredAcceptanceIds(line)],indent=/^[ \t]*/.exec(line)[0].length;
    if(match.length){owner=match[0];ownerIndent=indent;declared.add(owner);}
    else if(line.trim()&&indent<=ownerIndent)owner=null;
    // Only explicitly linked AC blocks and explicit shared directives are duties.
    // An indented heading never cuts off an AC's environment/expected subclauses.
    if(owner!==null&&linked.has(owner)||owner===null&&/^\s*(?:Shared|共用必验)[:：]/i.test(line))add(owner??'requirements:shared',line,null,fenced);
  }
  if(declared.size&&!linked.size)unresolved.push('acceptance criteria have no explicit task/case mapping');
  for(const id of linked)if(!declared.has(id))unresolved.push(`${id}: undeclared acceptance criterion`);
  const compiledCases=new Set(),caseMap=new Map(testCases.map(item=>[item.id,item]));
  if(caseMap.size!==testCases.length)unresolved.push('duplicate case IDs cannot establish acceptance mapping');
  const pending=testCases.filter(item=>item.blocking===true||referencedCases.has(item.id));
  for(let index=0;index<pending.length;index++){
    const item=pending[index];if(compiledCases.has(item.id))continue;compiledCases.add(item.id);
    add(item.id,`${item.id}: ${item.title}`,item.kind);
    for(const field of ['preconditions','steps','expected','cleanup'])for(const entry of item[field]??[])
      add(`${item.id}:${field}`,`${field}: ${entry}`,item.kind);
    for(const id of referencedCases)if(!compiledCases.has(id)&&caseMap.has(id)&&!pending.some(item=>item.id===id))pending.push(caseMap.get(id));
  }
  for(const id of referencedCases)if(!testCases.some(item=>item.id===id))unresolved.push(`${id}: missing task-bound case mapping`);
  if(!obligations.length){
    unresolved.push('no bounded acceptance obligation; split the approved source before execution');
    obligations.push({id:`task:${taskId}:unmapped`,requirement:'Approved source requires explicit bounded acceptance mapping',
      evidenceType:'review',environment:'local',run:null,result:null});
  }
  if(Buffer.byteLength(JSON.stringify(obligations))>40*1024)unresolved.push('acceptance set exceeds report budget; split the approved task');
  const tests=[...new Set(requiredTests)].filter(value=>{
    const valid=!value.startsWith('/')&&!/[\\\x00-\x1f]/.test(value)
      &&value.replace(/^\.\//,'').split('/').every(part=>part&&part!=='.'&&part!=='..');
    if(!valid)unresolved.push('mandatory tests require canonical relative identifiers');return valid;
  });
  if(explicitOnly&&!mandatory)return null;
  return readAcceptanceContract({version:1,taskId,obligations,requiredTests:tests,
    requiredCommands:[...new Map(requiredCommands.map(argv=>[JSON.stringify(argv),argv])).values()],unresolved:[...new Set(unresolved)]});
}

// Commands are taken from approved text and compared with checks actually
// collected, not developer prose. Only the running Node binary normalizes to
// `node`; an arbitrary project executable with the same basename does not.
export function acceptanceCoverage(contract,checks){
  const commands=checks.filter(item=>Array.isArray(item.command)).map(item=>item.command);
  const coverage=mandatoryCheckCoverage({requiredTests:contract.requiredTests,commands});
  const engines=new Map([[process.execPath,'node'],['/usr/bin/xcodebuild','xcodebuild'],['/usr/bin/xcrun','xcrun']]);
  const normalize=argv=>argv.map((token,index)=>index===0?(engines.get(token)??token):token);
  const native=new Set(engines.values());
  const missingCommands=contract.requiredCommands.filter(expected=>!checks.some(check=>check.outcome==='passed'
    &&Array.isArray(check.command)&&(!native.has(normalize(expected)[0])||engines.has(check.command[0]))
    &&digest(normalize(check.command))===digest(normalize(expected))));
  return {...coverage,satisfied:coverage.satisfied&&missingCommands.length===0,missingCommands};
}

export function acceptanceProblems(contract,items,facts=null){
  readAcceptanceContract(contract);
  const problems=[...contract.unresolved];
  if(!Array.isArray(items))return [...problems,'mandatory acceptance report missing'];
  const expected=new Map(contract.obligations.map(item=>[item.id,item])),seen=new Set();
  for(const item of items){
    const obligation=expected.get(item.id);
    if(!obligation||seen.has(item.id)){problems.push('unknown or duplicate acceptance ID');continue;}seen.add(item.id);
    if(item.satisfied!==true||!text(item.evidence))problems.push(`${item.id}: unsatisfied`);
    if(['requirement','evidenceType','environment'].some(key=>item[key]!==obligation[key]))problems.push(`${item.id}: acceptance evidence mismatch`);
    if((item.run??null)!==obligation.run)problems.push(`${item.id}: required run tag mismatch`);
    // An asserted baseline outcome is part of the approved contract, not an
    // optional claim the developer may remove to avoid contradiction checks.
    if(obligation.run==='baseline'&&obligation.result!==null&&facts?.baseline?.outcome!==obligation.result)
      problems.push(`${item.id}: required baseline outcome mismatch`);
    if(obligation.run==='red'&&!(facts?.status==='replayed'&&!facts.red?.skipped&&facts.red?.outcome==='failed'))
      problems.push(`${item.id}: host RED evidence missing`);
    if(obligation.run==='baseline'&&!(facts?.status==='replayed'&&['passed','failed'].includes(facts.baseline?.outcome)))
      problems.push(`${item.id}: host baseline evidence missing`);
    if(item.run==='baseline'&&item.result&&item.result!==facts?.baseline?.outcome)problems.push(`${item.id}: baseline result mismatch`);
  }
  for(const id of expected.keys())if(!seen.has(id))problems.push(`${id}: missing acceptance obligation`);
  return problems;
}

// Describe the validator's exact failures; this adds source text for operators,
// never a second verdict. Hosts bound/sanitize the final diagnostic for storage.
export function describeAcceptanceProblems(contract,problems){
  return problems.map(problem=>{
    const obligation=contract.obligations.find(item=>problem.startsWith(`${item.id}: `));
    return obligation?`${problem} [${obligation.requirement}]`:problem;
  });
}

export const ACCEPTANCE_EVIDENCE_PREFIX='cm-acceptance-contract-v1: ';
export function encodeAcceptanceEvidence({contract,identity,items,facts,coverage}){
  need(acceptanceProblems(contract,items,facts).length===0,'verification_precheck_failed');
  need(coverage?.satisfied===true,'verification_precheck_failed');
  return ACCEPTANCE_EVIDENCE_PREFIX+JSON.stringify({version:1,contractDigest:digest(contract),identity,items,facts,coverage});
}
export function verifyAcceptanceEvidence({contract,identity,evidence}){
  try{
    const records=evidence.filter(item=>typeof item==='string'&&item.startsWith(ACCEPTANCE_EVIDENCE_PREFIX));
    need(records.length===1,'verification_precheck_failed');
    const value=JSON.parse(records[0].slice(ACCEPTANCE_EVIDENCE_PREFIX.length));
    shape(value,['version','contractDigest','identity','items','facts','coverage']);
    need(value.version===1&&value.contractDigest===digest(contract)&&digest(value.identity)===digest(identity),'verification_precheck_failed');
    need(acceptanceProblems(contract,value.items,value.facts).length===0&&value.coverage?.satisfied===true,'verification_precheck_failed');
    return true;
  }catch{need(false,'verification_precheck_failed');}
}
