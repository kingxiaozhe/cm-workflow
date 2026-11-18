// Diagnostic only. A resume whose launch inputs differ from creation is still
// refused with fingerprint_mismatch; this names the differing input so the
// operator can find the exit. The comparison reads the journal's own init
// record (the runner configuration it bound) and never widens what opens.
import {digest} from './effect-contract.mjs';

const UNLISTED='其余启动配置与创建时不同：--workflow-config、--protected-conversation-config、--bootstrap-config、'
  +'QA/文档设置或创建时的任务选择（journal 只保存它们的指纹）。请用创建时的同一组文件与参数恢复。';

export function explainFingerprintMismatch({snapshot,definition,execution,fingerprints}){
  try{
    if(snapshot.fingerprints.workflow!==fingerprints.workflow)
      return execution===null?'该运行由 cm-ai-host.mjs 创建，不能用无执行适配的 cm-ai-run.mjs 恢复'
        :'该运行由无执行适配的控制入口 cm-ai-run.mjs 创建，不能用 cm-ai-host.mjs 恢复';
    if(snapshot.fingerprints.inputs!==fingerprints.inputs)return `运行定义的 feature/task 与创建时不同（本次 ${definition.feature}/${definition.identity.taskId}）`;
    const bound=snapshot.records[0]?.payload?.config;
    if(!bound)return UNLISTED;
    const found=[];
    const changed=[['scope','scope'],['requirements','requirements'],['identity','identity'],['root','codeProject']]
      .filter(([key,field])=>digest(bound[key])!==digest(key==='root'?definition.codeProject:definition[field]))
      .map(([,field])=>field);
    if(changed.length)found.push(`运行定义字段 ${changed.join('、')} 与创建时不同`);
    if(execution!==null){
      const developer=execution.developer??{},reviewer=execution.reviewers?.[0]??{},was=bound.reviewers?.[0]??{};
      if(bound.developer?.provider!==developer.provider)
        found.push(`--runtime：创建时为 ${bound.developer?.provider}，本次为 ${developer.provider}（驱动 PLAN 未写 runtime 时默认 codex）`);
      else if(bound.developer?.requestedModel!==developer.requestedModel)
        found.push(`开发模式不同：创建时开发者为 ${bound.developer?.requestedModel}，本次为 ${developer.requestedModel}（--protected-config 是否使用须与创建时一致）`);
      if(was.requestedModel==='unconfigured'&&reviewer.requestedModel!=='unconfigured')
        found.push('--review-config：创建时没有审查配置，运行已绑定为“未配置审查”，resume 不能补加；'
          +'本运行只能 status/cancel。要审查这次开发：cancel 后以带 --review-config 的新运行重做（--supersede-reviewed-evidence）');
      else if(was.requestedModel!=='unconfigured'&&reviewer.requestedModel==='unconfigured')
        found.push(`--review-config：创建时用了审查模型 ${was.requestedModel}，本次没有提供；请带上创建时的 review.json`);
      else if(was.requestedModel!==reviewer.requestedModel||was.provider!==reviewer.provider)
        found.push(`审查配置：创建时为 ${was.provider}/${was.requestedModel}，本次为 ${reviewer.provider}/${reviewer.requestedModel}`);
      const host=bound.excludedContexts?.[0],current=execution.excludedContexts?.[0];
      if(host!==current)found.push(`--host-context：创建会话为 ${host}，本次按 ${current} 恢复；换会话恢复请加 --original-host-context ${host}`);
      if(bound.timeoutMs!==execution.timeoutMs&&!found.length)found.push('开发模式或受保护配置与创建时不同');
    }
    return found.length?found.join('；'):UNLISTED;
  }catch{return UNLISTED;}
}
