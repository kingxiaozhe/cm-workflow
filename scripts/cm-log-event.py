#!/usr/bin/env python3
"""Compatibility CLI and cross-platform lock adapter for cm-log-event.mjs."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path
from typing import BinaryIO, List, Optional


LOCK_HANDLES: List[BinaryIO] = []


def option_value(arguments: List[str], name: str) -> Optional[str]:
    value = None
    for index, argument in enumerate(arguments):
        if argument == name and index + 1 < len(arguments):
            value = arguments[index + 1]
    return value


def ensure_private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        os.chmod(path, 0o700)


def acquire_file_lock(
    path: Path, *, private: bool, timeout: float = 10.0
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    if private and os.name != "nt":
        os.chmod(path, 0o600)
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"0")
        handle.flush()
    deadline = time.monotonic() + timeout
    while True:
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            LOCK_HANDLES.append(handle)
            return
        except (OSError, BlockingIOError):
            if time.monotonic() >= deadline:
                handle.close()
                raise TimeoutError(f"timed out waiting for log lock: {path}")
            time.sleep(0.05)


def run_node(entry: Path, arguments: List[str], environment: dict) -> int:
    try:
        result = subprocess.run(
            ["node", str(entry), *arguments], env=environment, check=False
        )
    except OSError as error:
        print(f"cm-log-event: cannot start JavaScript log writer: {error}", file=sys.stderr)
        return 1
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


def main() -> int:
    arguments = sys.argv[1:]
    entry = Path(__file__).resolve().with_name("cm-log-event.mjs")

    if "--help" in arguments or "-h" in arguments:
        return run_node(entry, arguments, os.environ.copy())

    preflight_environment = os.environ.copy()
    preflight_environment["CM_LOG_PREFLIGHT"] = "1"
    preflight = run_node(entry, arguments, preflight_environment)
    if preflight != 0:
        return preflight

    specs_raw = option_value(arguments, "--specs-dir")
    specs_dir = (
        Path(specs_raw).expanduser().resolve(strict=False)
        if specs_raw is not None
        else None
    )
    if specs_dir is not None:
        try:
            acquire_file_lock(specs_dir / ".cm-run.lock", private=False)
        except OSError as error:
            print(
                f"cm-log-event: project run lock failed: {type(error).__name__}",
                file=sys.stderr,
            )
            return 1

    global_home = Path(
        os.environ.get("CM_WORKFLOW_LOG_HOME", "~/.cm-workflow/logs")
    ).expanduser().resolve(strict=False)
    global_error: Optional[OSError] = None
    try:
        ensure_private_directory(global_home)
        acquire_file_lock(global_home / ".cm-write.lock", private=True)
    except OSError as error:
        global_error = error
        if specs_dir is None:
            print(
                f"cm-log-event: global-only log lock failed: {type(error).__name__}",
                file=sys.stderr,
            )
            return 1

    environment = os.environ.copy()
    environment["CM_LOG_LOCK_ADAPTER"] = "1"
    environment["CM_LOG_LOCK_PARENT_PID"] = str(os.getpid())
    if specs_dir is not None:
        environment["CM_LOG_PROJECT_LOCK"] = str(specs_dir / ".cm-run.lock")
    environment["CM_LOG_GLOBAL_LOCK"] = str(global_home / ".cm-write.lock")
    environment["CM_LOG_GLOBAL_LOCKED"] = "0" if global_error else "1"
    if global_error is not None:
        environment["CM_LOG_GLOBAL_LOCK_ERROR"] = str(global_error)
        environment["CM_LOG_GLOBAL_LOCK_ERROR_TYPE"] = type(global_error).__name__
    return run_node(entry, arguments, environment)


if __name__ == "__main__":
    raise SystemExit(main())
