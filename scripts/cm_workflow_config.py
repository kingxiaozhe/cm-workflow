#!/usr/bin/env python3
"""Compatibility CLI forwarding to the authoritative JavaScript config loader."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


ROLE_NAMES = {
    "analyst", "planner", "coder", "tester", "reviewer", "browser_qa", "external_expert"
}
RUNTIMES = {"codex", "claude", "unknown"}


def parse_legacy_cli(argv: list[str] | None = None) -> list[str]:
    parser = argparse.ArgumentParser(description="Validate and print CM Workflow project configuration")
    parser.add_argument("--project", type=Path, default=Path.cwd(), help="project root to inspect")
    parser.add_argument("--config", type=Path, help="explicit config path")
    parser.add_argument("--role", choices=sorted(ROLE_NAMES), help="resolve one effective workflow role")
    parser.add_argument("--runtime", choices=sorted(RUNTIMES), default="unknown", help="active CM runtime")
    parser.add_argument("--print-role", action="store_true", help="print one role route as redacted JSON")
    parser.add_argument("--print-effective", action="store_true", help="print the redacted effective JSON")
    args = parser.parse_args(argv)
    forwarded = ["--project", str(args.project), "--runtime", args.runtime]
    if args.config is not None:
        forwarded.extend(["--config", str(args.config)])
    if args.role is not None:
        forwarded.extend(["--role", args.role])
    if args.print_role:
        forwarded.append("--print-role")
    if args.print_effective:
        forwarded.append("--print-effective")
    return forwarded


def main() -> int:
    entry = Path(__file__).resolve().with_name("cm-workflow-config.mjs")
    try:
        result = subprocess.run(
            ["node", str(entry), *parse_legacy_cli()], check=False
        )
    except OSError as error:
        print(f"FAIL: cannot start JavaScript config loader: {error}", file=sys.stderr)
        return 1
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
