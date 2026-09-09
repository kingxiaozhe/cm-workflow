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
CM_AI_RUNTIME = (
    "cm-ai-admission.mjs",
    "cm-ai-context-refresh.mjs",
    "cm-ai-conversation-entry.mjs",
    "cm-ai-learning-handoff-writer.mjs",
    "cm-ai-learning-writer.mjs",
    "cm-ai-qa-log.mjs",
    "cm-ai-run-finalizer.mjs",
    "codex-config.mjs",
    "codex-review-adapter.mjs",
    "contracts.mjs",
    "durable-runner-state.mjs",
    "effect-contract.mjs",
    "execution-store.mjs",
    "gate-bridge.mjs",
    "host.mjs",
    "host-session.mjs",
    "index.mjs",
    "provider-review-observation.mjs",
    "review-package.mjs",
    "review-result.schema.json",
    "review-runner.mjs",
    "task-commit-codec.mjs",
    "task-commit.mjs",
    "task-owner.mjs",
    "task-runner.mjs",
    "worker-codex.mjs",
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
    "runtime/external-expert.md",
    "runtime/logging.md",
    "runtime/model-efficiency.md",
    "runtime/orchestration.md",
    "runtime/review.md",
    "runtime/task-gates.md",
    "runtime/task-handoff.schema.json",
    "runtime/test-contract.md",
    "runtime/workflow-config.md",
    "runtime/workflow-routing.md",
    "scripts/cm-ai-admission.mjs",
    "scripts/cm-ai-run.mjs",
    "scripts/cm-ai-run.test.mjs",
    "docs/js-workflow-control.md",
    "scripts/cm-ai-admission.test.mjs",
    "scripts/cm-check-runtime.sh",
    "scripts/cm-check-runtime.ps1",
    "scripts/cm-log-event.mjs",
    "scripts/cm-log-event.test.mjs",
    "scripts/cm-log-event.py",
    "scripts/cm-prd-timing.py",
    "scripts/cm-usage-report.py",
    "scripts/cm-openai-compatible-call.py",
    "scripts/cm-task-gate.mjs",
    "scripts/cm-task-gate.test.mjs",
    "scripts/cm-task-gate.py",
    "scripts/test-cm-log-event.py",
    "scripts/test-cm-prd-timing.py",
    "scripts/test-cm-usage-report.py",
    "scripts/test-cm-openai-compatible-call.py",
    "scripts/test-task-gate.py",
    "scripts/cm-workflow-config.mjs",
    "scripts/cm-workflow-config.test.mjs",
    "scripts/cm_workflow_config.py",
    "scripts/test-workflow-config.py",
    "scripts/validate-test-cases.mjs",
    "scripts/validate-test-cases.test.mjs",
    "scripts/validate-test-cases.py",
    "templates/cm-workflow.yml",
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
    for name in CM_AI_RUNTIME:
        relative = f"runtime/js/cm-ai/{name}"
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

    handoff_schema = json.loads(
        (ROOT / "runtime/task-handoff.schema.json").read_text(encoding="utf-8")
    )
    if handoff_schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        fail("task handoff schema must declare JSON Schema draft 2020-12", failures)
    if handoff_schema.get("additionalProperties") is not False:
        fail("task handoff schema must reject unknown fields", failures)
    expected_handoff_fields = {
        "schema_version",
        "task_id",
        "attempt",
        "status",
        "changed_files",
        "verification",
        "evidence",
        "blockers",
        "scope_deviation",
    }
    if set(handoff_schema.get("required", [])) != expected_handoff_fields:
        fail("task handoff schema required fields drifted", failures)
    handoff_properties = handoff_schema.get("properties", {})
    if set(handoff_properties) != expected_handoff_fields | {"implementation_sha256"}:
        fail("task handoff schema properties drifted", failures)
    if handoff_properties.get("implementation_sha256", {}).get("pattern") != "^[0-9a-f]{64}$":
        fail("task handoff implementation digest contract drifted", failures)
    if set(handoff_properties.get("status", {}).get("enum", [])) != {
        "ready_for_review",
        "blocked",
    }:
        fail("task handoff status enum drifted", failures)
    verification_properties = (
        handoff_properties.get("verification", {}).get("items", {}).get("properties", {})
    )
    if set(verification_properties) != {"command", "status", "evidence"}:
        fail("task handoff verification fields drifted", failures)

    for skill_path in sorted((ROOT / "skills").glob("*/SKILL.md")):
        metadata = frontmatter(skill_path)
        expected = skill_path.parent.name
        if metadata.get("name") != expected:
            fail(f"{skill_path.relative_to(ROOT)} declares name={metadata.get('name')!r}", failures)
        if not metadata.get("description"):
            fail(f"{skill_path.relative_to(ROOT)} has no description", failures)

    if not (ROOT / "skills" / "external-expert" / "SKILL.md").is_file():
        fail("missing independent skill: external-expert", failures)

    for reference in (
        "skills/cm-idea/references/idea-to-prd.md",
        "skills/cm-idea/references/example-prd.md",
        "skills/cm-idea/references/domains/trading.md",
    ):
        if not (ROOT / reference).is_file():
            fail(f"missing cm-idea reference: {reference}", failures)

    cm_idea_text = (ROOT / "skills/cm-idea/SKILL.md").read_text(encoding="utf-8")
    if "references/idea-to-prd.md" not in cm_idea_text:
        fail("cm-idea does not delegate to its internal interview reference", failures)

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
