// Keep optional operator guidance private to the error that produced it.
const tagged=new WeakSet();

export function tagDiagnosticReason(error,reason){
  error.reason=reason;tagged.add(error);return error;
}

export function diagnosticReason(error){
  return tagged.has(error)?error.reason:null;
}
