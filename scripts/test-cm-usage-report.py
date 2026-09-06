#!/usr/bin/env python3
"""Dependency-free behavior fixture for CM model-usage observability."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, List


ROOT = Path(__file__).resolve().parents[1]
WRITER = ROOT / "scripts" / "cm-log-event.py"
REPORTER = ROOT / "scripts" / "cm-usage-report.py"


def write_jsonl(path: Path, rows: List[Dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def invoke_writer(log_home: Path, data: Dict[str, object], expected_exit: int = 0) -> subprocess.CompletedProcess[str]:
    payload = {
        "stage": "design_generation",
        "adapter": "company-api",
        "requested_model": "planner-default",
        "source": "api",
        "purpose": "cm-prd:design_generation",
        **data,
    }
    env = os.environ.copy()
    env["CM_WORKFLOW_LOG_HOME"] = str(log_home)
    result = subprocess.run(
        [
            sys.executable,
            str(WRITER),
            "--workflow",
            "cm-prd",
            "--event",
            "model_usage",
            "--phase",
            "complete",
            "--runtime",
            "codex",
            "--run-id",
            "usage-fixture-0001",
            "--detail",
            "planner model call completed",
            "--data-json",
            json.dumps(payload),
        ],
        cwd=ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    if result.returncode != expected_exit:
        raise AssertionError(
            f"expected exit {expected_exit}, got {result.returncode}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def invoke_claim(
    log_home: Path,
    data: Dict[str, object],
    expected_exit: int = 0,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["CM_WORKFLOW_LOG_HOME"] = str(log_home)
    result = subprocess.run(
        [
            sys.executable,
            str(WRITER),
            "--workflow",
            "cm-prd",
            "--event",
            "model_call",
            "--phase",
            "claimed",
            "--runtime",
            "codex",
            "--run-id",
            "usage-fixture-0001",
            "--detail",
            "planner model call claimed",
            "--data-json",
            json.dumps(data),
        ],
        cwd=ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    if result.returncode != expected_exit:
        raise AssertionError(
            f"expected exit {expected_exit}, got {result.returncode}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def invoke_report(log_home: Path, *args: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [sys.executable, str(REPORTER), "--log-home", str(log_home), *args],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"report failed with {result.returncode}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="cm-usage-") as tmp:
        home = Path(tmp).resolve()

        accepted = invoke_writer(
            home,
            {
                "call_id": "planner-call-0001",
                "role": "planner",
                "adapter": "company-api",
                "requested_model": "planner-default",
                "effective_model": "provider-model-v2",
                "usage_state": "observed",
                "input_tokens": 1200,
                "output_tokens": 300,
                "cache_read_tokens": 800,
                "cache_write_tokens": 100,
                "duration_ms": 2500,
                "outcome": "success",
            },
        )
        payload = json.loads(accepted.stdout)
        run_log = Path(payload["global_log"])
        event = json.loads(run_log.read_text(encoding="utf-8").splitlines()[0])
        assert event["input_tokens"] == 1200
        assert event["cache_read_tokens"] == 800

        second_call_data = {
            "call_id": "planner-call-0002",
            "role": "planner",
            "adapter": "company-api",
            "requested_model": "planner-default",
            "effective_model": "provider-model-v2",
            "usage_state": "observed",
            "input_tokens": 1200,
            "output_tokens": 300,
            "cache_read_tokens": 800,
            "cache_write_tokens": 100,
            "duration_ms": 2500,
            "outcome": "success",
        }
        second_call = invoke_writer(home, second_call_data)
        second_payload = json.loads(second_call.stdout)
        assert second_payload["deduplicated"] is False
        assert len(run_log.read_text(encoding="utf-8").splitlines()) == 2
        retry = invoke_writer(home, second_call_data)
        retry_payload = json.loads(retry.stdout)
        assert retry_payload["deduplicated"] is True
        assert len(run_log.read_text(encoding="utf-8").splitlines()) == 2
        changed_retry_data = dict(second_call_data)
        changed_retry_data["output_tokens"] = 301
        changed_retry = invoke_writer(home, changed_retry_data, expected_exit=2)
        assert "call_id already used with different payload" in changed_retry.stderr

        late_claim = invoke_claim(
            home,
            {
                "call_id": "planner-call-0001",
                "stage": "design_generation",
                "role": "planner",
                "adapter": "company-api",
                "requested_model": "planner-default",
                "source": "api",
                "purpose": "cm-prd:design_generation",
            },
            expected_exit=2,
        )
        assert "call_id already completed" in late_claim.stderr

        incomplete_claim = invoke_claim(
            home,
            {
                "call_id": "planner-incomplete-claim",
                "role": "planner",
            },
            expected_exit=2,
        )
        assert "requires a non-empty stage" in incomplete_claim.stderr

        identity_claim = invoke_claim(
            home,
            {
                "call_id": "planner-identity-mismatch",
                "stage": "design_generation",
                "role": "planner",
                "adapter": "company-api",
                "requested_model": "planner-default",
                "source": "api",
                "purpose": "cm-prd:design_generation",
            },
        )
        assert json.loads(identity_claim.stdout)["global_written"] is True
        identity_mismatch = invoke_writer(
            home,
            {
                "call_id": "planner-identity-mismatch",
                "stage": "other_stage",
                "role": "analyst",
                "adapter": "other-api",
                "requested_model": "analyst-default",
                "source": "api",
                "purpose": "cm-prd:other_stage",
                "usage_state": "observed",
                "input_tokens": 1,
                "output_tokens": 1,
                "outcome": "success",
            },
            expected_exit=2,
        )
        assert "identity does not match model_call claim" in identity_mismatch.stderr

        managed_without_claim = invoke_writer(
            home,
            {
                "call_id": "managed-without-claim",
                "role": "planner",
                "adapter": "openai-compatible",
                "usage_state": "observed",
                "input_tokens": 999,
                "output_tokens": 111,
                "outcome": "success",
            },
            expected_exit=2,
        )
        assert "requires a prior model_call claim" in managed_without_claim.stderr

        rejected = invoke_writer(
            home,
            {
                "call_id": "planner-negative-0001",
                "role": "planner",
                "usage_state": "observed",
                "input_tokens": -1,
                "output_tokens": 1,
                "outcome": "success",
            },
            expected_exit=2,
        )
        assert "non-negative integer" in rejected.stderr

        secret = invoke_writer(
            home,
            {
                "call_id": "planner-secret-0001",
                "role": "planner",
                "usage_state": "observed",
                "input_tokens": 1,
                "output_tokens": 1,
                "access_token": "must-not-log",
                "outcome": "success",
            },
            expected_exit=2,
        )
        assert "sensitive log field" in secret.stderr

        prompt = invoke_writer(
            home,
            {
                "call_id": "planner-prompt-0001",
                "role": "planner",
                "usage_state": "observed",
                "input_tokens": 1,
                "output_tokens": 1,
                "prompt": "must-not-log",
                "outcome": "success",
            },
            expected_exit=2,
        )
        assert "unsupported fields" in prompt.stderr

        unavailable_with_counts = invoke_writer(
            home,
            {
                "call_id": "planner-unavailable-counts-0001",
                "role": "planner",
                "usage_state": "unavailable",
                "input_tokens": 0,
                "output_tokens": 0,
                "outcome": "success",
            },
            expected_exit=2,
        )
        assert "cannot contain token counts" in unavailable_with_counts.stderr

        unavailable_duration = invoke_writer(
            home,
            {
                "call_id": "planner-unavailable-duration-0001",
                "role": "planner",
                "usage_state": "unavailable",
                "duration_ms": 700,
                "outcome": "success",
            },
        )
        assert json.loads(unavailable_duration.stdout)["global_written"] is True

        unavailable_run = "usage-fixture-0002"
        duplicate_row = dict(event)
        conflicting_duplicate = dict(event)
        conflicting_duplicate["event_id"] = "conflicting-call-event"
        conflicting_duplicate["output_tokens"] = 301
        unavailable_row: Dict[str, object] = {
            "schema_version": 1,
            "event_id": "unavailable-event",
            "run_id": unavailable_run,
            "at": "2026-08-06T11:00:00+00:00",
            "workflow": "cm-ai",
            "event": "model_usage",
            "phase": "complete",
            "runtime": "codex",
            "project": "fixture",
            "detail": "usage unavailable",
            "call_id": "coder-call-0001",
            "stage": "task_execution",
            "role": "coder",
            "adapter": "subscription-runtime",
            "requested_model": "coder-default",
            "source": "subscription",
            "purpose": "cm-ai:task_execution",
            "usage_state": "unavailable",
            "duration_ms": 700,
            "outcome": "success",
        }
        failed_unavailable_row: Dict[str, object] = {
            **unavailable_row,
            "event_id": "unavailable-error-event",
            "call_id": "coder-call-0002",
            "at": "2026-08-06T11:00:30+00:00",
            "duration_ms": 400,
            "outcome": "error",
        }
        unresolved_claim: Dict[str, object] = {
            "schema_version": 1,
            "event_id": "unresolved-claim-event",
            "run_id": unavailable_run,
            "at": "2026-08-06T11:00:45+00:00",
            "workflow": "cm-ai",
            "event": "model_call",
            "phase": "claimed",
            "runtime": "codex",
            "project": "fixture",
            "detail": "reviewer call claimed",
            "call_id": "reviewer-call-unresolved",
            "stage": "task_review",
            "role": "reviewer",
            "adapter": "openai-compatible",
            "requested_model": "reviewer-default",
            "source": "api",
            "purpose": "cm-ai:task_review",
        }
        malformed_base: Dict[str, object] = {
            "schema_version": 1,
            "run_id": unavailable_run,
            "at": "2026-08-06T11:01:00+00:00",
            "workflow": "cm-ai",
            "event": "model_usage",
            "phase": "complete",
            "runtime": "codex",
            "project": "fixture",
            "detail": "malformed fixture",
            "stage": "task_execution",
            "role": "coder",
            "adapter": "company-api",
            "requested_model": "coder-default",
            "source": "api",
            "purpose": "cm-ai:task_execution",
            "usage_state": "observed",
            "outcome": "success",
        }
        malformed_rows = [
            {
                **malformed_base,
                "event_id": "malformed-missing-input",
                "call_id": "malformed-call-0001",
                "output_tokens": 4,
            },
            {
                **malformed_base,
                "event_id": "malformed-bool-input",
                "call_id": "malformed-call-0002",
                "input_tokens": True,
                "output_tokens": 4,
            },
            {
                **malformed_base,
                "event_id": "malformed-negative-output",
                "call_id": "malformed-call-0003",
                "input_tokens": 4,
                "output_tokens": -1,
            },
        ]
        mismatched_claim: Dict[str, object] = {
            **unresolved_claim,
            "event_id": "mismatched-claim-event",
            "call_id": "mismatched-call-0001",
        }
        mismatched_usage: Dict[str, object] = {
            **malformed_base,
            "event_id": "mismatched-usage-event",
            "call_id": "mismatched-call-0001",
            "workflow": "cm-prd",
            "stage": "design_generation",
            "role": "planner",
            "adapter": "other-api",
            "requested_model": "planner-default",
            "purpose": "cm-prd:design_generation",
            "input_tokens": 10,
            "output_tokens": 2,
        }
        conflicting_claim_one: Dict[str, object] = {
            **unresolved_claim,
            "event_id": "conflicting-claim-one",
            "call_id": "conflicting-call-0001",
        }
        conflicting_claim_two: Dict[str, object] = {
            **conflicting_claim_one,
            "event_id": "conflicting-claim-two",
            "stage": "design_generation",
            "role": "planner",
            "requested_model": "planner-default",
            "purpose": "cm-ai:design_generation",
        }
        conflicting_usage: Dict[str, object] = {
            **malformed_base,
            "event_id": "conflicting-usage-event",
            "call_id": "conflicting-call-0001",
            "stage": "task_review",
            "role": "reviewer",
            "adapter": "openai-compatible",
            "requested_model": "reviewer-default",
            "source": "api",
            "purpose": "cm-ai:task_review",
            "input_tokens": 10,
            "output_tokens": 2,
        }
        usage_before_claim: Dict[str, object] = {
            **conflicting_usage,
            "event_id": "usage-before-claim-event",
            "call_id": "usage-before-claim-0001",
        }
        claim_after_usage: Dict[str, object] = {
            **conflicting_claim_one,
            "event_id": "claim-after-usage-event",
            "call_id": "usage-before-claim-0001",
        }
        managed_without_claim_row: Dict[str, object] = {
            **conflicting_usage,
            "event_id": "managed-without-claim-event",
            "call_id": "managed-without-claim-0002",
        }
        write_jsonl(
            home / "index.jsonl",
            [
                {
                    "schema_version": 1,
                    "at": "2026-08-06T10:00:00+00:00",
                    "run_id": "usage-fixture-0001",
                    "status": "done",
                    "workflow": "cm-prd",
                    "runtime": "codex",
                    "project": "fixture",
                    "log_file": str(run_log.relative_to(home)),
                },
                {
                    "schema_version": 1,
                    "at": "2026-08-06T11:00:00+00:00",
                    "run_id": unavailable_run,
                    "status": "done",
                    "workflow": "cm-ai",
                    "runtime": "codex",
                    "project": "fixture",
                    "log_file": f"runs/2026-08/{unavailable_run}.jsonl",
                },
            ],
        )
        write_jsonl(run_log, [event, duplicate_row, conflicting_duplicate])
        write_jsonl(
            home / f"runs/2026-08/{unavailable_run}.jsonl",
            [
                unavailable_row,
                failed_unavailable_row,
                unresolved_claim,
                mismatched_claim,
                mismatched_usage,
                conflicting_claim_one,
                conflicting_claim_two,
                conflicting_usage,
                usage_before_claim,
                claim_after_usage,
                managed_without_claim_row,
                *malformed_rows,
            ],
        )

        machine = invoke_report(home, "--last", "2", "--json")
        report = json.loads(machine.stdout)
        assert report["unresolved_claim_policy"] == "reported-not-counted"
        assert report["summary"]["observed_calls"] == 1
        assert report["summary"]["unavailable_calls"] == 2
        assert report["summary"]["unresolved_claims"] == 4
        assert report["summary"]["invalid_calls"] == 8
        assert report["summary"]["outcomes"] == {
            "success": 2,
            "error": 1,
            "blocked": 0,
            "cancelled": 0,
        }
        assert report["summary"]["input_tokens"] == 1200
        assert report["summary"]["output_tokens"] == 300
        assert report["summary"]["cache_read_tokens"] == 800
        assert report["summary"]["cache_write_tokens"] == 100
        assert report["summary"]["duration_ms"] == 3600
        assert report["summary"]["duration_observed_calls"] == 3
        assert len(report["groups"]) == 1
        assert report["groups"][0]["model_source"] == "effective"
        assert report["groups"][0]["model"] == "provider-model-v2"
        assert report["groups"][0]["outcome"] == "success"
        assert {group["outcome"] for group in report["unavailable_groups"]} == {
            "success",
            "error",
        }
        assert sum(group["duration_ms"] for group in report["unavailable_groups"]) == 1100
        assert report["unresolved_groups"] == [
            {
                "workflow": "cm-ai",
                "stage": "task_review",
                "role": "reviewer",
                "adapter": "openai-compatible",
                "requested_model": "reviewer-default",
                "source": "api",
                "claims": 4,
            }
        ]
        assert "ignored malformed model_usage" in machine.stderr
        assert "conflicting model_call identity" in machine.stderr
        assert "mismatched claim identity" in machine.stderr

        human = invoke_report(home, "--last", "2")
        assert "observed 1" in human.stdout
        assert "unavailable 2" in human.stdout
        assert "unresolved claims 4" in human.stdout
        assert "cm-ai/task_review | reviewer | openai-compatible | reviewer-default" in (
            human.stdout
        )
        assert "outcomes: success 2 | error 1 | blocked 0 | cancelled 0" in human.stdout
        assert "cache read 800" in human.stdout
        assert "未推测缺失用量" in human.stdout

    print("cm usage report fixture: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
