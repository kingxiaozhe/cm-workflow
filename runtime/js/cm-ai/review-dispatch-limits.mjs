// Pure data shared by durable-runner-state.mjs and the light operator-guidance.mjs. No imports on
// purpose: operator-guidance is copied into partial runtimes (scripts/cm-check-drive.test.mjs), so it
// must not pull in the runner's dependency graph. scripts/cm-ai-light-modules.test.mjs guards that.

// A review that never started a reviewer (see durable-runner-state.mjs): bounds and limit codes.
export const MAX_REVIEW_NOT_DISPATCHED_RETRIES=2;
export const MAX_REVIEW_NOT_DISPATCHED_EXTENSIONS=1;
export const REVIEW_NOT_DISPATCHED_LIMIT_CODE='review_not_dispatched_limit';
export const MAX_REVIEW_DENIAL_CONFIRMATIONS=2;
export const REVIEW_DENIAL_LIMIT_CODE='review_permission_denied_limit';
// The only manual step left once a never-started review has no in-run exit: the review
// process never started, so there is no writer to wait for; cancel is accepted from this raw
// pending_review end and supersede accepts the cancelled run (reviewed-evidence-supersede.mjs).
// The external-run guard still refuses a strict prior run whose last review was voided
// before dispatch (strictPriorAttemptResolved), so that case has no new-run exit at all.
export const REVIEW_NEVER_STARTED_MANUAL_STEP='要继续这个任务：先用 cancel 取消本运行（审查从未启动，没有需要等待停下的写入方）；另存或还原本运行留在盘上的代码改动；'
  +'再用 --supersede-reviewed-evidence --supersede-reason 原因 新建运行重做。不要加 --accept-superseded-code-drift：那会把这些没审过的改动当成已有代码，新运行的审查看不到它们。'
  +'原运行若是外部模型或执行策略运行，外部运行守卫可能拒绝同一代码根上的新运行（被派发前作废的审查记录仍带对账标记）；守卫拒绝时本运行没有别的出口，保留运行记录与代码，把本 reason 交给维护者。';
