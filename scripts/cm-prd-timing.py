#!/usr/bin/env python3
"""Summarize recent cm-prd phase timing events from the local global mirror."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple


PHASE_ORDER = (
    "context_load",
    "requirements_analysis",
    "design_generation",
    "design_review",
    "task_split",
    "spec_validation",
    "spec_review",
)


@dataclass
class RunRef:
    run_id: str
    project: str
    status: str
    updated_at: datetime
    at_text: str
    log_file: str


@dataclass
class RunTiming:
    ref: RunRef
    phases: Dict[str, float]
    triggered: Set[str]
    pauses: int
    incomplete: int


def configure_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(errors="backslashreplace")


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Show active phase time for recent cm-prd runs."
    )
    parser.add_argument("--last", type=positive_int, default=5)
    parser.add_argument(
        "--log-home",
        help="Override CM_WORKFLOW_LOG_HOME for this report.",
    )
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
        if row.get("workflow") != "cm-prd":
            continue
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


def load_run_timing(log_home: Path, ref: RunRef) -> Optional[RunTiming]:
    log_path = safe_log_path(log_home, ref.log_file)
    if log_path is None or not log_path.is_file():
        print(f"warning: missing run log for {ref.run_id}", file=sys.stderr)
        return None

    groups: Dict[Tuple[str, str, int], Dict[str, List[Dict[str, Any]]]] = {}
    for _, row in read_jsonl(log_path):
        if row.get("workflow") != "cm-prd" or row.get("event") != "progress":
            continue
        operation_id = row.get("operation_id")
        phase_name = row.get("phase_name")
        segment = row.get("segment")
        phase = row.get("phase")
        if (
            not isinstance(operation_id, str)
            or not isinstance(phase_name, str)
            or not isinstance(segment, int)
            or phase not in {"start", "complete"}
        ):
            continue
        key = (operation_id, phase_name, segment)
        groups.setdefault(key, {"start": [], "complete": []})[str(phase)].append(row)

    phases: Dict[str, float] = {}
    triggered: Set[str] = set()
    pauses = 0
    incomplete = 0
    for (_, phase_name, _), pair in groups.items():
        if pair["start"]:
            triggered.add(phase_name)
        if len(pair["start"]) != 1 or len(pair["complete"]) != 1:
            incomplete += 1
            continue
        started_at = parse_at(pair["start"][0].get("at"))
        completed_at = parse_at(pair["complete"][0].get("at"))
        if started_at is None or completed_at is None or completed_at < started_at:
            incomplete += 1
            continue
        phases[phase_name] = phases.get(phase_name, 0.0) + (
            completed_at - started_at
        ).total_seconds()
        if pair["complete"][0].get("outcome") == "awaiting_input":
            pauses += 1
    return RunTiming(
        ref=ref,
        phases=phases,
        triggered=triggered,
        pauses=pauses,
        incomplete=incomplete,
    )


def format_seconds(value: float) -> str:
    if value < 60:
        return f"{value:.1f}s"
    minutes = int(value // 60)
    seconds = value - minutes * 60
    return f"{minutes}m {seconds:.1f}s"


def phase_sort_key(name: str) -> Tuple[int, str]:
    try:
        return (PHASE_ORDER.index(name), name)
    except ValueError:
        return (len(PHASE_ORDER), name)


def print_report(runs: List[RunTiming], requested: int) -> None:
    if not runs:
        print("没有找到可读取的 cm-prd 阶段耗时日志。")
        return

    print(f"CM PRD 阶段耗时（最近 {min(requested, len(runs))} 次）")
    slowest: Optional[Tuple[float, str, RunRef]] = None
    total_pauses = 0
    total_incomplete = 0
    design_reviews = 0
    spec_reviews = 0

    for run in runs:
        print(
            f"\n- {run.ref.at_text} | {run.ref.project} | "
            f"{run.ref.run_id} | {run.ref.status}"
        )
        if run.phases:
            for phase_name in sorted(run.phases, key=phase_sort_key):
                duration = run.phases[phase_name]
                print(f"  {phase_name}: {format_seconds(duration)}")
                candidate = (duration, phase_name, run.ref)
                if slowest is None or candidate[0] > slowest[0]:
                    slowest = candidate
        else:
            print("  暂无完整的阶段事件配对")
        total_pauses += run.pauses
        total_incomplete += run.incomplete
        design_reviews += int("design_review" in run.triggered)
        spec_reviews += int("spec_review" in run.triggered)

    print("\n汇总")
    if slowest is None:
        print("- 最慢阶段: 暂无完整数据")
    else:
        print(
            f"- 最慢阶段: {slowest[1]} {format_seconds(slowest[0])} "
            f"({slowest[2].project} / {slowest[2].run_id})"
        )
    print(f"- 人工暂停: {total_pauses}")
    print(f"- 审查触发: design_review {design_reviews}，spec_review {spec_reviews}")
    print(f"- 未配对 segment: {total_incomplete}（未猜测耗时）")


def main() -> int:
    configure_output()
    args = parse_args()
    configured_home = args.log_home or os.environ.get(
        "CM_WORKFLOW_LOG_HOME", "~/.cm-workflow/logs"
    )
    log_home = Path(configured_home).expanduser().resolve(strict=False)
    refs = load_run_refs(log_home)[: args.last]
    timings = [timing for ref in refs if (timing := load_run_timing(log_home, ref))]
    print_report(timings, args.last)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
