#!/usr/bin/env python3
"""Validate CM task handoffs, review transitions, and parallel write isolation."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Dict, List, Mapping, Sequence, Tuple


TASK_RE = re.compile(r"^T-[A-Za-z0-9][A-Za-z0-9._-]*$")
REVIEWERS = {"codex-subagent", "codex-cli", "self-degraded"}
VERDICTS = {"approved", "changes_requested", "blocked"}


class GateError(ValueError):
    """Expected contract violation."""


def load_schema_contract() -> Tuple[set[str], set[str], set[str], set[str]]:
    schema_path = Path(__file__).resolve().parents[1] / "runtime" / "task-handoff.schema.json"
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        properties = schema["properties"]
        verification_properties = properties["verification"]["items"]["properties"]
        fields = set(schema["required"])
        if fields != set(properties):
            raise KeyError("required/properties mismatch")
        return (
            fields,
            set(verification_properties),
            set(verification_properties["status"]["enum"]),
            set(properties["status"]["enum"]),
        )
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise RuntimeError(f"invalid task handoff schema: {schema_path}: {exc}") from exc


HANDOFF_FIELDS, VERIFICATION_FIELDS, VERIFICATION_STATUSES, HANDOFF_STATUSES = (
    load_schema_contract()
)


def require_task_id(value: object, field: str = "task_id") -> str:
    if not isinstance(value, str) or not TASK_RE.fullmatch(value):
        raise GateError(f"{field} must match T-<id>")
    return value


def require_string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GateError(f"{field} must be a non-empty string")
    return value


def require_string_list(value: object, field: str, *, minimum: int = 0) -> List[str]:
    if not isinstance(value, list) or len(value) < minimum:
        raise GateError(f"{field} must be a list with at least {minimum} item(s)")
    items: List[str] = []
    for index, item in enumerate(value):
        items.append(require_string(item, f"{field}[{index}]"))
    if len(set(items)) != len(items):
        raise GateError(f"{field} must not contain duplicates")
    return items


def require_feature(value: str) -> str:
    if not value or value in {".", ".."} or value[-1:] in {" ", "."}:
        raise GateError("feature must be a safe filename slug")
    if any(ord(char) < 32 or char in '<>:"/\\|?*' for char in value):
        raise GateError("feature must be a safe cross-platform filename slug")
    return value


def require_relative_files(value: object) -> List[str]:
    files = require_string_list(value, "changed_files")
    for item in files:
        path = PurePosixPath(item)
        if (
            item.startswith(("/", "\\"))
            or re.match(r"^[A-Za-z]:[\\/]", item)
            or "\\" in item
            or ".." in path.parts
            or item in {".", ".."}
        ):
            raise GateError(f"changed_files entry must be a safe relative path: {item}")
    return files


def reject_duplicate_keys(pairs: List[Tuple[str, object]]) -> Dict[str, object]:
    result: Dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise GateError(f"JSON contains duplicate key: {key}")
        result[key] = value
    return result


def load_handoff(path: Path, *, task: str | None = None, attempt: int | None = None) -> Dict[str, object]:
    if path.is_symlink():
        raise GateError(f"handoff evidence must not be a symlink: {path}")
    try:
        payload = json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicate_keys
        )
    except FileNotFoundError as exc:
        raise GateError(f"handoff not found: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise GateError(f"cannot read handoff {path}: {exc}") from exc

    if not isinstance(payload, dict):
        raise GateError("handoff root must be an object")
    fields = set(payload)
    missing = sorted(HANDOFF_FIELDS - fields)
    unknown = sorted(fields - HANDOFF_FIELDS)
    if missing:
        raise GateError(f"handoff missing fields: {', '.join(missing)}")
    if unknown:
        raise GateError(f"handoff has unknown fields: {', '.join(unknown)}")

    if payload["schema_version"] != 1 or isinstance(payload["schema_version"], bool):
        raise GateError("schema_version must be 1")
    task_id = require_task_id(payload["task_id"])
    raw_attempt = payload["attempt"]
    if isinstance(raw_attempt, bool) or not isinstance(raw_attempt, int) or raw_attempt not in {1, 2}:
        raise GateError("attempt must be 1 or 2")
    status = payload["status"]
    if status not in HANDOFF_STATUSES:
        raise GateError("status must be ready_for_review or blocked")

    require_relative_files(payload["changed_files"])
    evidence = require_string_list(payload["evidence"], "evidence", minimum=1)
    blockers = require_string_list(payload["blockers"], "blockers")
    scope_deviation = require_string_list(payload["scope_deviation"], "scope_deviation")
    del evidence

    verification = payload["verification"]
    if not isinstance(verification, list) or not verification:
        raise GateError("verification must contain at least one result")
    verification_statuses: List[str] = []
    for index, item in enumerate(verification):
        if not isinstance(item, dict):
            raise GateError(f"verification[{index}] must be an object")
        fields = set(item)
        if fields != VERIFICATION_FIELDS:
            raise GateError(f"verification[{index}] must contain command, status, and evidence only")
        require_string(item["command"], f"verification[{index}].command")
        require_string(item["evidence"], f"verification[{index}].evidence")
        verification_status = item["status"]
        if verification_status not in VERIFICATION_STATUSES:
            raise GateError(f"verification[{index}].status is invalid")
        verification_statuses.append(str(verification_status))

    if status == "ready_for_review":
        if blockers:
            raise GateError("ready_for_review handoff must not contain blockers")
        if scope_deviation:
            raise GateError("ready_for_review handoff must not contain scope_deviation")
        if any(item != "passed" for item in verification_statuses):
            raise GateError("ready_for_review handoff requires every verification result to pass")
    elif not blockers and not scope_deviation:
        raise GateError("blocked handoff must explain a blocker or scope deviation")

    if task is not None and task_id != task:
        raise GateError(f"handoff task {task_id} does not match requested task {task}")
    if attempt is not None and raw_attempt != attempt:
        raise GateError(f"handoff attempt {raw_attempt} does not match requested attempt {attempt}")
    return payload


def parse_review(path: Path) -> Tuple[Dict[str, str], List[str], str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError as exc:
        raise GateError(f"review evidence not found: {path}") from exc
    except OSError as exc:
        raise GateError(f"cannot read review evidence {path}: {exc}") from exc
    if not lines or lines[0].strip() != "---":
        raise GateError(f"review evidence has no YAML header: {path}")
    try:
        end = next(index for index, line in enumerate(lines[1:], start=1) if line.strip() == "---")
    except StopIteration as exc:
        raise GateError(f"review evidence header is not closed: {path}") from exc

    scalars: Dict[str, str] = {}
    scalar_seen: set[str] = set()
    scope_items: List[str] = []
    in_scope = False
    scope_seen = False
    for line in lines[1:end]:
        if line.strip() == "scope:":
            if scope_seen or "scope" in scalar_seen:
                raise GateError("review header contains duplicate field: scope")
            scope_seen = True
            in_scope = True
            continue
        if in_scope and line.startswith((" ", "\t")):
            stripped = line.strip()
            if stripped.startswith("- ") and stripped[2:].strip():
                scope_items.append(stripped[2:].strip())
            continue
        in_scope = False
        if line.startswith((" ", "\t")) or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        if key in scalar_seen or (key == "scope" and scope_seen):
            raise GateError(f"review header contains duplicate field: {key}")
        scalar_seen.add(key)
        value = value.strip()
        if value:
            scalars[key] = value.strip('"\'')
    if not scope_items:
        raise GateError(f"review evidence scope must contain at least one entry: {path}")
    if len(set(scope_items)) != len(scope_items):
        raise GateError(f"review evidence scope must not contain duplicates: {path}")
    body = "\n".join(lines[end + 1 :]).strip()
    if not body:
        raise GateError(f"review evidence body must not be empty: {path}")
    return scalars, scope_items, body


def file_sha256(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        raise GateError(f"cannot hash evidence {path}: {exc}") from exc


def validate_review(
    path: Path,
    *,
    task: str,
    attempt: int,
    handoff: Path,
    changed_files: Sequence[str],
) -> Dict[str, str]:
    if path.is_symlink():
        raise GateError(f"review evidence must not be a symlink: {path}")
    header, scope_items, body = parse_review(path)
    required = {
        "at",
        "reviewer",
        "independent",
        "task",
        "attempt",
        "round",
        "verdict",
        "handoff",
        "handoff_sha256",
        "blocking_findings",
    }
    missing = sorted(required - set(header))
    if missing:
        raise GateError(f"review header missing fields: {', '.join(missing)}")
    if header["task"] != task:
        raise GateError(f"review task {header['task']} does not match {task}")
    try:
        timestamp = datetime.fromisoformat(header["at"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise GateError("review at must be an ISO-8601 timestamp") from exc
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise GateError("review at must include a timezone")
    try:
        review_attempt = int(header["attempt"])
        review_round = int(header["round"])
    except ValueError as exc:
        raise GateError("review attempt and round must be integers") from exc
    if review_attempt != attempt or review_round != attempt:
        raise GateError("review attempt and round must match the handoff attempt")
    reviewer = header["reviewer"]
    if reviewer not in REVIEWERS:
        raise GateError(f"unsupported reviewer channel: {reviewer}")
    independent = header["independent"].lower()
    if independent not in {"true", "false"}:
        raise GateError("review independent must be true or false")
    if reviewer == "self-degraded" and independent != "false":
        raise GateError("self-degraded review must declare independent: false")
    if reviewer != "self-degraded" and independent != "true":
        raise GateError("independent review channel must declare independent: true")
    if header["verdict"] not in VERDICTS:
        raise GateError(f"unsupported review verdict: {header['verdict']}")
    try:
        blocking_findings = int(header["blocking_findings"])
    except ValueError as exc:
        raise GateError("review blocking_findings must be an integer") from exc
    if blocking_findings < 0:
        raise GateError("review blocking_findings must not be negative")
    if header["verdict"] == "approved" and blocking_findings != 0:
        raise GateError("approved review must declare blocking_findings: 0")
    if header["verdict"] != "approved" and blocking_findings == 0:
        raise GateError("non-approved review must declare at least one blocking finding")
    if reviewer == "self-degraded" and not header.get("degraded_reason", "").strip():
        raise GateError("self-degraded review must include degraded_reason")
    if header["verdict"] == "approved" and re.search(
        r"零发现|无阻塞发现|未发现阻塞|zero findings|no findings|no blocking findings",
        body,
        flags=re.IGNORECASE,
    ) is None:
        raise GateError("approved review body must explicitly state zero blocking findings")
    if attempt == 2 and header["verdict"] == "changes_requested":
        raise GateError("round 2 blocking findings must use verdict: blocked")

    if header["handoff"] != handoff.name:
        raise GateError("review handoff does not match the current implementation evidence")
    if not re.fullmatch(r"[0-9a-f]{64}", header["handoff_sha256"]):
        raise GateError("review handoff_sha256 must be a lowercase SHA-256 digest")
    if header["handoff_sha256"] != file_sha256(handoff):
        raise GateError("review handoff digest does not match the current implementation evidence")
    missing_scope = sorted(set(changed_files) - set(scope_items))
    if missing_scope:
        raise GateError(f"review scope does not cover changed files: {', '.join(missing_scope)}")
    return header


def review_path(reviews_dir: Path, feature: str, task: str, attempt: int) -> Path:
    require_feature(feature)
    return reviews_dir / f"{feature}-{task}-r{attempt}.md"


def require_expected_handoff_path(
    handoff: Path,
    *,
    reviews_dir: Path,
    feature: str,
    task: str,
    attempt: int,
) -> None:
    require_feature(feature)
    expected = reviews_dir / f"{feature}-{task}-a{attempt}-handoff.json"
    if reviews_dir.is_symlink():
        raise GateError(f"reviews directory must not be a symlink: {reviews_dir}")
    if handoff.is_symlink():
        raise GateError(f"handoff evidence must not be a symlink: {handoff}")
    if handoff.parent.resolve() != reviews_dir.resolve() or handoff.name != expected.name:
        raise GateError(f"handoff must use the task evidence path: {expected}")


def validate_attempt_chain(reviews_dir: Path, feature: str, task: str, attempt: int) -> None:
    if attempt != 2:
        return
    prior_handoff = reviews_dir / f"{feature}-{task}-a1-handoff.json"
    require_expected_handoff_path(
        prior_handoff,
        reviews_dir=reviews_dir,
        feature=feature,
        task=task,
        attempt=1,
    )
    prior_payload = load_handoff(prior_handoff, task=task, attempt=1)
    if prior_payload["status"] != "ready_for_review":
        raise GateError("attempt 2 requires a ready_for_review attempt 1 handoff")
    prior_path = review_path(reviews_dir, feature, task, 1)
    prior = validate_review(
        prior_path,
        task=task,
        attempt=1,
        handoff=prior_handoff,
        changed_files=prior_payload["changed_files"],
    )
    if prior["verdict"] != "changes_requested":
        raise GateError("attempt 2 requires round 1 verdict: changes_requested")


def check_n4(args: argparse.Namespace) -> Mapping[str, object]:
    handoff_path = Path(args.handoff)
    payload = load_handoff(handoff_path, task=args.task)
    if payload["status"] != "ready_for_review":
        raise GateError("N4 requires a ready_for_review handoff")
    attempt = int(payload["attempt"])
    reviews_dir = Path(args.reviews_dir)
    require_expected_handoff_path(
        handoff_path,
        reviews_dir=reviews_dir,
        feature=args.feature,
        task=args.task,
        attempt=attempt,
    )
    validate_attempt_chain(reviews_dir, args.feature, args.task, attempt)
    return {
        "gate": "n4",
        "task": args.task,
        "attempt": attempt,
        "outcome": "ready_for_review",
        "handoff_sha256": file_sha256(handoff_path),
    }


def check_n5(args: argparse.Namespace) -> Mapping[str, object]:
    handoff_path = Path(args.handoff)
    payload = load_handoff(handoff_path, task=args.task)
    if payload["status"] != "ready_for_review":
        raise GateError("N5 requires a ready_for_review handoff")
    attempt = int(payload["attempt"])
    reviews_dir = Path(args.reviews_dir)
    require_expected_handoff_path(
        handoff_path,
        reviews_dir=reviews_dir,
        feature=args.feature,
        task=args.task,
        attempt=attempt,
    )
    validate_attempt_chain(reviews_dir, args.feature, args.task, attempt)
    path = review_path(reviews_dir, args.feature, args.task, attempt)
    review = validate_review(
        path,
        task=args.task,
        attempt=attempt,
        handoff=handoff_path,
        changed_files=payload["changed_files"],
    )
    if review["verdict"] != "approved":
        raise GateError(f"N5 requires verdict: approved, got {review['verdict']}")
    return {
        "gate": "n5",
        "task": args.task,
        "attempt": attempt,
        "outcome": "approved",
        "review": str(path.resolve()),
    }


def mark_done(args: argparse.Namespace) -> Mapping[str, object]:
    approval = dict(check_n5(args))
    tasks_path = Path(args.tasks)
    feature = require_feature(args.feature)
    specs_root = Path(args.reviews_dir).parent.resolve()
    resolved_tasks = tasks_path.resolve()
    feature_dir = resolved_tasks.parent.name
    feature_matches = feature_dir == feature or re.fullmatch(
        rf"\d+\.{re.escape(feature)}",
        feature_dir,
    )
    if (
        resolved_tasks.name != "tasks.md"
        or resolved_tasks.parent.parent != specs_root
        or feature_matches is None
    ):
        raise GateError(
            "tasks file must be the matching feature-local authority under "
            f"{specs_root}"
        )
    if tasks_path.is_symlink():
        raise GateError(f"tasks file must not be a symlink: {tasks_path}")
    try:
        text = tasks_path.read_text(encoding="utf-8")
        mode = tasks_path.stat().st_mode
    except (FileNotFoundError, OSError) as exc:
        raise GateError(f"cannot read tasks file {tasks_path}: {exc}") from exc

    task_pattern = re.compile(
        rf"^(?P<prefix>\s*-\s*)\[(?P<state>[ xX])\](?P<suffix>\s+{re.escape(args.task)}(?=[:\s]|$).*)$"
    )
    lines = text.splitlines(keepends=True)
    matches: List[Tuple[int, re.Match[str]]] = []
    for index, line in enumerate(lines):
        match = task_pattern.match(line.rstrip("\r\n"))
        if match:
            matches.append((index, match))
    if len(matches) != 1:
        raise GateError(f"tasks file must contain exactly one checkbox for {args.task}")

    index, match = matches[0]
    if match.group("state").lower() == "x":
        approval["outcome"] = "already_done"
        approval["tasks"] = str(tasks_path.resolve())
        return approval

    newline = "\r\n" if lines[index].endswith("\r\n") else "\n" if lines[index].endswith("\n") else ""
    lines[index] = f"{match.group('prefix')}[x]{match.group('suffix')}{newline}"
    tasks_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    try:
        descriptor, raw_temp = tempfile.mkstemp(
            prefix=f".{tasks_path.name}.", suffix=".tmp", dir=str(tasks_path.parent)
        )
        temp_path = Path(raw_temp)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write("".join(lines))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, stat.S_IMODE(mode))
        os.replace(temp_path, tasks_path)
    except OSError as exc:
        raise GateError(f"cannot atomically update tasks file {tasks_path}: {exc}") from exc
    finally:
        if temp_path is not None and temp_path.exists():
            temp_path.unlink()

    approval["outcome"] = "marked_done"
    approval["tasks"] = str(tasks_path.resolve())
    return approval


def run_git(path: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), *arguments],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "git command failed"
        raise GateError(f"git -C {path} {' '.join(arguments)}: {detail}")
    return result.stdout.strip()


def common_git_dir(path: Path) -> Path:
    raw = Path(run_git(path, "rev-parse", "--git-common-dir"))
    return (path / raw).resolve() if not raw.is_absolute() else raw.resolve()


def registered_worktrees(repo: Path) -> Dict[Path, Tuple[str, bool]]:
    output = run_git(repo, "worktree", "list", "--porcelain")
    entries: Dict[Path, Tuple[str, bool]] = {}
    current_path: Path | None = None
    branch = ""
    detached = False
    for line in [*output.splitlines(), ""]:
        if line.startswith("worktree "):
            if current_path is not None:
                entries[current_path] = (branch, detached)
            current_path = Path(line[len("worktree ") :]).resolve()
            branch = ""
            detached = False
        elif line.startswith("branch "):
            branch = line[len("branch refs/heads/") :] if line.startswith("branch refs/heads/") else line[7:]
        elif line == "detached":
            detached = True
        elif not line and current_path is not None:
            entries[current_path] = (branch, detached)
            current_path = None
    return entries


def parse_assignment(raw: str) -> Tuple[str, Path]:
    if "=" not in raw:
        raise GateError("assignment must use T-xxx=/absolute/worktree/path")
    task, raw_path = raw.split("=", 1)
    require_task_id(task, "assignment task")
    path = Path(require_string(raw_path, "assignment path"))
    if not path.is_absolute():
        raise GateError("assignment path must be absolute")
    return task, path.resolve()


def check_parallel_write(args: argparse.Namespace) -> Mapping[str, object]:
    repo = Path(args.repo).resolve()
    if len(args.assignment) < 2:
        raise GateError("parallel write guard requires at least two assignments")
    base_common = common_git_dir(repo)
    registered = registered_worktrees(repo)
    assignments = [parse_assignment(raw) for raw in args.assignment]
    tasks = [item[0] for item in assignments]
    paths = [item[1] for item in assignments]
    if len(set(tasks)) != len(tasks):
        raise GateError("parallel write assignments must use unique task ids")
    if len(set(paths)) != len(paths):
        raise GateError("parallel write assignments must use distinct worktree paths")

    branches: List[str] = []
    for task, path in assignments:
        if path not in registered:
            raise GateError(f"{task} path is not a registered worktree: {path}")
        if common_git_dir(path) != base_common:
            raise GateError(f"{task} worktree belongs to a different repository")
        branch, detached = registered[path]
        observed_branch = run_git(path, "branch", "--show-current")
        if detached or not branch or not observed_branch:
            raise GateError(f"{task} worktree must use a non-detached branch")
        if branch != observed_branch:
            raise GateError(f"{task} branch metadata does not match the worktree")
        branches.append(branch)
    if len(set(branches)) != len(branches):
        raise GateError("parallel write assignments must use distinct branches")
    return {
        "gate": "parallel-write",
        "outcome": "isolated",
        "assignments": [
            {"task": task, "worktree": str(path), "branch": branch}
            for (task, path), branch in zip(assignments, branches)
        ],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    validate = commands.add_parser("validate-handoff")
    validate.add_argument("--handoff", required=True)
    validate.add_argument("--task", required=True)
    validate.add_argument("--attempt", required=True, type=int)

    for name in ("check-n4", "check-n5"):
        command = commands.add_parser(name)
        command.add_argument("--handoff", required=True)
        command.add_argument("--reviews-dir", required=True)
        command.add_argument("--feature", required=True)
        command.add_argument("--task", required=True)

    mark = commands.add_parser("mark-done")
    mark.add_argument("--handoff", required=True)
    mark.add_argument("--reviews-dir", required=True)
    mark.add_argument("--feature", required=True)
    mark.add_argument("--task", required=True)
    mark.add_argument("--tasks", required=True)

    parallel = commands.add_parser("check-parallel-write")
    parallel.add_argument("--repo", required=True)
    parallel.add_argument("--assignment", action="append", default=[], required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if hasattr(args, "task"):
            require_task_id(args.task, "task")
        if args.command == "validate-handoff":
            payload = load_handoff(Path(args.handoff), task=args.task, attempt=args.attempt)
            result: Mapping[str, object] = {
                "gate": "handoff",
                "task": payload["task_id"],
                "attempt": payload["attempt"],
                "outcome": payload["status"],
            }
        elif args.command == "check-n4":
            result = check_n4(args)
        elif args.command == "check-n5":
            result = check_n5(args)
        elif args.command == "mark-done":
            result = mark_done(args)
        else:
            result = check_parallel_write(args)
    except GateError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
