#!/usr/bin/env python3
"""Summarize verified model usage from the private CM global log mirror."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple


TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
)
CALL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
OUTCOMES = {"success", "error", "blocked", "cancelled"}
OUTCOME_ORDER = ("success", "error", "blocked", "cancelled")
IDENTITY_FIELDS = (
    "workflow",
    "runtime",
    "stage",
    "role",
    "adapter",
    "requested_model",
    "source",
    "purpose",
)


@dataclass
class RunRef:
    run_id: str
    workflow: str
    project: str
    status: str
    updated_at: datetime
    at_text: str
    log_file: str


def configure_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Show verified model usage for recent CM runs."
    )
    parser.add_argument("--last", type=positive_int, default=10)
    parser.add_argument("--log-home", help="Override CM_WORKFLOW_LOG_HOME.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    return parser.parse_args()


def parse_at(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def read_jsonl(path: Path) -> Iterable[Tuple[int, Dict[str, Any]]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        print(f"warning: cannot read {path}: {type(exc).__name__}", file=sys.stderr)
        return []
    rows: List[Tuple[int, Dict[str, Any]]] = []
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            print(f"warning: invalid JSON at {path}:{line_number}", file=sys.stderr)
            continue
        if isinstance(value, dict):
            rows.append((line_number, value))
    return rows


def load_run_refs(log_home: Path) -> List[RunRef]:
    index_path = log_home / "index.jsonl"
    if not index_path.is_file():
        return []
    refs: Dict[str, RunRef] = {}
    for _, row in read_jsonl(index_path):
        run_id = row.get("run_id")
        log_file = row.get("log_file")
        updated_at = parse_at(row.get("at"))
        if not isinstance(run_id, str) or not isinstance(log_file, str) or updated_at is None:
            continue
        previous = refs.get(run_id)
        status = "done" if row.get("status") == "done" else "running"
        if previous is not None and previous.status == "done":
            status = "done"
        if previous is None or updated_at >= previous.updated_at:
            refs[run_id] = RunRef(
                run_id=run_id,
                workflow=str(row.get("workflow") or "unknown"),
                project=str(row.get("project") or "unknown"),
                status=status,
                updated_at=updated_at,
                at_text=str(row.get("at")),
                log_file=log_file,
            )
        elif status == "done":
            previous.status = "done"
    return sorted(refs.values(), key=lambda item: item.updated_at, reverse=True)


def safe_log_path(log_home: Path, relative: str) -> Optional[Path]:
    candidate = (log_home / relative).resolve(strict=False)
    try:
        candidate.relative_to(log_home)
    except ValueError:
        print(f"warning: ignored log path outside log home: {relative}", file=sys.stderr)
        return None
    return candidate


def empty_counts() -> Dict[str, int]:
    return {
        "calls": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "duration_ms": 0,
        "duration_observed_calls": 0,
    }


def is_nonnegative_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def usage_row_error(row: Dict[str, Any]) -> Optional[str]:
    call_id = row.get("call_id")
    if not isinstance(call_id, str) or not CALL_ID.fullmatch(call_id):
        return "invalid call_id"
    if row.get("phase") != "complete":
        return "invalid phase"
    for field in IDENTITY_FIELDS:
        if not isinstance(row.get(field), str) or not row[field]:
            return f"invalid {field}"
    if row.get("outcome") not in OUTCOMES:
        return "invalid outcome"
    duration = row.get("duration_ms")
    if duration is not None and not is_nonnegative_int(duration):
        return "invalid duration"
    usage_state = row.get("usage_state")
    if usage_state == "observed":
        if not is_nonnegative_int(row.get("input_tokens")):
            return "invalid input count"
        if not is_nonnegative_int(row.get("output_tokens")):
            return "invalid output count"
        for field in ("cache_read_tokens", "cache_write_tokens"):
            if field in row and not is_nonnegative_int(row[field]):
                return "invalid cache count"
        return None
    if usage_state == "unavailable":
        if any(field in row for field in TOKEN_FIELDS):
            return "unavailable row contains token counts"
        return None
    return "invalid usage state"


def claim_row_error(row: Dict[str, Any]) -> Optional[str]:
    call_id = row.get("call_id")
    if not isinstance(call_id, str) or not CALL_ID.fullmatch(call_id):
        return "invalid call_id"
    if row.get("phase") != "claimed":
        return "invalid phase"
    for field in IDENTITY_FIELDS:
        if not isinstance(row.get(field), str) or not row[field]:
            return f"invalid {field}"
    return None


def call_identity(row: Dict[str, Any]) -> Tuple[str, ...]:
    return tuple(str(row[field]) for field in IDENTITY_FIELDS)


def add_observed(counts: Dict[str, int], row: Dict[str, Any]) -> None:
    counts["calls"] += 1
    for field in TOKEN_FIELDS:
        value = row.get(field, 0)
        if is_nonnegative_int(value):
            counts[field] += value
    duration = row.get("duration_ms")
    if is_nonnegative_int(duration):
        counts["duration_ms"] += duration
        counts["duration_observed_calls"] += 1


def build_report(log_home: Path, refs: List[RunRef]) -> Dict[str, Any]:
    summary = {
        "runs": len(refs),
        "observed_calls": 0,
        "unavailable_calls": 0,
        "unresolved_claims": 0,
        "invalid_calls": 0,
        "outcomes": {outcome: 0 for outcome in OUTCOME_ORDER},
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "duration_ms": 0,
        "duration_observed_calls": 0,
    }
    grouped: Dict[Tuple[str, str, str, str, str, str, str], Dict[str, Any]] = {}
    unavailable: Dict[Tuple[str, str, str, str], Dict[str, int]] = {}
    claims: Dict[Tuple[str, str], Dict[str, Any]] = {}
    claim_lines: Dict[Tuple[str, str], int] = {}
    completed_calls: Set[Tuple[str, str]] = set()
    ambiguous_claims: Set[Tuple[str, str]] = set()
    usage_candidates: List[Tuple[RunRef, Path, int, Dict[str, Any]]] = []
    seen_event_ids: Set[str] = set()
    seen_call_ids: Set[Tuple[str, str]] = set()

    for ref in refs:
        log_path = safe_log_path(log_home, ref.log_file)
        if log_path is None or not log_path.is_file():
            print(f"warning: missing run log for {ref.run_id}", file=sys.stderr)
            continue
        for line_number, row in read_jsonl(log_path):
            if row.get("run_id") != ref.run_id:
                continue
            if row.get("event") == "model_call":
                malformed_claim = claim_row_error(row)
                if malformed_claim is not None:
                    print(
                        f"warning: ignored malformed model_call at "
                        f"{log_path}:{line_number} ({malformed_claim})",
                        file=sys.stderr,
                    )
                    continue
                claim_key = (ref.run_id, str(row["call_id"]))
                existing_claim = claims.get(claim_key)
                if existing_claim is None:
                    claims[claim_key] = row
                    claim_lines[claim_key] = line_number
                elif call_identity(existing_claim) != call_identity(row):
                    ambiguous_claims.add(claim_key)
                    print(
                        f"warning: conflicting model_call identity at "
                        f"{log_path}:{line_number}",
                        file=sys.stderr,
                    )
                continue
            if row.get("event") != "model_usage":
                continue
            event_id = row.get("event_id")
            dedupe_key = (
                event_id
                if isinstance(event_id, str) and event_id
                else f"{log_path}:{line_number}"
            )
            if dedupe_key in seen_event_ids:
                continue
            seen_event_ids.add(dedupe_key)
            malformed = usage_row_error(row)
            if malformed is not None:
                summary["invalid_calls"] += 1
                print(
                    f"warning: ignored malformed model_usage at "
                    f"{log_path}:{line_number} ({malformed})",
                    file=sys.stderr,
                )
                continue
            usage_candidates.append((ref, log_path, line_number, row))

    for ref, log_path, line_number, row in usage_candidates:
        call_key = (ref.run_id, str(row["call_id"]))
        if call_key in seen_call_ids:
            summary["invalid_calls"] += 1
            print(
                f"warning: ignored duplicate model_usage call_id at "
                f"{log_path}:{line_number}",
                file=sys.stderr,
            )
            continue
        seen_call_ids.add(call_key)
        claim = claims.get(call_key)
        if row.get("adapter") == "openai-compatible" and claim is None:
            summary["invalid_calls"] += 1
            print(
                f"warning: ignored managed model_usage without prior claim at "
                f"{log_path}:{line_number}",
                file=sys.stderr,
            )
            continue
        if claim is not None and (
            call_key in ambiguous_claims
            or line_number <= claim_lines[call_key]
            or call_identity(claim) != call_identity(row)
        ):
            summary["invalid_calls"] += 1
            print(
                f"warning: ignored model_usage with mismatched claim identity at "
                f"{log_path}:{line_number}",
                file=sys.stderr,
            )
            continue
        if claim is not None:
            completed_calls.add(call_key)
        workflow = str(row["workflow"])
        stage = str(row["stage"])
        role = str(row["role"])
        usage_state = row.get("usage_state")
        outcome = str(row["outcome"])
        summary["outcomes"][outcome] += 1
        if usage_state == "unavailable":
            summary["unavailable_calls"] += 1
            key = (workflow, stage, role, outcome)
            if key not in unavailable:
                unavailable[key] = {
                    "calls": 0,
                    "duration_ms": 0,
                    "duration_observed_calls": 0,
                }
            unavailable[key]["calls"] += 1
            duration = row.get("duration_ms")
            if is_nonnegative_int(duration):
                unavailable[key]["duration_ms"] += duration
                unavailable[key]["duration_observed_calls"] += 1
                summary["duration_ms"] += duration
                summary["duration_observed_calls"] += 1
            continue
        if usage_state != "observed":
            continue

        effective = row.get("effective_model")
        requested = row.get("requested_model")
        if isinstance(effective, str) and effective:
            model = effective
            model_source = "effective"
        elif isinstance(requested, str) and requested:
            model = requested
            model_source = "requested"
        else:
            model = "unknown"
            model_source = "unreported"
        adapter = str(row["adapter"])
        key = (workflow, stage, role, adapter, model, model_source, outcome)
        if key not in grouped:
            grouped[key] = {
                "workflow": workflow,
                "stage": stage,
                "role": role,
                "adapter": adapter,
                "model": model,
                "model_source": model_source,
                "outcome": outcome,
                **empty_counts(),
            }
        add_observed(grouped[key], row)
        summary["observed_calls"] += 1
        for field in TOKEN_FIELDS:
            value = row.get(field, 0)
            if is_nonnegative_int(value):
                summary[field] += value
        duration = row.get("duration_ms")
        if is_nonnegative_int(duration):
            summary["duration_ms"] += duration
            summary["duration_observed_calls"] += 1

    groups = sorted(
        grouped.values(),
        key=lambda item: (
            str(item["workflow"]),
            str(item["stage"]),
            str(item["role"]),
            str(item["adapter"]),
            str(item["model"]),
            str(item["outcome"]),
        ),
    )
    unavailable_groups = [
        {
            "workflow": key[0],
            "stage": key[1],
            "role": key[2],
            "outcome": key[3],
            **counts,
        }
        for key, counts in sorted(unavailable.items())
    ]
    unresolved: Dict[Tuple[str, str, str, str, str, str], int] = {}
    for claim_key, claim in claims.items():
        if claim_key in completed_calls:
            continue
        key = (
            str(claim["workflow"]),
            str(claim["stage"]),
            str(claim["role"]),
            str(claim["adapter"]),
            str(claim["requested_model"]),
            str(claim["source"]),
        )
        unresolved[key] = unresolved.get(key, 0) + 1
    unresolved_groups = [
        {
            "workflow": key[0],
            "stage": key[1],
            "role": key[2],
            "adapter": key[3],
            "requested_model": key[4],
            "source": key[5],
            "claims": count,
        }
        for key, count in sorted(unresolved.items())
    ]
    summary["unresolved_claims"] = sum(unresolved.values())
    return {
        "schema_version": 1,
        "source": "cm-global-log-mirror",
        "missing_usage_policy": "unavailable-not-guessed",
        "unresolved_claim_policy": "reported-not-counted",
        "summary": summary,
        "groups": groups,
        "unavailable_groups": unavailable_groups,
        "unresolved_groups": unresolved_groups,
    }


def print_human(report: Dict[str, Any]) -> None:
    summary = report["summary"]
    print(f"CM API Usage（最近 {summary['runs']} 次运行）")
    print(
        f"- calls: observed {summary['observed_calls']} | "
        f"unavailable {summary['unavailable_calls']} | "
        f"unresolved claims {summary['unresolved_claims']} | "
        f"invalid {summary['invalid_calls']}"
    )
    print(
        f"- tokens: input {summary['input_tokens']} | output {summary['output_tokens']} | "
        f"cache read {summary['cache_read_tokens']} | "
        f"cache write {summary['cache_write_tokens']}"
    )
    print(
        "- outcomes: "
        + " | ".join(
            f"{outcome} {summary['outcomes'][outcome]}"
            for outcome in OUTCOME_ORDER
        )
    )
    if summary["duration_observed_calls"]:
        print(
            f"- observed duration: {summary['duration_ms']} ms "
            f"across {summary['duration_observed_calls']} calls"
        )
    for group in report["groups"]:
        print(
            f"- {group['workflow']}/{group['stage']} | {group['role']} | "
            f"{group['adapter']} | {group['model']} ({group['model_source']}) | "
            f"{group['outcome']} | "
            f"calls {group['calls']}, in {group['input_tokens']}, "
            f"out {group['output_tokens']}, cache-read {group['cache_read_tokens']}, "
            f"cache-write {group['cache_write_tokens']}"
        )
    for group in report["unresolved_groups"]:
        print(
            f"- unresolved: {group['workflow']}/{group['stage']} | "
            f"{group['role']} | {group['adapter']} | "
            f"{group['requested_model']} | claims {group['claims']}"
        )
    print(
        "- 缺失 usage 保持 unavailable；未完成 claim 单独报告且不计调用/Token；"
        "未推测缺失用量，也未换算费用。"
    )


def main() -> int:
    configure_output()
    args = parse_args()
    configured_home = args.log_home or os.environ.get(
        "CM_WORKFLOW_LOG_HOME", "~/.cm-workflow/logs"
    )
    log_home = Path(configured_home).expanduser().resolve(strict=False)
    refs = load_run_refs(log_home)[: args.last]
    report = build_report(log_home, refs)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    else:
        print_human(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
