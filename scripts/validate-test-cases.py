#!/usr/bin/env python3
"""Compatibility CLI forwarding to the authoritative JavaScript validator."""

from __future__ import annotations

import subprocess
import os
import sys
from pathlib import Path


def main() -> int:
    entry = Path(__file__).resolve().with_name("validate-test-cases.mjs")
    environment = os.environ.copy()
    environment["CM_COMPAT_PROGRAM"] = Path(sys.argv[0]).name
    try:
        result = subprocess.run(
            ["node", str(entry), *sys.argv[1:]], check=False, env=environment
        )
    except OSError as error:
        print(f"FAIL: cannot start JavaScript test-case validator: {error}", file=sys.stderr)
        return 1
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
