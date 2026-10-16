// Read-only qualification and immutable record validation for one startup correction.
import {digest,json,need,shape} from '../cm-ai/effect-contract.mjs';
import {verifyFixRedEvidence} from './red-test.mjs';
import {COMMAND_CORRECTION,correctionRow,deriveJestCorrection,readCorrectionConfig,correctionFiles} from './jest-command-correction.mjs';
export {COMMAND_CORRECTION,correctionRow};
export function inspectCommandCorrection(payload,{configuration,records,red}){
 const p=json(payload,256*1024);shape(p,['target','reason','previousInvocationStopped']);
 const t=p.target;shape(t,['configurationDigest','historyDigest','redResultDigest','outputSha256','declaration','configFile','commands','files','snapshotDigest']);
 need(p.previousInvocationStopped===true&&typeof p.reason==='string'&&p.reason.trim()&&Buffer.byteLength(p.reason)<=1000&&!/[\r\n\0]/.test(p.reason),'fix_command_correction_confirmation');
 need(!correctionRow(records)&&t.configurationDigest===digest(configuration)&&t.historyDigest===digest(records)
  &&red?.status==='not_red'&&t.redResultDigest===digest(records.at(-1))&&records.at(-1).id==='fix-red-test-result'
  &&t.outputSha256===red.output.sha256,'fix_command_correction_binding');
 need(digest(t.commands)===digest(deriveJestCorrection(configuration,t.declaration,t.configFile))
  &&t.commands.some(c=>c.id==='red-test'),'fix_command_correction_binding');
 need(Array.isArray(t.files)&&t.snapshotDigest===digest(t.files),'fix_command_correction_binding');
 const file=t.files.find(f=>f.path===t.configFile.path);need(file&&file.sha256===t.configFile.sha256&&file.mode===t.configFile.mode,'fix_command_correction_binding');
 return p;
}
export function inspectCommandCorrectionTarget({configuration,records,status,specsRoot,declaration}){
 need(!correctionRow(records),'fix_command_correction_used');
 need(status.stage==='red_test_not_confirmed'&&status.redTest?.status==='not_red'
  &&!configuration.qaSource&&!configuration.externalModels&&!configuration.executionPolicy,'fix_command_correction_unavailable');
 const raw=verifyFixRedEvidence(status.redTest,configuration.redTest,specsRoot);
 const stderr=Buffer.from(raw.stderrBase64,'base64').toString('utf8');
 const stdout=Buffer.from(raw.stdoutBase64,'base64').toString('utf8');
 need(status.redTest.output.complete===true&&status.redTest.observation.outcome==='failed'
  &&!/(?:^|[\r\n])\s*(?:Test Suites|Tests):/m.test(stdout+'\n'+stderr)
  &&status.redTest.observation.exitCode===1&&status.redTest.observation.signatureMatched===false
  &&stderr.startsWith('Error: Could not find a config file based on provided values:')
  &&stderr.includes(`cwd: "${configuration.redTest.cwd}"`),'fix_command_correction_unavailable');
 const mutable=[...(configuration.repair?.scope??[]),...(configuration.redTest?.testFiles??[]),...(configuration.baseline?.testFiles??[])];
 need(!mutable.includes(declaration.path),'fix_command_correction_config');
 const configFile=readCorrectionConfig(configuration,declaration),commands=deriveJestCorrection(configuration,declaration,configFile),files=correctionFiles(configuration,declaration);
 need(commands.every(c=>!c.before.includes('--')&&!c.before.includes('-c')),'fix_command_correction_config');
 return {configurationDigest:digest(configuration),historyDigest:digest(records),redResultDigest:digest(records.at(-1)),outputSha256:status.redTest.output.sha256,
  declaration:json(declaration),configFile,commands,files,snapshotDigest:digest(files)};
}
