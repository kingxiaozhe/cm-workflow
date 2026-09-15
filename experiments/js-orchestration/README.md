# CM JS orchestration — compatibility fixtures and historical experiments

The accepted `cm-ai` implementation source now lives only in
`runtime/js/cm-ai/`, which is shipped with the shared runtime. Matching `.mjs`
files here are compatibility re-exports so historical tests and evidence paths
remain valid; they are not a second implementation. The new formal host API is
still inactive: this directory's tests, demos, and prior approvals do not prove
installed host activation, provider execution, real task completion, platform
support, or release.

The older B1 demo assets below remain opt-in experiments and are not installed:

- `inspect-task.mjs`: fixed shared workflow (`meta`, `run(ctx)`), one synthetic input and result validation.
- `host.mjs`: stage/event correlation and a one-dispatch limit. No durable state or recovery.
- `codex-config.mjs`: compatibility export of the formal runtime's common CLI flags; no global configuration writes.
- `tool-preview.mjs`: loopback sink receives tool definitions with synthetic authentication and returns HTTP 400. No model forwarding.
- `worker-codex.mjs`: compatibility export of the formal runtime worker; optional real CLI use remains separately authorized.
- `run-demo.mjs`: explicit preflight/live entry; accepts only the prepared temporary fixture directory.

The separate C fixture adds `two-step.mjs`, `contracts.mjs` and `replay.mjs`, with
two test files. It uses only fake workers, frozen JSON, serialized checkpoints,
identity/prefix checks and simulated host decisions. It is not connected to the
real Codex worker or task-state writes. No arbitrary JS sandbox, durable storage,
authenticated approval bridge, retry, reconciliation or production resume exists.
Its integrity hashes detect accidental damage, not malicious snapshot rewriting.
The fingerprint covers the fixed local module graph only, not dynamic imports or
arbitrary closure dependencies. A running dispatch intent restores as unknown,
including a checkpoint taken just before the worker call; it is never retried.

## Verification

Tested initially with Node v24.14.0 and Codex CLI 0.144.5 on macOS; the preview uses
Node's built-in zstd decoder. This is not a supported-version or platform matrix.

```bash
node --test experiments/js-orchestration/*.test.mjs
node experiments/js-orchestration/run-demo.mjs --preflight /tmp/cm-js-b1-hb0cPK gpt-5.6-sol
```

`--live` is a separate explicit mode requiring authorization, a prepared synthetic
`greeting.schema.json`, and existing normal CLI login. It performs one live worker
dispatch after a fresh preflight. Never point it at a business repository or add
private content to the fixed fixture. The model value above was read from the
local user's configured CLI default; it is not a universal product default.

## Evidence and limits

The preview checks the actual request emitted to a **local custom provider**.
It also discovers skill-folder metadata in that local request and retries once
with invocation-only per-skill disable overrides. Neither skill bodies nor the
catalog descriptions are saved. An unrecognized or nonempty catalog blocks live
mode; an empty catalog heading is allowed. Global skill settings remain unchanged.
Live mode uses the normal built-in provider with the same common CLI flags and
model. Provider metadata/transport differences remain a limitation; the local
preview is not a live network interception or proof about every provider.
Tools are not enabled to obtain a greeting; unexpected live tool/item events
terminate the worker, but event observation is not a pre-execution security guard.

Read-only sandboxing prevents tested writes, not arbitrary reads. Do not use this
prototype with secrets, source trees, untrusted workflows, or business effects.
The host is trusted Node code, not a sandbox for generated JavaScript. Feature
receipts are diagnostic, not approval tokens. There is no crash-safe persistence,
real-provider resume, worker process-tree guarantee, automatic retry, Claude support, or N4/N5.
The 60-second local timeout does not guarantee remote cancellation or billing stop.

Existing normal CLI auth is used only for the authorized live dispatch. The probe
uses a public synthetic string instead; headers and prompts are not recorded.
Raw CLI stderr is suppressed. CLI-owned operational logs may still be written by
the CLI despite ephemeral conversation mode; no user settings are changed.

## Current result

One live worker dispatch was attempted on 2026-09-02; the initial adapter rejected
an unrecognized item and returned failure. Its item kind was not retained, so the
exact live cause and whether the remote model processed the request are unknown.
A local scripted response subsequently reproduced a skill-catalog diagnostic in
an `error` item. The current code disables that catalog and classifies diagnostics
without silently ignoring them; local fixture validation passes.

A separately authorized revised live retest on 2026-09-02 succeeded: one worker
dispatch, `Validate → Greet → Collect`, validated greeting `你好！`, exit 0, no
timeout. The fresh loopback preflight passed with no tools and an empty skill
catalog; this remains local-provider evidence, not an audit of the live request.
The 25 local tests also passed again. No implementation code changed for this
retest. **The minimal Codex success path is verified; B1 is not fully accepted:**
subsequent independent review found a P2 event-shape validation defect. A separately
authorized two-file repair now rejects malformed event structures before field
access or publication. The suite passes 57/57, and independent re-review closed
the P2 and approved this narrow repair, including 17/17 additional fake probes.
A further authorized current-adapter retest on 2026-09-02 now also succeeded,
with one dispatch and validated greeting. A separate real CLI cancellation probe
triggered host cancellation at `turn.started`, returned `cancelled`, and verified
the direct child pid was absent after closure. This does not verify the desktop
Stop button, descendant processes, remote cancellation or billing stop.

Claude's read-only auth check returned `loggedIn:false`; no Claude live call or
new login was performed. Current offline tests pass 81/81 (57 B1 + 24 C). C's
first independent review found two P2 redispatch defects; both have targeted
regressions and minimal fixes. Independent re-review closed both findings and
approved the fixed synthetic C slice. All C results remain offline evidence,
not cross-provider or real-project acceptance.

The current whole-tree public-safety scan fails on five existing findings: two
personal paths in user-owned marketing artifacts, the two B1 local CLI defaults,
and the loopback test endpoint. No scanner rule was weakened. This local opt-in
prototype is **not release-ready**; portable CLI discovery and test-endpoint
classification need separate reviewed changes and fresh evidence before shipping.
Detailed current evidence is in the local continuation report and JSON under
`.omx/research/`; historical B1 reports keep their original version boundaries.

For a zero-model, successful protocol fixture (not an AI answer):

```bash
node experiments/js-orchestration/tool-preview.mjs /tmp/cm-js-b1-hb0cPK gpt-5.6-sol --fixture-response
```

## S2a — offline review-package content binding

`review-package.mjs` is a separate, read-only experiment with three synchronous
functions: `captureReviewBaseline`, `createReviewPackage`, and
`verifyReviewPackage`. Its test file creates only temporary synthetic projects;
the module is **not connected to host/replay, real workers, or task gates**.

The baseline contains the actual initial file bytes, including pre-existing
dirty content. A fixed host-supplied file scope is compared against the complete
current file inventory. Added, deleted, modified and mode-only changes are
recorded; a rename is a deletion plus addition. Undeclared file changes reject
the package. Git-tracked, untracked, ignored and non-Git files use the same
algorithm; no Git commands or configuration are read by the module.

Each package includes exact before/after content, current requirements, supplied
check evidence and their digests, bound to the repository/run/task/attempt,
canonical-root digest and baseline digest. `verifyReviewPackage` compares these
against current content and a separately pinned expected digest. A successful
`matched` means only that content matches, **not** that any reviewer approved it
or that a task may be marked done. Failed/unavailable checks can be retained as
review material; their authenticity is not proven by a hash.

Only a trusted fixture host may select root/scope/identity and pin the expected
digest. Returned JSON is deeply frozen. Hashes do not authenticate the host or
reviewer, and reconstructing all hashes cannot replace an independently pinned
digest. Local project identity is the canonical root plus the supplied repository
ID, not an authenticated Git remote or HEAD.

The root must remain quiescent during capture. Per-file stat checks detect
observed changes, not cross-file atomicity or hostile same-user path replacement.
Only regular, single-link files are supported, with original bytes and `07777`
permission bits. Symlinks, hardlinks, special files, unsafe/ambiguous paths and
known sensitive filename components are rejected. Normal root `.git/` is skipped;
its paths cannot be in scope or requirements. Nested Git roots and `.git` files
(including linked-worktree layouts) are not supported. This filename policy is
not a secret scanner or proof that a real project is safe to read or transmit.

Bounds are 1 MiB per file, 2 MiB raw bytes and 256 files per snapshot, depth 32,
64 KiB check JSON and 8 MiB output JSON. Oversized data is rejected, not truncated.
Validation is tested on the local macOS/Node environment, not a Windows matrix.
I/O error and concurrent-stat-change fixtures use explicit fault injection; they
are not proof of process isolation, disk recovery or a shared-writer lock.

```bash
node --test experiments/js-orchestration/review-package.test.mjs
```

S2b still needs provider-neutral execution receipts and one authoritative effect
entrypoint; S3 needs persistent state and a common lock; S4 needs real host and
provider evidence. Existing B/C historical results above keep their own scope.
S2a does not install anything, launch a provider, update specs/tasks, or grant
permission to run against business projects. The whole-tree release-safety
failures described above remain unresolved.

## S2b — one effect entry and mandatory review (synthetic fixture)

`task-runner.mjs` adds a separate, in-memory `createTaskRunner` experiment.
Its default `run()` workflow requests `develop → review → complete` through
the same `executeEffect` entry. Only the runner closure holds the configured
adapter functions, registered review receipts and synchronous fixture commit
callback. A workflow return value such as `done` or `approved` has no authority.
`review-runner.mjs` and `gate-bridge.mjs` are pure data/validation helpers, not
alternate dispatch or task-writing entrypoints; `effect-contract.mjs` handles
bounded, frozen JSON and strict protocol shapes.

The trusted fixture host supplies the initial identity/root/scope/requirements,
developer, at most two authorized reviewer candidates, excluded participant
contexts, checks, and commit callback. Each review context is unique across
candidates and both rounds and cannot be an author/planner/diagnostic context.
Codex-only and Claude-only are tested as **synthetic transport labels** with
fresh same-provider reviewers; cross-provider routing is also a fixture.
They are not live provider tests, credentials, or proof of actual isolation.
Receipts distinguish requested/effective model (unknown when unobserved),
provider, fixture channel, request/result digests and fallback reasons.

Only a known, unaccepted unavailable/auth/permission response can try the next
authorized candidate. An unknown outcome, timeout, malformed response or thrown
call stops; late success cannot replace the terminal state. An accepted failure
stays pending review. An actual blocking verdict cannot be discarded by switching
reviewers. A first `changes_requested` permits attempt two with the original
dirty baseline and prior findings retained; a second stops. Starting a fresh
runner is a trusted-host operation, not a mechanism that enforces durable limits
across arbitrary host restarts.

Completion reruns required checks, revalidates the S2a content package, and
matches the internally registered receipt to the actual recorded fixture
invocation and current identity. Every check must pass, even when an unchanged
failed check was included in an otherwise approved review. The commit callback
then runs synchronously once and must return `fixture_completed`. It changes
only a test-owned memory marker in these fixtures, never `tasks.md` or Git.

Exact prior intents can replay from the private cache without dispatch or state
rollback, including after attempt advancement or cancellation. Conflicts,
concurrency, stage skipping and external snapshots are rejected. A `run()`
facade expires when its workflow exits; unawaited effects are cancelled and the
runner waits only for their bounded wrapper, not an unresponsive adapter promise.
Cancellation before commit prevents it; cancellation after the synchronous
callback was entered does not claim to undo an existing effect. Unknown commit
results are not retried. AbortSignal is best effort, not remote-stop evidence.

```bash
node --test experiments/js-orchestration/task-runner.test.mjs
node --test experiments/js-orchestration/*.test.mjs
```

This experiment reuses S2a and the existing digest but does not wire the old B/C
dispatchers into a second control path. There is no disk resume, shared writer
lock, Python gate wiring, real N5/N8, current-conversation bridge, or learning
loop here. A hash/closure is not authentication or an untrusted-JavaScript
sandbox. Only fixed, trusted workflows and synthetic, quiescent roots are in
scope. Existing S2a and B/C evidence above remains historical to its own slice;
S3 persistence and S4 live capability/permission tests are separate next gates.

Synchronous adapter/check returns are inspected as JSON before any Promise can
assimilate them; ordinary thenables and getter-bearing results are rejected.
Asynchronous callbacks use standard same-realm native Promises (no custom
constructor), with their settled data validated before it reaches the runner.
The runner does not execute a returned object's custom `then` or an exception's
`code` accessor. This checks the data received at its boundary; it cannot undo
work a trusted callback or its own Promise resolution already performed inside
the callback. Unsupported Promise containers stop as unknown, not as approval.
Observable unsupported native Promises (including ordinary subclass/cross-realm
returns and Promise-returning commits) receive local rejection cleanup using
the captured intrinsic method, never custom `then`/`catch`. Where needed, the
instance's constructor descriptor is temporarily shadowed and synchronously
restored; custom constructor/species hooks are not executed. Cleanup never
makes an unsupported result eligible, retries a call, or suppresses unrelated
process rejections. Tests use independent processes with strict rejection mode.

This is a trusted, initially pristine JS runtime contract, not process isolation:
an immutable constructor accessor, or a frozen foreign/subclass Promise with an
unprovable species path, cannot be safely observed using public ECMAScript APIs.
Such out-of-contract containers must already have rejection handling owned by
their producer. The runner rejects them without executing their accessors, but
cannot promise process survival or confidentiality of their unhandled rejection.
Do not use global rejection listeners or relaxed Node flags to hide that limit.

## S3a — durable records and process-owned writer lock (local experiment)

`execution-store.mjs` supplies `openExecutionStore({specsRoot, identity,
fingerprints, create})` and a frozen `snapshot() / append() / close()` interface.
Identity contains repositoryId/runId; fingerprints contains workflow/config/inputs
SHA256 values supplied by the trusted host. Callers must use an explicit synthetic
local specs directory, not a production project, network mount or synchronized drive.

A separate `.reviews/.execution/writer.sqlite` connection holds one SQLite
`BEGIN IMMEDIATE` transaction for the entire store lifetime. It is not the old
`.cm-run.lock` log lock. The lock file is never deleted or replaced on close;
the kernel releases process ownership on death. Other Node connections and a
Python SQLite connection must fail to acquire it while held. SQLite is reused
from `node:sqlite`, with no package install or extra process. This experimental
path is platform-gated to macOS with Node 24.14+; verified runtime is Node 24.14.0 / SQLite 3.51.2.
Node still emits its experimental SQLite warning, which is not suppressed.

Versioned, hash-bound JSON lives in `.reviews/.execution/<runId>/state.json`.
Records are immutable intent/result/cancel/commit-intent/commit-result/finalized
facts, not a second task-completion database. A record label cannot approve or
dispatch anything. `append({id,kind,payload,expectedRevision})` checks exact ID
retries and revision conflicts, limits each payload to 1 MiB, each committed
document to 16 MiB and 1024 records, and run-directory bytes plus write headroom
to 32 MiB. Crash temps are retained, not silently deleted or replayed as results.

Writes use a same-directory exclusive temp, file fsync, atomic rename and parent
fsync. Required initialization sync failures fail closed. A post-rename failure
is `store_write_unknown`; poisoned handles reject both snapshot and append until
closed and reopened. Old snapshots remain immutable history. Reopen validates
what actually exists, rejects missing/corrupt/unknown-version records, changed
fingerprints, links and permissions, and never initializes a missing existing run.
Validation compares canonical JSON against the original bytes, so invalid UTF-8
cannot be replacement-decoded into a valid record. The lock accepts only its exact
v1 schema and full object inventory, with no ignored SQLite/internal-name objects;
unrecognized structure is refused and retained, not migrated automatically.

```bash
node --test experiments/js-orchestration/execution-store.test.mjs
```

The tests use actual child-process contention and SIGKILL plus controlled I/O
faults. They do not demonstrate power-loss durability or other platforms.
Same-privilege malicious file replacement remains outside the trusted-host
contract. This store is not yet wired to the S2b runner or the legacy Python
mark-done path: S3b must integrate their common ownership, cancellation, recovery
and final task revision checks before any real task writes are enabled.

## S3b-1 — task owner binding and the legacy writer

`task-owner.mjs` adds the trusted-host `openTaskExecutionStore({tasksPath, feature,
...storeOptions})` entry. It validates inputs before creating one canonical owner
binding at `<tasks-parent>/.reviews/.cm-task-owner.json`. The binding location is
derived from the actual task path, not a caller-selected reviews root. Different
roots cannot claim the same tasks file. Matching existing bindings are checked
and synced; corrupt/partial/unknown records stay blocked and are not repaired.

The Python `mark-done` compatibility writer now uses that same binding plus the
bound root's SQLite lifetime transaction. A live JS owner blocks it; retained JS
run evidence also blocks legacy `already_done` after the process exits. Read-only
checks remain unchanged. Raw `openExecutionStore` is still a synthetic storage
primitive with no task authority; future task-enabled code must use the wrapper.
The wrapper stores records but does not itself mark a task complete or dispatch.

These local tests cover actual Node/Python contention, initializer races, SIGKILL,
binding sync failures, canonical UTF-8 parity and malformed metadata. Tested new
path is macOS / Node24.14 / Python3.9.6; not a cross-platform or power-loss claim.
For consistent local protocol behavior, numbered feature prefixes are ASCII-only;
exact feature names including Chinese remain valid. Other historic Unicode numeric
prefixes explicitly refuse; no file rename or migration is performed. Windows
legacy-only behavior is retained only in the absence of new protocol evidence.

This is the ownership portion of S3b, not complete durable checkbox commit,
unknown-result reconciliation, cancellation/logging recovery or real activation.
No new post-checkbox fsync/retry behavior has been added. Review/host permission,
finalization, old-binary exclusion and distribution gates are still required.

Task-enabled entries refuse any pre-existing `writer.sqlite-journal` before native
SQLite open, preserving even empty/ordinary journals rather than automatically
recovering interrupted initialization. Python preflights retained runs/unknown
objects too, and validates the pinned target's UTF-8/exact checkbox before owner
creation. This preflight is not atomic against a competing initializer's crash;
closing that unproven interleaving remains a real-activation prerequisite.

## S3b-2a — cooperative initialization certificate (local experiment)

The shared writer now publishes a private, immutable `writer-ready.json` only
after exclusive initialization commits and syncs, while its lifetime SQLite
transaction is held. Existing DBs require a matching certificate and database
SHA-256 before native open. Uncertified old experimental DBs and interrupted
initialization refuse without automatic recovery/adoption. Both Node (including
the raw store) and Python use the same canonical bytes and ordering.

This closes the tested cooperative initialization crash interleaving described
above; it is not durable task commit/cancellation/replay or real activation.
The trusted host uses one canonical module instance on one thread and must not
read/close the writer database independently. The runtime keeps its inspection
descriptor open until after SQLite closes and guards same-process reentry. This
follows SQLite's [POSIX lock warning](https://www.sqlite.org/howtocorrupt.html#_posix_advisory_locks_canceled_by_a_separate_thread_doing_close_):
closing any descriptor for that DB can cancel process-wide advisory locks.
No worker-thread, arbitrary native-connection or same-privilege hostile-host claim.

## S3b-2b — durable synthetic task runner

`createTaskRunner({...options, persistence: {store, mode: 'create' | 'resume'}})`
uses a trusted, already-owned `openTaskExecutionStore` handle dedicated to one task.
The workflow/worker does not receive that handle. Without persistence the S2b
in-memory interface remains available. No dependencies, providers or task-file
writers are introduced here; `commit` still returns a **synthetic fixture** result.

The first record pins original file bytes, normalized host route metadata and one
invocation session UUID. Effects write an intent before invoking any callback,
then a checkpoint before publishing success. Resume validates the entire ordered
history, reconstructs actual requests and independent review receipts, and retains
both attempts, their prior findings and immutable effect cache. It never snapshots
the developer's edits as a new baseline. Resumable effects recheck on-disk content.
Completed history is not fresh approval of subsequently modified files.

Cancellation/workflow errors are durable control records: an exception after
approval cannot regain approval on restart. An unmatched intent restores
`unknown/reconciliation_required`, even when an interrupted fixture commit wrote
its marker; **no automatic retry**. Durable status/checkpoints retain the monotonic
`cancellationRequested` flag even when recovery is unknown; historical cache keeps
its original value. Missing checkpoint/cache flags refuse, not auto-fill. This
flag is not a rollback or a guarantee that work stopped. Live write,
rename, sync and capacity failures poison the runner (`unknown/store_failure`),
abort cooperative callbacks and block new effects. The host MUST NOT automatically
resume a run known to have suffered a storage failure, even if an atomic rename
left readable bytes; explicit reconciliation is still a later slice. In-flight
uncooperative callbacks may continue, but late results cannot authorize new work.

The complete encoded record (including store envelope) cap is 1 MiB and the run
cap 16 MiB, lower than some S2a package limits;
oversize history is rejected, never truncated. Store fingerprints must cover the
real host/workflow dependency graph and policy; hashing a closure's source text is
not sufficient. Storage/metadata matching does not authenticate an arbitrary host.
This experimental host remains cooperative, single-threaded, single-module-owned,
with quiescent code and separate code/specs roots. Tests include actual subprocess
SIGKILL and local storage failures, not power-loss, production completion, real
provider cancellation, reconciliation or automatic migration/adoption of old runs.

## S3b-2c1 — reuse the read-only Python N5 seam

The existing gate now exposes `prepare-mark-done` and `verify-mark-done-plan`.
They validate the same independent N5 evidence and exact task/evidence revisions,
but return a bounded, byte-preserving proposal without changing any task or lock.
The private plan includes complete task bytes; it must not be sent to telemetry.
Opaque revision digests avoid rounding inode/nanosecond integers in JS. Full
schema/encoding/limits are documented in `runtime/task-gates.md`.

No fixture receipt is translated into a real review document, and no second JS
N5 rule set exists. This interface does not prove actual code contents or reviewer
execution and cannot replace the content-bound host gate. Existing durable runner
v1 is unchanged. A later separately reviewed commit/reconciliation component must
compose the seam under owned storage; this slice does not mark real tasks complete.

## S3b-2c2a — genuine task owner identity

Host-only `taskOwnerTarget(store)` accepts only the exact handle returned by this
canonical `task-owner.mjs` instance, then rechecks its binding and private raw
store snapshot/lifetime. It returns frozen `{tasksPath,feature,specsRoot}` from
validated private options. Raw stores, copied methods, wrappers and proxies
refuse without invoking caller properties. Matching run IDs do not imply the
same target. A returned identity is not a continuing lease, pinned task contents,
review approval or write authority; future commit must recheck the genuine handle
and compare target/feature/root immediately before writing. No task writes,
lock borrowing, duplicate-module/global branding or platform expansion is added.

## S3b-2c2b — fixture task commit and read-only observation

`commitFixtureTask(store,input,signal?)` is a synchronous, host-only experiment,
not an installed entry or runner-v1 completion adapter. It requires a genuine
task owner, independent synthetic N5 documents, actual fixture runner receipt/
registration and the same content-bound review package/checks. Code and specs
roots are separate. It never turns fixture receipts into real review documents.
No available review is not approval. Only macOS/Node24.14+ is supported here.

It invokes only the fixed local Python prepare/verify seam (10s/1MiB output), then
uses a separate dedicated empty store's `cm-task-commit` intent/result grammar.
Intent precedes0600 exclusive temporary creation; full after bytes and original
mode are synced before replacement. Final source/proof, N5 evidence/task revisions,
owner/parent and temporary inode/bytes/mode checks precede rename. Parent sync
and durable result precede `fixture_committed`. Errors after intent admission stay
`commit_unknown`; retained evidence is not removed, tasks are never rolled back,
and nonempty histories cannot retry. Delivered cancellation is checked before
rename, not retroactively afterward. Synchronous calls cannot observe queued events.
Each cancellation read rejects proxies before reflection and requires the captured
native signal prototype, at most64 own data properties and all pristine native
symbol slots. Accessor-bearing/subclass/unsupported shapes refuse without invoking
caller callbacks; mid-commit shape changes retain `commit_unknown`. Ordinary native
controller/abort/timeout/any signals are supported. This is callback-free admission
in the trusted Node host, not authentication of signal origin or a hostile-VM sandbox.

`observeFixtureCommit(store)` explicitly reports full-image/mode `observed_before`,
`observed_after` or `conflict`, plus a nullable **historical** recorded outcome.
It does not write, repair, approve, retry or synthesize missing completion. New
owner-open failures remain failures; no bypass creates an observation. Known
storage errors require host quarantine/explicit reopen, not automatic continuation.
Neither matching `[x]` nor matching full bytes proves fresh review or a durable
past fsync. Root/task corruption may prevent even acquiring a new owner.

Strict input<=16MiB, task/evidence reads<=256KiB, complete stored record<=1MiB.
Private plans contain full task bytes and must not enter public/global logs.
Trusted cooperative single-process/module and quiescent-filesystem assumptions
remain: no hostile same-UID CAS, power-loss proof, real provider auth, finalization,
entry migration or cross-platform activation. Tests use temporary trees, simulated
I/O failures and actual subprocess SIGKILL; default V1 runner behavior is unchanged.

## S3b-2c3a — explicit V2 journal grammar, not runner wiring

The internal `task-commit-codec.mjs` reuses the standalone C2b plan/intent/result
validation without filesystem operations or approval authority. Native standalone
writing, owner checks, evidence rereads and cancellation admission are unchanged.

`readRunnerHistory(records,config,2)` explicitly admits a composed V2 history.
Default V1 parsing refuses V2, and V2 refuses V1 or mixed records. V2 requires
complete global store envelopes/chains, a pinned owner/fingerprints/review-directory
and two handoff selectors. It also enforces the V1 host's initialization data rules:
initial attempt1, bounded timeout, exact provider descriptors, boolean eligibility
and independent unique reviewer contexts. Nested commit intent/result can appear only inside the
matching complete effect, binding actual global record digests and the reducer's
reconstructed baseline/package/checks/receipt/call. Every evidence path belongs to
the configured review directory and includes current/prior selected handoffs.
No history is filtered, projected, renumbered or automatically adopted.

V2 adds only a bounded `taskCommit` reference to state/checkpoint/status/cache;
the full plan remains in the intent. A nested result without its outer complete
checkpoint still restores `unknown/reconciliation_required`. A known unknown
checkpoint with a commit reference stays unknown after a later workflow error;
historical cache and cancellation facts remain intact. The internal `transaction`
reader result contains parsed records, not write/review authority. Record and
history limits include the nested wrapper and complete store envelope.

This slice supplies grammar validation only. Root identity still uses the existing
read-only canonical-root check; it does not read task files or create a writer.
Standalone C2b still requires an empty dedicated store. See the explicit fixture
V2 wiring below; this reader alone does not dispatch effects or write task files.

## S3b-2c3b — explicit owned-store fixture wiring

`createTaskRunner({...common,persistence:{store,mode:'create',version:2},
taskCompletion:{reviewsDir,handoffs:[firstAttempt,secondAttempt]}})` opts into V2.
Omit the generic V1 `commit` callback. `store` must be the genuine live handle from
`openTaskExecutionStore`; copied methods, raw stores and inferred version upgrades
are refused. The directory must already exist and selectors must match the fixed
canonical owner layout; absent future handoff leaves are allowed at initialization.
Use `mode:'resume'` with exactly matching metadata and an explicitly reopened owner.
V1/standalone histories are never projected or automatically adopted.

All effects, nested native intent/result and controls use the same runner journal
cursor and owner/lock. Every full-envelope candidate is checked against the V2
grammar before append and verified against exact durable readback. Recursive
guard/append entry, unknown storage failures or foreign revisions poison the host:
no further appends/effects, no rollback, and no synthetic failure checkpoint.
An ordinary native failure with usable storage may retain an unknown checkpoint.

A private, short-lived token binds the native writer to the pending complete
effect and internally reconstructed proof input. No token issuer, journal callback,
raw proof bundle or store is exposed through workflow/worker context. The internal
fixed-action resolver validates that live token/exact store first and returns only
frozen binding/digest/phase data. It cannot register a caller-supplied capability.
The token is revoked on every native exit before the outer checkpoint gap. The
writer reuses the same synchronous C2b filesystem/Python/cancellation sequence,
with no second mutable journal cursor. This is a trusted host boundary, not an
adversarial same-process module sandbox.

Only nested result **and** durable outer checkpoint publish/cache historical
`fixture_completed`. Any missing outer checkpoint resumes unknown without replay,
even when task bytes already changed or a nested result exists. Cancellation
delivered before committing prevents the write; during the synchronous commit it
is recorded as late-cancel if delivered at a completed operation boundary. Queued
events do not preempt synchronous native/Python calls. Old cache entries remain
historical, and commit unknown cannot become approval after workflow errors.

All tests use isolated synthetic fixtures, including genuine SQLite ownership and
actual SIGKILL windows. Synthetic review receipts and separately prepared N5 test
documents do not prove real reviewer execution. No composed observation API,
real provider bridge, installed entry, automatic recovery, learning integration,
task finalization/run_done or cross-platform activation is provided by this slice.

## S3b-2c3c — read-only composed observation

`observeRunnerFixture(store)` takes exactly one already-open genuine owner. It
validates the entire V2 history against actual owner/run/fingerprints, without
constructing a runner, projecting records, invoking Python/checks/providers or
opening/closing/writing the store. It returns frozen versioned diagnostic data:
`identity`, `observedImage`, `recordedNativeOutcome`, `recordedRunnerState`,
`recordedRunnerCode`, and the existing bounded `taskCommit` reference.

`not_observed` means no nested intent/comparison image, not proof of zero writes.
Otherwise the image is `observed_before`, `observed_after` or `conflict`, comparing
complete bytes and mode under the recorded parent pin. The parent is checked both
before and after the bounded task read (also in the standalone observer). Native
result and runner state remain separate: after-image or nested success without
an outer checkpoint still means runner unknown. Runner state/code are the parser's
deterministic interpretation; an unmatched tail does not imply an unknown checkpoint
was physically written. Neither field is fresh review, live policy or retry authority.

Final owner/store revision must stay unchanged, including no-intent/conflict
returns. Empty store fails `runner_missing`; bad/non-V2/unbound history fails
`runner_history_invalid`. Genuine owner/store failures are not swallowed as task
conflicts. Existing V2 root validation still requires readable code-root metadata:
missing root fails history validation. Source/evidence file contents are not
reread, and observation does not erase known host quarantine. It returns no plan,
task/source bytes, full config, receipt registry or next-action capability. This
is fixture-only historical diagnosis, not reconciliation or installed activation.

## S4-C1a — provider review observation, not completion authority

`provider-review-observation.mjs` adds pure
`inspectProviderReview(observationText, expectationText)`. It consumes bounded JSON
strings and reuses the existing review-package and review-result validation. No
CLI, network, file read/write, generated-code execution or dependency is added by
the inspector. The current event dialect describes sanitized Codex B1 records;
Claude event adaptation is not implemented here.

The expected request must be a self-consistent `requestFor` reviewer envelope with
a valid review package. The observation binds its request digest to that envelope.
Actual provider thread IDs are checked against the developer and excluded threads;
logical context names never substitute for actual thread identity. Caller-supplied
expectations/recordings are data: hashes establish consistency, not authenticity
or proof that a fresh dispatch happened. Current-tree validation remains the host's
responsibility; a removed code root does not invalidate this offline inspection.

The supported successful stream is thread.started, turn.started, one completed
agent_message, turn.completed, then process_closed with exit0/no signal/no timeout.
Incomplete prefixes remain unknown. Unknown/duplicate/out-of-order/tool events
reject; unsupported reasoning/event dialects must be adapted explicitly later.
Classification priority is timeout, explicit cancellation, incomplete/failure,
then completed. SIGTERM alone is unknown, not user cancellation: the existing
adapter can send that signal when handling failures. Missing/failed/cancelled
transports never export a review verdict, even if their payload says approved.

Inspection returns `cm-provider-review-inspection` with separate transport status
and validated review result, `effectiveModel:null`, and always
`completionEligible:false`. It cannot be passed to legacy `terminalFor` or
`checkCompletion`; an integration fixture verifies that returning it from a
reviewer callback leaves the existing runner unknown with no receipt or commit.
An approved model answer is never converted into a fixture channel or N4/N5 proof.

This is an **offline prerequisite**, not a completed live adapter. Existing
task-runner, durable grammar, gates and B1 worker are unchanged. C0's greeting
smoke is historical evidence of that smaller protocol, not a review-package result
under this new contract. Live invocation registration, supported host permissions,
decision/cancellation ownership and versioned runner integration still require
their own verification before real task writes or completion can be enabled.

## S4-C1b-V3 — host-authorized reviewer invocation fixture

Persistence version 3 is an explicit reviewer-only extension of the genuine
task-owned V2 runner. It requires exactly one allowed/available Codex reviewer with
a stable adapter ID, actual developer/excluded provider-thread IDs, and a trusted
synchronous host authorization callback. The callback sees the exact content-bound
review request and returns a short-lived, digest-bound grant. Invalid, denied, stale,
wrong-identity, wrong-package, wrong-context or wrong-adapter grants stop before any
adapter call. Hashes establish record consistency; they do not authenticate the host,
provider, model, remote thread or human decision.

The runner durably appends `review-invocation-registered` before calling the adapter,
then optionally appends the first accepted `review-invocation-started`, and finally
one `review-invocation-result`. A final dispatch-time sample can instead record
`not_dispatched` for expiry or clock failure. Provider events are sanitized through
the existing C1a inspector; the synchronous event sink seals before terminal result
append, so post-settlement callbacks are no-write no-ops. An invalid event records the
human-approved `{outcome:'unknown',reason:'observation_invalid',inspection:null}`
variant rather than pretending it was a cancellation, timeout or process crash.

After durable registration, provider-thread binding and a complete successful event
stream, V3 validates the package-bound review result and creates the existing
internally registered `host-authorized` review receipt. An approved receipt is
eligible only through the existing `checkCompletion` gate and complete effect;
V3 observation itself never writes a task. Valid incomplete observations, invalid
events, timeout, and every crash prefix after registration restore as unknown and
reconciliation-required without a receipt; resume and repeated effect IDs never
authorize or dispatch a retry. A cancelled result requires the runner's prior durable
cancel control. Timeout and cancel describe local control only and do not prove remote
termination or billing cessation.

This slice is exercised only with isolated local fixtures and the existing task-owned
SQLite store. It makes no real provider call, reads no credentials, installs nothing,
writes no real `tasks.md`, and adds no Claude/developer observation, fallback route,
hook or general invocation ledger.
V1/V2 payload/status golden hashes and their existing suites remain compatibility
canaries. F01 is still incomplete because remote provenance and actual host/provider
integration are not established.

## P1 — `cm-ai` N1–N2 read-only admission

`cm-ai-admission.mjs` adds a fixed, synchronous inspection boundary for the
existing `cm-ai` workflow. Given explicit specs and code-project directories, it
reads the specification approval state, numbered feature triplets, optional
test-case hashes, `0.bootstrap` conditions, task markers, explicit dependencies,
and historical review filenames. It returns frozen diagnostic data with one of
`awaiting_spec_approval`, `blocked`, `ready`, or `complete` plus the selected task
when one is eligible.

Generic continuation language such as `继续` is not specification approval. An
explicit `开始` response or `assumeYes:true` is reported only as approval intent;
this module still does not update `.cm-specs-status`. The approval file realpath must
remain inside the specs root. Approved test-case inventory and raw-byte SHA-256 values
must match the current files, and each optional test contract realpath must remain in
its own feature. The approved feature inventory must match the discovered numbered
directories, and no full feature name may collide with any unnumbered review slug.
Required triplet realpaths
must remain inside their feature root. Existing test contracts reuse the repository
validator and may reference only structured AC declarations and actual `tasks.md`
task rows in their own feature. `[x]` and `[DROPPED]` tasks remain terminal,
`[CHANGED]` tasks remain executable, invalid dependencies block, and historical
review filenames are matched by both feature and task before suppressing the existing
compatibility warning. A `.reviews` symlink is rejected rather than treated as local
review evidence.

The implementation has no provider, worker, review, completion, logging, Git,
installation, or real-project write path. It does not run N3–N8, implement the
Learning loop, add Claude compatibility, or introduce a generic workflow registry,
pipeline, DAG, or task-state database. Its tests use temporary fixtures and compare
fixture bytes before and after inspection; they are local behavior evidence, not
independent acceptance or proof of a live workflow run.

## F01-2 — offline Codex reviewer call wiring

`codex-review-adapter.mjs` is a fixed bridge from the existing V3 Codex reviewer
request to the existing `codexWorker` `{prompt}` input. It validates the complete
request digest, Codex reviewer role, package identity and exact package shape, then
serializes only the review package, prior review and derived examined paths after a
fixed instruction block. Package file bytes remain base64 JSON data; their contents
cannot alter process arguments, schema selection or adapter configuration. The
matching `review-result.schema.json` describes the current `reviewResult` shape;
the existing JS validator, not JSON Schema or model text, still owns package/path/
verdict consistency.

The worker retains its existing argument transport by default. Review wiring opts
into stdin, launches `codex exec ... -`, and never places the review package in argv.
Stdin write failure stops that one process and never falls back or retries. A stdin
worker also requires a preflight receipt explicitly marked `prompt_transport: stdin`;
legacy argument preflight remains valid only for the default argument path. This
field is local trusted-host consistency metadata, not provider authentication.

The local-only `previewTools`/`previewIsolated` probe has the same explicit
`promptTransport: 'stdin'` option. In that mode it sends its fixed canary through
stdin, records `prompt_transport: stdin`, and fails closed on a missing or failed
stdin writer; its default remains the legacy argument canary. This probe still
targets only the loopback synthetic sink and records `real_model_requests: 0`, so a
passing receipt is transport/isolation evidence, not proof of a live provider call.

The adapter does not issue dispatch grants or decisions and does not own registration,
thread attribution, cancellation, timeout, recovery or replay. Those remain in the
already accepted reviewer-only V3 runner. A composed approved fake response can create
the existing registered receipt only after V3 validates the complete observation;
the pure inspector still reports `completionEligible:false`, and no task changes until
the separate complete effect passes the existing gate. Denied authorization dispatches
nothing; signal-only incomplete output is unknown; explicit cancel is durable; reopen
and repeated effects never redispatch.

All new coverage uses an injected fake child process and isolated temporary files.
No real Codex/provider/CLI call, credential operation, installed entry, dialogue
start/status adapter, N3 project write, F02 review credential, N5 completion, Claude
path or Learning loop is provided or proven. In particular, fixture success is not
fresh remote-context evidence and does not complete F01.

## F01-3 — current Codex conversation entry

`cm-ai-conversation-entry.mjs` is a fixed, dependency-free host boundary over the
existing read-only admission inspector and an already opened V3 task runner. It
accepts only `start`, `status`, `decision`, `complete`, `qa`, `qa_result`,
`context_refresh`, `finish`, `run_finalize`, `cancel`, and `resume`, binds them to an
explicit feature plus the runner identity, and returns a small frozen status summary.
It owns no queue, request ledger, workflow state,
timer, provider, storage or task writer, and creates no second log format.

`start` and safe `resume` submit deterministic `develop-N` effects. `status` is
read-only. `cancel` delegates to the runner's durable cancel control. A review effect
requires `{status:'approved'}` through the trusted constructor boundary; an approval
field in the operation message is rejected, and a denied host decision dispatches
nothing. The existing V3 `authorize(request)` callback remains solely responsible for
issuing and validating the request-bound review dispatch grant.

`complete` requires the current package digest and an `approved` or already-completed
runner state, then submits deterministic `complete-N` through the same runner. The
existing gate and native task owner remain the only completion path; repeated requests
reuse the durable result. A completed task is reported with `pendingAction: qa`, not
`run_done`.

After completion, the runner's existing read-only `status()` revalidates the current
code-project tree against the approved review package. Changed code, tests, or project
instructions retain the historical `fixture_completed` state but project
`correction_review_required`; `complete`, QA, N7, and N8 return a blocked outcome
without writing logs or status. The durable completed task, prior evidence, and
attempt remain unchanged. This detection does not reopen work, create attempt 3,
or authorize a correction; restoring the exact approved bytes removes the projection,
while a real post-completion correction still requires the existing explicit review
process.

`qa` is the thin N6 decision boundary, not a QA executor. Only a trusted constructor
decision may record `triggered`, `skipped`, or `blocked`; that decision carries its own
stable decision id, full task identity, and completed package digest. The adapter calls
the existing `cm-log-event.py` writer so the specs-local `运行日志.jsonl` remains
authoritative. An exact retry reuses the one N6 decision; a different decision for the
same run/feature/task/attempt/package is rejected. A trigger records the need for real
QA and returns `pendingAction: qa_execution`; a skip continues to `context_refresh`; a
block stops. Missing or mismatched decisions, stale packages, pre-completion requests,
and log failures do not advance. Actual QA still owns `test_run` evidence and cannot be
replaced by this routing record.

`qa_result` is read-only. It accepts only a test-run operation id and the current
package selector, then verifies the existing specs log contains an earlier N6
`triggered` decision followed by one bound `test_run/start` and one
`test_run/complete`. When QA has multiple rounds, the latest bound `start` in the
authoritative log is the only selectable round; an older operation id is stale and
an incomplete latest round does not fall back to an earlier PASS. Bound round starts
must be exactly `1`, then `2`, then `3`; repeats, gaps, backwards attempts, and a reset
after round three are rejected. `PASS`/`PASSED`
advances to `context_refresh` only when the
aggregate counts are internally consistent, no `case_blocked` exists, and the logged
report is a real non-symlink file under the specs `.reviews/` root. `FAIL`/`FAILED`
and `BLOCKED`/`NEEDS_MANUAL` stop. Missing, contradictory, stale, reordered, or
out-of-root evidence is rejected. This reader neither writes test events nor runs or
repairs tests.

`inspectCmAiTaskLearningInput` is the first read-only F05 seam. For the current
disk-selected task it reuses the N7 context reader, then returns only task-bound
metadata for optional specs `LESSONS.md`, root `AGENTS.md`, and trusted applicable
nested `AGENTS.md` files. Duplicate applicable paths collapse to one entry; missing
optional files mean an empty input, while task mismatch or unsafe paths reject. The
digest changes with task identity or input bytes. It does not return file contents,
select lessons, or write project files. The existing conversation `start`/developing
`resume` path now captures this metadata before dispatch and attaches it to the one
`develop` effect. That effect is persisted in the existing runner journal and included
in the developer request. Learning-enabled task runners pin the expected feature in
their existing durable config and accept only project `AGENTS.md` or specs `LESSONS.md`
metadata. Exact replay reuses the original effect; the same effect id cannot replace it
with changed Learning bytes. Runners that do not opt in keep the prior effect contract.
This input seam adds no separate Learning store; the current writer, handoff, review,
and completion integrations are described below.

`createCmAiTaskLearningApplication` records the developer's task-start Learning use
without copying source contents. It binds the feature, full task identity, and fixed
Learning digest to either one `applied` note in the form “lesson -> verification
action” or `no_relevant_lesson`. Its deterministic
`cm-learning-application-v1:` encoding stays inside the existing handoff
`evidence[]`; there is no new handoff schema or automatic lesson selector.

`createCmAiTaskLearningRetrospective` is the read-only F05 closeout seam. It binds one
task retrospective to the feature, full task identity, and that task's Learning input
digest, and accepts exactly `no_new_lesson`, `lesson_candidate`, or
`writeback_pending`. A candidate contains only its `structured`/`memory_only`
classification, one-line trigger and action, and bounded relative evidence paths;
at most three candidates are accepted. `encodeCmAiTaskLearningEvidence` emits one
deterministic `cm-learning-retrospective-v1:` string that fits the existing handoff
`evidence[]` field. It does not alter the handoff schema, insert the string into a
handoff, write AGENTS/LESSONS/logs, or affect review/completion yet.

`attachCmAiTaskLearningEvidence` is the narrow N3 handoff-construction seam. The
trusted host supplies the task's fixed Learning input together with the retrospective;
the helper binds feature, full identity, and Learning digest before appending exactly
one retrospective string to the existing `evidence[]`. Exact replay is idempotent and
a different retrospective entry is rejected. The helper preserves the remaining
handoff fields and leaves schema validation to the existing Python handoff gate. It
does not write the handoff file, interpret candidate writeback as complete, or connect
Learning to review, N5, the runner, or a second completion path.

A Learning-enabled task runner exposes `attachLearningEvidence({handoff, application,
retrospective})`, but it succeeds only after the current attempt's develop effect
reaches `awaiting_review`. The runner obtains the fixed `learningInput` from its existing
validated effect cache, including after journal recovery; the caller cannot submit a
replacement Learning snapshot. Legacy runners do not expose this method. The method
still returns data only: it does not write the handoff, update AGENTS/LESSONS, start
review, or change completion state.

`writeCmAiProjectLearning` is the standalone F05 project writer seam. It accepts one
already-bound task Learning input and retrospective. `no_new_lesson` performs no disk
write; candidates are inserted under the root `AGENTS.md` `## 项目教训` section with a
stable semantic marker, source identity, evidence paths, and the existing
`[已结构化]`/`[仅记忆]` classification. Exact lessons are deduplicated. The writer
compares the root AGENTS file with the task-start metadata, rejects links and changed
bytes, writes through a same-directory temporary file, fsyncs, renames, and rereads
the result. Unsafe, concurrent, oversized, or failed writes return
`writeback_pending`. The writer itself does not update LESSONS, a handoff, review
state, N5, or any separate store; its runner call site is described below.

Learning-enabled task runners now require the successful developer result to carry
that attempt's bound application record and retrospective. The runner calls the same project writer
synchronously before checks and review-package construction, then records the
application, retrospective, and validated writeback result inside the existing effect checkpoint.
After a successful project writeback, it also updates the selected existing N3
handoff before checks. The application and retrospective are appended to the existing `evidence[]`,
and a newly written root `AGENTS.md` is added to `changed_files[]`. The handoff keeps
schema v1 and is validated by the existing Python gate before and after an atomic
replacement; an unsafe, invalid, missing, or concurrently changed handoff stops the
develop effect in `unknown` before review.
Only the review baseline is extended with root `AGENTS.md`; the developer request
keeps its original write scope. A written AGENTS digest must match the review-package
change, while `no_new_lesson` and deduplicated results cannot conceal a developer
AGENTS edit. `writeback_pending` stops before review with
`learning_writeback_pending`. Legacy runners still accept only
`{outcome: "implemented"}` and keep their previous scope and state shape. This does
not add a Learning store or lock service, write LESSONS, or create another
review/completion path.
On attempt two, a `no_new_lesson` result may retain the already-reviewed AGENTS change
from attempt one when its current digest matches the new task-start Learning input;
an unbound edit in the current developer call is still rejected.

Before a Learning-enabled `complete` effect enters the existing native completion
path, the runner rereads the selected handoff and checks that its Learning evidence
matches the current attempt's journaled application, retrospective, and writeback. A `written`
AGENTS result must also be present in the handoff's existing `changed_files[]`.
Mismatch blocks with `package_mismatch`; it does not create a second completion path.
Historical checkpoints created before application evidence existed continue through this
same path using their already-bound retrospective and writeback only when the handoff also
contains no application claim. Mixed old-checkpoint/new-handoff evidence is rejected;
newly created checkpoints must include bound application evidence.
The existing review-package check still owns current project bytes and the existing
Python N5/native transaction still owns handoff/review revisions and the task write.
Legacy runners do not perform this Learning-only check.

`context_refresh` is the read-only N7 boundary. It is available only after the same
package has either one recorded N6 skip or a latest legal QA `PASS`; missing,
incomplete, failed, blocked, or mismatched evidence cannot bypass N6. It reruns the
existing admission inspector against disk, rereads the current feature's
`requirements.md`, `design.md`, and `tasks.md`, plus optional specs `LESSONS.md`, root
`AGENTS.md`, trusted-host-supplied applicable nested `AGENTS.md` paths,
`.claude/CLAUDE.md`, referenced rules, and the three baseline compatibility rules when
present. Applicable paths must be project-root-relative, remain inside the real project
root, and name regular non-symlink files. The response contains only relative paths,
SHA-256 values, and one aggregate context digest, never file contents. A selected task
returns `pendingAction: start_next_task`; all-terminal task state returns
`pendingAction: finish` for the later N8 boundary. A renewed specification approval
gate or blocked admission remains visible instead of looping back to QA. It writes no
status or log, starts no task, and does not run N8.

`finish` is only the first, read-only N8 boundary. It repeats the N6 evidence check and
disk admission; all-terminal state hashes every approved feature contract, not only the
last feature. Without a trusted constructor-side documentation result it returns
`pendingAction: documentation_sync`. A blocked result stops, while a completed result
must bind the full task identity, current package, and current all-feature context
digest before returning `pendingAction: run_finalize`. Operation-message self-reports
are rejected by the strict shape. This route does not invoke `cm-doc-syncer`, write
README/CHANGELOG/status/logs, reconcile resources, create a durable receipt, or emit
`run_done`; those remain the following finalization step.

`run_finalize` repeats the same N6, all-terminal disk-context, and bound completed
documentation-result checks. It then delegates the only `run_done` write to the
existing `cm-log-event.py`, preserving its resource guard, authoritative project log,
global-mirror degradation, run pointer, and deterministic deduplication. Only after
that authoritative write succeeds does the adapter atomically replace the existing
`.cm-status.json` with `N8/run_done`. A known-invalid status target is rejected before
logging; a status commit failure after logging returns `run_finalize_unknown`, and a
retry deduplicates the same `run_done` before repairing the status file. This route
does not run `cm-doc-syncer`, QA, metrics/release work, a provider, or a runner effect.

Awaiting review, observed review, unknown, cancelled, and blocked states do not
auto-review, retry, reconcile, or complete. The entry exports only `handle`; it does
not implement QA execution, documentation-sync execution, metrics/release work,
Learning writes, Claude execution, installation or release. All completion, N6, N7,
and N8 tests use isolated temporary tasks/logs and synthetic decisions/review evidence,
not a real project or provider.
