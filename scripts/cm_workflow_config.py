#!/usr/bin/env python3
"""Load and validate the optional project-level CM Workflow configuration.

The loader intentionally supports a small, dependency-free YAML subset because
CM installers must work without PyYAML. JSON is accepted as well. The schema
is deliberately finite: it configures roles and policies, but never grants
permissions or stores credentials.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path
from typing import Any


CONFIG_FILENAMES = (".cm-workflow.yml", ".cm-workflow.yaml", ".cm-workflow.json")
MAX_CONFIG_BYTES = 64 * 1024

PROJECT_TYPES = {"auto", "java-backend", "web-frontend", "custom"}
WORKFLOWS = {"cm-default", "java-backend", "web-frontend"}
ROLE_NAMES = {
    "analyst",
    "planner",
    "coder",
    "tester",
    "reviewer",
    "browser_qa",
    "external_expert",
}
ROLE_FIELDS = {"adapter", "model", "source"}
EXTERNAL_FIELDS = ROLE_FIELDS | {"enabled", "activation", "model_policy"}
ADAPTERS = {
    "current-ai",
    "codex-cli",
    "claude-cli",
    "claude-api",
    "openai-compatible",
    "local",
    "browser",
    "external-browser",
}
SOURCES = {"local", "subscription", "api", "browser", "none"}
TEST_KINDS = {"logic", "commands", "browser"}
ACTIVATIONS = {"explicit"}
MODEL_POLICIES = {"pro-extra-high-high-skip", "strict-pro", "strict-Pro"}
MODEL_POLICY_ALIASES = {"strict-Pro": "strict-pro"}
AUTO_FIX_POLICIES = {"explicit", "never", "auto"}
DELIVERY_MODES = {"diff", "branch", "draft-mr"}
RUNTIMES = {"codex", "claude", "unknown"}
SECRET_KEY = re.compile(
    r"(?:api[_-]?key|access[_-]?token|secret|cookie|password|private[_-]?key|credential|authorization)",
    re.IGNORECASE,
)
SECRET_VALUE = re.compile(
    r"(?:"
    r"-----BEGIN [^-]+ PRIVATE KEY-----|"
    r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|"
    r"\bAIza[0-9A-Za-z_-]{20,}\b|"
    r"\bsk[-_](?:ant-api\d{2}[-_])?[A-Za-z0-9_-]{12,}\b|"
    r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)[-_][A-Za-z0-9_-]{8,}\b|"
    r"\bxox[baprs][-_][A-Za-z0-9_-]{8,}\b|"
    r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"
    r")"
)
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,127}$")


class ConfigError(ValueError):
    """Raised when a project configuration is missing or invalid."""


DEFAULT_CONFIG: dict[str, Any] = {
    "version": 1,
    "project": {"type": "auto", "workflow": "cm-default"},
    "roles": {
        "analyst": {"adapter": "current-ai", "model": "default", "source": "local"},
        "planner": {"adapter": "current-ai", "model": "default", "source": "local"},
        "coder": {"adapter": "current-ai", "model": "default", "source": "local"},
        "tester": {"adapter": "local", "model": "none", "source": "local"},
        "reviewer": {"adapter": "current-ai", "model": "default", "source": "local"},
        "browser_qa": {"adapter": "browser", "model": "none", "source": "local"},
        "external_expert": {
            "adapter": "external-browser",
            "model": "chatgpt-pro",
            "source": "browser",
            "enabled": True,
            "activation": "explicit",
            "model_policy": "pro-extra-high-high-skip",
        },
    },
    "policies": {
        "tests": ["logic", "commands", "browser"],
        "generate_cases": True,
        "auto_fix": "explicit",
        "delivery": "draft-mr",
    },
}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _strip_comment(value: str) -> str:
    quote: str | None = None
    escaped = False
    for index, character in enumerate(value):
        if quote == '"' and escaped:
            escaped = False
            continue
        if character == "\\" and quote == '"':
            escaped = True
            continue
        if character in {"'", '"'}:
            if quote is None:
                quote = character
            elif quote == character:
                quote = None
            continue
        if character == "#" and quote is None and (index == 0 or value[index - 1].isspace()):
            return value[:index].rstrip()
    return value.rstrip()


def _split_top_level(value: str, separator: str = ",") -> list[str]:
    parts: list[str] = []
    start = 0
    depth = 0
    quote: str | None = None
    escaped = False
    for index, character in enumerate(value):
        if quote == '"' and escaped:
            escaped = False
            continue
        if character == "\\" and quote == '"':
            escaped = True
            continue
        if character in {"'", '"'}:
            if quote is None:
                quote = character
            elif quote == character:
                quote = None
        elif quote is None:
            if character in "[{(":
                depth += 1
            elif character in "]})":
                depth -= 1
            elif character == separator and depth == 0:
                parts.append(value[start:index].strip())
                start = index + 1
    if quote is not None or depth != 0:
        raise ConfigError("unclosed quote or inline collection")
    parts.append(value[start:].strip())
    return parts


def _mapping_colon(value: str) -> int:
    depth = 0
    quote: str | None = None
    escaped = False
    for index, character in enumerate(value):
        if quote == '"' and escaped:
            escaped = False
            continue
        if character == "\\" and quote == '"':
            escaped = True
            continue
        if character in {"'", '"'}:
            if quote is None:
                quote = character
            elif quote == character:
                quote = None
        elif quote is None:
            if character in "[{(":
                depth += 1
            elif character in "]})":
                depth -= 1
            elif character == ":" and depth == 0 and (
                index + 1 == len(value) or value[index + 1].isspace()
            ):
                return index
    return -1


def _parse_scalar(value: str) -> Any:
    value = value.strip()
    if not value:
        raise ConfigError("empty scalar is not allowed")
    if value.startswith(("!", "&", "*", "|", ">")):
        raise ConfigError(f"unsupported YAML feature: {value[0]}")
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        return [] if not inner else [_parse_scalar(item) for item in _split_top_level(inner)]
    if value.startswith("{") and value.endswith("}"):
        inner = value[1:-1].strip()
        if not inner:
            return {}
        result: dict[str, Any] = {}
        for item in _split_top_level(inner):
            colon = _mapping_colon(item)
            if colon < 0:
                raise ConfigError(f"invalid inline mapping item: {item}")
            key = _parse_key(item[:colon])
            if key in result:
                raise ConfigError(f"duplicate key {key!r} in inline mapping")
            result[key] = _parse_scalar(item[colon + 1 :])
        return result
    if value.startswith('"') or value.startswith("'"):
        if len(value) < 2 or value[-1] != value[0]:
            raise ConfigError("unterminated quoted scalar")
        if value[0] == '"':
            try:
                return json.loads(value)
            except json.JSONDecodeError as error:
                raise ConfigError(f"invalid quoted scalar: {error}") from error
        return value[1:-1].replace("''", "'")
    lowered = value.lower()
    if lowered in {"true", "false"}:
        return lowered == "true"
    if lowered in {"null", "~"}:
        return None
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if re.fullmatch(r"-?(?:\d+\.\d*|\d*\.\d+)", value):
        return float(value)
    return value


def _parse_key(value: str) -> str:
    key = value.strip()
    if not key:
        raise ConfigError("mapping key cannot be empty")
    parsed = _parse_scalar(key)
    if not isinstance(parsed, str):
        raise ConfigError("mapping keys must be strings")
    return parsed


def _parse_yaml_subset(text: str) -> Any:
    lines: list[tuple[int, str, int]] = []
    for line_number, raw in enumerate(text.splitlines(), 1):
        if "\t" in raw[: len(raw) - len(raw.lstrip(" "))]:
            raise ConfigError(f"line {line_number}: tabs are not allowed for indentation")
        indent = len(raw) - len(raw.lstrip(" "))
        content = _strip_comment(raw[indent:])
        if not content:
            continue
        lines.append((indent, content, line_number))
    if not lines:
        raise ConfigError("configuration is empty")
    if lines[0][0] != 0:
        raise ConfigError(f"line {lines[0][2]}: root indentation must be zero")

    def parse_block(index: int, indent: int) -> tuple[Any, int]:
        if index >= len(lines) or lines[index][0] != indent:
            raise ConfigError("expected an indented mapping or list")
        is_list = lines[index][1] == "-" or lines[index][1].startswith("- ")
        result: Any = [] if is_list else {}
        while index < len(lines):
            current_indent, content, line_number = lines[index]
            if current_indent < indent:
                break
            if current_indent > indent:
                raise ConfigError(f"line {line_number}: unexpected indentation")
            if is_list:
                if not (content == "-" or content.startswith("- ")):
                    raise ConfigError(f"line {line_number}: mixed mapping and list")
                item_text = content[1:].strip()
                if not item_text:
                    if index + 1 >= len(lines) or lines[index + 1][0] <= indent:
                        raise ConfigError(f"line {line_number}: empty list item")
                    item, index = parse_block(index + 1, lines[index + 1][0])
                else:
                    item = _parse_scalar(item_text)
                    index += 1
                result.append(item)
                continue
            colon = _mapping_colon(content)
            if colon < 0:
                raise ConfigError(f"line {line_number}: expected 'key: value'")
            key = _parse_key(content[:colon])
            if key in result:
                raise ConfigError(f"line {line_number}: duplicate key {key!r}")
            item_text = content[colon + 1 :].strip()
            if item_text:
                result[key] = _parse_scalar(item_text)
                index += 1
            else:
                if index + 1 >= len(lines) or lines[index + 1][0] <= indent:
                    raise ConfigError(f"line {line_number}: missing value for {key!r}")
                result[key], index = parse_block(index + 1, lines[index + 1][0])
        return result, index

    value, index = parse_block(0, 0)
    if index != len(lines):
        raise ConfigError(f"line {lines[index][2]}: unexpected content")
    return value


def _json_object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ConfigError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result


def _parse_document(path: Path, text: str) -> Any:
    if text.startswith("\ufeff"):
        text = text[1:]
    if path.suffix.lower() == ".json":
        try:
            return json.loads(text, object_pairs_hook=_json_object_pairs)
        except json.JSONDecodeError as error:
            raise ConfigError(f"invalid JSON: {error}") from error
    return _parse_yaml_subset(text)


def _walk_for_secrets(value: Any, path: str = "config") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if SECRET_KEY.search(str(key)):
                raise ConfigError(f"{path}.{key}: credential fields are forbidden")
            _walk_for_secrets(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _walk_for_secrets(item, f"{path}[{index}]")
    elif isinstance(value, str) and SECRET_VALUE.search(value):
        raise ConfigError(f"{path}: secret-like values are forbidden")


def _require_mapping(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"{path} must be a mapping")
    return value


def _reject_unknown(mapping: dict[str, Any], allowed: set[str], path: str) -> None:
    unknown = sorted(set(mapping) - allowed)
    if unknown:
        raise ConfigError(f"{path} has unknown field(s): {', '.join(unknown)}")


def _require_string(value: Any, path: str, choices: set[str] | None = None) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{path} must be a non-empty string")
    if len(value) > 128 or IDENTIFIER.fullmatch(value) is None:
        raise ConfigError(f"{path} contains unsupported characters")
    if choices is not None and value not in choices:
        options = ", ".join(sorted(choices))
        raise ConfigError(f"{path} must be one of: {options}")


def _validate_raw(value: Any) -> None:
    root = _require_mapping(value, "config")
    _reject_unknown(root, {"version", "project", "roles", "policies"}, "config")
    if type(root.get("version")) is not int or root.get("version") != 1:
        raise ConfigError('config.version must equal integer 1')

    if "project" in root:
        project = _require_mapping(root["project"], "config.project")
        _reject_unknown(project, {"type", "workflow"}, "config.project")
        if "type" in project:
            _require_string(project["type"], "config.project.type", PROJECT_TYPES)
        if "workflow" in project:
            _require_string(project["workflow"], "config.project.workflow", WORKFLOWS)

    if "roles" in root:
        roles = _require_mapping(root["roles"], "config.roles")
        _reject_unknown(roles, ROLE_NAMES, "config.roles")
        for role, raw_role in roles.items():
            role_data = _require_mapping(raw_role, f"config.roles.{role}")
            allowed = EXTERNAL_FIELDS if role == "external_expert" else ROLE_FIELDS
            _reject_unknown(role_data, allowed, f"config.roles.{role}")
            for field in ("adapter", "model", "source"):
                if field in role_data:
                    _require_string(role_data[field], f"config.roles.{role}.{field}")
            if role != "external_expert":
                if role_data.get("adapter") == "external-browser":
                    raise ConfigError(
                        f"config.roles.{role}.adapter cannot be external-browser;"
                        " only external_expert may use the external browser"
                    )
                if role_data.get("adapter") == "browser" and role != "browser_qa":
                    raise ConfigError(
                        f"config.roles.{role}.adapter browser is reserved for browser_qa"
                    )
                if role_data.get("source") == "browser":
                    raise ConfigError(
                        f"config.roles.{role}.source browser is reserved for external_expert"
                    )
            if "enabled" in role_data and type(role_data["enabled"]) is not bool:
                raise ConfigError(f"config.roles.{role}.enabled must be boolean")
            if "activation" in role_data:
                _require_string(role_data["activation"], f"config.roles.{role}.activation", ACTIVATIONS)
            if "model_policy" in role_data:
                _require_string(
                    role_data["model_policy"],
                    f"config.roles.{role}.model_policy",
                    MODEL_POLICIES,
                )

    if "policies" in root:
        policies = _require_mapping(root["policies"], "config.policies")
        _reject_unknown(policies, {"tests", "generate_cases", "auto_fix", "delivery"}, "config.policies")
        if "tests" in policies:
            tests = policies["tests"]
            if (
                not isinstance(tests, list)
                or not tests
                or any(not isinstance(item, str) or item not in TEST_KINDS for item in tests)
            ):
                raise ConfigError("config.policies.tests must be a non-empty list of logic/commands/browser")
        if "generate_cases" in policies and type(policies["generate_cases"]) is not bool:
            raise ConfigError("config.policies.generate_cases must be boolean")
        if "auto_fix" in policies:
            _require_string(policies["auto_fix"], "config.policies.auto_fix", AUTO_FIX_POLICIES)
        if "delivery" in policies:
            _require_string(policies["delivery"], "config.policies.delivery", DELIVERY_MODES)


def _validate_effective(config: dict[str, Any]) -> None:
    project = config["project"]
    _require_string(project["type"], "project.type", PROJECT_TYPES)
    _require_string(project["workflow"], "project.workflow", WORKFLOWS)
    for role, role_data in config["roles"].items():
        _require_string(role_data["adapter"], f"roles.{role}.adapter", ADAPTERS)
        if role != "external_expert":
            if role_data["adapter"] == "external-browser":
                raise ConfigError(
                    f"roles.{role}.adapter cannot be external-browser; only external_expert may use it"
                )
            if role_data["adapter"] == "browser" and role != "browser_qa":
                raise ConfigError(f"roles.{role}.adapter browser is reserved for browser_qa")
            if role_data["source"] == "browser":
                raise ConfigError(f"roles.{role}.source browser is reserved for external_expert")
        _require_string(role_data["model"], f"roles.{role}.model")
        _require_string(role_data["source"], f"roles.{role}.source", SOURCES)
        if role == "external_expert":
            if role_data["adapter"] != "external-browser" or role_data["source"] != "browser":
                raise ConfigError(
                    "roles.external_expert must use adapter external-browser and source browser"
                )
            if type(role_data["enabled"]) is not bool:
                raise ConfigError("roles.external_expert.enabled must be boolean")
            _require_string(role_data["activation"], "roles.external_expert.activation", ACTIVATIONS)
            _require_string(
                role_data["model_policy"],
                "roles.external_expert.model_policy",
                MODEL_POLICIES,
            )
    policies = config["policies"]
    if not isinstance(policies["tests"], list) or not policies["tests"]:
        raise ConfigError("policies.tests must be a non-empty list")
    if any(not isinstance(item, str) or item not in TEST_KINDS for item in policies["tests"]):
        raise ConfigError("policies.tests contains an unsupported test kind")
    if type(policies["generate_cases"]) is not bool:
        raise ConfigError("policies.generate_cases must be boolean")
    _require_string(policies["auto_fix"], "policies.auto_fix", AUTO_FIX_POLICIES)
    _require_string(policies["delivery"], "policies.delivery", DELIVERY_MODES)


def _canonicalize_effective(config: dict[str, Any]) -> None:
    policy = config["roles"]["external_expert"]["model_policy"]
    if policy in MODEL_POLICY_ALIASES:
        config["roles"]["external_expert"]["model_policy"] = MODEL_POLICY_ALIASES[policy]


def _route_state(adapter: str, runtime: str) -> str:
    if adapter == "current-ai":
        return "current-runtime"
    if adapter == "local":
        return "local-tool"
    if adapter == "browser":
        return "local-browser"
    if adapter == "external-browser":
        return "external-expert"
    if (runtime == "codex" and adapter == "codex-cli") or (
        runtime == "claude" and adapter == "claude-cli"
    ):
        return "current-runtime"
    return "declared-adapter"


def resolve_role(config: dict[str, Any], role: str, runtime: str = "unknown") -> dict[str, Any]:
    """Return one effective role route without exposing any credentials."""

    if role not in ROLE_NAMES:
        raise ConfigError(f"unknown workflow role: {role}")
    if runtime not in RUNTIMES:
        raise ConfigError(f"unknown runtime: {runtime}")
    roles = config.get("roles")
    if not isinstance(roles, dict) or not isinstance(roles.get(role), dict):
        raise ConfigError(f"roles.{role} is missing from the effective config")
    result = {"role": role}
    result.update(copy.deepcopy(roles[role]))
    result["runtime"] = runtime
    if role == "external_expert" and result.get("enabled") is False:
        result["route_state"] = "disabled"
    else:
        result["route_state"] = _route_state(str(result["adapter"]), runtime)
    return result


def find_config(project_root: Path) -> Path | None:
    root = project_root.expanduser().resolve()
    if not root.is_dir():
        raise ConfigError(f"project root is not a directory: {root}")
    candidates = [root / name for name in CONFIG_FILENAMES if (root / name).is_file()]
    if len(candidates) > 1:
        names = ", ".join(path.name for path in candidates)
        raise ConfigError(f"multiple CM workflow configs found: {names}")
    return candidates[0] if candidates else None


def load_config(
    project_root: Path,
    config_path: Path | None = None,
    text: str | None = None,
) -> dict[str, Any]:
    """Return a validated effective config with defaults merged in."""

    root = project_root.expanduser().resolve()
    if not root.is_dir():
        raise ConfigError(f"project root is not a directory: {root}")
    path = config_path.expanduser().resolve() if config_path is not None else find_config(root)
    if text is None and path is None:
        return copy.deepcopy(DEFAULT_CONFIG)
    if text is None:
        assert path is not None
        if not path.is_file():
            raise ConfigError(f"configuration file not found: {path}")
        if path.stat().st_size > MAX_CONFIG_BYTES:
            raise ConfigError(f"configuration file exceeds {MAX_CONFIG_BYTES} bytes: {path}")
        try:
            text = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError) as error:
            raise ConfigError(f"cannot read configuration {path}: {error}") from error
    else:
        path = path or Path(".cm-workflow.yml")
    if SECRET_VALUE.search(text):
        raise ConfigError("configuration contains a secret-like value")
    try:
        raw = _parse_document(path, text)
        _walk_for_secrets(raw)
        _validate_raw(raw)
        effective = _deep_merge(DEFAULT_CONFIG, raw)
        _canonicalize_effective(effective)
        _validate_effective(effective)
    except RecursionError as error:
        raise ConfigError("configuration nesting is too deep") from error
    return effective


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate and print CM Workflow project configuration")
    parser.add_argument("--project", type=Path, default=Path.cwd(), help="project root to inspect")
    parser.add_argument("--config", type=Path, help="explicit config path")
    parser.add_argument("--role", choices=sorted(ROLE_NAMES), help="resolve one effective workflow role")
    parser.add_argument("--runtime", choices=sorted(RUNTIMES), default="unknown", help="active CM runtime")
    parser.add_argument("--print-role", action="store_true", help="print one role route as redacted JSON")
    parser.add_argument("--print-effective", action="store_true", help="print the redacted effective JSON")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.project, args.config)
    except (ConfigError, OSError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    if args.print_role and not args.role:
        print("FAIL: --print-role requires --role", file=sys.stderr)
        return 2
    if args.role:
        role = resolve_role(config, args.role, runtime=args.runtime)
        if args.print_role:
            print(json.dumps(role, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        else:
            print("workflow role: " + json.dumps(role, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    elif args.print_effective:
        print(json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    else:
        print("workflow config: PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
