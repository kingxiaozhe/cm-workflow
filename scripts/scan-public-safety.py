#!/usr/bin/env python3
"""Fail on common secrets and personal absolute paths in the current tree."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SELF = Path(__file__).resolve()
SKIP_DIRS = {".git"}
SKIP_SUFFIXES = {".png", ".gif", ".jpg", ".jpeg", ".mp4", ".woff", ".woff2"}
PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "GitHub token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    "OpenAI-style key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "Google API key": re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"),
    "Slack token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    "personal macOS path": re.compile(r"/Users/(?!example(?:/|$)|your-name(?:/|$))[^/\s]+/"),
    "personal Linux path": re.compile(r"/home/(?!example(?:/|$)|your-name(?:/|$))[^/\s]+/"),
    "private endpoint": re.compile(
        r"https?://(?:localhost|127\.0\.0\.1)(?::\d+)?|"
        r"https?://(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)"
    ),
}
ALLOW_PRIVATE_ENDPOINT_FILES = {
    Path("templates/dashboard/serve.sh"),
    Path("templates/pixel/serve.sh"),
    Path("templates/pixel/dev/README.md"),
}


def main() -> int:
    findings: list[str] = []
    tracked_result = subprocess.run(
        ["git", "ls-files", "-z", "--", ".omx"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    tracked_omx = None
    if tracked_result.returncode == 0:
        tracked_omx = {
            Path(item.decode("utf-8"))
            for item in tracked_result.stdout.split(b"\0")
            if item
        }

    for path in sorted(ROOT.rglob("*")):
        if path == SELF or not path.is_file() or any(part in SKIP_DIRS for part in path.parts):
            continue
        relative = path.relative_to(ROOT)
        # OMX execution state is machine-local and normally ignored. Skip only
        # untracked state; an accidentally tracked `.omx` file remains public
        # package content and must still be scanned. If Git lookup fails, scan
        # everything rather than creating a blind spot.
        if ".omx" in relative.parts and tracked_omx is not None and relative not in tracked_omx:
            continue
        if path.suffix.lower() in SKIP_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for label, pattern in PATTERNS.items():
            if label == "private endpoint" and relative in ALLOW_PRIVATE_ENDPOINT_FILES:
                continue
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                findings.append(f"{relative}:{line}: {label}")

    if findings:
        for finding in findings:
            print(f"FAIL: {finding}", file=sys.stderr)
        print(f"public safety scan: FAILED ({len(findings)})", file=sys.stderr)
        return 1

    print("public safety scan: PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
