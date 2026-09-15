#!/usr/bin/env python3
"""Compatibility CLI; semantic approval rules live in cm-spec-manifest.mjs."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys


def main() -> int:
    entry = Path(__file__).resolve().with_name("cm-spec-manifest.mjs")
    try:
        result = subprocess.run(
            [os.environ.get("CM_NODE_BIN", "node"), str(entry), *sys.argv[1:]],
            check=False,
        )
    except OSError as error:
        print(f"cm-spec-manifest: cannot start JavaScript runtime: {error}", file=sys.stderr)
        return 1
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
