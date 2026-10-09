// Q14: the N6 QA budget is three rounds of product evidence. A round that ended
// because of the host or the session's answer (no answer before the deadline or
// a host death, a host-judged evidence or environment gap, a session-declared
// BLOCKED) and was superseded for exactly that reason does not count; at most
// two such rounds are given back per run. Operator decisions (a declared
// environment failure, a configuration revision) and product FAILs still count.
export const QA_BASE_ROUNDS=3;
export const QA_EXTRA_ROUNDS=2;
export const QA_MAX_ROUNDS=QA_BASE_ROUNDS+QA_EXTRA_ROUNDS;
export const NON_PRODUCT_SUPERSESSIONS=Object.freeze(['host_request_timeout','host_evidence_problem']);
export const nonProductSupersession=reason=>NON_PRODUCT_SUPERSESSIONS.includes(reason);
// The highest round that may start once `freed` such supersessions are recorded.
export const qaRoundLimit=freed=>QA_BASE_ROUNDS+Math.min(QA_EXTRA_ROUNDS,freed);
