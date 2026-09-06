# CM task handoff and review gates

This contract makes the N3 → N4 → N5 boundary mechanically checkable without
creating a second task-state database. `tasks.md` remains the authoritative
business-task state. Handoffs and review files are content-bound evidence under the
existing `{SPECS_DIR}/.reviews/` domain.

## Implementation handoff

For attempt 1 or 2, N3 writes:

```text
{SPECS_DIR}/.reviews/{feature}-{task}-a{attempt}-handoff.json
```

The document follows `runtime/task-handoff.schema.json`. A worker may report only:

- `ready_for_review`: every verification entry is `passed`; `blockers` and
  `scope_deviation` are empty;
- `blocked`: at least one blocker or scope deviation explains why N4 cannot start.

The main agent, not the worker, writes the evidence file after checking the
worker response against the actual diff and command output. A handoff never
marks `tasks.md`, approves a review, writes metrics, or authorizes Git actions.
Project paths use forward-slash, project-relative form so the evidence remains
portable across macOS, Linux, and Windows.

Before writing a new handoff, hash the exact `changed_files` set:

```bash
python3 {CM_WORKFLOW_ROOT}/scripts/cm-task-gate.py hash-implementation \
  --project-root {CODE_PROJECT} \
  --file path/one --file path/two
```

Copy the returned `implementation_sha256` into the handoff. `check-n4` and N5
recompute it from the same project root, so any reviewed file change invalidates
the approval. Deleted paths are represented by an explicit missing-file marker;
symlinks and directories are rejected. Historical unbound handoffs require the
explicit recovery flag `--allow-legacy-unbound` and return `content_bound: false`;
new work must not use that flag.

The gate validates declaration consistency; it does not reconstruct a task diff
from an already-dirty or multi-repository working tree. N3 remains responsible
for comparing `changed_files` with the task-scoped diff before writing handoff.

Validate the evidence before N4:

```bash
node {CM_WORKFLOW_ROOT}/scripts/cm-task-gate.mjs check-n4 \
  --handoff {HANDOFF_PATH} \
  --reviews-dir {SPECS_DIR}/.reviews \
  --feature {FEATURE_SLUG} \
  --task {T-xxx} \
  --project-root {CODE_PROJECT}
```

Attempt 2 is valid only when round 1 exists and has
`verdict: changes_requested`. A blocked handoff never enters N4.

## Review disposition

Each review header keeps the existing fields and adds:

```yaml
attempt: 1
verdict: approved | changes_requested | blocked
blocking_findings: 0
handoff: login-T-001-a1-handoff.json
handoff_sha256: <lowercase SHA-256 returned by check-n4>
```

`round` must equal `attempt`. The review scope must cover every `changed_files`
entry and the body must contain findings or an explicit zero-findings result.
`changes_requested` returns to N3 and produces the next attempt. N4 never edits
implementation files. Round 2 cannot create attempt 3: another blocking result
becomes `blocked` and requires human resolution under `runtime/review.md`.

N5 must let the JavaScript gate validate and update the exact task checkbox while
the compatibility entry holds the existing platform ownership lock:

```bash
python3 {CM_WORKFLOW_ROOT}/scripts/cm-task-gate.py mark-done \
  --handoff {HANDOFF_PATH} \
  --reviews-dir {SPECS_DIR}/.reviews \
  --feature {FEATURE_SLUG} \
  --task {T-xxx} \
  --tasks {SPECS_DIR}/{FEATURE_DIR}/tasks.md \
  --project-root {CODE_PROJECT}
```

`cm-task-gate.py` contains only the write-lock adapter for this command: it uses
the existing SQLite ownership protocol on POSIX and a byte-range mutex on Windows.
The N5 decision and exact replacement remain owned by
`cm-task-gate.mjs`. `--tasks` is explicit so feature-local specs remain the authority.
`{FEATURE_DIR}` is the exact numbered directory name (for example
`2.bulk-clear-completed`), while `{FEATURE_SLUG}` is the review/audit slug without
the numeric prefix. The tasks file must be that direct feature-local authority; a
specs-root, sibling feature, symlinked evidence-root or other alias is rejected.
Only the review for the same task,
attempt, and handoff with
`verdict: approved`, `independent: true`, and the same handoff SHA-256 passes. For attempt 2, N5 also
revalidates the complete attempt-1 → changes-requested chain. The write is an
atomic same-directory replacement and changes only the exact task checkbox,
preserving LF/CRLF (including mixed endings) and a missing final newline.
File existence or a separate manual edit is not approval.

`mark-done` pins task bytes, file identity/mode, and all selected handoff/review
files, including the attempt-1 chain for attempt 2. Evidence must remain stable
across validation. Immediately before replacement (and before an `already_done`
return), the gate repeats N5 validation and compares the pinned revisions.
Observed changes reject the write and preserve the external edits; callers must
not hand-edit a checkbox to bypass the rejection. This is an optimistic stale-write
detector only: another writer can still race after the final check. It is not a
filesystem compare-and-swap or a completed crash-recovery protocol.

The new POSIX source path also binds each canonical, non-hardlinked `tasks.md` to
one specs root in `<tasks-parent>/.reviews/.cm-task-owner.json`. Both task-enabled
JS and Python use the same canonical UTF-8 bytes and exclusive initial creation.
Conflicting roots, damaged/unknown bindings and control symlinks are refused, never
rebound automatically. Existing layout support includes root tasks, exact feature
names (including Chinese), and ASCII-numbered feature directories; other Unicode
numeric prefixes are explicitly unsupported in this inactive prototype.

After binding, Python holds the bound root's `.reviews/.execution/writer.sqlite`
SQLite transaction through replacement or `already_done`. Existing JS runs or
unknown execution evidence block the POSIX compatibility writer even after the JS owner exits.
The JS task-enabled entry is `openTaskExecutionStore` from
`runtime/js/cm-ai/task-owner.mjs`, not the raw storage primitive. The historical
experiment path is only a compatibility re-export. Read-only gate operations do not
bind or lock. Old installed binaries cannot be forced to cooperate; do not activate
real mixed-version writing. Windows serializes completion writes through
`.reviews/.cm-task-write.lock`.

Binding/ownership initialization is synced before any task mutation. POSIX JS
completion also fsyncs the task parent after replacement; Windows skips unsupported
directory fsync after its locked atomic replacement so it cannot report a post-write
failure as if no write occurred. No unknown-outcome retry or automatic recovery is
added: full durable commit/cancel/reconciliation remains outstanding.

The pinned target must decode as UTF-8 and contain exactly one requested checkbox
before Python creates an owner binding. Both task-enabled entries refuse every
pre-existing `writer.sqlite-journal` before opening SQLite, including empty or
otherwise ordinary journals; they preserve it for explicit future reconciliation.
Python also rejects retained run/unknown objects before opening SQLite. Preflight
is not an atomic barrier against another initializer crashing between the check
and open; that remaining window must be closed before real task activation.

The current initialization-barrier experiment now requires `writer-ready.json`
alongside the DB. Only the exclusive DB creator publishes this immutable
certificate after schema commit, required synchronization and locked validation.
Existing DBs must match the certificate's exact bytes/version and database SHA-256
before SQLite is opened; no certificate means refusal, not automatic adoption.
Interrupted or old uncertified initialization is retained for explicit repair.
Certificate publication is not task approval, task completion or run recovery.

The cooperative host must load one canonical runtime instance, use one thread,
and not independently open/close the writer DB while it is owned. SQLite's POSIX
locks can be dropped by closing an unrelated descriptor for the same DB. Runtime
inspection therefore holds one descriptor until after SQLite closes and rejects
same-process reentry before opening that descriptor. This is not protection from
arbitrary code in the host process; fixtures use separate processes for contenders.

`self-degraded` remains readable for historical audit, never for authorizing new
completion. Missing independent capacity leaves work pending; do not add a skip
flag or treat diagnostic approval as independent. Existing completed tasks are
not automatically reopened or assigned fabricated review evidence.

This is a declaration gate, not proof of reviewer execution, an immutable code
snapshot, or full crash-recoverable completion. Any post-review change to reviewed code,
tests, or instructions needs fresh evidence under `runtime/review.md`, including
changes suggested during N5 lesson recording.

## Experimental read-only N5 preparation seam

`prepare-mark-done` takes the same selectors as `mark-done` and emits a private
`cm-mark-done-plan` v1 JSON proposal. `verify-mark-done-plan` additionally takes
`--expected-plan-digest` and returns only `matched` plus the digest after repeating
N5 and all revisions. These commands do not create ownership/control files,
acquire a writer lock, execute a subprocess or change tasks. They can read while
the JS task-enabled store is owned. Do not treat their output as commit authority.

The plan preserves complete before/after Base64 bytes and raw SHA256, canonical
task path, feature/task/validated attempt, decimal permission mode (`S_IMODE`),
the complete N5 attempt evidence chain and opaque revisions. A revision hashes
canonical UTF8 JSON `{path,stat,sha256}` with `stat` ordered as dev,ino,mode,nlink,
size,mtime_ns,ctime_ns, all **decimal strings** (not JS Number). `planDigest` hashes
all other plan fields with Python `sort_keys=True,separators=(',', ':'),ensure_ascii=False`.
Evidence entries are deduplicated and sorted by physical path; alias selectors
are still individually rechecked and conflicting physical revisions refuse.
Actual code/requirements/checks are
NOT authenticated by this legacy declaration gate; future JS commit must bind
and revalidate them separately under canonical ownership.

Reads and every N5 reread are bounded to256KiB per task/evidence file, at most4
evidence files; encoded plan<=1MiB. Oversize, links/hardlinks, invalid UTF8 and stale
revisions refuse without repair. Output contains private task bytes: never mirror
it into public/global logs. Already `[x/X]` produces identical before/after bytes,
not a newly completed task or proof of recovered execution. The shared byte helper
changes only one checkbox byte, including preserving CR-only/mixed line endings.
The JS writer revalidates N5 and the exact plan under the platform lock immediately
before replacement.

Run `node --test scripts/cm-task-gate.test.mjs` for the ownership and completion
path. `python3 scripts/test-task-gate.py` only checks that the compatibility adapter
has not regained duplicate business rules.

The formal but inactive JS host assembly may call `taskOwnerTarget(store)` to identify the genuine
live task-enabled handle. Private per-module registration plus existing binding
and raw-store guards are required; a path, copied method or run ID is insufficient.
The frozen target is a point-in-time identity, not a persistent lease, task-content
revision or approval. Future commit must compare it to the N5 target and recheck
the handle before writes. No writer/reconciliation is supplied by this accessor.

The shipped but inactive `runtime/js/cm-ai/task-commit.mjs` fixture primitive
separately composes this seam with genuine ownership and the S2 content-bound
fixture review gate. It requires a dedicated empty store (not runner-v1 records),
persists intent before writes, rechecks N5/source/task/evidence/temp/owner, then
renames, syncs the task parent and persists result before `fixture_committed`.
It never emits real review evidence or bypasses the existing Python gate/lock.
Post-intent errors are unknown and retained; nonempty histories never auto-retry.
Cancellation reads reject proxied/accessor-bearing or unsupported signal shapes
before invoking the native getter; repeat admission prevents caller callbacks
between final file verification and replacement. This does not authenticate signals.
Read-only observation compares complete before/after images and modes but cannot
approve work, fill a missing result or infer current review from historical hashes.
See the experiment README for limits/trust/activation boundaries. Current installed
Skill completion and real reviewer execution remain governed by their own gates.

The experimental explicit runner V2 reader validates a single complete global
history with nested C2b records; its pure shared commit codec grants no authority.
Fixed owner/evidence selectors and reconstructed runner proof materials must match.
Nested result alone never supplies a missing outer checkpoint: restore remains
unknown, and post-checkpoint commit unknown stays unknown after workflow errors.
Only a small taskCommit reference enters V2 status/cache. Actual runner wiring,
task-file observation and installed entry activation are not provided by this reader.

The separate inactive fixture runner now explicitly accepts
`persistence:{store,mode,version:2}` with fixed `taskCompletion:{reviewsDir,handoffs}`
and no generic commit callback. It requires the genuine owner handle, reuses one
global journal cursor for outer and native records, and calls the existing native
mechanics only under a private live capability derived from registered review and
fresh checks. That capability is revoked before the outer checkpoint gap; no
worker-provided callback, identity or hash can register one. Storage uncertainty,
foreign revision or recursive storage entry poisons the runner without retry.
Only nested result plus durable outer checkpoint yields historical fixture success;
incomplete prefixes restore unknown even with changed task bytes. Native failure
never rolls back tasks or clears evidence. This remains isolated-fixture wiring,
not real N5 reviewer evidence, provider/Skill activation, observation or run_done.

The separate experimental `observeRunnerFixture(store)` is read-only diagnosis:
it validates all V2 records and genuine owner/fingerprints/run, then separately
reports current full-image comparison, recorded native outcome and deterministic
runner-history state. Missing outer checkpoint remains unknown, even with `[x]`
or a nested result. No nested intent means no comparison, not no historical writes.
Both native observers now check the parent before and after task reads; final
owner and snapshot revision must still match. The existing code-root metadata
check remains required. No task/store writes, checks/Python/provider dispatch,
automatic reopen/retry, approval, quarantine clearing or run_done are supplied.

## Parallel-write guard

Serial work and parallel read-only work do not need this check. Before two or
more tasks write code concurrently, the main agent declares every assignment:

```bash
node {CM_WORKFLOW_ROOT}/scripts/cm-task-gate.mjs check-parallel-write \
  --repo {CODE_PROJECT} \
  --assignment T-101={WORKTREE_ONE} \
  --assignment T-102={WORKTREE_TWO}
```

Every assignment must resolve to a registered worktree of the same Git
repository, use a distinct path and a distinct non-detached branch, and have a
unique task id. Failure means **run serially**; it never means bypass the guard.
