// Single source of truth for QA / visual / walkthrough environment carriers.
// Previously duplicated verbatim in four modules; a new delivery form had to be
// added in every copy or the validators silently diverged.
// The list follows the delivery forms cm-prd confirms with the user
// (skills/cm-prd/references/greenfield.md), plus the backend, CLI and library
// projects cm-prd already recognises as having no deployment form.
export const QA_ENVIRONMENT_CARRIERS=Object.freeze({
  web:Object.freeze(['browser']),
  app:Object.freeze(['ios-simulator','android-emulator','device']),
  miniprogram:Object.freeze(['wechat-devtools','device']),
  desktop:Object.freeze(['app-window']),
  service:Object.freeze(['cli','http-api']),
  library:Object.freeze(['none']),
});
export const QA_ENVIRONMENT_SCOPES=Object.freeze(['local','test']);
// Validation only: nothing downstream branches on kind/carrier, the pair travels
// with each case request as declared provenance.
// hasOwn keeps an inherited key such as __proto__ from resolving to Object.prototype,
// which made the previous duplicated lookups throw instead of rejecting the value.
export function isQaEnvironmentCarrier(kind,carrier){
  return Object.hasOwn(QA_ENVIRONMENT_CARRIERS,kind)&&QA_ENVIRONMENT_CARRIERS[kind].includes(carrier);
}
