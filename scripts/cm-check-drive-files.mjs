// The partial runtime scripts/cm-check-drive.test.mjs copies into a temp dir. Shared so the light-module
// guard (cm-ai-light-modules.test.mjs) imports operator-guidance.mjs from exactly this copy.
export const CHECK_DRIVE_COPIED_FILES=Object.freeze([
  'scripts/cm-check-entry.mjs','scripts/cm-check-host.mjs','scripts/cm-check-drive.mjs',
  'scripts/cm-workflow-config.mjs','runtime/js/cm-check/host.mjs','runtime/js/cm-ai/drive-core.mjs',
  'runtime/js/cm-ai/operator-guidance.mjs','runtime/js/cm-ai/review-dispatch-limits.mjs',
  'runtime/js/cm-ai/host-tool-bridge.mjs','runtime/js/cm-ai/host-session.mjs','runtime/js/cm-ai/diagnostic-reason.mjs','runtime/js/cm-ai/effect-contract.mjs',
  'runtime/js/cm-ai/contracts.mjs','runtime/js/cm-init/draft-inspection.mjs','skills/cm-check/SKILL.md']);
