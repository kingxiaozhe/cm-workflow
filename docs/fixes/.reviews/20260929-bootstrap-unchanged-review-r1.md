# Independent review: bootstrap unchanged-target recovery

Verdict: approved.

The independent reviewer found two material gaps before approval. An attempt-2 rule restored to the original task baseline must appear in `unchangedScope` even though its current-attempt before SHA differs; the validator and a CI-collected regression test now cover this. The original recovery integration test was in a fixture excluded from CI; its runner/entry append-and-replay test now runs from `scripts/cm-bootstrap-review-recovery.test.mjs`. The reviewer also checked the standard driver route, explicit permission and reason, handoff binding, fail-closed drift behavior, project lesson, and operator documentation. No remaining blocking findings.

Verification reviewed: CI-collected focused suite 8/8, bootstrap end-to-end fixture 9/9 before fixture extraction and 8/8 after moving the recovery case, and `git diff --check`. The main executor additionally ran the affected driver/entry suite (59/59), `cm-check-runtime.sh`, public repository validation, and safety scan.
