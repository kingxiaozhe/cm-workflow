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
from typing import Any, Dict, List, Optional, Tuple


SCHEMA_VERSION = 1
IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,63}$")
RESOURCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
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
RESOURCE_GUARDED_EVENTS = TERMINAL_EVENTS | {"task_done"}
RESOURCE_PHASES = {"acquired", "released", "cleanup_failed"}
TEST_RUN_GUARDED_EVENTS = TERMINAL_EVENTS | {"task_done"}
TEST_RUN_PHASES = {"start", "case_start", "case_complete", "case_blocked", "complete"}
MODEL_USAGE_TOKEN_FIELDS = {
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
}
MODEL_USAGE_STATES = {"observed", "unavailable"}
MODEL_USAGE_OUTCOMES = {"success", "error", "blocked", "cancelled"}
MODEL_USAGE_ALLOWED_FIELDS = MODEL_USAGE_TOKEN_FIELDS | {
    "call_id",
    "role",
    "adapter",
    "requested_model",
    "effective_model",
    "provider",
    "source",
    "purpose",
    "stage",
    "node",
    "feature",
    "task",
    "usage_state",
    "duration_ms",
    "outcome",
    "attempt",
}
MODEL_CALL_ALLOWED_FIELDS = {
    "call_id",
    "stage",
    "role",
    "adapter",
    "requested_model",
    "source",
    "purpose",
}
MODEL_CALL_IDENTITY_FIELDS = (
    "workflow",
    "runtime",
    "stage",
    "role",
    "adapter",
    "requested_model",
    "source",
    "purpose",
)
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


def reject_sensitive_keys(
    value: Any,
    path: str = "data",
    allowed_sensitive_keys: Optional[set[str]] = None,
) -> None:
    allowed = allowed_sensitive_keys or set()
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                raise UsageError(f"{path} keys must be strings")
            if SENSITIVE_KEY.search(key) and not (path == "data" and key in allowed):
                raise UsageError(f"sensitive log field is forbidden: {path}.{key}")
            reject_sensitive_keys(child, f"{path}.{key}", allowed)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_sensitive_keys(child, f"{path}[{index}]", allowed)


def parse_data(raw: str, event: str) -> Dict[str, Any]:
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
    allowed = MODEL_USAGE_TOKEN_FIELDS if event == "model_usage" else set()
    reject_sensitive_keys(value, allowed_sensitive_keys=allowed)
    return value


def validate_short_text(label: str, value: Any, *, required: bool = False) -> None:
    if value is None and not required:
        return
    if not isinstance(value, str) or not value.strip():
        raise UsageError(f"model event requires a non-empty {label}")
    if len(value) > 160 or any(character in value for character in ("\n", "\r", "\0")):
        raise UsageError(f"model event {label} must be one line and at most 160 characters")


def validate_model_usage_event(
    event: str,
    phase: Optional[str],
    data: Dict[str, Any],
) -> None:
    if event != "model_usage":
        return
    unknown = set(data).difference(MODEL_USAGE_ALLOWED_FIELDS)
    if unknown:
        raise UsageError(
            "model_usage contains unsupported fields: " + ", ".join(sorted(unknown))
        )
    if phase != "complete":
        raise UsageError("model_usage events require phase complete")
    call_id = data.get("call_id")
    if not isinstance(call_id, str) or not RESOURCE_ID.fullmatch(call_id):
        raise UsageError("model_usage requires a valid call_id")
    role = data.get("role")
    if not isinstance(role, str) or not IDENTIFIER.fullmatch(role):
        raise UsageError("model_usage requires a valid role")
    usage_state = data.get("usage_state")
    if usage_state not in MODEL_USAGE_STATES:
        raise UsageError("model_usage usage_state must be observed or unavailable")
    outcome = data.get("outcome")
    if outcome not in MODEL_USAGE_OUTCOMES:
        raise UsageError(
            "model_usage outcome must be success, error, blocked, or cancelled"
        )
    for field in (
        "adapter",
        "requested_model",
        "source",
        "purpose",
        "stage",
    ):
        validate_short_text(field, data.get(field), required=True)
    for field in (
        "effective_model",
        "provider",
        "node",
        "feature",
        "task",
    ):
        validate_short_text(field, data.get(field))
    attempt = data.get("attempt")
    if attempt is not None and (
        isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1
    ):
        raise UsageError("model_usage attempt must be a positive integer")
    numeric_fields = MODEL_USAGE_TOKEN_FIELDS | {"duration_ms"}
    present_numeric = numeric_fields.intersection(data)
    if usage_state == "unavailable" and MODEL_USAGE_TOKEN_FIELDS.intersection(data):
        raise UsageError("unavailable model_usage cannot contain token counts")
    if usage_state == "observed":
        for required_field in ("input_tokens", "output_tokens"):
            if required_field not in data:
                raise UsageError(
                    f"observed model_usage requires {required_field}"
                )
    for field in present_numeric:
        value = data[field]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise UsageError(f"model_usage {field} must be a non-negative integer")


def validate_model_call_event(
    event: str,
    phase: Optional[str],
    data: Dict[str, Any],
) -> None:
    if event != "model_call":
        return
    unknown = set(data).difference(MODEL_CALL_ALLOWED_FIELDS)
    if unknown:
        raise UsageError(
            "model_call contains unsupported fields: " + ", ".join(sorted(unknown))
        )
    if phase != "claimed":
        raise UsageError("model_call events require phase claimed")
    call_id = data.get("call_id")
    if not isinstance(call_id, str) or not RESOURCE_ID.fullmatch(call_id):
        raise UsageError("model_call requires a valid call_id")
    role = data.get("role")
    if not isinstance(role, str) or not IDENTIFIER.fullmatch(role):
        raise UsageError("model_call requires a valid role")
    for field in (
        "stage",
        "adapter",
        "requested_model",
        "source",
        "purpose",
    ):
        validate_short_text(field, data.get(field), required=True)


def model_call_identity(event: Dict[str, Any]) -> Tuple[str, ...]:
    return tuple(str(event.get(field, "")) for field in MODEL_CALL_IDENTITY_FIELDS)


def validate_resource_event(
    event: str,
    phase: Optional[str],
    data: Dict[str, Any],
) -> None:
    if event != "resource":
        return
    if phase not in RESOURCE_PHASES:
        raise UsageError(
            "resource events require phase acquired, released, or cleanup_failed"
        )
    resource_id = data.get("resource_id")
    if not isinstance(resource_id, str) or not RESOURCE_ID.fullmatch(resource_id):
        raise UsageError("resource events require a valid resource_id")
    resource_kind = data.get("resource_kind")
    if (
        not isinstance(resource_kind, str)
        or not IDENTIFIER.fullmatch(resource_kind)
    ):
        raise UsageError("resource events require a valid resource_kind")
    if phase == "acquired" and data.get("cleanup_required") is not True:
        raise UsageError("resource acquisition requires cleanup_required: true")


def validate_test_run_event(
    event: str,
    phase: Optional[str],
    data: Dict[str, Any],
) -> None:
    if event != "test_run" or phase is None:
        return
    if phase not in TEST_RUN_PHASES:
        raise UsageError(
            "test_run events require phase start, case_start, case_complete, "
            "case_blocked, or complete"
        )
    if phase.startswith("case_"):
        case_id = data.get("case_id")
        if not isinstance(case_id, str) or not RESOURCE_ID.fullmatch(case_id):
            raise UsageError("test_run case events require a valid case_id")


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


def find_model_usage_call(
    path: Path,
    run_id: str,
    call_id: str,
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
                if (
                    isinstance(value, dict)
                    and value.get("run_id") == run_id
                    and value.get("event") == "model_usage"
                    and value.get("call_id") == call_id
                ):
                    return value
    except OSError:
        return None
    return None


def find_model_call_claim(
    path: Path,
    run_id: str,
    call_id: str,
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
                if (
                    isinstance(value, dict)
                    and value.get("run_id") == run_id
                    and value.get("event") == "model_call"
                    and value.get("phase") == "claimed"
                    and value.get("call_id") == call_id
                ):
                    return value
    except OSError:
        return None
    return None


def jsonl_has_event(path: Path, event_id: str) -> bool:
    return find_jsonl_event(path, event_id) is not None


def load_resource_states(
    path: Path,
    run_id: str,
) -> Dict[str, Tuple[str, str]]:
    if not path.is_file():
        return {}
    states: Dict[str, Tuple[str, str]] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise UsageError("resource state log contains invalid JSON") from exc
            if (
                not isinstance(value, dict)
                or value.get("run_id") != run_id
                or value.get("event") != "resource"
            ):
                continue
            resource_id = value.get("resource_id")
            resource_kind = value.get("resource_kind")
            phase = value.get("phase")
            if (
                not isinstance(resource_id, str)
                or not RESOURCE_ID.fullmatch(resource_id)
                or not isinstance(resource_kind, str)
                or not IDENTIFIER.fullmatch(resource_kind)
                or phase not in RESOURCE_PHASES
            ):
                raise UsageError("resource state log contains a malformed event")
            if phase == "acquired" and value.get("cleanup_required") is not True:
                raise UsageError("resource acquisition is missing cleanup_required")
            apply_resource_transition(
                states,
                resource_id,
                resource_kind,
                str(phase),
            )
    return states


def apply_resource_transition(
    states: Dict[str, Tuple[str, str]],
    resource_id: str,
    resource_kind: str,
    phase: str,
) -> None:
    previous = states.get(resource_id)
    if previous is None:
        if phase != "acquired":
            raise UsageError("resource terminal phase has no acquisition")
        states[resource_id] = (phase, resource_kind)
        return

    previous_phase, previous_kind = previous
    if previous_kind != resource_kind:
        raise UsageError("resource_kind does not match its acquisition")
    if phase == "acquired":
        if previous_phase != "acquired":
            raise UsageError(
                "released resource_id cannot be reused; acquire a new resource_id"
            )
        raise UsageError(
            "active resource_id already has an acquisition; "
            "acquire a new resource_id"
        )
    elif phase == "cleanup_failed" and previous_phase == "released":
        raise UsageError("released resource cannot fail cleanup")
    states[resource_id] = (phase, resource_kind)


def unclosed_resources(states: Dict[str, Tuple[str, str]]) -> List[str]:
    return sorted(
        resource_id
        for resource_id, (phase, _) in states.items()
        if phase in {"acquired", "cleanup_failed"}
    )


def apply_test_run_transition(
    active: bool,
    open_cases: set[str],
    phase: str,
    case_id: Optional[str],
) -> bool:
    if phase == "start":
        if active:
            raise UsageError("test_run start has no preceding complete")
        if open_cases:
            raise UsageError("test_run state contains cases without an active run")
        return True
    if phase == "case_start":
        if not active:
            raise UsageError("test_run case_start has no active test run")
        assert case_id is not None
        if case_id in open_cases:
            raise UsageError("test_run case already has an active case_start")
        open_cases.add(case_id)
        return active
    if phase in {"case_complete", "case_blocked"}:
        if not active:
            raise UsageError("test_run case terminal phase has no active test run")
        assert case_id is not None
        if case_id not in open_cases:
            raise UsageError("test_run case terminal phase has no case_start")
        open_cases.remove(case_id)
        return active
    if not active:
        raise UsageError("test_run complete has no active test run")
    if open_cases:
        raise UsageError("test_run complete has unfinished cases")
    return False


def load_test_run_state(path: Path, run_id: str) -> Tuple[bool, set[str]]:
    if not path.is_file():
        return False, set()
    active = False
    open_cases: set[str] = set()
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise UsageError("test_run state log contains invalid JSON") from exc
            if (
                not isinstance(value, dict)
                or value.get("run_id") != run_id
                or value.get("event") != "test_run"
                or value.get("phase") is None
            ):
                continue
            phase = value.get("phase")
            if phase not in TEST_RUN_PHASES:
                raise UsageError("test_run state log contains a malformed event")
            case_id = value.get("case_id")
            if phase.startswith("case_") and (
                not isinstance(case_id, str) or not RESOURCE_ID.fullmatch(case_id)
            ):
                raise UsageError("test_run state log contains a malformed case event")
            # Before invocation-level pairing was introduced, phased test records
            # could contain a standalone complete event. Treat that historical
            # shape as already closed; candidate writes still pass through the
            # strict transition validator below and cannot create new orphans.
            if phase == "complete" and not active and not open_cases:
                continue
            active = apply_test_run_transition(
                active,
                open_cases,
                str(phase),
                str(case_id) if isinstance(case_id, str) else None,
            )
    return active, open_cases


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
        data = parse_data(args.data_json, event_name)
        validate_resource_event(event_name, phase, data)
        validate_test_run_event(event_name, phase, data)
        validate_model_usage_event(event_name, phase, data)
        validate_model_call_event(event_name, phase, data)
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

    global_log: Optional[Path] = None
    if project_log is None:
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
    authoritative_log = project_log if project_log else global_log
    assert authoritative_log is not None
    if event_name == "model_usage":
        existing_call = find_model_usage_call(
            authoritative_log,
            run_id,
            str(data["call_id"]),
        )
        if existing_call is not None and existing_call.get("event_id") != event_id:
            print(
                "cm-log-event: model_usage call_id already used with different payload",
                file=sys.stderr,
            )
            return 2
        existing_claim = find_model_call_claim(
            authoritative_log,
            run_id,
            str(data["call_id"]),
        )
        if data.get("adapter") == "openai-compatible" and existing_claim is None:
            print(
                "cm-log-event: managed model_usage requires a prior model_call claim",
                file=sys.stderr,
            )
            return 2
        if (
            existing_claim is not None
            and model_call_identity(existing_claim) != model_call_identity(event)
        ):
            print(
                "cm-log-event: model_usage identity does not match model_call claim",
                file=sys.stderr,
            )
            return 2
    if event_name == "model_call":
        existing_usage = find_model_usage_call(
            authoritative_log,
            run_id,
            str(data["call_id"]),
        )
        if existing_usage is not None:
            print(
                "cm-log-event: model_call call_id already completed",
                file=sys.stderr,
            )
            return 2
        existing_claim = find_model_call_claim(
            authoritative_log,
            run_id,
            str(data["call_id"]),
        )
        if existing_claim is not None and existing_claim.get("event_id") != event_id:
            print(
                "cm-log-event: model_call call_id already claimed with different payload",
                file=sys.stderr,
            )
            return 2
    existing_authoritative_event = None
    if (
        event_name in {"resource", "test_run"}
        or event_name in RESOURCE_GUARDED_EVENTS
        or event_name in TEST_RUN_GUARDED_EVENTS
    ):
        existing_authoritative_event = find_jsonl_event(
            authoritative_log,
            event_id,
        )

    resource_states: Dict[str, Tuple[str, str]] = {}
    if (
        event_name == "resource"
        and existing_authoritative_event is None
    ) or (
        event_name in RESOURCE_GUARDED_EVENTS
        and existing_authoritative_event is None
    ):
        try:
            resource_states = load_resource_states(authoritative_log, run_id)
        except (OSError, UsageError) as exc:
            print(
                "cm-log-event: resource state cannot be verified: "
                f"{type(exc).__name__}",
                file=sys.stderr,
            )
            return 2

    if (
        event_name in RESOURCE_GUARDED_EVENTS
        and existing_authoritative_event is None
    ):
        pending_resources = unclosed_resources(resource_states)
        if pending_resources:
            print(
                "cm-log-event: completion blocked by unclosed resources: "
                + ", ".join(pending_resources),
                file=sys.stderr,
            )
            return 2

    if event_name == "resource" and existing_authoritative_event is None:
        try:
            apply_resource_transition(
                resource_states,
                str(data["resource_id"]),
                str(data["resource_kind"]),
                str(phase),
            )
        except UsageError as exc:
            print(f"cm-log-event: {exc}", file=sys.stderr)
            return 2

    test_run_active = False
    open_test_cases: set[str] = set()
    if (
        (event_name == "test_run" and phase is not None)
        or event_name in TEST_RUN_GUARDED_EVENTS
    ) and existing_authoritative_event is None:
        try:
            test_run_active, open_test_cases = load_test_run_state(
                authoritative_log,
                run_id,
            )
        except (OSError, UsageError) as exc:
            print(
                "cm-log-event: test_run state cannot be verified: "
                f"{type(exc).__name__}",
                file=sys.stderr,
            )
            return 2

    if (
        event_name in TEST_RUN_GUARDED_EVENTS
        and existing_authoritative_event is None
        and (test_run_active or open_test_cases)
    ):
        detail_parts = []
        if test_run_active:
            detail_parts.append("active invocation")
        if open_test_cases:
            detail_parts.append("open cases: " + ", ".join(sorted(open_test_cases)))
        print(
            "cm-log-event: completion blocked by incomplete test_run: "
            + "; ".join(detail_parts),
            file=sys.stderr,
        )
        return 2

    if (
        event_name == "test_run"
        and phase is not None
        and existing_authoritative_event is None
    ):
        try:
            apply_test_run_transition(
                test_run_active,
                open_test_cases,
                str(phase),
                str(data["case_id"]) if "case_id" in data else None,
            )
        except UsageError as exc:
            print(f"cm-log-event: {exc}", file=sys.stderr)
            return 2

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

    if global_log is None:
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
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
