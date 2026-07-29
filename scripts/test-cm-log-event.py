#!/usr/bin/env python3
"""Dependency-free behavior fixture for scripts/cm-log-event.py."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple


ROOT = Path(__file__).resolve().parents[1]
WRITER = ROOT / "scripts" / "cm-log-event.py"


def invoke(
    args: List[str],
    *,
    log_home: Path,
    expected_exit: int = 0,
) -> Tuple[subprocess.CompletedProcess, Optional[Dict[str, object]]]:
    env = os.environ.copy()
    env["CM_WORKFLOW_LOG_HOME"] = str(log_home)
    result = subprocess.run(
        [sys.executable, str(WRITER), *args],
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
    payload = json.loads(result.stdout) if result.stdout.strip() else None
    return result, payload


def read_jsonl(path: Path) -> List[Dict[str, object]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="cm-log-fixture-") as tmp:
        root = Path(tmp)
        project = root / "project"
        specs = root / "specs"
        log_home = root / "global-logs"
        project.mkdir()
        specs.mkdir()
        resolved_log_home = log_home.resolve()

        _, started = invoke(
            [
                "--workflow",
                "cm-ai",
                "--event",
                "run_start",
                "--phase",
                "start",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(specs),
                "--detail",
                "开始执行已审批规格",
                "--at",
                "2026-07-29T09:10:00-07:00",
                "--data-json",
                '{"role":"orchestrator","feature":"1.login"}',
            ],
            log_home=log_home,
        )
        assert started is not None
        first_run = str(started["run_id"])
        project_log = Path(str(started["project_log"]))
        global_log = Path(str(started["global_log"]))
        pointer = specs / ".cm-run.json"
        index = resolved_log_home / "index.jsonl"
        assert started["global_written"] is True
        assert started["degraded"] is False
        assert project_log == specs.resolve() / "运行日志.jsonl"
        assert global_log.parent.parent == resolved_log_home / "runs"
        assert global_log.name == f"{first_run}.jsonl"
        assert pointer.is_file()
        assert len(read_jsonl(project_log)) == 1
        assert read_jsonl(project_log) == read_jsonl(global_log)
        assert read_jsonl(project_log)[0]["feature"] == "1.login"
        assert read_jsonl(project_log)[0]["schema_version"] == 1
        assert read_jsonl(index)[0]["status"] == "running"

        _, routed = invoke(
            [
                "--workflow",
                "cm-ai",
                "--event",
                "external_expert",
                "--phase",
                "route",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(specs),
                "--detail",
                "AUTO 选择 VERIFY",
                "--data-json",
                '{"mode":"verify","purpose":"research"}',
            ],
            log_home=log_home,
        )
        assert routed is not None
        assert routed["run_id"] == first_run
        assert len(read_jsonl(project_log)) == 2
        assert read_jsonl(project_log) == read_jsonl(global_log)

        _, completed = invoke(
            [
                "--workflow",
                "cm-ai",
                "--event",
                "run_done",
                "--phase",
                "done",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(specs),
                "--detail",
                "执行完成",
                "--at",
                "2026-08-01T00:10:00-07:00",
            ],
            log_home=log_home,
        )
        assert completed is not None
        assert completed["run_id"] == first_run
        assert Path(str(completed["global_log"])) == global_log
        assert json.loads(pointer.read_text(encoding="utf-8"))["status"] == "done"
        assert [row["status"] for row in read_jsonl(index)] == ["running", "done"]
        assert read_jsonl(index)[-1]["log_file"] == read_jsonl(index)[0]["log_file"]
        _, completed_retry = invoke(
            [
                "--workflow",
                "cm-ai",
                "--event",
                "run_done",
                "--phase",
                "done",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(specs),
                "--detail",
                "执行完成",
                "--at",
                "2026-08-01T00:10:00-07:00",
            ],
            log_home=log_home,
        )
        assert completed_retry is not None
        assert completed_retry["run_id"] == first_run
        assert completed_retry["event_id"] == completed["event_id"]
        assert completed_retry["deduplicated"] is True
        assert [row["status"] for row in read_jsonl(index)] == ["running", "done"]

        _, restarted = invoke(
            [
                "--workflow",
                "cm-ai",
                "--event",
                "run_start",
                "--phase",
                "start",
                "--runtime",
                "claude",
                "--project-root",
                str(project),
                "--specs-dir",
                str(specs),
                "--detail",
                "开始新一轮执行",
            ],
            log_home=log_home,
        )
        assert restarted is not None
        assert restarted["run_id"] != first_run
        assert Path(str(restarted["global_log"])) != global_log

        pointer_failure_specs = root / "pointer-failure-specs"
        pointer_failure_specs.mkdir()
        pointer_failure_home = root / "pointer-failure-logs"
        _, pointer_started = invoke(
            [
                "--workflow",
                "cm-test",
                "--event",
                "run_start",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(pointer_failure_specs),
                "--detail",
                "开始指针恢复夹具",
            ],
            log_home=pointer_failure_home,
        )
        assert pointer_started is not None
        pointer_failure_id = str(pointer_started["run_id"])
        pointer_failure_pointer = pointer_failure_specs / ".cm-run.json"
        pointer_failure_pointer.unlink()
        pointer_failure_pointer.mkdir()
        _, pointer_done = invoke(
            [
                "--workflow",
                "cm-test",
                "--event",
                "run_done",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(pointer_failure_specs),
                "--detail",
                "指针不可写但权威日志完成",
            ],
            log_home=pointer_failure_home,
        )
        assert pointer_done is not None
        assert pointer_done["run_id"] == pointer_failure_id
        assert pointer_done["pointer_written"] is False
        assert pointer_done["degraded"] is True
        pointer_rows = read_jsonl(pointer_failure_specs / "运行日志.jsonl")
        assert [row["event"] for row in pointer_rows][-2:] == [
            "run_done",
            "degrade",
        ]
        _, pointer_restarted = invoke(
            [
                "--workflow",
                "cm-test",
                "--event",
                "run_start",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(pointer_failure_specs),
                "--detail",
                "从权威日志判断上一轮已完成",
            ],
            log_home=pointer_failure_home,
        )
        assert pointer_restarted is not None
        assert pointer_restarted["run_id"] != pointer_failure_id

        standalone_home = root / "standalone-logs"
        _, standalone = invoke(
            [
                "--workflow",
                "external-expert",
                "--event",
                "run_start",
                "--phase",
                "start",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--detail",
                "开始独立研究",
            ],
            log_home=standalone_home,
        )
        assert standalone is not None
        standalone_id = str(standalone["run_id"])
        assert standalone["project_log"] is None
        _, standalone_done = invoke(
            [
                "--workflow",
                "external-expert",
                "--event",
                "run_done",
                "--phase",
                "done",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--run-id",
                standalone_id,
                "--detail",
                "独立研究完成",
            ],
            log_home=standalone_home,
        )
        assert standalone_done is not None
        assert standalone_done["run_id"] == standalone_id
        assert len(read_jsonl(Path(str(standalone_done["global_log"])))) == 2

        idempotent_home = root / "idempotent-logs"
        explicit_run_id = "20260729T120000Z-retry001"
        repeated_args = [
            "--workflow",
            "external-expert",
            "--event",
            "run_start",
            "--runtime",
            "codex",
            "--project-root",
            str(project),
            "--run-id",
            explicit_run_id,
            "--detail",
            "相同调用安全重试",
        ]
        _, repeated_first = invoke(repeated_args, log_home=idempotent_home)
        _, repeated_second = invoke(repeated_args, log_home=idempotent_home)
        assert repeated_first is not None
        assert repeated_second is not None
        assert repeated_second["event_id"] == repeated_first["event_id"]
        assert repeated_second["deduplicated"] is True
        assert len(read_jsonl(Path(str(repeated_first["global_log"])))) == 1
        assert len(read_jsonl(idempotent_home.resolve() / "index.jsonl")) == 1

        concurrent_specs = root / "concurrent-specs"
        concurrent_specs.mkdir()
        concurrent_home = root / "concurrent-logs"
        concurrent_command = [
            sys.executable,
            str(WRITER),
            "--workflow",
            "cm-ai",
            "--event",
            "run_start",
            "--runtime",
            "codex",
            "--project-root",
            str(project),
            "--specs-dir",
            str(concurrent_specs),
            "--detail",
            "并发启动必须认领同一轮",
        ]
        concurrent_env = os.environ.copy()
        concurrent_env["CM_WORKFLOW_LOG_HOME"] = str(concurrent_home)
        processes = [
            subprocess.Popen(
                concurrent_command,
                cwd=ROOT,
                env=concurrent_env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            for _ in range(8)
        ]
        concurrent_results = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=20)
            if process.returncode != 0:
                raise AssertionError(
                    f"concurrent writer failed: {process.returncode}\n{stderr}"
                )
            concurrent_results.append(json.loads(stdout))
        assert len({row["run_id"] for row in concurrent_results}) == 1
        assert sum(not row["deduplicated"] for row in concurrent_results) == 1
        concurrent_rows = read_jsonl(concurrent_specs / "运行日志.jsonl")
        assert [row["event"] for row in concurrent_rows] == ["run_start"]

        sensitive_home = root / "sensitive-logs"
        invoke(
            [
                "--workflow",
                "cm-test",
                "--event",
                "test_run",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--detail",
                "不应写入",
                "--data-json",
                '{"api_key":"secret"}',
            ],
            log_home=sensitive_home,
            expected_exit=2,
        )
        assert not sensitive_home.exists()

        broken_home = root / "not-a-directory"
        broken_home.write_text("occupied", encoding="utf-8")
        degraded_specs = root / "degraded-specs"
        degraded_specs.mkdir()
        _, degraded = invoke(
            [
                "--workflow",
                "cm-test",
                "--event",
                "test_run",
                "--phase",
                "complete",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(degraded_specs),
                "--detail",
                "测试报告已落盘",
            ],
            log_home=broken_home,
        )
        assert degraded is not None
        assert degraded["global_written"] is False
        assert degraded["degraded"] is True
        degraded_rows = read_jsonl(degraded_specs / "运行日志.jsonl")
        assert [row["event"] for row in degraded_rows] == ["test_run", "degrade"]
        assert degraded_rows[-1]["phase"] == "global_log"

        invoke(
            [
                "--workflow",
                "external-expert",
                "--event",
                "run_start",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--detail",
                "全局唯一落点失败",
            ],
            log_home=broken_home,
            expected_exit=1,
        )

        if os.name != "nt":
            assert (resolved_log_home.stat().st_mode & 0o777) == 0o700
            assert ((resolved_log_home / "runs").stat().st_mode & 0o777) == 0o700
            assert (global_log.parent.stat().st_mode & 0o777) == 0o700
            assert (global_log.stat().st_mode & 0o777) == 0o600
            assert (index.stat().st_mode & 0o777) == 0o600
            assert (
                (resolved_log_home / ".cm-write.lock").stat().st_mode & 0o777
            ) == 0o600

    print("cm global log fixture: PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
