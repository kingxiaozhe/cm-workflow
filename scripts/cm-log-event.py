#!/usr/bin/env python3
"""Append one normalized CM event to project and user-global JSONL logs."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


SCHEMA_VERSION = 1
IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,63}$")
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$")
SENSITIVE_KEY = re.compile(
    r"(api[_-]?key|authorization|cookie|password|passwd|private[_-]?key|"
    r"recovery[_-]?code|secret|token)",
    re.IGNORECASE,
)
RESERVED_FIELDS = {
    "schema_version",
    "event_id",
    "run_id",
    "at",
    "workflow",
    "event",
    "phase",
    "runtime",
    "project",
    "project_path",
    "specs_path",
    "detail",
}
TERMINAL_EVENTS = {"done", "run_done"}
LOCK_HANDLES = []


class UsageError(ValueError):
    """User-facing input error."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Write one CM Workflow event to project and global logs."
    )
    parser.add_argument("--workflow", required=True)
    parser.add_argument("--event", required=True)
    parser.add_argument("--phase")
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--project")
    parser.add_argument("--project-root")
    parser.add_argument("--specs-dir")
    parser.add_argument("--run-id")
    parser.add_argument("--at")
    parser.add_argument("--detail", required=True)
    parser.add_argument("--data-json", default="{}")
    return parser.parse_args()


def validate_identifier(label: str, value: Optional[str]) -> Optional[str]:
    if value is not None and not IDENTIFIER.fullmatch(value):
        raise UsageError(
            f"{label} must match {IDENTIFIER.pattern!r}; got {value!r}"
        )
    return value


def parse_timestamp(raw: Optional[str]) -> Tuple[str, datetime]:
    if raw is None:
        parsed = datetime.now().astimezone()
    else:
        normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError as exc:
            raise UsageError("--at must be an ISO-8601 timestamp") from exc
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise UsageError("--at must include a timezone offset")
    return parsed.isoformat(timespec="seconds"), parsed


def validate_detail(detail: str) -> str:
    if not detail.strip():
        raise UsageError("--detail cannot be empty")
    if len(detail) > 500:
        raise UsageError("--detail cannot exceed 500 characters")
    if any(character in detail for character in ("\n", "\r", "\0")):
        raise UsageError("--detail cannot contain control-line characters")
    return detail


def reject_sensitive_keys(value: Any, path: str = "data") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                raise UsageError(f"{path} keys must be strings")
            if SENSITIVE_KEY.search(key):
                raise UsageError(f"sensitive log field is forbidden: {path}.{key}")
            reject_sensitive_keys(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_sensitive_keys(child, f"{path}[{index}]")


def parse_data(raw: str) -> Dict[str, Any]:
    if len(raw.encode("utf-8")) > 8192:
        raise UsageError("--data-json cannot exceed 8192 UTF-8 bytes")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise UsageError("--data-json must be a JSON object") from exc
    if not isinstance(value, dict):
        raise UsageError("--data-json must be a JSON object")
    overlap = RESERVED_FIELDS.intersection(value)
    if overlap:
        raise UsageError(
            "--data-json cannot override reserved fields: "
            + ", ".join(sorted(overlap))
        )
    reject_sensitive_keys(value)
    return value


def resolve_directory(label: str, raw: Optional[str]) -> Optional[Path]:
    if raw is None:
        return None
    path = Path(raw).expanduser().resolve(strict=False)
    if not path.is_dir():
        raise UsageError(f"{label} is not an existing directory: {path}")
    return path


def generated_run_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{uuid.uuid4().hex[:8]}"


def load_pointer(path: Path) -> Optional[Dict[str, Any]]:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    run_id = value.get("run_id")
    if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
        return None
    return value


def load_project_run_state(
    path: Optional[Path],
) -> Tuple[Optional[str], Dict[str, str]]:
    if path is None or not path.is_file():
        return None, {}
    latest_run_id = None
    states: Dict[str, str] = {}
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(value, dict):
                    continue
                run_id = value.get("run_id")
                event = value.get("event")
                if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
                    continue
                if not isinstance(event, str):
                    continue
                latest_run_id = run_id
                if event == "run_start":
                    states[run_id] = "running"
                elif event in TERMINAL_EVENTS:
                    states[run_id] = "done"
                elif run_id not in states:
                    states[run_id] = "running"
    except OSError:
        return None, {}
    return latest_run_id, states


def select_run_id(
    *,
    explicit: Optional[str],
    event: str,
    pointer: Optional[Dict[str, Any]],
    latest_project_run: Optional[str],
    project_states: Dict[str, str],
) -> Tuple[str, bool]:
    if explicit is not None:
        if not RUN_ID.fullmatch(explicit):
            raise UsageError("invalid --run-id")
        return explicit, event == "run_start"
    if pointer and pointer.get("status") == "running":
        pointer_run_id = str(pointer["run_id"])
        if project_states.get(pointer_run_id) != "done":
            return pointer_run_id, False
    if (
        pointer
        and pointer.get("status") == "done"
        and event in TERMINAL_EVENTS
    ):
        return str(pointer["run_id"]), False
    if (
        latest_project_run is not None
        and project_states.get(latest_project_run) == "running"
    ):
        return latest_project_run, False
    if (
        latest_project_run is not None
        and project_states.get(latest_project_run) == "done"
        and event in TERMINAL_EVENTS
    ):
        return latest_project_run, False
    return generated_run_id(), True


def compact_json(value: Dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"


def canonical_json(value: Dict[str, Any]) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def deterministic_event_id(value: Dict[str, Any]) -> str:
    identity = dict(value)
    identity.pop("at", None)
    identity.pop("event_id", None)
    return str(uuid.uuid5(uuid.NAMESPACE_URL, canonical_json(identity)))


def find_jsonl_event(
    path: Path, event_id: str
) -> Optional[Dict[str, Any]]:
    if not path.is_file():
        return None
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict) and value.get("event_id") == event_id:
                    return value
    except OSError:
        return None
    return None


def jsonl_has_event(path: Path, event_id: str) -> bool:
    return find_jsonl_event(path, event_id) is not None


def index_has_status(path: Path, run_id: str, status: str) -> bool:
    if not path.is_file():
        return False
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if (
                    isinstance(value, dict)
                    and value.get("run_id") == run_id
                    and value.get("status") == status
                ):
                    return True
    except OSError:
        return False
    return False


def append_line(path: Path, value: Dict[str, Any], *, private: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = 0o600 if private else 0o644
    descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, mode)
    try:
        os.write(descriptor, compact_json(value).encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    if private and os.name != "nt":
        os.chmod(path, 0o600)


def ensure_private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        os.chmod(path, 0o700)


def acquire_file_lock(path: Path, *, private: bool, timeout: float = 10.0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    if private and os.name != "nt":
        os.chmod(path, 0o600)
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"0")
        handle.flush()
    deadline = time.monotonic() + timeout
    while True:
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            LOCK_HANDLES.append(handle)
            return
        except (OSError, BlockingIOError):
            if time.monotonic() >= deadline:
                handle.close()
                raise TimeoutError(f"timed out waiting for log lock: {path}")
            time.sleep(0.05)


def write_pointer(path: Path, value: Dict[str, Any]) -> None:
    temporary = path.with_name(f"{path.name}.tmp.{os.getpid()}.{uuid.uuid4().hex}")
    try:
        temporary.write_text(compact_json(value), encoding="utf-8")
        if os.name != "nt":
            os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def project_name(explicit: Optional[str], project_root: Optional[Path]) -> str:
    if explicit:
        if len(explicit) > 120 or any(char in explicit for char in ("\n", "\r", "\0")):
            raise UsageError("--project must be one line and at most 120 characters")
        return explicit
    return project_root.name if project_root else "unscoped"


def valid_pointer_global_log(
    pointer: Optional[Dict[str, Any]],
    global_home: Path,
    run_id: str,
) -> Optional[Path]:
    if not pointer or pointer.get("run_id") != run_id:
        return None
    raw = pointer.get("global_log")
    if not isinstance(raw, str):
        return None
    candidate = Path(raw).expanduser().resolve(strict=False)
    try:
        relative = candidate.relative_to(global_home)
    except ValueError:
        return None
    parts = relative.parts
    if (
        len(parts) != 3
        or parts[0] != "runs"
        or not re.fullmatch(r"\d{4}-\d{2}", parts[1])
        or parts[2] != f"{run_id}.jsonl"
    ):
        return None
    return candidate


def select_global_log(
    *,
    global_home: Path,
    run_id: str,
    parsed_at: datetime,
    pointer: Optional[Dict[str, Any]],
) -> Path:
    pointed = valid_pointer_global_log(pointer, global_home, run_id)
    if pointed is not None:
        return pointed
    matches = sorted((global_home / "runs").glob(f"*/{run_id}.jsonl"))
    if len(matches) > 1:
        raise UsageError(
            f"multiple global log files found for run_id {run_id}; "
            "repair the local mirror before continuing"
        )
    if matches:
        return matches[0].resolve(strict=False)
    month = parsed_at.strftime("%Y-%m")
    return global_home / "runs" / month / f"{run_id}.jsonl"


def main() -> int:
    args = parse_args()
    try:
        workflow = str(validate_identifier("--workflow", args.workflow))
        event_name = str(validate_identifier("--event", args.event))
        phase = validate_identifier("--phase", args.phase)
        runtime = str(validate_identifier("--runtime", args.runtime))
        detail = validate_detail(args.detail)
        data = parse_data(args.data_json)
        at, parsed_at = parse_timestamp(args.at)
        project_root = resolve_directory("--project-root", args.project_root)
        specs_dir = resolve_directory("--specs-dir", args.specs_dir)
        display_project = project_name(args.project, project_root)
    except UsageError as exc:
        print(f"cm-log-event: {exc}", file=sys.stderr)
        return 2

    global_home = Path(
        os.environ.get("CM_WORKFLOW_LOG_HOME", "~/.cm-workflow/logs")
    ).expanduser().resolve(strict=False)
    if specs_dir:
        try:
            acquire_file_lock(specs_dir / ".cm-run.lock", private=False)
        except OSError as exc:
            print(
                f"cm-log-event: project run lock failed: {type(exc).__name__}",
                file=sys.stderr,
            )
            return 1
    global_lock_error = None
    try:
        ensure_private_directory(global_home)
        acquire_file_lock(global_home / ".cm-write.lock", private=True)
    except OSError as exc:
        global_lock_error = exc
        if specs_dir is None:
            print(
                f"cm-log-event: global-only log lock failed: {type(exc).__name__}",
                file=sys.stderr,
            )
            return 1

    pointer_path = specs_dir / ".cm-run.json" if specs_dir else None
    pointer = load_pointer(pointer_path) if pointer_path else None
    project_log = specs_dir / "运行日志.jsonl" if specs_dir else None
    latest_project_run, project_states = load_project_run_state(project_log)
    try:
        run_id, new_run = select_run_id(
            explicit=args.run_id,
            event=event_name,
            pointer=pointer,
            latest_project_run=latest_project_run,
            project_states=project_states,
        )
    except UsageError as exc:
        print(f"cm-log-event: {exc}", file=sys.stderr)
        return 2

    terminal = event_name in TERMINAL_EVENTS
    event: Dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "at": at,
        "workflow": workflow,
        "event": event_name,
        "runtime": runtime,
        "project": display_project,
        "detail": detail,
    }
    if phase:
        event["phase"] = phase
    if project_root:
        event["project_path"] = str(project_root)
    if specs_dir:
        event["specs_path"] = str(specs_dir)
    event.update(data)
    event_id = deterministic_event_id(event)
    event["event_id"] = event_id

    project_duplicate = False
    if project_log:
        try:
            existing_project_event = find_jsonl_event(project_log, event_id)
            project_duplicate = existing_project_event is not None
            if existing_project_event is not None:
                event = existing_project_event
                at, parsed_at = parse_timestamp(str(event["at"]))
            else:
                append_line(project_log, event, private=False)
        except OSError as exc:
            print(
                f"cm-log-event: authoritative project log write failed: "
                f"{type(exc).__name__}",
                file=sys.stderr,
            )
            return 1

    try:
        global_log = select_global_log(
            global_home=global_home,
            run_id=run_id,
            parsed_at=parsed_at,
            pointer=pointer,
        )
    except UsageError as exc:
        print(f"cm-log-event: {exc}", file=sys.stderr)
        return 2

    global_written = False
    degraded = False
    global_duplicate = False
    try:
        if global_lock_error is not None:
            raise global_lock_error
        ensure_private_directory(global_home)
        ensure_private_directory(global_home / "runs")
        ensure_private_directory(global_log.parent)
        global_duplicate = jsonl_has_event(global_log, event_id)
        if not global_duplicate:
            append_line(global_log, event, private=True)
        index_path = global_home / "index.jsonl"
        if new_run and not index_has_status(index_path, run_id, "running"):
            index_start = {
                "schema_version": SCHEMA_VERSION,
                "at": at,
                "run_id": run_id,
                "status": "running",
                "workflow": workflow,
                "runtime": runtime,
                "project": display_project,
                "project_path": str(project_root) if project_root else None,
                "specs_path": str(specs_dir) if specs_dir else None,
                "log_file": str(global_log.relative_to(global_home)),
            }
            append_line(index_path, index_start, private=True)
        if terminal and not index_has_status(index_path, run_id, "done"):
            index_done = {
                "schema_version": SCHEMA_VERSION,
                "at": at,
                "run_id": run_id,
                "status": "done",
                "workflow": workflow,
                "runtime": runtime,
                "project": display_project,
                "log_file": str(global_log.relative_to(global_home)),
            }
            append_line(index_path, index_done, private=True)
        global_written = True
    except OSError as exc:
        if project_log is None:
            print(
                f"cm-log-event: global-only log write failed: {type(exc).__name__}",
                file=sys.stderr,
            )
            return 1
        degraded = True
        degrade_event = {
            "schema_version": SCHEMA_VERSION,
            "run_id": run_id,
            "at": at,
            "workflow": workflow,
            "event": "degrade",
            "phase": "global_log",
            "runtime": runtime,
            "project": display_project,
            "detail": "全局日志镜像写入失败，项目日志继续作为权威来源",
            "error_type": type(exc).__name__,
        }
        if project_root:
            degrade_event["project_path"] = str(project_root)
        if specs_dir:
            degrade_event["specs_path"] = str(specs_dir)
        degrade_event["event_id"] = deterministic_event_id(degrade_event)
        try:
            if not jsonl_has_event(project_log, str(degrade_event["event_id"])):
                append_line(project_log, degrade_event, private=False)
        except OSError as project_exc:
            print(
                f"cm-log-event: project degradation log failed: "
                f"{type(project_exc).__name__}",
                file=sys.stderr,
            )
            return 1
        print(
            "cm-log-event: global mirror unavailable; project log retained",
            file=sys.stderr,
        )

    pointer_written = None
    if pointer_path:
        pointer_value = {
            "schema_version": SCHEMA_VERSION,
            "run_id": run_id,
            "workflow": workflow,
            "status": "done" if terminal else "running",
            "global_log": str(global_log),
            "global_written": global_written,
            "updated_at": at,
        }
        try:
            write_pointer(pointer_path, pointer_value)
            pointer_written = True
        except OSError as exc:
            pointer_written = False
            degraded = True
            pointer_degrade = {
                "schema_version": SCHEMA_VERSION,
                "run_id": run_id,
                "at": at,
                "workflow": workflow,
                "event": "degrade",
                "phase": "run_pointer",
                "runtime": runtime,
                "project": display_project,
                "detail": "运行指针写入失败，将从权威项目日志恢复",
                "error_type": type(exc).__name__,
            }
            if project_root:
                pointer_degrade["project_path"] = str(project_root)
            if specs_dir:
                pointer_degrade["specs_path"] = str(specs_dir)
            pointer_degrade["event_id"] = deterministic_event_id(pointer_degrade)
            try:
                if not jsonl_has_event(
                    project_log, str(pointer_degrade["event_id"])
                ):
                    append_line(project_log, pointer_degrade, private=False)
            except OSError as project_exc:
                print(
                    f"cm-log-event: run-pointer degradation log failed: "
                    f"{type(project_exc).__name__}",
                    file=sys.stderr,
                )
                return 1
            if global_written:
                try:
                    if not jsonl_has_event(
                        global_log, str(pointer_degrade["event_id"])
                    ):
                        append_line(global_log, pointer_degrade, private=True)
                except OSError:
                    pass
            print(
                "cm-log-event: active-run pointer unavailable; "
                "project log recovery retained",
                file=sys.stderr,
            )

    result = {
        "event_id": event_id,
        "run_id": run_id,
        "project_log": str(project_log) if project_log else None,
        "global_log": str(global_log),
        "global_written": global_written,
        "pointer_written": pointer_written,
        "deduplicated": project_duplicate if project_log else global_duplicate,
        "degraded": degraded,
    }
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
