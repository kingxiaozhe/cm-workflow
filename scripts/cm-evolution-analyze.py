#!/usr/bin/env python3
"""Read-only, deterministic analyzer for repeated CM Workflow failure signals."""

from collections import Counter, defaultdict
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys


MAX_FILES = 32
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_LINES = 200_000
MAX_LINE_BYTES = 65_536
MAX_FINGERPRINTS = 1_000
MAX_RUN_REFS = 128

IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,63}$")
ENTITY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$")
SECRET_SHAPED = re.compile(
    r"api[_-]?key|authorization|cookie|password|passwd|private[_-]?key|"
    r"recovery[_-]?code|secret|token",
    re.IGNORECASE,
)
CREDENTIAL_SHAPED = re.compile(
    r"(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,}|"
    r"xox[baprs]-[A-Za-z0-9-]{20,}"
)
HIGH_RISK_IMPACTS = {
    "security",
    "data_integrity",
    "state_integrity",
    "completion_integrity",
}
RESOURCE_PHASES = {"acquired", "released", "cleanup_failed"}


class InputBoundaryError(Exception):
    def __init__(self, code, input_index=None):
        super().__init__(code)
        self.code = code
        self.input_index = input_index


def hash_ref(value):
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def parse_cli(arguments):
    if not arguments or len(arguments) % 2:
        raise InputBoundaryError("invalid_arguments")
    paths = []
    for offset in range(0, len(arguments), 2):
        if arguments[offset] != "--log" or not arguments[offset + 1]:
            raise InputBoundaryError("invalid_arguments", offset // 2 + 1)
        paths.append(Path(arguments[offset + 1]))
    if len(paths) > MAX_FILES:
        raise InputBoundaryError("too_many_files")
    return paths


def open_regular_file(path, input_index):
    try:
        if path.is_symlink():
            raise InputBoundaryError("invalid_input", input_index)
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(str(path), flags)
    except InputBoundaryError:
        raise
    except (OSError, ValueError):
        raise InputBoundaryError("unreadable_input", input_index)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise InputBoundaryError("invalid_input", input_index)
        return os.fdopen(descriptor, "rb"), metadata.st_size
    except InputBoundaryError:
        os.close(descriptor)
        raise
    except OSError:
        os.close(descriptor)
        raise InputBoundaryError("unreadable_input", input_index)


def reject_non_standard_constant(_value):
    raise ValueError("non-standard JSON constant")


def parse_finite_float(value):
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("non-finite JSON number")
    return parsed


class Analyzer:
    def __init__(self):
        self.summary = {
            "files": 0,
            "lines": 0,
            "valid_events": 0,
            "signal_events": 0,
            "malformed_lines": 0,
        }
        self.diagnostics = Counter()
        self.aggregates = {}
        self.resource_events = defaultdict(list)
        self.invalid_resource_groups = set()
        self.unknown_resource_runs = 0
        self.total_bytes = 0

    def diagnose(self, code, malformed=False):
        self.diagnostics[code] += 1
        if malformed:
            self.summary["malformed_lines"] += 1

    def read(self, paths):
        self.summary["files"] = len(paths)
        declared_size = 0
        for input_index, path in enumerate(paths, start=1):
            handle, file_size = open_regular_file(path, input_index)
            declared_size += file_size
            if declared_size > MAX_TOTAL_BYTES:
                handle.close()
                raise InputBoundaryError("input_too_large", input_index)
            try:
                with handle:
                    while True:
                        try:
                            raw_line = handle.readline(MAX_LINE_BYTES + 1)
                        except OSError:
                            raise InputBoundaryError("unreadable_input", input_index)
                        if not raw_line:
                            break
                        if len(raw_line) > MAX_LINE_BYTES:
                            raise InputBoundaryError("line_too_long", input_index)
                        self.total_bytes += len(raw_line)
                        if self.total_bytes > MAX_TOTAL_BYTES:
                            raise InputBoundaryError("input_too_large", input_index)
                        self.summary["lines"] += 1
                        if self.summary["lines"] > MAX_LINES:
                            raise InputBoundaryError("too_many_lines", input_index)
                        self.process_line(raw_line)
            except InputBoundaryError:
                raise
            except OSError:
                raise InputBoundaryError("unreadable_input", input_index)
        self.finish_resources()

    def process_line(self, raw_line):
        try:
            text = raw_line.decode("utf-8")
        except UnicodeDecodeError:
            self.diagnose("invalid_utf8", malformed=True)
            return
        try:
            row = json.loads(
                text,
                parse_constant=reject_non_standard_constant,
                parse_float=parse_finite_float,
            )
        except (json.JSONDecodeError, RecursionError, ValueError):
            self.diagnose("malformed_json", malformed=True)
            return
        if not isinstance(row, dict):
            self.diagnose("non_object", malformed=True)
            return
        self.summary["valid_events"] += 1
        self.process_event(row)

    def process_event(self, row):
        event_name = row.get("event")
        if not isinstance(event_name, str):
            if "event" in row:
                self.diagnose("invalid_field_type")
            return

        if event_name == "resource":
            self.collect_resource(row)
            return
        if event_name == "error":
            signal_kind = self.error_signal_kind(row)
            if signal_kind is not None:
                self.summary["signal_events"] += 1
                self.add_event_signal(signal_kind, row)
            return
        if event_name == "degrade":
            self.summary["signal_events"] += 1
            self.add_event_signal("degrade", row)
            return
        if event_name == "warning":
            recovered = row.get("recovered")
            if not isinstance(recovered, bool):
                self.diagnose("invalid_field_type")
                return
            if recovered is False:
                self.summary["signal_events"] += 1
                self.add_event_signal("unrecovered_warning", row)
            return
        if event_name in {"review", "task_review"}:
            state = self.normalized_state(
                row, {"retry": "retry", "changes_requested": "changes_requested"}
            )
            if state is not None:
                self.summary["signal_events"] += 1
                if state:
                    self.add_event_signal("review_retry", row, normalized_state=state)
            return
        if event_name in {"qa", "test_run"}:
            state = self.normalized_state(
                row, {"blocked": "blocked", "case_blocked": "case_blocked"}
            )
            if state is not None:
                self.summary["signal_events"] += 1
                if state:
                    self.add_event_signal("qa_blocked", row, normalized_state=state)

    def normalized_state(self, row, allowed):
        found = []
        saw_relevant_field = False
        for name in ("phase", "outcome"):
            if name not in row:
                continue
            saw_relevant_field = True
            value = row[name]
            if not isinstance(value, str):
                self.diagnose("invalid_field_type")
                return ""
            if value in allowed:
                found.append(allowed[value])
        if not found:
            return None if saw_relevant_field else None
        if len(set(found)) > 1:
            self.diagnose("conflicting_signal_state")
            return ""
        return found[0]

    def error_signal_kind(self, row):
        recovered = row.get("recovered")
        if "recovered" in row and not isinstance(recovered, bool):
            self.diagnose("invalid_field_type")
            return None
        for name in ("outcome", "impact"):
            if name in row and not isinstance(row[name], str):
                self.diagnose("invalid_field_type")
                return None
        high_risk = (
            recovered is False
            and row.get("outcome") == "blocked"
            and row.get("impact") in HIGH_RISK_IMPACTS
        )
        return "high_risk_error" if high_risk else "error"

    def common_signature(self, row, signal_kind):
        schema_version = row.get("schema_version")
        if isinstance(schema_version, bool) or not isinstance(schema_version, int):
            self.diagnose(
                "invalid_field_type" if "schema_version" in row else "insufficient_signature"
            )
            return None
        if schema_version != 1:
            self.diagnose("unsupported_schema_version")
            return None
        workflow = self.identifier(row, "workflow")
        if workflow is None:
            return None
        return {
            "fingerprint_version": 1,
            "schema_version": 1,
            "workflow": workflow,
            "signal_kind": signal_kind,
        }

    def identifier(self, row, name, pattern=IDENTIFIER):
        if name not in row:
            self.diagnose("insufficient_signature")
            return None
        value = row[name]
        if not isinstance(value, str):
            self.diagnose("invalid_field_type")
            return None
        if SECRET_SHAPED.search(value) or CREDENTIAL_SHAPED.search(value):
            self.diagnose("secret_shaped_token")
            return None
        if not pattern.fullmatch(value):
            self.diagnose("invalid_identifier")
            return None
        return value

    def scope_ref(self, row, preferred, fallback):
        name = preferred if preferred in row else fallback
        pattern = IDENTIFIER if name == "node" else ENTITY_ID
        value = self.identifier(row, name, pattern)
        return None if value is None else hash_ref(value)

    def valid_run_id(self, row):
        if "run_id" not in row:
            self.diagnose("invalid_run_id")
            return None
        value = row["run_id"]
        if not isinstance(value, str):
            self.diagnose("invalid_field_type")
            return None
        if SECRET_SHAPED.search(value) or CREDENTIAL_SHAPED.search(value):
            self.diagnose("secret_shaped_token")
            return None
        if not RUN_ID.fullmatch(value):
            self.diagnose("invalid_run_id")
            return None
        return value

    def resource_run_identity(self, row):
        if "run_id" not in row:
            self.diagnose("invalid_run_id")
            self.unknown_resource_runs += 1
            return f"unknown:{self.unknown_resource_runs}", None
        value = row["run_id"]
        if not isinstance(value, str):
            self.diagnose("invalid_field_type")
            self.unknown_resource_runs += 1
            return f"unknown:{self.unknown_resource_runs}", None
        if SECRET_SHAPED.search(value) or CREDENTIAL_SHAPED.search(value):
            self.diagnose("secret_shaped_token")
            return None, None
        if not RUN_ID.fullmatch(value):
            self.diagnose("invalid_run_id")
            try:
                return "invalid:" + hash_ref(value), None
            except UnicodeEncodeError:
                return None, None
        return "valid:" + value, value

    def add_event_signal(self, signal_kind, row, normalized_state=None):
        raw_run_id = row.get("run_id")
        if isinstance(raw_run_id, str) and (
            SECRET_SHAPED.search(raw_run_id) or CREDENTIAL_SHAPED.search(raw_run_id)
        ):
            self.diagnose("secret_shaped_token")
            return
        signature = self.common_signature(row, signal_kind)
        if signature is None:
            return

        if signal_kind == "error":
            scope_ref = self.scope_ref(row, "node", "task")
            phase = self.identifier(row, "phase")
            error_type = self.identifier(row, "error_type")
            if None in (scope_ref, phase, error_type):
                return
            signature.update(
                {"scope_ref": scope_ref, "phase": phase, "error_type": error_type}
            )
        elif signal_kind == "high_risk_error":
            scope_ref = self.scope_ref(row, "node", "task")
            phase = self.identifier(row, "phase")
            outcome = self.identifier(row, "outcome")
            error_type = self.identifier(row, "error_type")
            impact = self.identifier(row, "impact")
            if None in (scope_ref, phase, outcome, error_type, impact):
                return
            signature.update(
                {
                    "scope_ref": scope_ref,
                    "phase": phase,
                    "outcome": outcome,
                    "error_type": error_type,
                    "impact": impact,
                }
            )
        elif signal_kind == "degrade":
            phase = self.identifier(row, "phase")
            error_type = self.identifier(row, "error_type")
            if None in (phase, error_type):
                return
            signature.update({"phase": phase, "error_type": error_type})
        elif signal_kind == "unrecovered_warning":
            scope_ref = self.scope_ref(row, "node", "task")
            phase = self.identifier(row, "phase")
            error_type = self.identifier(row, "error_type")
            if None in (scope_ref, phase, error_type):
                return
            signature.update(
                {"scope_ref": scope_ref, "phase": phase, "error_type": error_type}
            )
        elif signal_kind == "review_retry":
            scope_ref = self.scope_ref(row, "task", "node")
            if scope_ref is None:
                return
            signature.update(
                {"scope_ref": scope_ref, "review_state": normalized_state}
            )
        elif signal_kind == "qa_blocked":
            case_id = self.identifier(row, "case_id", ENTITY_ID)
            if case_id is None:
                return
            signature.update(
                {"case_ref": hash_ref(case_id), "qa_state": normalized_state}
            )
        run_id = self.valid_run_id(row)
        self.aggregate(signature, run_id, signal_kind == "high_risk_error")

    def collect_resource(self, row):
        phase = row.get("phase")
        if not isinstance(phase, str):
            self.diagnose("invalid_field_type")
            return
        if phase not in RESOURCE_PHASES:
            return
        run_key, run_id = self.resource_run_identity(row)
        resource_id = self.identifier(row, "resource_id", ENTITY_ID)
        resource_kind = self.identifier(row, "resource_kind")
        if None in (run_key, resource_id, resource_kind):
            return
        key = (run_key, resource_id, resource_kind)
        at_value = row.get("at")
        if not isinstance(at_value, str) or SECRET_SHAPED.search(at_value) or CREDENTIAL_SHAPED.search(at_value):
            self.diagnose(
                "invalid_field_type" if not isinstance(at_value, str) else "secret_shaped_token"
            )
            self.diagnose("ambiguous_resource_terminal")
            self.invalid_resource_groups.add(key)
            return
        try:
            parsed_at = datetime.fromisoformat(at_value.replace("Z", "+00:00"))
            if parsed_at.tzinfo is None:
                raise ValueError
        except (ValueError, OverflowError):
            self.diagnose("ambiguous_resource_terminal")
            self.invalid_resource_groups.add(key)
            return
        common = self.common_signature(row, "resource_cleanup_failed")
        self.resource_events[key].append((parsed_at, phase, common, run_id))

    def finish_resources(self):
        for key in sorted(self.resource_events):
            if key in self.invalid_resource_groups:
                continue
            rows = self.resource_events[key]
            by_time = defaultdict(set)
            for at_value, phase, _, _ in rows:
                by_time[at_value].add(phase)
            if any(len(states) > 1 for states in by_time.values()):
                self.diagnose("ambiguous_resource_terminal")
                continue
            final_at = max(by_time)
            final_phase = next(iter(by_time[final_at]))
            if final_phase != "cleanup_failed":
                continue
            _, _, resource_kind = key
            final_common = [
                common
                for at_value, _, common, _ in rows
                if at_value == final_at and common is not None
            ]
            if not final_common:
                continue
            common = min(final_common, key=lambda value: value["workflow"])
            run_id = next(
                (
                    candidate
                    for at_value, _, _, candidate in rows
                    if at_value == final_at and candidate is not None
                ),
                None,
            )
            signature = dict(common)
            signature.update(
                {
                    "resource_kind": resource_kind,
                    "resource_state": "cleanup_failed_unreleased",
                }
            )
            self.summary["signal_events"] += 1
            self.aggregate(signature, run_id, True)

    def aggregate(self, signature, run_id, high_risk):
        canonical = json.dumps(
            signature, ensure_ascii=True, separators=(",", ":"), sort_keys=False
        ).encode("utf-8")
        fingerprint = "sha256:" + hashlib.sha256(canonical).hexdigest()
        if fingerprint not in self.aggregates:
            if len(self.aggregates) >= MAX_FINGERPRINTS:
                raise InputBoundaryError("too_many_fingerprints")
            self.aggregates[fingerprint] = {
                "signal_kind": signature["signal_kind"],
                "signature": signature,
                "occurrences": 0,
                "run_ids": set(),
                "high_risk": high_risk,
            }
        aggregate = self.aggregates[fingerprint]
        aggregate["occurrences"] += 1
        if run_id is not None:
            aggregate["run_ids"].add(run_id)

    def output(self):
        signals = []
        for fingerprint in sorted(self.aggregates):
            aggregate = self.aggregates[fingerprint]
            run_ids = aggregate["run_ids"]
            if aggregate["high_risk"]:
                classification = "candidate"
                reason = "high_risk_invariant"
            elif len(run_ids) >= 2:
                classification = "candidate"
                reason = "repeated_across_runs"
            else:
                classification = "observe"
                reason = "single_run"
            run_refs = sorted(hash_ref(run_id) for run_id in run_ids)
            signals.append(
                {
                    "fingerprint": fingerprint,
                    "classification": classification,
                    "reason": reason,
                    "signal_kind": aggregate["signal_kind"],
                    "occurrences": aggregate["occurrences"],
                    "distinct_runs": len(run_ids),
                    "run_refs": run_refs[:MAX_RUN_REFS],
                    "run_refs_truncated": len(run_refs) > MAX_RUN_REFS,
                    "signature": aggregate["signature"],
                }
            )
        if any(item["classification"] == "candidate" for item in signals):
            status_value = "candidate"
        elif signals or self.diagnostics:
            status_value = "observe"
        else:
            status_value = "no_signal"
        diagnostics = [
            {"code": code, "count": self.diagnostics[code]}
            for code in sorted(self.diagnostics)
        ]
        return {
            "schema_version": 1,
            "status": status_value,
            "summary": self.summary,
            "signals": signals,
            "diagnostics": diagnostics,
        }


def run(arguments):
    paths = parse_cli(arguments)
    analyzer = Analyzer()
    analyzer.read(paths)
    payload = analyzer.output()
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


def main():
    try:
        return run(sys.argv[1:])
    except InputBoundaryError as error:
        message = "cm-evolution-analyze:error=" + error.code
        if error.input_index is not None:
            message += " input=" + str(error.input_index)
        sys.stderr.write(message + "\n")
        return 2
    except (MemoryError, RecursionError):
        sys.stderr.write("cm-evolution-analyze:error=resource_limit\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
