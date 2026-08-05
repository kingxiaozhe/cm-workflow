#!/usr/bin/env python3
"""Dependency-free behavior fixtures for the CM task/review gates."""

from __future__ import annotations

import json
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional


ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "scripts" / "cm-task-gate.py"


def invoke(args: List[str], *, expected_exit: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [sys.executable, str(GATE), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != expected_exit:
        raise AssertionError(
            f"expected exit {expected_exit}, got {result.returncode}\n"
            f"command: {args}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def write_handoff(
    path: Path,
    *,
    task_id: str = "T-001",
    attempt: int = 1,
    status: str = "ready_for_review",
    verification_status: str = "passed",
    blockers: Optional[List[str]] = None,
    scope_deviation: Optional[List[str]] = None,
) -> None:
    payload: Dict[str, object] = {
        "schema_version": 1,
        "task_id": task_id,
        "attempt": attempt,
        "status": status,
        "changed_files": ["src/example.ts"],
        "verification": [
            {
                "command": "npm test -- example",
                "status": verification_status,
                "evidence": "tests passed",
            }
        ],
        "evidence": ["src/example.ts", "tests passed"],
        "blockers": blockers or [],
        "scope_deviation": scope_deviation or [],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_review(
    path: Path,
    *,
    task_id: str = "T-001",
    attempt: int = 1,
    round_number: int = 1,
    verdict: str = "approved",
    handoff: Path,
    independent: bool = True,
    reviewer: str = "codex-subagent",
    scope: Optional[List[str]] = None,
    body: Optional[str] = None,
    blocking_findings: Optional[int] = None,
    degraded_reason: Optional[str] = None,
) -> None:
    digest = hashlib.sha256(handoff.read_bytes()).hexdigest()
    scope_lines = [f"  - {item}" for item in (scope or ["src/example.ts"])]
    path.write_text(
        "\n".join(
            [
                "---",
                "at: 2026-08-02T09:00:00-07:00",
                f"reviewer: {reviewer}",
                f"independent: {'true' if independent else 'false'}",
                f"task: {task_id}",
                f"attempt: {attempt}",
                f"round: {round_number}",
                f"verdict: {verdict}",
                f"blocking_findings: {blocking_findings if blocking_findings is not None else (0 if verdict == 'approved' else 1)}",
                f"handoff: {handoff.name}",
                f"handoff_sha256: {digest}",
                *([f"degraded_reason: {degraded_reason or 'independent channels unavailable'}"] if reviewer == "self-degraded" else []),
                "scope:",
                *scope_lines,
                "---",
                "",
                body if body is not None else ("零发现。" if verdict == "approved" else "需要修复。"),
                "",
            ]
        ),
        encoding="utf-8",
    )


def git(path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"git {' '.join(args)} failed in {path}\n{result.stdout}\n{result.stderr}"
        )
    return result.stdout.strip()


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="cm-task-gate-") as tmp:
        temp = Path(tmp)
        specs = temp / "specs"
        reviews = specs / ".reviews"
        reviews.mkdir(parents=True)

        handoff1 = reviews / "login-T-001-a1-handoff.json"
        write_handoff(handoff1)

        invoke(["validate-handoff", "--handoff", str(handoff1), "--task", "T-001", "--attempt", "1"])
        n4 = invoke(["check-n4", "--handoff", str(handoff1), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-001"])
        assert json.loads(n4.stdout)["handoff_sha256"] == hashlib.sha256(handoff1.read_bytes()).hexdigest()

        unicode_handoff = reviews / "用户登录-T-009-a1-handoff.json"
        write_handoff(unicode_handoff, task_id="T-009")
        invoke(["check-n4", "--handoff", str(unicode_handoff), "--reviews-dir", str(reviews), "--feature", "用户登录", "--task", "T-009"])

        malformed = reviews / "login-T-002-a1-handoff.json"
        malformed.write_text('{"schema_version": 1, "task_id": "T-002"}\n', encoding="utf-8")
        invoke(["validate-handoff", "--handoff", str(malformed), "--task", "T-002", "--attempt", "1"], expected_exit=1)

        duplicate_json = reviews / "login-T-010-a1-handoff.json"
        duplicate_json.write_text(
            handoff1.read_text(encoding="utf-8").replace(
                '"status": "ready_for_review",',
                '"status": "blocked",\n  "status": "ready_for_review",',
            ).replace('"task_id": "T-001"', '"task_id": "T-010"'),
            encoding="utf-8",
        )
        invoke(["validate-handoff", "--handoff", str(duplicate_json), "--task", "T-010", "--attempt", "1"], expected_exit=1)

        blocked = reviews / "login-T-003-a1-handoff.json"
        write_handoff(blocked, task_id="T-003", status="blocked", blockers=["dependency unavailable"])
        invoke(["validate-handoff", "--handoff", str(blocked), "--task", "T-003", "--attempt", "1"])
        invoke(["check-n4", "--handoff", str(blocked), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-003"], expected_exit=1)

        failed_check = reviews / "login-T-004-a1-handoff.json"
        write_handoff(failed_check, task_id="T-004", verification_status="failed")
        invoke(["validate-handoff", "--handoff", str(failed_check), "--task", "T-004", "--attempt", "1"], expected_exit=1)

        unsafe_path = reviews / "login-T-015-a1-handoff.json"
        write_handoff(unsafe_path, task_id="T-015")
        unsafe_payload = json.loads(unsafe_path.read_text(encoding="utf-8"))
        unsafe_payload["changed_files"] = [r"C:\project\secret.txt"]
        unsafe_path.write_text(json.dumps(unsafe_payload, indent=2) + "\n", encoding="utf-8")
        invoke(["validate-handoff", "--handoff", str(unsafe_path), "--task", "T-015", "--attempt", "1"], expected_exit=1)

        deviated = reviews / "login-T-005-a1-handoff.json"
        write_handoff(deviated, task_id="T-005", scope_deviation=["changed config outside scope"])
        invoke(["validate-handoff", "--handoff", str(deviated), "--task", "T-005", "--attempt", "1"], expected_exit=1)

        review1 = reviews / "login-T-001-r1.md"
        write_review(review1, verdict="changes_requested", handoff=handoff1)
        invoke(["check-n5", "--handoff", str(handoff1), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-001"], expected_exit=1)

        handoff2 = reviews / "login-T-001-a2-handoff.json"
        write_handoff(handoff2, attempt=2)
        invoke(["check-n4", "--handoff", str(handoff2), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-001"])

        review2 = reviews / "login-T-001-r2.md"
        write_review(review2, attempt=2, round_number=2, verdict="approved", handoff=handoff2)
        invoke(["check-n5", "--handoff", str(handoff2), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-001"])

        feature_tasks_dir = specs / "1.login"
        feature_tasks_dir.mkdir()
        tasks = feature_tasks_dir / "tasks.md"
        tasks.write_text("- [ ] T-001: implement login\n- [ ] T-010: unrelated\n", encoding="utf-8")
        marked = invoke(["mark-done", "--handoff", str(handoff2), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-001", "--tasks", str(tasks)])
        assert json.loads(marked.stdout)["outcome"] == "marked_done"
        assert tasks.read_text(encoding="utf-8") == "- [x] T-001: implement login\n- [ ] T-010: unrelated\n"
        marked_again = invoke(["mark-done", "--handoff", str(handoff2), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-001", "--tasks", str(tasks)])
        assert json.loads(marked_again.stdout)["outcome"] == "already_done"

        other_specs = temp / "other-specs"
        other_specs.mkdir()
        other_tasks = other_specs / "tasks.md"
        other_tasks.write_text("- [ ] T-001: unrelated specs\n", encoding="utf-8")
        invoke(["mark-done", "--handoff", str(handoff2), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-001", "--tasks", str(other_tasks)], expected_exit=1)
        assert other_tasks.read_text(encoding="utf-8") == "- [ ] T-001: unrelated specs\n"

        orphan_attempt2 = reviews / "login-T-006-a2-handoff.json"
        write_handoff(orphan_attempt2, task_id="T-006", attempt=2)
        invoke(["check-n4", "--handoff", str(orphan_attempt2), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-006"], expected_exit=1)
        orphan_review2 = reviews / "login-T-006-r2.md"
        write_review(
            orphan_review2,
            task_id="T-006",
            attempt=2,
            round_number=2,
            handoff=orphan_attempt2,
        )
        invoke(["check-n5", "--handoff", str(orphan_attempt2), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-006"], expected_exit=1)

        blocked_attempt1 = reviews / "login-T-016-a1-handoff.json"
        blocked_attempt1_review = reviews / "login-T-016-r1.md"
        blocked_attempt2 = reviews / "login-T-016-a2-handoff.json"
        write_handoff(
            blocked_attempt1,
            task_id="T-016",
            status="blocked",
            verification_status="blocked",
            blockers=["dependency unavailable"],
        )
        write_review(
            blocked_attempt1_review,
            task_id="T-016",
            verdict="changes_requested",
            handoff=blocked_attempt1,
        )
        write_handoff(blocked_attempt2, task_id="T-016", attempt=2)
        invoke(["check-n4", "--handoff", str(blocked_attempt2), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-016"], expected_exit=1)

        symlink_target = reviews / "symlink-target.json"
        symlink_handoff = reviews / "login-T-017-a1-handoff.json"
        write_handoff(symlink_target, task_id="T-017")
        try:
            symlink_handoff.symlink_to(symlink_target.name)
        except OSError:
            pass
        else:
            invoke(["check-n4", "--handoff", str(symlink_handoff), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-017"], expected_exit=1)

        mismatched_review = reviews / "login-T-007-r1.md"
        mismatched_handoff = reviews / "login-T-007-a1-handoff.json"
        write_handoff(mismatched_handoff, task_id="T-007")
        write_review(mismatched_review, task_id="T-007", handoff=handoff1)
        invoke(["check-n5", "--handoff", str(mismatched_handoff), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-007"], expected_exit=1)

        degraded_review = reviews / "login-T-008-r1.md"
        degraded_handoff = reviews / "login-T-008-a1-handoff.json"
        write_handoff(degraded_handoff, task_id="T-008")
        write_review(
            degraded_review,
            task_id="T-008",
            verdict="approved",
            handoff=degraded_handoff,
            independent=False,
            reviewer="self-degraded",
        )
        invoke(["check-n5", "--handoff", str(degraded_handoff), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-008"])

        for feature_name, task_id in (
            ("fix-session-timeout", "T-FIX-session-timeout"),
            ("refactor-session-store", "T-REFACTOR-session-store"),
        ):
            synthetic_handoff = reviews / f"{feature_name}-{task_id}-a1-handoff.json"
            synthetic_review = reviews / f"{feature_name}-{task_id}-r1.md"
            write_handoff(synthetic_handoff, task_id=task_id)
            invoke(
                [
                    "check-n4",
                    "--handoff",
                    str(synthetic_handoff),
                    "--reviews-dir",
                    str(reviews),
                    "--feature",
                    feature_name,
                    "--task",
                    task_id,
                ]
            )
            write_review(synthetic_review, task_id=task_id, handoff=synthetic_handoff)
            invoke(
                [
                    "check-n5",
                    "--handoff",
                    str(synthetic_handoff),
                    "--reviews-dir",
                    str(reviews),
                    "--feature",
                    feature_name,
                    "--task",
                    task_id,
                ]
            )

        tampered_handoff = reviews / "login-T-011-a1-handoff.json"
        tampered_review = reviews / "login-T-011-r1.md"
        write_handoff(tampered_handoff, task_id="T-011")
        write_review(tampered_review, task_id="T-011", handoff=tampered_handoff)
        payload = json.loads(tampered_handoff.read_text(encoding="utf-8"))
        payload["evidence"].append("post-review edit")
        tampered_handoff.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        invoke(["check-n5", "--handoff", str(tampered_handoff), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-011"], expected_exit=1)

        incomplete_handoff = reviews / "login-T-012-a1-handoff.json"
        incomplete_review = reviews / "login-T-012-r1.md"
        write_handoff(incomplete_handoff, task_id="T-012")
        write_review(incomplete_review, task_id="T-012", handoff=incomplete_handoff, scope=["README.md"])
        invoke(["check-n5", "--handoff", str(incomplete_handoff), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-012"], expected_exit=1)

        empty_handoff = reviews / "login-T-013-a1-handoff.json"
        empty_review = reviews / "login-T-013-r1.md"
        write_handoff(empty_handoff, task_id="T-013")
        write_review(empty_review, task_id="T-013", handoff=empty_handoff, body="")
        invoke(["check-n5", "--handoff", str(empty_handoff), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-013"], expected_exit=1)

        duplicate_header_handoff = reviews / "login-T-014-a1-handoff.json"
        duplicate_header_review = reviews / "login-T-014-r1.md"
        write_handoff(duplicate_header_handoff, task_id="T-014")
        write_review(duplicate_header_review, task_id="T-014", handoff=duplicate_header_handoff)
        duplicate_header_review.write_text(
            duplicate_header_review.read_text(encoding="utf-8").replace(
                "verdict: approved", "verdict: blocked\nverdict: approved"
            ),
            encoding="utf-8",
        )
        invoke(["check-n5", "--handoff", str(duplicate_header_handoff), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-014"], expected_exit=1)

        duplicate_scope_handoff = reviews / "login-T-019-a1-handoff.json"
        duplicate_scope_review = reviews / "login-T-019-r1.md"
        write_handoff(duplicate_scope_handoff, task_id="T-019")
        write_review(duplicate_scope_review, task_id="T-019", handoff=duplicate_scope_handoff)
        duplicate_scope_review.write_text(
            duplicate_scope_review.read_text(encoding="utf-8").replace(
                "scope:\n", "scope: [README.md]\nscope:\n", 1
            ),
            encoding="utf-8",
        )
        invoke(["check-n5", "--handoff", str(duplicate_scope_handoff), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-019"], expected_exit=1)

        reverse_scope_handoff = reviews / "login-T-021-a1-handoff.json"
        reverse_scope_review = reviews / "login-T-021-r1.md"
        write_handoff(reverse_scope_handoff, task_id="T-021")
        write_review(reverse_scope_review, task_id="T-021", handoff=reverse_scope_handoff)
        reverse_scope_review.write_text(
            reverse_scope_review.read_text(encoding="utf-8").replace(
                "  - src/example.ts\n---", "  - src/example.ts\nscope: [README.md]\n---", 1
            ),
            encoding="utf-8",
        )
        invoke(["check-n5", "--handoff", str(reverse_scope_handoff), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-021"], expected_exit=1)

        placeholder_handoff = reviews / "login-T-020-a1-handoff.json"
        placeholder_review = reviews / "login-T-020-r1.md"
        write_handoff(placeholder_handoff, task_id="T-020")
        write_review(placeholder_review, task_id="T-020", handoff=placeholder_handoff, body="#")
        invoke(["check-n5", "--handoff", str(placeholder_handoff), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-020"], expected_exit=1)

        contradictory_handoff = reviews / "login-T-018-a1-handoff.json"
        contradictory_review = reviews / "login-T-018-r1.md"
        write_handoff(contradictory_handoff, task_id="T-018")
        write_review(
            contradictory_review,
            task_id="T-018",
            handoff=contradictory_handoff,
            blocking_findings=1,
            body="存在一个未解决的阻塞问题。",
        )
        invoke(["check-n5", "--handoff", str(contradictory_handoff), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-018"], expected_exit=1)

        unchanged_tasks = specs / "unchanged-tasks.md"
        unchanged_tasks.write_text("- [ ] T-001: must remain open\n", encoding="utf-8")
        invoke(["mark-done", "--handoff", str(handoff1), "--reviews-dir", str(reviews), "--feature", "login", "--task", "T-001", "--tasks", str(unchanged_tasks)], expected_exit=1)
        assert unchanged_tasks.read_text(encoding="utf-8") == "- [ ] T-001: must remain open\n"

        repo = temp / "repo"
        repo.mkdir()
        git(repo, "init")
        git(repo, "config", "user.email", "cm-fixture@example.invalid")
        git(repo, "config", "user.name", "CM Fixture")
        (repo / "README.md").write_text("fixture\n", encoding="utf-8")
        git(repo, "add", "README.md")
        git(repo, "commit", "-m", "fixture")
        main_branch = git(repo, "branch", "--show-current")

        worker1 = temp / "worker-1"
        worker2 = temp / "worker-2"
        git(repo, "worktree", "add", "-b", "cm-worker-1", str(worker1))
        git(repo, "worktree", "add", "-b", "cm-worker-2", str(worker2))

        invoke(
            [
                "check-parallel-write",
                "--repo",
                str(repo),
                "--assignment",
                f"T-101={worker1}",
                "--assignment",
                f"T-102={worker2}",
            ]
        )
        invoke(
            [
                "check-parallel-write",
                "--repo",
                str(repo),
                "--assignment",
                f"T-101={worker1}",
                "--assignment",
                f"T-102={worker1}",
            ],
            expected_exit=1,
        )

        detached = temp / "worker-detached"
        git(repo, "worktree", "add", "--detach", str(detached), "HEAD")
        invoke(
            [
                "check-parallel-write",
                "--repo",
                str(repo),
                "--assignment",
                f"T-101={worker1}",
                "--assignment",
                f"T-103={detached}",
            ],
            expected_exit=1,
        )

        other_repo = temp / "other-repo"
        other_repo.mkdir()
        git(other_repo, "init")
        git(other_repo, "config", "user.email", "cm-fixture@example.invalid")
        git(other_repo, "config", "user.name", "CM Fixture")
        (other_repo / "README.md").write_text("other\n", encoding="utf-8")
        git(other_repo, "add", "README.md")
        git(other_repo, "commit", "-m", "other")
        invoke(
            [
                "check-parallel-write",
                "--repo",
                str(repo),
                "--assignment",
                f"T-101={worker1}",
                "--assignment",
                f"T-104={other_repo}",
            ],
            expected_exit=1,
        )

        assert main_branch

    print("cm task gate fixtures: PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
