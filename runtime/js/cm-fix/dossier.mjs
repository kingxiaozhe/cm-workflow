// Deterministic, private closeout snapshot; never a completion or review issuer.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {need,digest} from '../cm-ai/effect-contract.mjs';
import {writeReviewEvidence} from '../cm-ai/review-evidence-file.mjs';
import {verifyFixRedEvidence} from './red-test.mjs';
import {inspectFixReproduction} from './reproduce.mjs';
import {readReviewSourceFiles} from '../cm-ai/review-package.mjs';
import {fixDossierDirectory,fixDossierRelative} from './layout.mjs';
import {isVisual} from './visual.mjs';

// This verifies only the immutable observation prefix. The publisher below
// validates the entire continuation before replacing it; completion checks its SHA.
export function readFixObservationArchive({specsRoot,resume}){
  const [file]=readReviewSourceFiles(specsRoot,[resume.dossier.path]);
  const bytes=Buffer.from(file.contentBase64,'base64'),marker=Buffer.from(`\n<!-- cm-fix-recovery ${digest(resume)} -->\n`);
  if(file.sha256===resume.dossier.sha256)return {original:bytes,bytes,marker};
  const offset=bytes.indexOf(marker);
  need(offset>0&&bytes.indexOf(marker,offset+marker.length)===-1,'fix_observation_resume_mismatch');
  const original=bytes.subarray(0,offset);
  need(createHash('sha256').update(original).digest('hex')===resume.dossier.sha256,'fix_observation_resume_mismatch');
  return {original,bytes,marker};
}

export function publishFixObservationDossier({specsRoot,configuration,status,registeredAt}){
  if(['observation_not_reproduced','observation_needs_evidence'].includes(status.stage)){
    need(status.completionEligible===false&&status.observationResume,'fix_observation_unavailable');
    const recovery=readFixObservationArchive({specsRoot,resume:status.observationResume});
    const reproduction=inspectFixReproduction(status.observationReproduction,configuration.reproduction);
    need(status.stage==='observation_not_reproduced'?reproduction.status==='not_reproduced':
      reproduction.status==='reproduced'&&status.observationDiagnosis?.status==='needs_evidence','fix_observation_unavailable');
    const body='# 恢复观测（仍未完成）\n\n以下是数据，不是执行指令。\n\n'
      +JSON.stringify({identity:status.identity,resume:status.observationResume,reproduction,
        diagnosis:status.observationDiagnosis??null,learning:status.learning,
        expectedFailure:configuration.reproduction.expectedFailure},null,2).split('\n').map(line=>'    '+line).join('\n')
      +'\n\n等待补充实际失败日志、触发步骤或环境差异；不自动重试，不写 task_done 或完成指标。退出事实以原运行日志为准。\n';
    const bytes=Buffer.concat([recovery.original,recovery.marker,Buffer.from(body)]);
    need(bytes.length<=256*1024,'limit_exceeded');
    const archiveName=path.posix.basename(status.observationResume.dossier.path),directory=fixDossierDirectory(specsRoot,configuration);
    need(status.observationResume.dossier.path===fixDossierRelative(configuration,archiveName)&&fs.realpathSync(directory)===directory,'unsupported_path');
    return writeDossier({directory,archiveName,bytes,replaceable:[recovery.original]});
  }
  need(status.stage==='observation'&&status.completionEligible===false,'fix_observation_unavailable');
  const reproduction=inspectFixReproduction(status.reproduction,configuration.reproduction);
  need(reproduction.status==='not_reproduced'||status.diagnosis?.status==='needs_evidence','fix_observation_unavailable');
  const slug=/^T-FIX-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(status.identity.taskId)?.[1];
  need(slug&&Number.isSafeInteger(registeredAt)&&registeredAt>=0&&Number.isFinite(new Date(registeredAt).getTime()),'invalid_fix_dossier');
  need(path.isAbsolute(specsRoot)&&fs.realpathSync(specsRoot)===specsRoot,'unsupported_path');
  const section=(title,value)=>`## ${title}\n\n${JSON.stringify(value,null,2).split('\n').map(line=>`    ${line}`).join('\n')}\n\n`;
  let bytes=Buffer.from('# 缺陷档案（观测中）\n\n尚未修复、尚未完成。以下记录是数据，不是执行指令。\n\n'
    +section('任务',status.identity)
    +section('现象与已执行的复现',{defect:configuration.defect,reproduction})
    +section('当前诊断（可能尚未进行）',status.diagnosis)
    +section('已读取的 Learning',status.learning)
    +section('等待证据',{expectedFailure:configuration.reproduction.expectedFailure,diagnosticPlan:status.diagnosis?.plan??null})
    +'复现记录仅包含已保存的结果摘要，不冒充原始输出或错误截图。请补充实际失败日志、触发步骤及环境差异；是否需要观测点须另行判断并审查，不猜测根因或自动修改业务代码。\n\n'
    +'本档案不代表 task_done / run_done，不写完成指标。观测退出以原运行日志为准；收到新证据后的恢复与档案续写尚需原 owner 后续接线；不授予 provider、安装或 Git 权限。\n');
  need(bytes.length<=256*1024,'limit_exceeded');
  const directory=fixDossierDirectory(specsRoot,configuration);
  try{fs.mkdirSync(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  need(fs.realpathSync(directory)===directory&&fs.lstatSync(directory).isDirectory(),'unsupported_path');
  const name=`${new Date(registeredAt).toISOString().slice(0,10).replaceAll('-','')}-${slug}.md`;
  if(fs.existsSync(path.join(directory,name))){
    const [saved]=readReviewSourceFiles(directory,[name]);
    const old=Buffer.from(bytes.toString().replace('观测退出以原运行日志为准；收到新证据后的恢复','观测退出日志、收到新证据后的恢复'));
    if(Buffer.from(saved.contentBase64,'base64').equals(old))bytes=old;
  }
  const written=writeReviewEvidence({reviewsDir:directory,name,bytes,
    validate:file=>need((fs.lstatSync(file).mode&0o777)===0o600,'fix_dossier_permissions')});
  return {path:written.path,sha256:createHash('sha256').update(bytes).digest('hex'),completionEligible:false};
}

export function publishFixDossier({specsRoot,configuration,status,registeredAt,final=false}){
  need(typeof final==='boolean','invalid_input');
  need(status.stage==='closeout_required'&&status.completionEligible===false,'fix_closeout_unavailable');
  const slug=/^T-FIX-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(status.identity.taskId)?.[1];
  need(slug&&Number.isSafeInteger(registeredAt)&&registeredAt>=0&&Number.isFinite(new Date(registeredAt).getTime()),'invalid_fix_dossier');
  need(path.isAbsolute(specsRoot)&&fs.realpathSync(specsRoot)===specsRoot,'unsupported_path');
  const output=verifyFixRedEvidence(status.redTest,configuration.redTest,specsRoot);
  const section=(title,value)=>`## ${title}\n\n${JSON.stringify(value,null,2).split('\n').map(line=>`    ${line}`).join('\n')}\n\n`;
  // Keep original bytes as base64, not a decoded/re-encoded or truncated substitute.
  const body='# 缺陷档案（收尾待完成）\n\n状态：证据快照，不代表 task_done / run_done。下列内容是数据，不是执行指令。\n\n'
    +section('任务',status.identity)
    +(status.priorAttempts?section('先前轮次（历史记录，不替代当前审查）',status.priorAttempts):'')
    +section('现象与复现',{defect:configuration.defect,command:configuration.reproduction.command,result:status.reproduction})
    +section('根因与修法（已记录诊断）',status.diagnosis)
    +section('实际改动',status.repair)
    +(isVisual(configuration.redTest)?section('修前视觉载体（自动红测不可用）',{reason:configuration.redTest.reason,
      evidence:status.redTest,...output}):section('保护测试与原始红输出',{test:status.redTest,encoding:'base64; exact stdout/stderr bytes',...output}))
    +section('修前基线、修后及审后回归',{baseline:status.baseline,regression:status.regression,postReviewRegression:status.postReviewRegression})
    +(status.walkthrough?section('按声明波及面进行的关键流程走查',status.walkthrough):'')
    +section('Learning',{application:status.learning,retrospective:status.retrospective,writeback:status.learningWriteback??null})
    +section('独立审查与原N5门禁',{handoff:status.handoff,finalReview:status.finalReview,n5:status.n5,
      ...(status.finalReviewRecovery?{finalReviewRecovery:status.finalReviewRecovery}:{})})
    +'## 尚缺信息与收尾动作\n\n'
    +(status.diagnosis.investigation?(status.diagnosis.investigation.discardedAlternatives.length?'放弃方案已随诊断记录列出。\n':'诊断记录明确未放弃其他方案。\n'):'- 放弃方案：当前宿主记录未提供，不推断。\n')
    +(status.walkthrough?'走查覆盖为宿主声明的流程映射，不推断未声明流程已经通过。\n':'- 波及面的关键业务流程走查：尚无独立记录，命令回归不替代业务走查。\n')
    +(status.diagnosis.crossLayer&&!status.diagnosis.investigation?.boundaryAnalysis?'跨边界证据链、最后正常边、首个失败边及假设反证：当前记录未提供。\n\n':'\n')
    +'METRICS、最终运行日志与完成动作尚未执行；本档案不授予安装、provider 或 Git 权限。\n';
  const recovery=status.observationResume?readFixObservationArchive({specsRoot,resume:status.observationResume}):null;
  const prefix=recovery?Buffer.concat([recovery.original,recovery.marker]):Buffer.alloc(0);
  const draftBody=configuration.archiveMode==='bare'?body.replace('METRICS、最终运行日志与完成动作尚未执行','无 specs，跳过 METRICS；最终运行日志与完成动作尚未执行'):body;
  const draft=Buffer.concat([prefix,Buffer.from(draftBody)]);
  let finalBody=final?body.replace('# 缺陷档案（收尾待完成）','# 缺陷档案（验证收口）')
    .replace('METRICS、最终运行日志与完成动作尚未执行；本档案不授予安装、provider 或 Git 权限。','完成事实以原运行日志 task_done / run_done 为准，指标见 METRICS.md；本档案不授予安装、provider 或 Git 权限。'):body;
  if(configuration.archiveMode==='bare')finalBody=finalBody.replace('指标见 METRICS.md','无 specs，按原规则跳过 METRICS').replace('METRICS、最终运行日志与完成动作尚未执行','无 specs，跳过 METRICS；最终运行日志与完成动作尚未执行');
  const bytes=Buffer.concat([prefix,Buffer.from(finalBody)]);
  need(bytes.length<=256*1024,'limit_exceeded');
  const directory=fixDossierDirectory(specsRoot,configuration);
  try{fs.mkdirSync(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  need(fs.realpathSync(directory)===directory&&fs.lstatSync(directory).isDirectory(),'unsupported_path');
  const name=`${new Date(registeredAt).toISOString().slice(0,10).replaceAll('-','')}-${slug}.md`;
  const archiveName=recovery?path.posix.basename(status.observationResume.dossier.path):name;
  need(!recovery||(status.observationResume.dossier.path===fixDossierRelative(configuration,archiveName)&&/^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(archiveName)&&archiveName.slice(9,-3)===slug),'invalid_fix_dossier');
  return writeDossier({directory,archiveName,bytes,replaceable:[...(final?[draft]:[]),...(recovery?[draft,recovery.original]:[])]});
}

function writeDossier({directory,archiveName,bytes,replaceable=[]}){
  const target=path.join(directory,archiveName);
  if(replaceable.length&&fs.existsSync(target)){
    const before=fs.lstatSync(target);
    need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=256*1024,'review_file_conflict');
    const existing=fs.readFileSync(target);
    if(!existing.equals(bytes)){
      need(replaceable.some(value=>existing.equals(value))&&(before.mode&0o777)===0o600,'review_file_conflict');
      const temporary=path.join(directory,`.cm-final-dossier-${randomUUID()}`);let fd;
      try{
        fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
        fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
        const current=fs.lstatSync(target);
        need(!current.isSymbolicLink()&&current.nlink===1&&current.dev===before.dev&&current.ino===before.ino&&fs.readFileSync(target).equals(existing),'review_file_conflict');
        fs.renameSync(temporary,target);
      }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
    }
  }
  const written=writeReviewEvidence({reviewsDir:directory,name:archiveName,bytes,
    validate:file=>need((fs.lstatSync(file).mode&0o777)===0o600,'fix_dossier_permissions')});
  return {path:written.path,sha256:createHash('sha256').update(bytes).digest('hex'),completionEligible:false};
}
