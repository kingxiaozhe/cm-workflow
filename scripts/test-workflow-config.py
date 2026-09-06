#!/usr/bin/env python3
"""Compatibility harness for the authoritative JavaScript config fixtures."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    scripts = Path(__file__).resolve().parent
    result = subprocess.run(
        ["node", "--test", str(scripts / "cm-workflow-config.test.mjs")],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, "CM_PYTHON_BIN": sys.executable},
    )
    if result.returncode != 0:
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        return result.returncode
    print("workflow config fixtures: PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
