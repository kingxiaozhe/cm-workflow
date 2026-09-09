# Test-only frozen pre-migration implementation; never a production fallback.
#!/usr/bin/env python3
"""Build or verify the semantic content manifest bound to CM spec approval."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


FEATURE_DIR = re.compile(r"^\d+\..+")
REQUIRED_FILES = ("requirements.md", "design.md", "tasks.md")
OPTIONAL_FILES = ("test-cases.json",)
SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMPLETED_TASK = re.compile(
    rb"^([ ]{0,3}-[ \t]+)\[[xX]\]([ \t]+T-[A-Za-z0-9][A-Za-z0-9._-]*[ \t]*:)",
)
COMPLETED_AC = re.compile(
    rb"^([ ]{0,3}-[ \t]+)\[[xX]\]([ \t]+\[AC-[A-Za-z0-9][A-Za-z0-9._-]*\])",
)
FENCE = re.compile(rb"^[ ]{0,3}(`{3,}|~{3,})")


class ManifestError(ValueError):
    """A spec tree or approval manifest violates the contract."""


def normalize_runtime_markers(content: bytes, marker: re.Pattern[bytes]) -> bytes:
    normalized: list[bytes] = []
    fence_char: bytes | None = None
    fence_width = 0
    for line in content.splitlines(keepends=True):
        fence = FENCE.match(line)
        if fence_char is not None:
            normalized.append(line)
            if fence:
                token = fence.group(1)
                remainder = line[fence.end() :].strip()
                if token[:1] == fence_char and len(token) >= fence_width and not remainder:
                    fence_char = None
                    fence_width = 0
            continue
        if fence:
            token = fence.group(1)
            fence_char = token[:1]
            fence_width = len(token)
            normalized.append(line)
            continue
        # Four-space and tab-indented blocks are Markdown code, not spec state.
        if line.startswith((b"    ", b"\t")):
            normalized.append(line)
            continue
        normalized.append(marker.sub(rb"\1[ ]\2", line, count=1))
    return b"".join(normalized)


def file_digest(path: Path) -> str:
    content = path.read_bytes()
    # N5/N6 write execution results into task/AC checkboxes. Approval protects
    # their meaning, not the unchecked/completed runtime marker itself.
    if path.name == "tasks.md":
        content = normalize_runtime_markers(content, COMPLETED_TASK)
    elif path.name == "requirements.md":
        content = normalize_runtime_markers(content, COMPLETED_AC)
    return hashlib.sha256(content).hexdigest()


def build_manifest(specs_dir: Path) -> list[dict[str, str]]:
    if not specs_dir.is_dir():
        raise ManifestError(f"specs directory does not exist: {specs_dir}")
    features = sorted(path for path in specs_dir.iterdir() if FEATURE_DIR.fullmatch(path.name))
    if not features:
        raise ManifestError("specs directory contains no numbered feature directories")

    rows: list[dict[str, str]] = []
    for feature in features:
        if feature.is_symlink() or not feature.is_dir():
            raise ManifestError(f"numbered feature must be a regular directory: {feature}")
        for name in REQUIRED_FILES:
            path = feature / name
            if not path.is_file():
                raise ManifestError(f"missing required spec file: {feature.name}/{name}")
            if path.is_symlink():
                raise ManifestError(f"approved spec file must not be a symlink: {path}")
        for name in (*REQUIRED_FILES, *OPTIONAL_FILES):
            path = feature / name
            if not path.exists():
                continue
            if not path.is_file():
                raise ManifestError(f"approved spec path must be a file: {path}")
            if path.is_symlink():
                raise ManifestError(f"approved spec file must not be a symlink: {path}")
            rows.append(
                {
                    "path": f"{feature.name}/{name}",
                    "sha256": file_digest(path),
                }
            )
    return sorted(rows, key=lambda item: item["path"])


def load_status(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManifestError(f"cannot read status file {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ManifestError("status file root must be an object")
    raw_rows = value.get("specFiles")
    if not isinstance(raw_rows, list) or not raw_rows:
        raise ManifestError("status file has no approved specFiles manifest")
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_rows):
        if not isinstance(item, dict) or set(item) != {"path", "sha256"}:
            raise ManifestError(f"specFiles[{index}] must contain path and sha256 only")
        relative = item.get("path")
        digest = item.get("sha256")
        if (
            not isinstance(relative, str)
            or relative.startswith(("/", "\\"))
            or "\\" in relative
            or ".." in Path(relative).parts
            or relative in seen
        ):
            raise ManifestError(f"specFiles[{index}].path is invalid or duplicated")
        if not isinstance(digest, str) or not SHA256.fullmatch(digest):
            raise ManifestError(f"specFiles[{index}].sha256 is invalid")
        seen.add(relative)
        rows.append({"path": relative, "sha256": digest})
    if value.get("status") != "approved":
        raise ManifestError("status file must have status approved before manifest verification")
    return {"status": value.get("status"), "specFiles": rows}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("specs_dir")
    parser.add_argument("--status-file")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        specs_dir = Path(args.specs_dir).expanduser().resolve(strict=False)
        manifest = build_manifest(specs_dir)
        if args.status_file:
            status = load_status(Path(args.status_file).expanduser().resolve(strict=False))
            if status["specFiles"] != manifest:
                raise ManifestError("approved spec manifest does not match current spec files")
            result: dict[str, Any] = {
                "schema_version": 1,
                "status": "matched",
                "specFiles": manifest,
            }
        else:
            result = {"schema_version": 1, "specFiles": manifest}
    except (OSError, ManifestError) as exc:
        print(f"cm-spec-manifest: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
