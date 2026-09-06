#!/usr/bin/env python3
"""Compatibility lock adapter for the JavaScript CM task gate."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
from typing import Iterator, Mapping, Sequence


class GateError(ValueError):
    """Expected lock-adapter failure."""


def sync_control_path(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def control_directory(path: Path, *, create: bool = False, private: bool = False) -> os.stat_result:
    if create:
        try:
            path.mkdir(mode=0o700)
            sync_control_path(path)
            sync_control_path(path.parent)
        except FileExistsError:
            pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or (private and info.st_mode & 0o077):
        raise GateError(f"unsupported control directory: {path}")
    return info


def private_control_file(path: Path, limit: int) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > limit:
        raise GateError(f"unsupported private control file: {path}")
    return info


def file_revision(path: Path) -> tuple[tuple[int, ...], bytes]:
    def identity(info: os.stat_result) -> tuple[int, ...]:
        return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise GateError(f"revision source must be a regular non-symlink file: {path}")
    with path.open("rb") as handle:
        opened = os.fstat(handle.fileno())
        content = handle.read()
        after = os.fstat(handle.fileno())
    if not identity(before) == identity(opened) == identity(after) == identity(path.lstat()):
        raise GateError(f"revision changed while reading: {path}")
    return identity(after), content


def bind_task_owner(tasks: Path, root: Path, feature: str) -> tuple[Path, tuple[tuple[int, ...], bytes]]:
    tasks = tasks.resolve()
    info = tasks.lstat()
    if tasks.name != "tasks.md" or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise GateError("task owner requires regular non-hardlinked tasks.md")
    parent = tasks.parent
    suffix = "." + feature
    numbered = parent.name.endswith(suffix) and re.fullmatch(r"[0-9]+", parent.name[: -len(suffix)])
    if parent != root and not (parent.parent == root and (parent.name == feature or numbered)):
        raise GateError("unsupported owner layout (numbered prefixes require ASCII digits)")
    reviews = parent / ".reviews"
    control_directory(reviews, create=True)
    binding = reviews / ".cm-task-owner.json"
    expected = (json.dumps({"version": 1, "tasksPath": str(tasks), "specsRoot": str(root)}, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    if len(expected) > 16384:
        raise GateError("task owner binding exceeds limit")
    try:
        descriptor = os.open(binding, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(expected)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        pass
    private_control_file(binding, 16384)
    revision = file_revision(binding)
    if revision[1] != expected:
        raise GateError("task owner mismatch or corrupt binding; refusing rebind")
    sync_control_path(binding)
    sync_control_path(reviews)
    sync_control_path(parent)
    if file_revision(binding) != revision:
        raise GateError("task owner binding changed")
    return binding, revision


def writer_database_digest(lock: Path, descriptor: int) -> str:
    before = private_control_file(lock, 65536)
    opened = os.fstat(descriptor)
    content = os.pread(descriptor, 65537, 0)
    after = os.fstat(descriptor)
    current = lock.lstat()
    key = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    if not key(before) == key(opened) == key(after) == key(current) or len(content) != before.st_size:
        raise GateError("writer database changed")
    return hashlib.sha256(content).hexdigest()


def writer_ready(lock: Path, descriptor: int) -> tuple[Path, tuple[tuple[int, ...], bytes]]:
    marker = lock.parent / "writer-ready.json"
    private_control_file(marker, 1024)
    revision = file_revision(marker)
    expected = (json.dumps({"version": 1, "protocol": "cm-writer-ready", "databaseDigest": writer_database_digest(lock, descriptor)}, separators=(",", ":")) + "\n").encode("utf-8")
    if revision[1] != expected:
        raise GateError("invalid writer readiness; refusing recovery/adoption")
    if file_revision(marker) != revision:
        raise GateError("writer readiness changed")
    return marker, revision


def publish_writer_ready(lock: Path, descriptor: int) -> None:
    if os.path.lexists(str(lock) + "-journal"):
        raise GateError("retained initialization journal")
    private_control_file(lock, 65536)
    payload = (json.dumps({"version": 1, "protocol": "cm-writer-ready", "databaseDigest": writer_database_digest(lock, descriptor)}, separators=(",", ":")) + "\n").encode("utf-8")
    descriptor_out = os.open(lock.parent / "writer-ready.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor_out, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    sync_control_path(lock.parent)


@contextmanager
def posix_writer(reviews: Path, tasks: Path, feature: str) -> Iterator[Path]:
    root = reviews.resolve().parent
    execution = reviews / ".execution"
    database = None
    inspection_fd = None
    try:
        if reviews.name != ".reviews":
            raise GateError("task ownership requires the canonical .reviews directory")
        control_directory(reviews)
        binding, binding_revision = bind_task_owner(tasks, root, feature)
        control_directory(execution, create=True, private=True)
        for item in execution.iterdir():
            if item.name not in {"writer.sqlite", "writer-ready.json"}:
                raise GateError("retained journal, JS run or unknown evidence blocks compatibility writer")
            private_control_file(item, 65536)
        lock = execution / "writer.sqlite"
        created = False
        if not os.path.lexists(lock):
            if list(execution.iterdir()):
                raise GateError("missing writer database with retained execution evidence")
            try:
                descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
                os.fsync(descriptor)
                os.close(descriptor)
                sync_control_path(execution)
                created = True
            except FileExistsError:
                pass
        info = private_control_file(lock, 65536)
        if not created and info.st_size == 0:
            raise GateError("incomplete writer database")
        inspection_fd = os.open(lock, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        prior_ready = None
        if os.path.lexists(str(lock) + "-journal"):
            raise GateError("retained initialization journal")
        if not created:
            marker, prior_ready = writer_ready(lock, inspection_fd)
            os.fsync(inspection_fd)
            sync_control_path(marker)
            sync_control_path(execution)
        database = sqlite3.connect(str(lock), timeout=0, isolation_level=None)
        database.executescript("PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON;")
        protocol_sql = "CREATE TABLE protocol(version INTEGER NOT NULL CHECK(version=1))"
        if created:
            database.executescript("BEGIN IMMEDIATE; PRAGMA application_id=1129142321; PRAGMA user_version=1; " + protocol_sql + "; INSERT INTO protocol VALUES(1); COMMIT;")
            os.fsync(inspection_fd)
            sync_control_path(execution)
        database.execute("BEGIN IMMEDIATE")
        if (database.execute("PRAGMA application_id").fetchone() != (0x434D5831,) or database.execute("PRAGMA user_version").fetchone() != (1,) or database.execute("PRAGMA journal_mode").fetchone() != ("delete",) or database.execute("SELECT name,type,tbl_name,sql FROM sqlite_master").fetchall() != [("protocol", "table", "protocol", protocol_sql)] or database.execute("SELECT version FROM protocol").fetchall() != [(1,)]):
            raise GateError("unknown writer protocol; refusing reset")
        if created:
            publish_writer_ready(lock, inspection_fd)
        marker, current_ready = writer_ready(lock, inspection_fd)
        if prior_ready is not None and prior_ready != current_ready:
            raise GateError("writer readiness changed")
        if file_revision(binding) != binding_revision or file_revision(marker) != current_ready:
            raise GateError("task ownership evidence changed")
        yield lock.resolve()
    except (OSError, sqlite3.Error) as error:
        raise GateError(f"task writer unavailable: {error}") from error
    finally:
        if database is not None:
            database.close()
        if inspection_fd is not None:
            os.close(inspection_fd)


@contextmanager
def windows_writer(reviews: Path) -> Iterator[Path]:
    import msvcrt

    if reviews.name != ".reviews" or not reviews.is_dir() or reviews.is_symlink():
        raise GateError("task ownership requires the canonical .reviews directory")
    lock = reviews / ".cm-task-write.lock"
    descriptor = os.open(lock, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o600)
    try:
        if os.fstat(descriptor).st_size == 0:
            os.write(descriptor, b"0")
            os.fsync(descriptor)
        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
        yield lock.resolve()
    except OSError as error:
        raise GateError(f"task writer unavailable: {error}") from error
    finally:
        try:
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        os.close(descriptor)


@contextmanager
def task_writer(reviews: Path, tasks: Path, feature: str) -> Iterator[Path]:
    if os.name == "nt":
        with windows_writer(reviews) as lock:
            yield lock
    else:
        with posix_writer(reviews, tasks, feature) as lock:
            yield lock


def run_js(arguments: Sequence[str], *, environment: Mapping[str, str] | None = None, capture: bool = False):
    entry = Path(__file__).resolve().with_name("cm-task-gate.mjs")
    return subprocess.run(["node", str(entry), *arguments], check=False, text=True, capture_output=capture, env=dict(environment) if environment is not None else None)


def read_js_object(arguments: Sequence[str], *, environment: Mapping[str, str] | None = None) -> dict[str, object]:
    result = run_js(arguments, environment=environment, capture=True)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "JavaScript task gate failed"
        raise GateError(detail.removeprefix("ERROR: "))
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise GateError("JavaScript task gate returned invalid JSON") from error
    if not isinstance(value, dict):
        raise GateError("JavaScript task gate returned a non-object result")
    return value


def mark_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cm-task-gate.py")
    parser.add_argument("command", choices=["mark-done"])
    parser.add_argument("--handoff", required=True)
    parser.add_argument("--reviews-dir", required=True)
    parser.add_argument("--feature", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--tasks", required=True)
    parser.add_argument("--project-root")
    parser.add_argument("--allow-legacy-unbound", action="store_true")
    return parser


def mark_done(raw_arguments: Sequence[str]) -> dict[str, object]:
    args = mark_parser().parse_args(raw_arguments)
    prepare_arguments = ["prepare-mark-done", *raw_arguments[1:]]
    initial = read_js_object(prepare_arguments)
    tasks = Path(str(initial.get("tasksPath", "")))
    if not tasks.is_absolute():
        raise GateError("JavaScript task gate returned an invalid completion plan")
    reviews = Path(args.reviews_dir).resolve()
    with task_writer(reviews, tasks, args.feature) as lock:
        plan = read_js_object(prepare_arguments)
        plan_digest = str(plan.get("planDigest", ""))
        if Path(str(plan.get("tasksPath", ""))) != tasks or not re.fullmatch(r"[0-9a-f]{64}", plan_digest):
            raise GateError("JavaScript task gate returned an invalid completion plan")
        environment = os.environ.copy()
        environment.update({"CM_TASK_GATE_LOCK_ADAPTER": "1", "CM_TASK_GATE_LOCK_PARENT_PID": str(os.getpid()), "CM_TASK_GATE_WRITER_LOCK": str(lock)})
        return read_js_object(["mark-done-locked", *raw_arguments[1:], "--expected-plan-digest", plan_digest], environment=environment)


def main(argv: Sequence[str] | None = None) -> int:
    raw_arguments = list(argv) if argv is not None else sys.argv[1:]
    if not raw_arguments or raw_arguments[0] != "mark-done":
        result = run_js(raw_arguments)
        return result.returncode if result.returncode >= 0 else 128 - result.returncode
    try:
        result = mark_done(raw_arguments)
    except GateError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
