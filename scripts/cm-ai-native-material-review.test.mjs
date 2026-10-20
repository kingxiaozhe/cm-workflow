// Original-run bounded material recovery, synthetic provider only.
process.env.CM_NATIVE_MATERIAL_REVIEW_FIXTURE='1';
await import('./cm-ai-bounded-native-correction.test.mjs');
