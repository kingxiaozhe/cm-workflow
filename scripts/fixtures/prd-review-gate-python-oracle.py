# Test-only frozen pre-migration implementation; never a production fallback.
#!/usr/bin/env python3
"""Guard one-attempt PRD review dispatch and crash-safe finding disposition."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any


FEATURE = re.compile(r"^[^<>:\"/\\|?*\x00-\x1f]+$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
STAGES = {"design", "split"}
DISPOSITIONS = {"applied", "escalated", "no_findings"}


class GateError(ValueError):
    """A PRD review recovery artifact violates the contract."""


def digest(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        raise GateError(f"cannot hash {path}: {exc}") from exc


def validate_disposition(disposition: str, finding_count: int, unresolved_count: int) -> None:
    if finding_count < 0 or unresolved_count < 0:
        raise GateError("finding counts must be non-negative")
    if unresolved_count > finding_count:
        raise GateError("unresolved_count cannot exceed finding_count")
    if disposition in {"applied", "no_findings"} and unresolved_count != 0:
        raise GateError("completed disposition cannot retain unresolved findings")
    if disposition == "no_findings" and finding_count != 0:
        raise GateError("no_findings disposition requires finding_count 0")
    if disposition == "escalated" and unresolved_count == 0:
        raise GateError("escalated disposition requires unresolved findings")


def require_paths(args: argparse.Namespace) -> tuple[Path, Path]:
    if (
        not FEATURE.fullmatch(args.feature)
        or args.feature in {".", ".."}
        or args.feature[-1:] in {" ", "."}
    ):
        raise GateError("feature must be a safe filename slug")
    evidence = Path(args.evidence).expanduser().resolve(strict=False)
    receipt = Path(args.receipt).expanduser().resolve(strict=False)
    expected_evidence = f"prd-{args.feature}-{args.stage}-r1.md"
    expected_receipt = f"prd-{args.feature}-{args.stage}-disposition.json"
    if evidence.name != expected_evidence:
        raise GateError(f"evidence must use {expected_evidence}")
    if receipt.name != expected_receipt or receipt.parent != evidence.parent:
        raise GateError(f"receipt must be adjacent and use {expected_receipt}")
    if evidence.parent.is_symlink():
        raise GateError("review directory must not be a symlink")
    r2 = evidence.with_name(f"prd-{args.feature}-{args.stage}-r2.md")
    if r2.exists():
        raise GateError(f"single-attempt PRD review forbids {r2.name}")
    return evidence, receipt


def validate_evidence(path: Path) -> None:
    if path.is_symlink():
        raise GateError("PRD review evidence must not be a symlink")
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise GateError(f"cannot read evidence {path}: {exc}") from exc
    if not lines or lines[0].strip() != "---":
        raise GateError("PRD review evidence must start with a YAML header")
    try:
        end = next(index for index, line in enumerate(lines[1:], start=1) if line.strip() == "---")
    except StopIteration as exc:
        raise GateError("PRD review evidence header is not closed") from exc
    header_lines = lines[1:end]
    fields: dict[str, str] = {}
    scope_items: list[str] = []
    in_scope = False
    for line in header_lines:
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?", line)
        if match:
            key = match.group(1)
            if key in fields:
                raise GateError(f"PRD review evidence duplicates {key}")
            fields[key] = (match.group(2) or "").strip()
            in_scope = key == "scope"
            continue
        scope_match = re.fullmatch(r"\s+-\s+(.+)", line)
        if in_scope and scope_match:
            scope_items.append(scope_match.group(1).strip())
            continue
        if line.strip():
            raise GateError("PRD review evidence header contains invalid YAML")
    for field in ("at", "reviewer", "independent", "scope"):
        if field not in fields:
            raise GateError(f"PRD review evidence is missing {field}")
    reviewer = fields["reviewer"]
    if reviewer not in {"codex-subagent", "codex-cli", "self-degraded"}:
        raise GateError("PRD review evidence reviewer is not a supported channel")
    if reviewer == "self-degraded":
        if fields["independent"] != "false" or not fields.get("degraded_reason", ""):
            raise GateError(
                "self-degraded evidence requires independent: false and degraded_reason"
            )
    elif fields["independent"] != "true":
        raise GateError("independent review evidence must record independent: true")
    if fields["scope"] or not scope_items or any(not item for item in scope_items):
        raise GateError("PRD review evidence scope must be a non-empty list")
    try:
        reviewed_at = datetime.fromisoformat(fields["at"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise GateError("PRD review evidence at must be an ISO-8601 timestamp") from exc
    if reviewed_at.tzinfo is None or reviewed_at.utcoffset() is None:
        raise GateError("PRD review evidence at must include a timezone")
    if not "\n".join(lines[end + 1 :]).strip():
        raise GateError("PRD review evidence body must not be empty")


def load_receipt(path: Path, *, stage: str, feature: str, evidence: Path) -> dict[str, Any]:
    if path.is_symlink():
        raise GateError("PRD review receipt must not be a symlink")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GateError(f"cannot read receipt {path}: {exc}") from exc
    required = {
        "schema_version",
        "stage",
        "feature",
        "status",
        "disposition",
        "finding_count",
        "unresolved_count",
        "evidence",
        "evidence_sha256",
        "artifacts",
        "at",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise GateError("PRD review receipt fields do not match the contract")
    if (
        value["schema_version"] != 1
        or value["stage"] != stage
        or value["feature"] != feature
        or value["status"] != "completed"
        or value["disposition"] not in DISPOSITIONS
        or value["evidence"] != evidence.name
        or value["evidence_sha256"] != digest(evidence)
    ):
        raise GateError("PRD review receipt does not match current evidence")
    for field in ("finding_count", "unresolved_count"):
        if isinstance(value[field], bool) or not isinstance(value[field], int) or value[field] < 0:
            raise GateError(f"PRD review receipt {field} is invalid")
    validate_disposition(
        str(value["disposition"]),
        int(value["finding_count"]),
        int(value["unresolved_count"]),
    )
    if not isinstance(value["at"], str):
        raise GateError("PRD review receipt at is invalid")
    try:
        recorded_at = datetime.fromisoformat(value["at"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise GateError("PRD review receipt at must be an ISO-8601 timestamp") from exc
    if recorded_at.tzinfo is None or recorded_at.utcoffset() is None:
        raise GateError("PRD review receipt at must include a timezone")
    artifacts = value["artifacts"]
    if not isinstance(artifacts, list) or not artifacts:
        raise GateError("PRD review receipt must contain artifact hashes")
    specs_root = path.parent.parent.resolve(strict=False)
    seen: set[str] = set()
    for item in artifacts:
        if (
            not isinstance(item, dict)
            or set(item) != {"path", "sha256"}
            or not isinstance(item["path"], str)
            or not isinstance(item["sha256"], str)
            or not SHA256.fullmatch(item["sha256"])
        ):
            raise GateError("PRD review receipt contains an invalid artifact")
        relative = item["path"]
        if (
            relative.startswith(("/", "\\"))
            or "\\" in relative
            or ".." in Path(relative).parts
            or relative in seen
        ):
            raise GateError("PRD review receipt contains an unsafe artifact path")
        seen.add(relative)
        raw_artifact = specs_root / relative
        if raw_artifact.is_symlink():
            raise GateError(f"PRD review artifact is missing or unsafe: {relative}")
        artifact = raw_artifact.resolve(strict=False)
        try:
            artifact.relative_to(specs_root)
        except ValueError as exc:
            raise GateError("PRD review artifact escapes the specs directory") from exc
        if not artifact.is_file():
            raise GateError(f"PRD review artifact is missing or unsafe: {relative}")
        if digest(artifact) != item["sha256"]:
            raise GateError(f"PRD review artifact changed after disposition: {relative}")
    return value


def inspect(args: argparse.Namespace) -> dict[str, Any]:
    evidence, receipt = require_paths(args)
    if receipt.exists() and not evidence.is_file():
        raise GateError("PRD review receipt exists without its r1 evidence")
    if not evidence.exists():
        return {"stage": args.stage, "feature": args.feature, "outcome": "dispatch_once"}
    validate_evidence(evidence)
    if not receipt.exists():
        return {"stage": args.stage, "feature": args.feature, "outcome": "resume_disposition"}
    value = load_receipt(receipt, stage=args.stage, feature=args.feature, evidence=evidence)
    return {
        "stage": args.stage,
        "feature": args.feature,
        "outcome": "completed",
        "disposition": value["disposition"],
    }


def record(args: argparse.Namespace) -> dict[str, Any]:
    evidence, receipt = require_paths(args)
    validate_evidence(evidence)
    if receipt.exists():
        load_receipt(receipt, stage=args.stage, feature=args.feature, evidence=evidence)
        return {"stage": args.stage, "feature": args.feature, "outcome": "already_recorded"}
    artifacts = []
    seen_artifacts: set[str] = set()
    specs_root = receipt.parent.parent.resolve(strict=False)
    for raw in args.artifact:
        path = Path(raw).expanduser().resolve(strict=False)
        if not path.is_file() or path.is_symlink():
            raise GateError(f"artifact must be a regular non-symlink file: {path}")
        try:
            relative = path.relative_to(specs_root)
        except ValueError as exc:
            raise GateError(f"artifact must stay inside the specs directory: {path}") from exc
        relative_path = relative.as_posix()
        if relative_path in seen_artifacts:
            raise GateError(f"artifact must not be duplicated: {relative_path}")
        seen_artifacts.add(relative_path)
        artifacts.append({"path": relative_path, "sha256": digest(path)})
    value = {
        "schema_version": 1,
        "stage": args.stage,
        "feature": args.feature,
        "status": "completed",
        "disposition": args.disposition,
        "finding_count": args.finding_count,
        "unresolved_count": args.unresolved_count,
        "evidence": evidence.name,
        "evidence_sha256": digest(evidence),
        "artifacts": artifacts,
        "at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    receipt.parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw_temp = tempfile.mkstemp(prefix=f".{receipt.name}.", dir=str(receipt.parent))
    temporary = Path(raw_temp)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, receipt)
    finally:
        if temporary.exists():
            temporary.unlink()
    return {"stage": args.stage, "feature": args.feature, "outcome": "recorded"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("inspect", "record"):
        command = commands.add_parser(name)
        command.add_argument("--stage", choices=sorted(STAGES), required=True)
        command.add_argument("--feature", required=True)
        command.add_argument("--evidence", required=True)
        command.add_argument("--receipt", required=True)
        if name == "record":
            command.add_argument("--artifact", action="append", required=True)
            command.add_argument("--disposition", choices=sorted(DISPOSITIONS), required=True)
            command.add_argument("--finding-count", type=int, required=True)
            command.add_argument("--unresolved-count", type=int, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.command == "inspect":
            result = inspect(args)
        else:
            validate_disposition(
                args.disposition,
                args.finding_count,
                args.unresolved_count,
            )
            result = record(args)
    except GateError as exc:
        print(f"cm-prd-review-gate: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
