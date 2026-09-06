#!/usr/bin/env python3
"""Lean compatibility checks for the Python task-gate lock adapter."""

from __future__ import annotations

from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
PYTHON_GATE = ROOT / "scripts" / "cm-task-gate.py"
JS_GATE = ROOT / "scripts" / "cm-task-gate.mjs"


def main() -> int:
    source = PYTHON_GATE.read_text(encoding="utf-8")
    forbidden_business_authorities = (
        "def check_n4(",
        "def check_n5(",
        "def prepare_mark_done(",
        "def verify_mark_done_plan(",
        "def check_parallel_write(",
        "def load_handoff(",
        "def validate_review(",
    )
    for symbol in forbidden_business_authorities:
        assert symbol not in source, f"Python adapter regained JS business authority: {symbol}"

    arguments = ["check-n4", "--help"]
    direct = subprocess.run(
        ["node", str(JS_GATE), *arguments], text=True, capture_output=True, check=False
    )
    compatibility = subprocess.run(
        [sys.executable, str(PYTHON_GATE), *arguments], text=True, capture_output=True, check=False
    )
    assert compatibility.returncode == direct.returncode
    assert compatibility.stdout == direct.stdout
    assert compatibility.stderr == direct.stderr

    print("cm task-gate Python adapter: PASSED (lock-only wrapper; JS owns decisions)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
