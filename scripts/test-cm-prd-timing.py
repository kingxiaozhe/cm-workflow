#!/usr/bin/env python3
"""Dependency-free fixtures for scripts/cm-prd-timing.py."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional


ROOT = Path(__file__).resolve().parents[1]
REPORTER = ROOT / "scripts" / "cm-prd-timing.py"


def write_jsonl(path: Path, rows: List[Dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def invoke(
    log_home: Path,
    *args: str,
    expected_exit: int = 0,
    python_io_encoding: Optional[str] = None,
) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    if python_io_encoding is not None:
        env["PYTHONIOENCODING"] = python_io_encoding
    result = subprocess.run(
        [sys.executable, str(REPORTER), "--log-home", str(log_home), *args],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != expected_exit:
        raise AssertionError(
            f"expected exit {expected_exit}, got {result.returncode}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def progress(
    run_id: str,
    phase: str,
    at: str,
    operation_id: str,
    phase_name: str,
    segment: int,
    outcome: Optional[str] = None,
) -> Dict[str, object]:
    row: Dict[str, object] = {
        "schema_version": 1,
        "run_id": run_id,
        "at": at,
        "workflow": "cm-prd",
        "event": "progress",
        "phase": phase,
        "runtime": "codex",
        "project": "fixture",
        "detail": "fixture",
        "operation_id": operation_id,
        "phase_name": phase_name,
        "segment": segment,
    }
    if outcome is not None:
        row["outcome"] = outcome
    return row


def index_rows(run_id: str, at: str, project: str, status: str) -> Dict[str, object]:
    return {
        "schema_version": 1,
        "at": at,
        "run_id": run_id,
        "status": status,
        "workflow": "cm-prd",
        "runtime": "codex",
        "project": project,
        "log_file": f"runs/2026-08/{run_id}.jsonl",
    }


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="cm-prd-timing-") as tmp:
        home = Path(tmp)
        old_run = "prd-old-0001"
        done_run = "prd-done-0002"
        live_run = "prd-live-0003"
        write_jsonl(
            home / "index.jsonl",
            [
                index_rows(old_run, "2026-08-01T10:00:00+00:00", "old-project", "done"),
                index_rows(done_run, "2026-08-02T10:00:00+00:00", "done-project", "running"),
                index_rows(done_run, "2026-08-02T10:01:00+00:00", "done-project", "done"),
                index_rows(live_run, "2026-08-03T10:00:00+00:00", "live-project", "running"),
                {
                    **index_rows("other-flow", "2026-08-04T10:00:00+00:00", "ignored", "done"),
                    "workflow": "cm-ai",
                },
            ],
        )
        write_jsonl(
            home / f"runs/2026-08/{old_run}.jsonl",
            [
                progress(old_run, "start", "2026-08-01T10:00:00Z", "prd-context", "context_load", 1),
                progress(old_run, "complete", "2026-08-01T10:00:02Z", "prd-context", "context_load", 1, "completed"),
            ],
        )
        write_jsonl(
            home / f"runs/2026-08/{done_run}.jsonl",
            [
                progress(done_run, "start", "2026-08-02T10:00:00Z", "prd-requirements", "requirements_analysis", 1),
                progress(done_run, "complete", "2026-08-02T10:00:10Z", "prd-requirements", "requirements_analysis", 1, "awaiting_input"),
                progress(done_run, "start", "2026-08-02T11:00:00Z", "prd-requirements", "requirements_analysis", 2),
                progress(done_run, "complete", "2026-08-02T11:00:15Z", "prd-requirements", "requirements_analysis", 2, "completed"),
                progress(done_run, "start", "2026-08-02T11:00:20Z", "prd-spec-review", "spec_review", 1),
                progress(done_run, "complete", "2026-08-02T11:00:25Z", "prd-spec-review", "spec_review", 1, "completed"),
                progress(done_run, "start", "2026-08-02T11:00:30Z", "prd-design-review", "design_review", 1),
            ],
        )
        write_jsonl(
            home / f"runs/2026-08/{live_run}.jsonl",
            [
                progress(live_run, "start", "2026-08-03T10:00:00Z", "prd-context", "context_load", 1),
                progress(live_run, "complete", "2026-08-03T10:00:03Z", "prd-context", "context_load", 1, "completed"),
            ],
        )

        report = invoke(home, "--last", "2")
        assert "CM PRD 阶段耗时（最近 2 次）" in report.stdout
        assert "old-project" not in report.stdout
        assert "requirements_analysis: 25.0s" in report.stdout
        assert "spec_review: 5.0s" in report.stdout
        assert "最慢阶段: requirements_analysis 25.0s" in report.stdout
        assert "人工暂停: 1" in report.stdout
        assert "design_review 1，spec_review 1" in report.stdout
        assert "未配对 segment: 1（未猜测耗时）" in report.stdout
        assert f"{live_run} | running" in report.stdout
        assert f"{done_run} | done" in report.stdout

        empty = invoke(home / "empty")
        assert "没有找到可读取的 cm-prd 阶段耗时日志" in empty.stdout
        assert empty.stderr == ""

        invalid = invoke(home, "--last", "0", expected_exit=2)
        assert "must be at least 1" in invalid.stderr

        legacy_console = invoke(home, "--last", "1", python_io_encoding="cp1252")
        assert "UnicodeEncodeError" not in legacy_console.stderr
        assert "CM PRD" in legacy_console.stdout

    print("cm-prd timing fixtures: PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
