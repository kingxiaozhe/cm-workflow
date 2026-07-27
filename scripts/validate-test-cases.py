#!/usr/bin/env python3
"""Validate a CM test-cases.json without external dependencies."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


CASE_ID = re.compile(r"^TC-(\d{3,})$")
FEATURE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
REF_IDS = {
    "acIds": re.compile(r"^AC-\d{3,}$"),
    "taskIds": re.compile(r"^T-\d{3,}$"),
}
CASE_FIELDS = {
    "id",
    "origin",
    "kind",
    "blocking",
    "acIds",
    "taskIds",
    "title",
    "preconditions",
    "steps",
    "expected",
    "cleanup",
}
STRING_LISTS = ("acIds", "taskIds", "preconditions", "steps", "expected", "cleanup")


def fail(message: str, failures: list[str]) -> None:
    failures.append(message)


def validate_string_list(
    case: dict[str, object],
    field: str,
    index: int,
    failures: list[str],
) -> None:
    value = case.get(field)
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        fail(f"cases[{index}].{field} must be an array of strings", failures)
        return
    if field in {"steps", "expected"} and not value:
        fail(f"cases[{index}].{field} must not be empty", failures)
    pattern = REF_IDS.get(field)
    if pattern is not None:
        for item in value:
            if not pattern.fullmatch(item):
                fail(f"cases[{index}].{field} has invalid id: {item!r}", failures)


def validate(path: Path) -> list[str]:
    failures: list[str] = []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        return [f"cannot parse JSON: {error}"]

    if not isinstance(data, dict):
        return ["root must be an object"]
    if data.get("schemaVersion") != "1.0":
        fail('schemaVersion must equal "1.0"', failures)
    feature = data.get("feature")
    if not isinstance(feature, str) or FEATURE.fullmatch(feature) is None:
        fail("feature must be a non-empty kebab-case string", failures)
    cases = data.get("cases")
    if not isinstance(cases, list) or not cases:
        fail("cases must be a non-empty array", failures)
        return failures

    seen: set[str] = set()
    for index, item in enumerate(cases):
        if not isinstance(item, dict):
            fail(f"cases[{index}] must be an object", failures)
            continue
        missing = sorted(CASE_FIELDS - item.keys())
        if missing:
            fail(f"cases[{index}] missing fields: {', '.join(missing)}", failures)

        case_id = item.get("id")
        match = CASE_ID.fullmatch(case_id) if isinstance(case_id, str) else None
        if match is None:
            fail(f"cases[{index}].id must match TC-001", failures)
        else:
            expected = index + 1
            if int(match.group(1)) != expected:
                fail(f"cases[{index}].id must be TC-{expected:03d}", failures)
            if case_id in seen:
                fail(f"duplicate case id: {case_id}", failures)
            seen.add(case_id)

        if item.get("origin") not in {"user", "generated", "inferred"}:
            fail(f"cases[{index}].origin is invalid", failures)
        if item.get("kind") not in {"logic", "browser"}:
            fail(f"cases[{index}].kind is invalid", failures)
        if type(item.get("blocking")) is not bool:
            fail(f"cases[{index}].blocking must be boolean", failures)
        title = item.get("title")
        if not isinstance(title, str) or not title.strip():
            fail(f"cases[{index}].title must be a non-empty string", failures)
        for field in STRING_LISTS:
            validate_string_list(item, field, index, failures)
    return failures


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} TEST_CASES_JSON", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    failures = validate(path)
    if failures:
        for message in failures:
            print(f"FAIL: {message}", file=sys.stderr)
        print(f"test-cases validation: FAILED ({len(failures)})", file=sys.stderr)
        return 1
    print(f"test-cases validation: PASSED ({path})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
