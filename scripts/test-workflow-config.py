#!/usr/bin/env python3
"""Regression tests for the dependency-free CM workflow config loader."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

from cm_workflow_config import (  # noqa: E402
    ConfigError,
    DEFAULT_CONFIG,
    MAX_CONFIG_BYTES,
    load_config,
    resolve_role,
)


VALID_YAML = """
version: 1
project:
  type: java-backend
  workflow: java-backend
roles:
  planner:
    adapter: claude-api
    model: claude-opus
    source: api
  coder:
    adapter: codex-cli
    model: gpt-5.6-sol
    source: subscription
  external_expert:
    enabled: true
    activation: explicit
    model_policy: pro-extra-high-high-skip
policies:
  tests:
    - logic
    - commands
  generate_cases: true
  auto_fix: explicit
  delivery: draft-mr
""".strip()


def assert_equal(actual: object, expected: object, message: str) -> None:
    if actual != expected:
        raise AssertionError(f"{message}: expected {expected!r}, got {actual!r}")


def assert_raises(callback, message: str) -> None:
    try:
        callback()
    except ConfigError:
        return
    raise AssertionError(message)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="cm-workflow-config-") as temp:
        root = Path(temp)

        defaults = load_config(root)
        assert_equal(defaults["version"], DEFAULT_CONFIG["version"], "default version")
        assert_equal(defaults["project"], DEFAULT_CONFIG["project"], "default project")
        assert_equal(defaults["roles"]["coder"], DEFAULT_CONFIG["roles"]["coder"], "default coder")
        coder_route = resolve_role(defaults, "coder")
        assert_equal(coder_route["role"], "coder", "resolved role name")
        assert_equal(coder_route["adapter"], "current-ai", "resolved role adapter")
        assert_equal(coder_route["model"], "default", "resolved role model")
        assert_equal(
            resolve_role(defaults, "coder", runtime="codex")["route_state"],
            "current-runtime",
            "current runtime route",
        )
        assert_equal(
            resolve_role(defaults, "tester", runtime="codex")["route_state"],
            "local-tool",
            "local tool route",
        )
        browser_route = resolve_role(defaults, "browser_qa", runtime="codex")
        assert_equal(browser_route["adapter"], "browser", "browser QA adapter")
        assert_equal(browser_route["route_state"], "local-browser", "browser QA route")
        disabled_external = load_config(
            root,
            config_path=root / "disabled-external.yml",
            text="version: 1\nroles:\n  external_expert:\n    enabled: false\n",
        )
        assert_equal(
            resolve_role(disabled_external, "external_expert", runtime="codex")["route_state"],
            "disabled",
            "disabled external expert route",
        )
        assert_raises(
            lambda: load_config(root / "missing-project"),
            "missing project roots must be rejected",
        )

        config_path = root / ".cm-workflow.yml"
        config_path.write_text(VALID_YAML, encoding="utf-8")
        configured = load_config(root)
        assert_equal(configured["project"]["type"], "java-backend", "project type")
        assert_equal(configured["roles"]["coder"]["adapter"], "codex-cli", "coder adapter")
        assert_equal(configured["roles"]["coder"]["source"], "subscription", "coder source")
        assert_equal(configured["roles"]["analyst"], DEFAULT_CONFIG["roles"]["analyst"], "role defaults")
        assert_equal(configured["policies"]["tests"], ["logic", "commands"], "test policy")
        assert_equal(
            resolve_role(configured, "planner", runtime="codex")["route_state"],
            "declared-adapter",
            "unavailable adapter route is not claimed as current",
        )
        managed_adapter = load_config(
            root,
            config_path=root / "managed-adapter.yml",
            text=(
                "version: 1\nroles:\n  planner:\n"
                "    adapter: openai-compatible\n"
                "    model: planner-default\n"
                "    source: api\n"
            ),
        )
        assert_equal(
            resolve_role(managed_adapter, "planner", runtime="codex")["route_state"],
            "managed-adapter",
            "bundled openai-compatible adapter route",
        )
        assert_raises(
            lambda: load_config(
                root,
                config_path=root / "managed-adapter-local-source.yml",
                text=(
                    "version: 1\nroles:\n  planner:\n"
                    "    adapter: openai-compatible\n"
                    "    model: planner-default\n"
                ),
            ),
            "openai-compatible must not inherit the local source",
        )
        assert_raises(
            lambda: load_config(
                root,
                config_path=root / "managed-reviewer.yml",
                text=(
                    "version: 1\nroles:\n  reviewer:\n"
                    "    adapter: openai-compatible\n"
                    "    model: reviewer-default\n"
                    "    source: api\n"
                ),
            ),
            "managed reviewer must be rejected until it can satisfy N4",
        )

        json_path = root / ".cm-workflow.json"
        json_path.write_text(json.dumps({"version": 1, "project": {"type": "web-frontend"}}), encoding="utf-8")
        config_path.unlink()
        json_config = load_config(root)
        assert_equal(json_config["project"]["type"], "web-frontend", "JSON project type")
        assert_equal(json_config["roles"]["coder"], DEFAULT_CONFIG["roles"]["coder"], "JSON role defaults")

        def unknown_field() -> None:
            load_config(root, config_path=root / "unknown.yml", text="version: 1\nforbidden: true\n")

        assert_raises(unknown_field, "unknown top-level fields must be rejected")

        def secret_field() -> None:
            load_config(root, config_path=root / "secret.yml", text="version: 1\napi_key: leaked\n")

        assert_raises(secret_field, "secret-shaped fields must be rejected")

        for secret in (
            "AK" + "IA1234567890ABCDEF",
            "AIza" + "12345678901234567890123456789012",
            "sk-" + "ant-api03-abcdefghijklmnop",
            "xoxb-" + "1234567890-abcdefghij",
        ):
            def secret_value(value: str = secret) -> None:
                load_config(
                    root,
                    config_path=root / "secret-value.yml",
                    text=f"version: 1\nroles:\n  coder:\n    model: {value}\n",
                )

            assert_raises(secret_value, f"secret-like value must be rejected: {secret}")

        def unsupported_yaml() -> None:
            load_config(
                root,
                config_path=root / "unsupported.yml",
                text="version: 1\nroles: &defaults\n  coder: *defaults\n",
            )

        assert_raises(unsupported_yaml, "unsupported YAML aliases must be rejected")

        assert_raises(
            lambda: load_config(
                root,
                config_path=root / "external-coder.yml",
                text="version: 1\nroles:\n  coder:\n    adapter: external-browser\n    model: chatgpt-pro\n    source: browser\n",
            ),
            "external browser adapter must be limited to external_expert",
        )

        assert_raises(
            lambda: load_config(
                root,
                config_path=root / "browser-coder.yml",
                text="version: 1\nroles:\n  coder:\n    adapter: browser\n    model: none\n    source: local\n",
            ),
            "browser adapter must be limited to browser_qa",
        )

        assert_raises(
            lambda: load_config(
                root,
                config_path=root / "browser-source.yml",
                text="version: 1\nroles:\n  analyst:\n    adapter: current-ai\n    model: default\n    source: browser\n",
            ),
            "browser source must be limited to external_expert",
        )

        assert_raises(
            lambda: load_config(
                root,
                config_path=root / "external-api.yml",
                text="version: 1\nroles:\n  external_expert:\n    adapter: claude-api\n    model: claude-opus\n    source: api\n",
            ),
            "external expert API adapter must be rejected in v1",
        )

        assert_raises(
            lambda: load_config(
                root,
                config_path=root / "secret-comment.yml",
                text="# " + "sk-" + "live-abcdefghijklmnop\nversion: 1\n",
            ),
            "secret-like values in comments must be rejected",
        )

        assert_raises(
            lambda: load_config(
                root,
                config_path=root / "auto.yml",
                text="version: 1\nroles:\n  external_expert:\n    activation: auto\n",
            ),
            "persistent external-expert AUTO must be rejected",
        )

        strict_alias = load_config(
            root,
            config_path=root / "strict-alias.yml",
            text="version: 1\nroles:\n  external_expert:\n    model_policy: strict-Pro\n",
        )
        assert_equal(
            strict_alias["roles"]["external_expert"]["model_policy"],
            "strict-pro",
            "strict-Pro model policy alias",
        )

        def invalid_adapter() -> None:
            load_config(
                root,
                config_path=root / "invalid.yml",
                text="version: 1\nroles:\n  coder:\n    adapter: made-up\n    model: x\n    source: api\n",
            )

        assert_raises(invalid_adapter, "unknown adapters must be rejected")

        assert_raises(
            lambda: load_config(
                root,
                config_path=root / "invalid-test-kind.yml",
                text="version: 1\npolicies:\n  tests:\n    - [logic]\n",
            ),
            "non-string test kinds must be rejected as ConfigError",
        )

        def boolean_version() -> None:
            load_config(root, config_path=root / "boolean-version.yml", text="version: true\n")

        assert_raises(boolean_version, "boolean version values must be rejected")

        assert_raises(
            lambda: load_config(
                root,
                config_path=root / "duplicate-flow.yml",
                text="version: 1\nproject: {type: auto, type: custom}\n",
            ),
            "duplicate inline YAML keys must be rejected",
        )
        assert_raises(
            lambda: load_config(
                root,
                config_path=root / "duplicate-json.json",
                text='{"version": 1, "project": {"type": "auto", "type": "custom"}}',
            ),
            "duplicate JSON keys must be rejected",
        )

        bom_path = root / "bom.yml"
        bom_path.write_text("\ufeffversion: 1\nproject:\n  type: custom\n", encoding="utf-8")
        bom_config = load_config(root, config_path=bom_path)
        assert_equal(bom_config["project"]["type"], "custom", "UTF-8 BOM project type")
        bom_path.unlink()

        deep_yaml = ["version: 1"]
        for index in range(1100):
            deep_yaml.append("  " * index + f"nested{index}:")
        deep_yaml.append("  " * 1100 + "value: 1")
        assert_raises(
            lambda: load_config(root, config_path=root / "deep.yml", text="\n".join(deep_yaml)),
            "deeply nested configuration must fail as a ConfigError",
        )

        duplicate_path = root / ".cm-workflow.yml"
        duplicate_path.write_text("version: 1\n", encoding="utf-8")
        assert_raises(lambda: load_config(root), "multiple config files must be rejected")
        duplicate_path.unlink()

        yaml_path = root / ".cm-workflow.yaml"
        yaml_path.write_text("version: 1\nproject:\n  type: custom\n", encoding="utf-8")
        json_path.unlink()
        yaml_config = load_config(root)
        assert_equal(yaml_config["project"]["type"], "custom", ".yaml project type")
        yaml_path.unlink()

        json_path.write_text(json.dumps({"version": 1, "project": {"type": "web-frontend"}}), encoding="utf-8")

        oversized_path = root / "oversized.yml"
        oversized_path.write_text("version: 1\n#" + ("x" * MAX_CONFIG_BYTES), encoding="utf-8")
        assert_raises(lambda: load_config(root, config_path=oversized_path), "oversized config must be rejected")
        oversized_path.unlink()

        result = subprocess.run(
            [sys.executable, str(SCRIPTS / "cm_workflow_config.py"), "--config", str(json_path), "--print-effective"],
            check=False,
            capture_output=True,
            text=True,
        )
        assert_equal(result.returncode, 0, "CLI exit code")
        printed = json.loads(result.stdout)
        assert_equal(printed["project"]["type"], "web-frontend", "CLI project type")
        if any(token in result.stdout.lower() for token in ("api_key", "token", "cookie", "secret")):
            raise AssertionError("effective config must not print secret-shaped fields")

        role_result = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "cm_workflow_config.py"),
                "--config",
                str(json_path),
                "--role",
                "coder",
                "--print-role",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        assert_equal(role_result.returncode, 0, "CLI role exit code")
        role_printed = json.loads(role_result.stdout)
        assert_equal(role_printed["role"], "coder", "CLI role name")
        assert_equal(role_printed["adapter"], "current-ai", "CLI role adapter")
        assert_equal(role_printed["model"], "default", "CLI role model")

        bad_role = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "cm_workflow_config.py"),
                "--config",
                str(json_path),
                "--role",
                "not-a-role",
                "--print-role",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        if bad_role.returncode == 0:
            raise AssertionError("unknown role must fail")

    print("workflow config fixtures: PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
