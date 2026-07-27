#!/usr/bin/env python3
"""Validate the public repository without external Python dependencies."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
CORE_SKILLS = (
    "cm-idea",
    "cm-init",
    "cm-prd",
    "cm-ai",
    "cm-test",
    "cm-fix",
    "cm-refactor",
    "cm-check",
)
REQUIRED = (
    ".codex-plugin/plugin.json",
    "AGENTS.md",
    "README.md",
    "VERSION",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "runtime/project-context.md",
    "runtime/orchestration.md",
    "runtime/review.md",
    "runtime/test-contract.md",
    "scripts/cm-check-runtime.sh",
    "scripts/validate-test-cases.py",
)


def fail(message: str, failures: list[str]) -> None:
    failures.append(message)


def frontmatter(path: Path) -> dict[str, str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0] != "---":
        return {}
    result: dict[str, str] = {}
    for line in lines[1:]:
        if line == "---":
            return result
        if ":" in line:
            key, value = line.split(":", 1)
            result[key.strip()] = value.strip().strip("\"'")
    return {}


def main() -> int:
    failures: list[str] = []
    for relative in REQUIRED:
        if not (ROOT / relative).is_file():
            fail(f"missing required file: {relative}", failures)

    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version) is None:
        fail(f"VERSION is not a supported semantic version: {version}", failures)

    manifest = json.loads((ROOT / ".codex-plugin/plugin.json").read_text(encoding="utf-8"))
    manifest_version = str(manifest.get("version", "")).split("+", 1)[0]
    if manifest_version != version:
        fail(f"manifest version {manifest_version} != VERSION {version}", failures)
    if manifest.get("name") != "cm-workflow":
        fail("plugin name must be cm-workflow", failures)
    if manifest.get("skills") != "./skills/":
        fail("plugin skills must point to ./skills/", failures)

    for skill_path in sorted((ROOT / "skills").glob("*/SKILL.md")):
        metadata = frontmatter(skill_path)
        expected = skill_path.parent.name
        if metadata.get("name") != expected:
            fail(f"{skill_path.relative_to(ROOT)} declares name={metadata.get('name')!r}", failures)
        if not metadata.get("description"):
            fail(f"{skill_path.relative_to(ROOT)} has no description", failures)

    for name in CORE_SKILLS:
        skill = ROOT / "skills" / name / "SKILL.md"
        wrapper = ROOT / "compat" / "claude-commands" / f"{name}.md"
        if not skill.is_file():
            fail(f"missing core skill: {name}", failures)
        if not wrapper.is_file():
            fail(f"missing Claude wrapper for {name}", failures)
            continue
        text = wrapper.read_text(encoding="utf-8")
        if f"skills/{name}/SKILL.md" not in text:
            fail(f"wrapper does not delegate to {name}", failures)
        if len(text.splitlines()) > 8:
            fail(f"wrapper is not thin: {wrapper.relative_to(ROOT)}", failures)

    for node in (
        "N1-init",
        "N2-enter-feature",
        "N3-execute-task",
        "N4-review",
        "N5-mark-done",
        "N6-qa-eval",
        "N7-context",
        "N8-finish",
    ):
        if not (ROOT / "skills/cm-ai/references" / f"{node}.md").is_file():
            fail(f"missing cm-ai node: {node}", failures)

    for mode in ("greenfield", "brownfield", "change-mode", "spec-self-check"):
        if not (ROOT / "skills/cm-prd/references" / f"{mode}.md").is_file():
            fail(f"missing cm-prd mode: {mode}", failures)

    if failures:
        for item in failures:
            print(f"FAIL: {item}", file=sys.stderr)
        print(f"public repository validation: FAILED ({len(failures)})", file=sys.stderr)
        return 1

    print(f"public repository validation: PASSED (v{version}, {len(CORE_SKILLS)} core skills)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
