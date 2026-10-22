// v2 运行没有 --workflow-config 时，宿主隐式补上 QA 判定（只有判定，没有执行器和文档能力）。
// 修复前创建的同类运行指纹里没有它；恢复时宿主据此识别并按原样打开，不改变它们的行为。
const IMPLICIT=new WeakSet();
export function markImplicitQaDecision(provider){IMPLICIT.add(provider);return provider;}
export function isImplicitQaDecision(provider){return provider!=null&&typeof provider==='object'&&IMPLICIT.has(provider);}
