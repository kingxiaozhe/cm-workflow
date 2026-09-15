# CM JS N1–N2 admission R1 boundary fixes

Date: 2026-09-03
Status: fixed and locally verified; fresh independent R2 pending.

## Symptoms and reproductions

Fresh independent R1 reproduced four failures against the original candidate:

1. An approved status listing only `1.approved` still selected a newly added
   `2.unapproved/T-001`.
2. A test contract's `T-999` reference passed when `T-999` appeared only in design prose.
3. A feature `tasks.md` symlink outside specs supplied the selected task.
4. `login-T-001-r1.md` incorrectly suppressed missing-review evidence for
   `2.profile/T-001`.

Each reproduction was added to
`experiments/js-orchestration/cm-ai-admission.test.mjs` and failed before its repair.

## Root cause

The read-only admission already parsed the relevant files, but four authority identities
were only partially bound: approved feature inventory, structured declarations, feature
realpaths, and feature-plus-task review filenames.

## Minimal repair

- Compare approved `features` as an exact set with discovered numbered feature directories;
  drift returns `awaiting_spec_approval/spec_features_changed`.
- Build AC references only from structured AC declaration rows and task references only from
  actual `tasks.md` task rows.
- Resolve each required triplet file and require its realpath to remain under the feature root.
- Match historical review evidence by feature name plus task id, while accepting the existing
  numbered and unnumbered feature filename forms.

No generic registry, DAG, pipeline, database, provider identity scheme, N3–N8 behavior or
automatic Learning analyzer was added.

## Verification

- Focused admission suite: 13/13 passed.
- Full Node suite: 977/977 passed.
- Module syntax and `git diff --check`: passed.
- `./scripts/cm-check-runtime.sh`: passed, plugin v0.10.4.
- `python3 scripts/validate-public-repo.py`: passed, 8 core skills.
- Public safety scan: same five pre-existing findings; no new finding.

Current hashes:

- `cm-ai-admission.mjs`: `df3aa4f0ddaa12aaac743f9736a5e33ebebd4a1dbf13978504565348f17d1a44`
- `cm-ai-admission.test.mjs`: `941da7b393b4c1b30a9f29bd9c1b2f0674d7f173f97fc8d69b1781cca01b5b8a`
- `experiments/js-orchestration/README.md`: `ef47c3e8ba72df1c9403c30a148f21bed1aa55b8ff7d0fc085d0cf08b37192b3`

## Review and delivery boundary

R1 was `changes_requested`. These changes are attempt 2 and have not received fresh R2.
No task/F01 checkbox, review credential, Git commit, push, install, release, real specs write,
or provider call was produced by this repair.

## Learning

Two evidence-backed `[已结构化]` lessons were added to the root `AGENTS.md`: approved
snapshots bind complete inventories, and identity boundaries require structured declarations,
realpath containment, and feature-plus-task evidence matching. They must be included in R2.
