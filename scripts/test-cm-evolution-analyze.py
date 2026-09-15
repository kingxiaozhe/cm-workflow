#!/usr/bin/env python3
"""Executable behavior fixture for cm-evolution-analyze.py."""

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "cm-evolution-analyze.py"
HASH_REF = re.compile(r"^sha256:[0-9a-f]{64}$")


def event(run_id, event_name, **fields):
    row = {
        "schema_version": 1,
        "run_id": run_id,
        "workflow": "cm-ai",
        "event": event_name,
    }
    row.update(fields)
    return row


def write_jsonl(path, rows):
    path.write_bytes(
        b"".join(
            json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            + b"\n"
            for row in rows
        )
    )


def invoke(paths, timeout=30):
    command = [sys.executable, str(SCRIPT)]
    for path in paths:
        command.extend(["--log", str(path)])
    return subprocess.run(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )


def success(paths):
    result = invoke(paths)
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")
    assert result.stderr == b"", result.stderr
    assert result.stdout.count(b"\n") <= 1
    parsed = json.loads(result.stdout.decode("utf-8"))
    assert list(parsed) == ["schema_version", "status", "summary", "signals", "diagnostics"]
    assert parsed["schema_version"] == 1
    assert parsed["signals"] == sorted(parsed["signals"], key=lambda item: item["fingerprint"])
    assert parsed["diagnostics"] == sorted(
        parsed["diagnostics"], key=lambda item: item["code"]
    )
    return parsed, result.stdout


def fail_closed(paths, forbidden=()):
    result = invoke(paths, timeout=60)
    assert result.returncode == 2, (result.returncode, result.stderr[:300])
    assert result.stdout == b""
    assert b"Traceback" not in result.stderr
    for value in forbidden:
        assert str(value).encode("utf-8") not in result.stderr
    return result


def diagnostic_codes(payload):
    return {item["code"] for item in payload["diagnostics"]}


def git_status_hash():
    result = subprocess.run(
        ["git", "status", "--porcelain=v1", "-uall", "-z"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return hashlib.sha256(result.stdout).hexdigest()


def test_healthy_and_recovered_warning(temp):
    log = temp / "healthy.jsonl"
    write_jsonl(
        log,
        [
            event("20260901T120000Z-run00001", "run_start", phase="start"),
            event(
                "20260901T120000Z-run00001",
                "warning",
                recovered=True,
                node="N3",
                phase="retry",
                error_type="temporary_io",
            ),
            event("20260901T120000Z-run00001", "run_done", phase="complete"),
        ],
    )
    payload, _ = success([log])
    assert payload["status"] == "no_signal"
    assert payload["signals"] == []
    assert payload["summary"] == {
        "files": 1,
        "lines": 3,
        "valid_events": 3,
        "signal_events": 0,
        "malformed_lines": 0,
    }


def test_repeat_threshold_and_same_run_duplicate(temp):
    one = temp / "one.jsonl"
    repeated = temp / "repeated.jsonl"
    duplicate = temp / "duplicate.jsonl"
    signal = {
        "node": "N4",
        "phase": "review",
        "error_type": "contract_mismatch",
    }
    write_jsonl(one, [event("20260901T120000Z-run00001", "error", **signal)])
    payload, _ = success([one])
    assert payload["status"] == "observe"
    assert payload["signals"][0]["classification"] == "observe"
    assert payload["signals"][0]["distinct_runs"] == 1

    one_degrade = temp / "one-degrade.jsonl"
    write_jsonl(
        one_degrade,
        [
            event(
                "20260901T120000Z-run00001",
                "degrade",
                phase="global_log",
                error_type="mirror_unavailable",
            )
        ],
    )
    payload, _ = success([one_degrade])
    assert payload["status"] == "observe"
    assert payload["signals"][0]["signal_kind"] == "degrade"

    write_jsonl(
        repeated,
        [event("20260901T120100Z-run00002", "error", detail="changed", **signal)],
    )
    payload, _ = success([one, repeated])
    assert payload["status"] == "candidate"
    assert payload["signals"][0]["classification"] == "candidate"
    assert payload["signals"][0]["reason"] == "repeated_across_runs"
    assert payload["signals"][0]["distinct_runs"] == 2

    write_jsonl(
        duplicate,
        [
            event("20260901T120000Z-run00001", "error", **signal),
            event("20260901T120000Z-run00001", "error", event_id="different", **signal),
        ],
    )
    payload, _ = success([duplicate])
    assert payload["status"] == "observe"
    assert payload["signals"][0]["occurrences"] == 2
    assert payload["signals"][0]["distinct_runs"] == 1

    invalid_runs = temp / "invalid-runs.jsonl"
    write_jsonl(
        invalid_runs,
        [
            event("bad1", "error", **signal),
            event("bad2", "error", **signal),
        ],
    )
    payload, _ = success([invalid_runs])
    assert payload["status"] == "observe"
    assert payload["signals"][0]["classification"] == "observe"
    assert payload["signals"][0]["distinct_runs"] == 0
    assert "invalid_run_id" in diagnostic_codes(payload)

    missing_run = temp / "missing-run.jsonl"
    missing_run_event = event("placeholder", "error", **signal)
    del missing_run_event["run_id"]
    write_jsonl(missing_run, [missing_run_event])
    payload, _ = success([missing_run])
    assert payload["status"] == "observe"
    assert payload["signals"][0]["distinct_runs"] == 0


def test_determinism_and_dynamic_fields(temp):
    first = temp / "first.jsonl"
    second = temp / "second.jsonl"
    rows_a = [
        event(
            "20260901T120000Z-run00001",
            "degrade",
            phase="global_log",
            error_type="mirror_unavailable",
            event_id="a",
            at="2026-09-01T12:00:00-07:00",
            duration_ms=12,
            detail="first wording",
        ),
        event(
            "20260901T120100Z-run00002",
            "degrade",
            phase="global_log",
            error_type="mirror_unavailable",
            event_id="b",
            at="2026-09-01T12:01:00-07:00",
            duration_ms=99,
            detail="second wording",
        ),
    ]
    write_jsonl(first, rows_a[:1])
    write_jsonl(second, rows_a[1:])
    left, left_bytes = success([first, second])

    write_jsonl(first, [dict(rows_a[1], event_id="new-b", detail="new")])
    write_jsonl(second, [dict(rows_a[0], event_id="new-a", detail="new")])
    right, right_bytes = success([first, second])
    assert left_bytes == right_bytes
    assert left == right


def test_distinct_scope_or_cause_changes_fingerprint(temp):
    log = temp / "different.jsonl"
    write_jsonl(
        log,
        [
            event(
                "20260901T120000Z-run00001",
                "error",
                node="N3",
                phase="execute",
                error_type="timeout",
            ),
            event(
                "20260901T120000Z-run00001",
                "error",
                node="N4",
                phase="execute",
                error_type="timeout",
            ),
            event(
                "20260901T120000Z-run00001",
                "error",
                node="N3",
                phase="execute",
                error_type="schema_mismatch",
            ),
        ],
    )
    payload, _ = success([log])
    assert len(payload["signals"]) == 3
    assert len({item["fingerprint"] for item in payload["signals"]}) == 3


def test_insufficient_and_conflicting_signatures(temp):
    log = temp / "insufficient.jsonl"
    write_jsonl(
        log,
        [
            event(
                "20260901T120000Z-run00001",
                "error",
                node="N3",
                phase="execute",
            ),
            event(
                "20260901T120000Z-run00001",
                "review",
                task="T-101",
                phase="retry",
                outcome="changes_requested",
            ),
        ],
    )
    payload, _ = success([log])
    assert payload["status"] == "observe"
    assert payload["signals"] == []
    assert {"insufficient_signature", "conflicting_signal_state"} <= diagnostic_codes(payload)


def test_privacy_hashes_and_secret_rejection(temp):
    log = temp / "private-name.jsonl"
    raw_task = "T-private-42"
    raw_run = "20260901T120000Z-run00001"
    secret_task = "authorization-token"
    credential_shaped = "AKIA" + "IOSFODNN7EXAMPLE"
    slack_credential = "xoxb-" + "123456789012-123456789012-abcdefghijklmnopqrstuvwx"
    fine_grained_pat = "github_" + "pat_11AA22BB33CC44DD55EE66FF77GG"
    write_jsonl(
        log,
        [
            event(
                raw_run,
                "review",
                task=raw_task,
                phase="retry",
                detail=str(temp / "must-not-leak"),
                unknown_field="private-payload",
            ),
            event(
                "20260901T120100Z-run00002",
                "warning",
                recovered=False,
                task=secret_task,
                phase="retry",
                error_type="policy_miss",
            ),
            event(
                "20260901T120200Z-run00003",
                "degrade",
                phase="global_log",
                error_type=credential_shaped,
            ),
            event(
                "20260901T120300Z-run00004",
                "degrade",
                phase="global_log",
                error_type=slack_credential,
            ),
            event(
                "20260901T120400Z-run00005",
                "warning",
                recovered=False,
                task=fine_grained_pat,
                phase="execute",
                error_type="policy_miss",
            ),
            event(
                "20260901T120500Z-run00006",
                "warning",
                recovered=False,
                task=fine_grained_pat,
                phase="execute",
                error_type="policy_miss",
            ),
        ],
    )
    payload, raw = success([log])
    assert raw_task.encode() not in raw
    assert raw_run.encode() not in raw
    assert str(temp).encode() not in raw
    assert b"private-payload" not in raw
    assert secret_task.encode() not in raw
    assert credential_shaped.encode() not in raw
    assert slack_credential.encode() not in raw
    assert fine_grained_pat.encode() not in raw
    assert len(payload["signals"]) == 1
    signal = payload["signals"][0]
    assert HASH_REF.match(signal["signature"]["scope_ref"])
    assert all(HASH_REF.match(item) for item in signal["run_refs"])
    assert "secret_shaped_token" in diagnostic_codes(payload)


def test_resource_terminal_and_high_risk_rules(temp):
    resources = temp / "resources.jsonl"
    write_jsonl(
        resources,
        [
            event(
                "20260901T120000Z-run00001",
                "resource",
                phase="cleanup_failed",
                resource_id="fixture-001",
                resource_kind="fixture",
                at="2026-09-01T12:00:00-07:00",
            ),
            event(
                "20260901T120000Z-run00001",
                "resource",
                phase="released",
                resource_id="fixture-001",
                resource_kind="fixture",
                at="2026-09-01T12:01:00-07:00",
            ),
            event(
                "20260901T120100Z-run00002",
                "resource",
                phase="cleanup_failed",
                resource_id="fixture-002",
                resource_kind="fixture",
                at="2026-09-01T12:02:00-07:00",
            ),
        ],
    )
    payload, raw = success([resources])
    assert payload["status"] == "candidate"
    assert len(payload["signals"]) == 1
    signal = payload["signals"][0]
    assert signal["signal_kind"] == "resource_cleanup_failed"
    assert signal["reason"] == "high_risk_invariant"
    assert b"fixture-001" not in raw and b"fixture-002" not in raw

    cross_workflow = temp / "cross-workflow-resource.jsonl"
    write_jsonl(
        cross_workflow,
        [
            event(
                "20260901T130000Z-run00003",
                "resource",
                workflow="cm-ai",
                phase="cleanup_failed",
                resource_id="fixture-003",
                resource_kind="fixture",
                at="2026-09-01T13:00:00-07:00",
            ),
            event(
                "20260901T130000Z-run00003",
                "resource",
                workflow="cm-fix",
                phase="released",
                resource_id="fixture-003",
                resource_kind="fixture",
                at="2026-09-01T13:01:00-07:00",
            ),
        ],
    )
    payload, _ = success([cross_workflow])
    assert payload["signals"] == []

    invalid_run_resource = temp / "invalid-run-resource.jsonl"
    write_jsonl(
        invalid_run_resource,
        [
            event(
                "short",
                "resource",
                phase="cleanup_failed",
                resource_id="fixture-004",
                resource_kind="fixture",
                at="2026-09-01T13:02:00-07:00",
            )
        ],
    )
    payload, raw = success([invalid_run_resource])
    assert payload["status"] == "candidate"
    assert payload["signals"][0]["signal_kind"] == "resource_cleanup_failed"
    assert payload["signals"][0]["reason"] == "high_risk_invariant"
    assert payload["signals"][0]["occurrences"] == 1
    assert payload["signals"][0]["distinct_runs"] == 0
    assert payload["signals"][0]["run_refs"] == []
    assert "invalid_run_id" in diagnostic_codes(payload)
    assert b"short" not in raw

    invalid_workflow_release = temp / "invalid-workflow-release.jsonl"
    write_jsonl(
        invalid_workflow_release,
        [
            event(
                "20260901T130000Z-run00004",
                "resource",
                workflow="cm-ai",
                phase="cleanup_failed",
                resource_id="fixture-005",
                resource_kind="fixture",
                at="2026-09-01T13:03:00-07:00",
            ),
            event(
                "20260901T130000Z-run00004",
                "resource",
                workflow="authorization-token",
                phase="released",
                resource_id="fixture-005",
                resource_kind="fixture",
                at="2026-09-01T13:04:00-07:00",
            ),
        ],
    )
    payload, raw = success([invalid_workflow_release])
    assert payload["status"] == "observe"
    assert payload["signals"] == []
    assert "secret_shaped_token" in diagnostic_codes(payload)
    assert b"authorization-token" not in raw

    high_risk = temp / "high-risk.jsonl"
    write_jsonl(
        high_risk,
        [
            event(
                "20260901T120000Z-run00001",
                "error",
                recovered=False,
                outcome="blocked",
                impact="data_integrity",
                node="N5",
                phase="completion",
                error_type="state_mismatch",
            ),
            event(
                "20260901T120100Z-run00002",
                "error",
                recovered=True,
                outcome="blocked",
                impact="data_integrity",
                node="N6",
                phase="completion",
                error_type="recovered_state",
            ),
        ],
    )
    payload, _ = success([high_risk])
    kinds = {item["signal_kind"]: item for item in payload["signals"]}
    assert kinds["high_risk_error"]["classification"] == "candidate"
    assert kinds["high_risk_error"]["reason"] == "high_risk_invariant"
    assert kinds["error"]["classification"] == "observe"

    invalid_run_high_risk = temp / "high-risk-invalid-run.jsonl"
    write_jsonl(
        invalid_run_high_risk,
        [
            event(
                "short",
                "error",
                recovered=False,
                outcome="blocked",
                impact="security",
                node="N5",
                phase="completion",
                error_type="state_mismatch",
            )
        ],
    )
    payload, _ = success([invalid_run_high_risk])
    assert payload["status"] == "candidate"
    assert payload["signals"][0]["classification"] == "candidate"
    assert payload["signals"][0]["distinct_runs"] == 0
    assert payload["signals"][0]["run_refs"] == []


def test_warning_review_qa_and_run_refs_cap(temp):
    log = temp / "signals.jsonl"
    rows = []
    for index in range(130):
        rows.append(
            event(
                f"20260901T12{index:04d}Z-run{index:05d}",
                "warning",
                recovered=False,
                task="T-101",
                phase="execute",
                error_type="retry_budget",
            )
        )
    rows.extend(
        [
            event(
                "20260901T140000Z-review01",
                "task_review",
                task="T-101",
                outcome="changes_requested",
            ),
            event(
                "20260901T140100Z-qa000001",
                "test_run",
                case_id="AC-109-case-1",
                phase="case_blocked",
            ),
        ]
    )
    write_jsonl(log, rows)
    payload, _ = success([log])
    kinds = {item["signal_kind"]: item for item in payload["signals"]}
    warning = kinds["unrecovered_warning"]
    assert warning["classification"] == "candidate"
    assert warning["distinct_runs"] == 130
    assert len(warning["run_refs"]) == 128
    assert warning["run_refs_truncated"] is True
    assert kinds["review_retry"]["signature"]["review_state"] == "changes_requested"
    assert kinds["qa_blocked"]["signature"]["qa_state"] == "case_blocked"


def test_malformed_inputs_are_inert(temp):
    log = temp / "malformed.jsonl"
    marker = temp / "must-not-exist"
    read_sentinel = temp / "do-not-read"
    if os.name != "nt":
        os.mkfifo(read_sentinel)
    deep_json = ("[" * 1200 + "]" * 1200).encode("ascii") + b"\n"
    adversarial = event(
        "20260901T120000Z-run00001",
        "run_start",
        phase="start",
        payload=f"__import__('os').system('touch {marker}')",
        source_path=str(read_sentinel),
    )
    invalid_high_risk = event(
        "20260901T120100Z-run00002",
        "error",
        recovered=False,
        outcome="blocked",
        impact=[],
        node="N5",
        phase="completion",
        error_type="bad_impact_type",
    )
    invalid_recovered = [
        event(
            run_id,
            "error",
            recovered="false",
            outcome="blocked",
            impact="data_integrity",
            node="N5",
            phase="completion",
            error_type="bad_recovered_type",
        )
        for run_id in (
            "20260901T120200Z-run00003",
            "20260901T120300Z-run00004",
        )
    ]
    non_standard_json = (
        b'{"schema_version":1,"run_id":"20260901T120400Z-run00005",'
        b'"workflow":"cm-ai","event":"error","node":"N3",'
        b'"phase":"execute","error_type":"non_standard_json","unknown":NaN}\n'
    )
    overflow_float_json = (
        b'{"schema_version":1,"run_id":"20260901T120500Z-run00006",'
        b'"workflow":"cm-ai","event":"error","node":"N3",'
        b'"phase":"execute","error_type":"overflow_float","unknown":1e309}\n'
    )
    infinity_json = non_standard_json.replace(b"NaN", b"Infinity")
    negative_infinity_json = non_standard_json.replace(b"NaN", b"-Infinity")
    log.write_bytes(
        b'{"broken":\n'
        + b"\xff\n"
        + deep_json
        + b"[]\n"
        + json.dumps(
            event(
                "20260901T120000Z-run00001",
                "warning",
                recovered="false",
                task="T-101",
                phase="execute",
                error_type="wrong_type",
            ),
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
        + json.dumps(adversarial, separators=(",", ":")).encode("utf-8")
        + b"\n"
        + json.dumps(invalid_high_risk, separators=(",", ":")).encode("utf-8")
        + b"\n"
        + b"".join(
            json.dumps(row, separators=(",", ":")).encode("utf-8") + b"\n"
            for row in invalid_recovered
        )
        + non_standard_json
        + infinity_json
        + negative_infinity_json
        + overflow_float_json
    )
    payload, raw = success([log])
    assert not marker.exists()
    assert payload["status"] == "observe"
    assert payload["signals"] == []
    assert payload["summary"]["malformed_lines"] >= 8
    assert {"invalid_utf8", "malformed_json", "non_object", "invalid_field_type"} <= diagnostic_codes(payload)
    assert str(marker).encode() not in raw


def test_ambiguous_resource_terminal(temp):
    log = temp / "ambiguous.jsonl"
    common = {
        "run_id": "20260901T120000Z-run00001",
        "resource_id": "fixture-001",
        "resource_kind": "fixture",
        "at": "2026-09-01T12:00:00-07:00",
    }
    write_jsonl(
        log,
        [
            event(common.pop("run_id"), "resource", phase="cleanup_failed", **common),
            event(
                "20260901T120000Z-run00001",
                "resource",
                phase="released",
                **common,
            ),
        ],
    )
    payload, _ = success([log])
    assert payload["signals"] == []
    assert "ambiguous_resource_terminal" in diagnostic_codes(payload)


def test_fail_closed_limits_and_paths(temp):
    no_args = subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    assert no_args.returncode == 2 and no_args.stdout == b""

    missing = temp / "private-missing-name.jsonl"
    fail_closed([missing], forbidden=[missing])
    fail_closed([temp], forbidden=[temp])

    too_many = []
    for index in range(33):
        path = temp / f"empty-{index}.jsonl"
        path.write_bytes(b"")
        too_many.append(path)
    fail_closed(too_many, forbidden=too_many)

    long_line = temp / "long-line.jsonl"
    long_line.write_bytes(b"x" * 65_537)
    fail_closed([long_line], forbidden=[long_line])

    too_large = temp / "too-large.jsonl"
    with too_large.open("wb") as handle:
        handle.seek(64 * 1024 * 1024)
        handle.write(b"x")
    fail_closed([too_large], forbidden=[too_large])

    too_many_lines = temp / "too-many-lines.jsonl"
    too_many_lines.write_bytes(b"{}\n" * 200_001)
    fail_closed([too_many_lines], forbidden=[too_many_lines])

    too_many_fingerprints = temp / "too-many-fingerprints.jsonl"
    write_jsonl(
        too_many_fingerprints,
        [
            event(
                "20260901T120000Z-run00001",
                "error",
                node=f"Node{index}",
                phase="execute",
                error_type="unique_failure",
            )
            for index in range(1001)
        ],
    )
    fail_closed([too_many_fingerprints], forbidden=[too_many_fingerprints])

    if os.name != "nt":
        symlink_target = temp / "symlink-target.jsonl"
        symlink_target.write_bytes(b"{}\n")
        symlink_input = temp / "symlink-input.jsonl"
        symlink_input.symlink_to(symlink_target)
        fail_closed([symlink_input], forbidden=[symlink_input, symlink_target])

        unreadable = temp / "unreadable.jsonl"
        unreadable.write_bytes(b"{}\n")
        unreadable.chmod(0)
        try:
            if not os.access(unreadable, os.R_OK):
                fail_closed([unreadable], forbidden=[unreadable])
        finally:
            unreadable.chmod(stat.S_IRUSR | stat.S_IWUSR)


def test_sensitive_run_identity_is_inert(temp):
    log = temp / "sensitive-run.jsonl"
    for run_id in ("authorization-token", "AKIA" + "IOSFODNN7EXAMPLE"):
        write_jsonl(log, [event(
            run_id, "error", recovered=False, outcome="blocked",
            impact="security", node="N5", phase="completion",
            error_type="state_mismatch",
        )])
        payload, raw = success([log])
        assert payload["signals"] == []
        assert payload["status"] != "candidate"
        assert "secret_shaped_token" in diagnostic_codes(payload)
        assert run_id.encode() not in raw


def test_node_and_task_identifier_boundaries(temp):
    log = temp / "scope-grammar.jsonl"
    for node in ("1", "N" * 65):
        for event_name, fields in (
            ("error", {"phase": "execute", "error_type": "scope_check"}),
            ("review", {"phase": "retry"}),
        ):
            write_jsonl(log, [event(run_id, event_name, node=node, **fields)
                              for run_id in ("run00001", "run00002")])
            payload, _ = success([log])
            assert payload["signals"] == []
            assert "invalid_identifier" in diagnostic_codes(payload)
    for field, value in (("node", "N" * 64), ("task", "1"), ("task", "T" * 128)):
        write_jsonl(log, [event(run_id, "error", phase="execute",
                              error_type="scope_check", **{field: value})
                          for run_id in ("run00001", "run00002")])
        payload, _ = success([log])
        assert payload["status"] == "candidate"


def test_surrogate_resource_run_is_inert(temp):
    log = temp / "surrogate-run.jsonl"
    for run_id in ("\ud800", "\udfff", "run\ud800id"):
        row = event(run_id, "resource", phase="cleanup_failed",
                    resource_id="fixture-001", resource_kind="fixture",
                    at="2026-09-01T12:00:00Z")
        log.write_text(json.dumps(row, ensure_ascii=True) + "\n", encoding="utf-8")
        payload, _ = success([log])
        assert payload["signals"] == []
        assert "invalid_run_id" in diagnostic_codes(payload)


def test_no_filesystem_or_worktree_mutation(temp):
    log = temp / "readonly.jsonl"
    write_jsonl(
        log,
        [
            event(
                "20260901T120000Z-run00001",
                "error",
                node="N3",
                phase="execute",
                error_type="readonly_check",
            )
        ],
    )
    input_before = hashlib.sha256(log.read_bytes()).hexdigest()
    directory_before = sorted(path.name for path in temp.iterdir())
    worktree_before = git_status_hash()
    success([log])
    assert hashlib.sha256(log.read_bytes()).hexdigest() == input_before
    assert sorted(path.name for path in temp.iterdir()) == directory_before
    assert git_status_hash() == worktree_before


def main():
    tests = [
        test_healthy_and_recovered_warning,
        test_repeat_threshold_and_same_run_duplicate,
        test_determinism_and_dynamic_fields,
        test_distinct_scope_or_cause_changes_fingerprint,
        test_insufficient_and_conflicting_signatures,
        test_privacy_hashes_and_secret_rejection,
        test_resource_terminal_and_high_risk_rules,
        test_warning_review_qa_and_run_refs_cap,
        test_malformed_inputs_are_inert,
        test_ambiguous_resource_terminal,
        test_fail_closed_limits_and_paths,
        test_no_filesystem_or_worktree_mutation,
        test_sensitive_run_identity_is_inert,
        test_node_and_task_identifier_boundaries,
        test_surrogate_resource_run_is_inert,
    ]
    with tempfile.TemporaryDirectory(prefix="cm-evolution-fixture-") as raw_temp:
        temp_root = Path(raw_temp)
        for index, test in enumerate(tests, start=1):
            case_temp = temp_root / f"case-{index:02d}"
            case_temp.mkdir()
            test(case_temp)
            print(f"PASS {index:02d} {test.__name__}")
    print(f"PASS all {len(tests)} cm-evolution fixture groups")
    print("cm evolution analyzer fixtures: PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
