// 当前会话运行的每次宿主调用（含「检查」整步）共用一个期限，默认 30 分钟。
// 设备检查（构建 Release、在模拟器上跑多条流程）常常超过 30 分钟：运行可在创建时用
// --call-timeout-minutes N（30–60）把它放宽。上限 60 分钟与 runner 的 validCallTimeout、
// 宿主应答兜底（HOST_ANSWER_BACKSTOP_MS）一致。它不进运行指纹：恢复时可改（含给现有运行加上）。
export const DEFAULT_CALL_TIMEOUT_MS=1800000;
export const MIN_CALL_TIMEOUT_MINUTES=30,MAX_CALL_TIMEOUT_MINUTES=60;
export function parseCallTimeoutMinutes(raw){
  if(raw===undefined)return null;
  if(typeof raw!=='string'||!/^[1-9][0-9]$/.test(raw)||Number(raw)<MIN_CALL_TIMEOUT_MINUTES||Number(raw)>MAX_CALL_TIMEOUT_MINUTES){
    const error=new Error(`--call-timeout-minutes 须为 ${MIN_CALL_TIMEOUT_MINUTES}–${MAX_CALL_TIMEOUT_MINUTES} 的整数（分钟）`);
    error.code='invalid_arguments';throw error;
  }
  return Number(raw)*60000;
}
export const callTimeoutFrom=permissions=>{
  const at=Array.isArray(permissions)?permissions.indexOf('--call-timeout-minutes'):-1;
  // 宿主拒绝重复参数；体检同样按非法处理，不只读第一个值
  if(at!==-1&&permissions.indexOf('--call-timeout-minutes',at+1)!==-1)parseCallTimeoutMinutes('');
  // 写了参数却没给值：按非法处理，不悄悄退回默认
  return at===-1?null:parseCallTimeoutMinutes(permissions[at+1]??'');
};
