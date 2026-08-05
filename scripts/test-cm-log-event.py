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
    python_io_encoding: Optional[str] = None,
) -> Tuple[subprocess.CompletedProcess, Optional[Dict[str, object]]]:
    env = os.environ.copy()
    env["CM_WORKFLOW_LOG_HOME"] = str(log_home)
    if python_io_encoding is not None:
        env["PYTHONIOENCODING"] = python_io_encoding
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

        legacy_console_specs = root / "传统代码页-specs"
        legacy_console_specs.mkdir()
        legacy_console_process, legacy_console = invoke(
            [
                "--workflow",
                "cm-test",
                "--event",
                "test_run",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(legacy_console_specs),
                "--detail",
                "Windows 传统代码页仍须返回机器可读结果",
            ],
            log_home=root / "legacy-console-logs",
            python_io_encoding="cp1252",
        )
        assert legacy_console is not None
        assert "\\u" in legacy_console_process.stdout
        assert legacy_console["global_written"] is True
        legacy_project_log = Path(str(legacy_console["project_log"]))
        assert legacy_project_log.name == "运行日志.jsonl"
        assert legacy_project_log.parent.name == "传统代码页-specs"

        lifecycle_specs = root / "lifecycle-specs"
        lifecycle_specs.mkdir()
        lifecycle_home = root / "lifecycle-logs"
        lifecycle_acquire_args = [
            "--workflow",
            "cm-ai",
            "--event",
            "resource",
            "--phase",
            "acquired",
            "--runtime",
            "codex",
            "--project-root",
            str(project),
            "--specs-dir",
            str(lifecycle_specs),
            "--detail",
            "一次性测试 profile 已创建",
            "--data-json",
            '{"resource_id":"profile-1","resource_kind":"test_profile",'
            '"cleanup_required":true}',
        ]
        lifecycle_release_args = [
            "--workflow",
            "cm-ai",
            "--event",
            "resource",
            "--phase",
            "released",
            "--runtime",
            "codex",
            "--project-root",
            str(project),
            "--specs-dir",
            str(lifecycle_specs),
            "--detail",
            "一次性测试 profile 已清理",
            "--data-json",
            '{"resource_id":"profile-1","resource_kind":"test_profile"}',
        ]
        invoke(lifecycle_acquire_args, log_home=lifecycle_home)
        _, exact_acquire_retry = invoke(
            lifecycle_acquire_args,
            log_home=lifecycle_home,
        )
        assert exact_acquire_retry is not None
        assert exact_acquire_retry["deduplicated"] is True
        distinct_live_acquire_args = lifecycle_acquire_args.copy()
        distinct_live_acquire_args[
            distinct_live_acquire_args.index("一次性测试 profile 已创建")
        ] = "同一 ID 不能代表第二个仍存活的资源"
        distinct_live_acquire_args[-1] = (
            '{"resource_id":"profile-1","resource_kind":"test_profile",'
            '"cleanup_required":true,"operation_id":"second-live-resource"}'
        )
        distinct_live_acquire, _ = invoke(
            distinct_live_acquire_args,
            log_home=lifecycle_home,
            expected_exit=2,
        )
        assert "active resource_id already has an acquisition" in (
            distinct_live_acquire.stderr
        )
        blocked_task, _ = invoke(
            [
                "--workflow",
                "cm-ai",
                "--event",
                "task_done",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(lifecycle_specs),
                "--detail",
                "资源未释放时不能完成任务",
            ],
            log_home=lifecycle_home,
            expected_exit=2,
        )
        assert "completion blocked by unclosed resources" in blocked_task.stderr
        invoke(
            [
                "--workflow",
                "cm-ai",
                "--event",
                "progress",
                "--phase",
                "checkpoint",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(lifecycle_specs),
                "--detail",
                "受管 Runtime 已就绪",
                "--data-json",
                '{"operation_id":"desktop-case-1",'
                '"requested_model":"gpt-5.6-sol",'
                '"effective_model":"qwen3:8b","provider":"local-ollama",'
                '"purpose":"transport-smoke","model_equivalent":false}',
            ],
            log_home=lifecycle_home,
        )
        invoke(
            [
                "--workflow",
                "cm-ai",
                "--event",
                "warning",
                "--phase",
                "retry",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(lifecycle_specs),
                "--detail",
                "首次检查失败后已重试成功",
                "--data-json",
                '{"severity":"warning","impact":"none","recovered":true,'
                '"attempt":1,"outcome":"retried"}',
            ],
            log_home=lifecycle_home,
        )
        wrong_kind_release, _ = invoke(
            [
                "--workflow",
                "cm-ai",
                "--event",
                "resource",
                "--phase",
                "released",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(lifecycle_specs),
                "--detail",
                "错误类型不能关闭资源",
                "--data-json",
                '{"resource_id":"profile-1","resource_kind":"process"}',
            ],
            log_home=lifecycle_home,
            expected_exit=2,
        )
        assert "resource_kind does not match" in wrong_kind_release.stderr
        invoke(lifecycle_release_args, log_home=lifecycle_home)
        lifecycle_task_done_args = [
            "--workflow",
            "cm-ai",
            "--event",
            "task_done",
            "--runtime",
            "codex",
            "--project-root",
            str(project),
            "--specs-dir",
            str(lifecycle_specs),
            "--detail",
            "资源释放后允许完成任务",
        ]
        invoke(lifecycle_task_done_args, log_home=lifecycle_home)
        _, closed_acquire_retry = invoke(
            lifecycle_acquire_args,
            log_home=lifecycle_home,
        )
        assert closed_acquire_retry is not None
        assert closed_acquire_retry["deduplicated"] is True
        reused_id, _ = invoke(
            distinct_live_acquire_args,
            log_home=lifecycle_home,
            expected_exit=2,
        )
        assert "resource_id cannot be reused" in reused_id.stderr
        second_acquire_args = [
            value.replace("profile-1", "profile-2")
            for value in lifecycle_acquire_args
        ]
        second_release_args = [
            value.replace("profile-1", "profile-2")
            for value in lifecycle_release_args
        ]
        invoke(second_acquire_args, log_home=lifecycle_home)
        _, delayed_task_retry = invoke(
            lifecycle_task_done_args,
            log_home=lifecycle_home,
        )
        assert delayed_task_retry is not None
        assert delayed_task_retry["deduplicated"] is True
        invoke(lifecycle_release_args, log_home=lifecycle_home)
        blocked_second_resource, _ = invoke(
            [
                "--workflow",
                "cm-ai",
                "--event",
                "run_done",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(lifecycle_specs),
                "--detail",
                "旧清理重试不能关闭新资源",
            ],
            log_home=lifecycle_home,
            expected_exit=2,
        )
        assert (
            "completion blocked by unclosed resources"
            in blocked_second_resource.stderr
        )
        invoke(second_release_args, log_home=lifecycle_home)
        lifecycle_rows = read_jsonl(lifecycle_specs / "运行日志.jsonl")
        assert [(row["event"], row.get("phase")) for row in lifecycle_rows] == [
            ("resource", "acquired"),
            ("progress", "checkpoint"),
            ("warning", "retry"),
            ("resource", "released"),
            ("task_done", None),
            ("resource", "acquired"),
            ("resource", "released"),
        ]
        assert lifecycle_rows[0]["cleanup_required"] is True
        assert lifecycle_rows[3]["resource_id"] == "profile-1"
        assert lifecycle_rows[5]["resource_id"] == "profile-2"
        assert "resource_occurrence" not in lifecycle_rows[0]
        assert lifecycle_rows[1]["effective_model"] == "qwen3:8b"
        assert lifecycle_rows[1]["model_equivalent"] is False
        assert lifecycle_rows[2]["recovered"] is True
        assert lifecycle_rows[2]["impact"] == "none"

        qa_specs = root / "qa-terminal-specs"
        qa_specs.mkdir()
        qa_home = root / "qa-terminal-logs"
        qa_common = [
            "--workflow",
            "cm-ai",
            "--runtime",
            "codex",
            "--project-root",
            str(project),
            "--specs-dir",
            str(qa_specs),
        ]
        invoke(
            [*qa_common, "--event", "run_start", "--detail", "开始 QA 终态夹具"],
            log_home=qa_home,
        )
        invoke(
            [
                *qa_common,
                "--event",
                "test_run",
                "--phase",
                "start",
                "--detail",
                "开始浏览器 QA",
            ],
            log_home=qa_home,
        )
        invoke(
            [
                *qa_common,
                "--event",
                "test_run",
                "--phase",
                "case_start",
                "--detail",
                "开始阻断用例",
                "--data-json",
                '{"case_id":"TC-BROWSER-001","blocking":true}',
            ],
            log_home=qa_home,
        )
        unfinished_case, _ = invoke(
            [*qa_common, "--event", "run_done", "--detail", "未闭合用例不能结束"],
            log_home=qa_home,
            expected_exit=2,
        )
        assert "completion blocked by incomplete test_run" in unfinished_case.stderr
        invoke(
            [
                *qa_common,
                "--event",
                "test_run",
                "--phase",
                "case_complete",
                "--detail",
                "阻断用例已通过",
                "--data-json",
                '{"case_id":"TC-BROWSER-001","result":"PASS"}',
            ],
            log_home=qa_home,
        )
        unfinished_run, _ = invoke(
            [*qa_common, "--event", "run_done", "--detail", "QA invocation 未闭合不能结束"],
            log_home=qa_home,
            expected_exit=2,
        )
        assert "completion blocked by incomplete test_run" in unfinished_run.stderr
        invoke(
            [
                *qa_common,
                "--event",
                "test_run",
                "--phase",
                "complete",
                "--detail",
                "浏览器 QA 完成",
                "--data-json",
                '{"result":"PASS","cases":1,"passed":1,"failed":0,"blocked":0}',
            ],
            log_home=qa_home,
        )
        invoke(
            [*qa_common, "--event", "run_done", "--detail", "QA 闭合后允许结束"],
            log_home=qa_home,
        )

        legacy_complete_specs = root / "legacy-complete-specs"
        legacy_complete_specs.mkdir()
        legacy_complete_home = root / "legacy-complete-logs"
        legacy_complete_common = [
            "--workflow",
            "cm-ai",
            "--runtime",
            "codex",
            "--project-root",
            str(project),
            "--specs-dir",
            str(legacy_complete_specs),
        ]
        _, legacy_complete_started = invoke(
            [
                *legacy_complete_common,
                "--event",
                "run_start",
                "--detail",
                "开始历史 complete 兼容夹具",
            ],
            log_home=legacy_complete_home,
        )
        assert legacy_complete_started is not None
        legacy_complete_log = Path(str(legacy_complete_started["project_log"]))
        with legacy_complete_log.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "run_id": legacy_complete_started["run_id"],
                        "event": "test_run",
                        "phase": "complete",
                        "detail": "升级前写入的已完成测试记录",
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
        invoke(
            [
                *legacy_complete_common,
                "--event",
                "run_done",
                "--detail",
                "历史 complete 不应阻塞终态",
            ],
            log_home=legacy_complete_home,
        )

        malformed_home = root / "malformed-resource-logs"
        malformed, _ = invoke(
            [
                "--workflow",
                "cm-ai",
                "--event",
                "resource",
                "--phase",
                "acquired",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--detail",
                "缺少资源标识",
                "--data-json",
                '{"resource_kind":"process","cleanup_required":true}',
            ],
            log_home=malformed_home,
            expected_exit=2,
        )
        assert "require a valid resource_id" in malformed.stderr
        assert not malformed_home.exists()

        uuid_specs = root / "uuid-resource-specs"
        uuid_specs.mkdir()
        uuid_home = root / "uuid-resource-logs"
        uuid_resource_id = "9f5d70a2-9831-4a68-bfc9-6d6617ba55e9"
        uuid_common_args = [
            "--workflow",
            "cm-ai",
            "--event",
            "resource",
            "--runtime",
            "codex",
            "--project-root",
            str(project),
            "--specs-dir",
            str(uuid_specs),
        ]
        uuid_acquire_args = uuid_common_args + [
            "--phase",
            "acquired",
            "--detail",
            "数字开头 UUID 资源已获取",
            "--data-json",
            json.dumps(
                {
                    "resource_id": uuid_resource_id,
                    "resource_kind": "process",
                    "cleanup_required": True,
                },
                separators=(",", ":"),
            ),
        ]
        uuid_cleanup_failed_args = uuid_common_args + [
            "--phase",
            "cleanup_failed",
            "--detail",
            "数字开头 UUID 资源清理失败",
            "--data-json",
            json.dumps(
                {
                    "resource_id": uuid_resource_id,
                    "resource_kind": "process",
                },
                separators=(",", ":"),
            ),
        ]
        uuid_release_args = uuid_common_args + [
            "--phase",
            "released",
            "--detail",
            "数字开头 UUID 资源已释放",
            "--data-json",
            json.dumps(
                {
                    "resource_id": uuid_resource_id,
                    "resource_kind": "process",
                },
                separators=(",", ":"),
            ),
        ]
        invoke(uuid_acquire_args, log_home=uuid_home)
        invoke(uuid_cleanup_failed_args, log_home=uuid_home)
        invoke(uuid_release_args, log_home=uuid_home)
        _, closed_cleanup_retry = invoke(
            uuid_cleanup_failed_args,
            log_home=uuid_home,
        )
        assert closed_cleanup_retry is not None
        assert closed_cleanup_retry["deduplicated"] is True
        uuid_rows = read_jsonl(uuid_specs / "运行日志.jsonl")
        assert [row["resource_id"] for row in uuid_rows] == [
            uuid_resource_id,
            uuid_resource_id,
            uuid_resource_id,
        ]

        orphan_specs = root / "orphan-resource-specs"
        orphan_specs.mkdir()
        orphan_run_id = "20260729T120000Z-orphan01"
        orphan_row = {
            "schema_version": 1,
            "event_id": "orphan-fixture",
            "run_id": orphan_run_id,
            "at": "2026-07-29T12:00:00-07:00",
            "workflow": "cm-ai",
            "event": "resource",
            "phase": "released",
            "runtime": "codex",
            "project": "project",
            "detail": "没有前置获取的损坏记录",
            "resource_id": "orphan-1",
            "resource_kind": "process",
        }
        (orphan_specs / "运行日志.jsonl").write_text(
            json.dumps(orphan_row, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        orphan_done, _ = invoke(
            [
                "--workflow",
                "cm-ai",
                "--event",
                "run_done",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(orphan_specs),
                "--detail",
                "损坏状态不能完成",
            ],
            log_home=root / "orphan-resource-logs",
            expected_exit=2,
        )
        assert "resource state cannot be verified" in orphan_done.stderr

        if os.name != "nt":
            unreadable_specs = root / "unreadable-resource-specs"
            unreadable_specs.mkdir()
            unreadable_home = root / "unreadable-resource-logs"
            invoke(
                [
                    "--workflow",
                    "cm-ai",
                    "--event",
                    "resource",
                    "--phase",
                    "acquired",
                    "--runtime",
                    "codex",
                    "--project-root",
                    str(project),
                    "--specs-dir",
                    str(unreadable_specs),
                    "--detail",
                    "待验证的临时进程",
                    "--data-json",
                    '{"resource_id":"process-1","resource_kind":"process",'
                    '"cleanup_required":true}',
                ],
                log_home=unreadable_home,
            )
            unreadable_log = unreadable_specs / "运行日志.jsonl"
            unreadable_log.chmod(0o200)
            unreadable_done, _ = invoke(
                [
                    "--workflow",
                    "cm-ai",
                    "--event",
                    "run_done",
                    "--runtime",
                    "codex",
                    "--project-root",
                    str(project),
                    "--specs-dir",
                    str(unreadable_specs),
                    "--detail",
                    "日志不可读时不能结束",
                ],
                log_home=unreadable_home,
                expected_exit=2,
            )
            assert "resource state cannot be verified" in unreadable_done.stderr
            unreadable_log.chmod(0o600)

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

        mirror_specs = root / "mirror-recovery-specs"
        mirror_specs.mkdir()
        mirror_home = root / "mirror-recovery-logs"
        mirror_home.write_text("阻止首次全局镜像写入", encoding="utf-8")
        mirror_args = [
            "--workflow",
            "cm-ai",
            "--event",
            "progress",
            "--phase",
            "checkpoint",
            "--runtime",
            "codex",
            "--project-root",
            str(project),
            "--specs-dir",
            str(mirror_specs),
            "--detail",
            "跨月镜像恢复必须保留原始事件时间",
            "--data-json",
            '{"operation_id":"mirror-recovery-1","attempt":1}',
        ]
        _, mirror_degraded = invoke(
            [
                *mirror_args,
                "--at",
                "2026-06-30T23:00:00-07:00",
            ],
            log_home=mirror_home,
        )
        assert mirror_degraded is not None
        assert mirror_degraded["global_written"] is False
        assert mirror_degraded["degraded"] is True
        mirror_event_id = str(mirror_degraded["event_id"])
        (mirror_specs / ".cm-run.json").unlink()
        mirror_home.unlink()
        mirror_home.mkdir()
        _, mirror_recovered = invoke(
            [
                *mirror_args,
                "--at",
                "2026-07-31T23:00:00-07:00",
            ],
            log_home=mirror_home,
        )
        assert mirror_recovered is not None
        assert mirror_recovered["event_id"] == mirror_event_id
        assert mirror_recovered["deduplicated"] is True
        recovered_global_log = Path(str(mirror_recovered["global_log"]))
        assert recovered_global_log.parent.name == "2026-06"
        recovered_rows = read_jsonl(recovered_global_log)
        assert len(recovered_rows) == 1
        assert recovered_rows[0]["at"] == "2026-06-30T23:00:00-07:00"

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
        invoke(
            [
                "--workflow",
                "external-expert",
                "--event",
                "resource",
                "--phase",
                "acquired",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--run-id",
                standalone_id,
                "--detail",
                "临时浏览器进程已启动",
                "--data-json",
                '{"resource_id":"browser-1","resource_kind":"process",'
                '"cleanup_required":true}',
            ],
            log_home=standalone_home,
        )
        blocked_run, _ = invoke(
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
                "资源未释放时不能结束",
            ],
            log_home=standalone_home,
            expected_exit=2,
        )
        assert "completion blocked by unclosed resources" in blocked_run.stderr
        invoke(
            [
                "--workflow",
                "external-expert",
                "--event",
                "resource",
                "--phase",
                "released",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--run-id",
                standalone_id,
                "--detail",
                "临时浏览器进程已停止",
                "--data-json",
                '{"resource_id":"browser-1","resource_kind":"process",'
                '"cleanup_required":true}',
            ],
            log_home=standalone_home,
        )
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
        assert len(read_jsonl(Path(str(standalone_done["global_log"])))) == 4

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
        invoke(
            [
                "--workflow",
                "cm-test",
                "--event",
                "test_run",
                "--phase",
                "start",
                "--runtime",
                "codex",
                "--project-root",
                str(project),
                "--specs-dir",
                str(degraded_specs),
                "--detail",
                "开始降级镜像测试",
            ],
            log_home=broken_home,
        )
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
        degraded_events = [row["event"] for row in degraded_rows]
        assert degraded_events == [
            "test_run",
            "degrade",
            "test_run",
        ], degraded_events
        assert any(
            row["event"] == "degrade" and row.get("phase") == "global_log"
            for row in degraded_rows
        )

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
