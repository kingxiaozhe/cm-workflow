#!/usr/bin/env python3
"""Call one OpenAI-compatible role boundary and record verified CM usage."""

from __future__ import annotations

import argparse
import http.client
import ipaddress
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


MAX_PACKET_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_JSON_DEPTH = 128
PREFIX_ORDER = ("safety", "workflow", "project_rules", "role", "output_schema")
DYNAMIC_REQUIRED = {
    "workflow",
    "stage",
    "role",
    "objective",
    "identifiers",
    "constraints",
    "expected_output",
}
DYNAMIC_ALLOWED = DYNAMIC_REQUIRED | {"context"}
IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,63}$")
CALL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,127}$")
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$")


class AdapterError(ValueError):
    """Safe user-facing adapter error."""


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Keep credentials on the configured origin by rejecting all redirects."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


def configure_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")


def timeout_seconds(value: str) -> int:
    parsed = int(value)
    if parsed < 1 or parsed > 600:
        raise argparse.ArgumentTypeError("must be between 1 and 600")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Call an OpenAI-compatible model with a CM role packet."
    )
    parser.add_argument("--workflow", required=True)
    parser.add_argument("--stage", required=True)
    parser.add_argument("--role", required=True)
    parser.add_argument("--runtime", required=True, choices=("codex", "claude", "unknown"))
    parser.add_argument("--requested-model", required=True)
    parser.add_argument("--call-id", required=True)
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--specs-dir")
    parser.add_argument("--run-id")
    parser.add_argument("--timeout-seconds", type=timeout_seconds, default=120)
    return parser.parse_args()


def validate_identifier(label: str, value: str) -> str:
    if not IDENTIFIER.fullmatch(value):
        raise AdapterError(f"{label} is not a valid identifier")
    return value


def resolve_directory(label: str, value: Optional[str]) -> Optional[Path]:
    if value is None:
        return None
    path = Path(value).expanduser().resolve(strict=False)
    if not path.is_dir():
        raise AdapterError(f"{label} is not an existing directory")
    return path


def reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant: {value}")


def validate_json_tree(value: Any, label: str) -> None:
    stack = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        if depth > MAX_JSON_DEPTH:
            raise AdapterError(f"{label} exceeds the maximum JSON nesting depth")
        if isinstance(current, str):
            try:
                current.encode("utf-8")
            except UnicodeEncodeError as exc:
                raise AdapterError(f"{label} must contain valid Unicode") from exc
            continue
        if isinstance(current, dict):
            for key, child in current.items():
                try:
                    key.encode("utf-8")
                except UnicodeEncodeError as exc:
                    raise AdapterError(f"{label} must contain valid Unicode") from exc
                stack.append((child, depth + 1))
            continue
        if isinstance(current, list):
            stack.extend((child, depth + 1) for child in current)
            continue
        if isinstance(current, float) and not math.isfinite(current):
            raise AdapterError(f"{label} must contain strict JSON numbers")


def parse_strict_json(raw: bytes, label: str) -> Any:
    try:
        text = raw.decode("utf-8")
        value = json.loads(text, parse_constant=reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise AdapterError(f"{label} is not valid strict UTF-8 JSON") from exc
    validate_json_tree(value, label)
    return value


def read_packet(
    expected_workflow: str,
    expected_stage: str,
    expected_role: str,
) -> Tuple[str, Dict[str, Any]]:
    raw = sys.stdin.buffer.read(MAX_PACKET_BYTES + 1)
    if len(raw) > MAX_PACKET_BYTES:
        raise AdapterError("role packet exceeds 1 MiB")
    packet = parse_strict_json(raw, "stdin")
    if not isinstance(packet, dict) or set(packet) != {"stable_prefix", "dynamic_packet"}:
        raise AdapterError("role packet requires only stable_prefix and dynamic_packet")
    stable = packet["stable_prefix"]
    dynamic = packet["dynamic_packet"]
    if not isinstance(stable, dict) or set(stable) != set(PREFIX_ORDER):
        raise AdapterError(
            "stable_prefix requires exactly: " + ", ".join(PREFIX_ORDER)
        )
    stable_parts = []
    for key in PREFIX_ORDER:
        value = stable[key]
        if not isinstance(value, str) or not value.strip():
            raise AdapterError(f"stable_prefix.{key} must be a non-empty string")
        stable_parts.append(f"[{key}]\n{value}")
    if not isinstance(dynamic, dict):
        raise AdapterError("dynamic_packet must be a JSON object")
    missing = DYNAMIC_REQUIRED.difference(dynamic)
    if missing:
        raise AdapterError(
            "dynamic_packet requires: " + ", ".join(sorted(DYNAMIC_REQUIRED))
        )
    unknown = set(dynamic).difference(DYNAMIC_ALLOWED)
    if unknown:
        raise AdapterError(
            "dynamic_packet contains unsupported fields: "
            + ", ".join(sorted(unknown))
        )
    for field in ("workflow", "stage", "role", "objective", "expected_output"):
        value = dynamic[field]
        if not isinstance(value, str) or not value.strip():
            raise AdapterError(f"dynamic_packet.{field} must be a non-empty string")
    for field, expected in (
        ("workflow", expected_workflow),
        ("stage", expected_stage),
        ("role", expected_role),
    ):
        if dynamic[field] != expected:
            raise AdapterError(f"dynamic_packet.{field} must match --{field}")
    if not isinstance(dynamic["identifiers"], dict):
        raise AdapterError("dynamic_packet.identifiers must be a JSON object")
    constraints = dynamic["constraints"]
    if not isinstance(constraints, list) or any(
        not isinstance(item, str) or not item.strip() for item in constraints
    ):
        raise AdapterError("dynamic_packet.constraints must be a list of strings")
    if "context" in dynamic and not isinstance(dynamic["context"], dict):
        raise AdapterError("dynamic_packet.context must be a JSON object")
    system_message = "\n\n".join(stable_parts)
    return system_message, dynamic


def is_loopback(hostname: Optional[str]) -> bool:
    if hostname is None:
        return False
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def resolve_endpoint() -> Tuple[str, str]:
    if os.environ.get("CM_OPENAI_COMPATIBLE_ENABLED", "").lower() != "true":
        raise AdapterError(
            "OpenAI-compatible calls are not explicitly enabled; "
            "set CM_OPENAI_COMPATIBLE_ENABLED=true"
        )
    base_url = os.environ.get("CM_OPENAI_COMPATIBLE_BASE_URL", "")
    api_key = os.environ.get("CM_OPENAI_COMPATIBLE_API_KEY", "")
    if not base_url:
        raise AdapterError("CM_OPENAI_COMPATIBLE_BASE_URL is not configured")
    if any(ord(character) < 0x21 or ord(character) > 0x7E for character in base_url):
        raise AdapterError("CM_OPENAI_COMPATIBLE_BASE_URL contains unsupported characters")
    if not api_key:
        raise AdapterError("CM_OPENAI_COMPATIBLE_API_KEY is not configured")
    if len(api_key) > 4096 or any(
        ord(character) < 0x21 or ord(character) > 0x7E
        for character in api_key
    ):
        raise AdapterError("API key contains unsupported characters")
    try:
        parsed = urllib.parse.urlparse(base_url)
        hostname = parsed.hostname
        parsed.port
    except ValueError as exc:
        raise AdapterError(
            "CM_OPENAI_COMPATIBLE_BASE_URL must be a valid HTTP(S) URL"
        ) from exc
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or hostname is None:
        raise AdapterError("CM_OPENAI_COMPATIBLE_BASE_URL must be an HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise AdapterError("CM_OPENAI_COMPATIBLE_BASE_URL cannot contain credentials or query data")
    if parsed.scheme == "http" and not is_loopback(hostname):
        raise AdapterError("non-loopback OpenAI-compatible endpoints require HTTPS")
    normalized = base_url.rstrip("/")
    endpoint = (
        normalized
        if normalized.endswith("/chat/completions")
        else normalized + "/chat/completions"
    )
    return endpoint, api_key


def nonnegative_int(value: Any) -> Optional[int]:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def first_count(mapping: Dict[str, Any], *names: str) -> Optional[int]:
    for name in names:
        value = nonnegative_int(mapping.get(name))
        if value is not None:
            return value
    return None


def extract_usage(response: Dict[str, Any]) -> Tuple[str, Dict[str, int]]:
    usage = response.get("usage")
    if not isinstance(usage, dict):
        return "unavailable", {}
    input_count = first_count(usage, "input_tokens", "prompt_tokens")
    output_count = first_count(usage, "output_tokens", "completion_tokens")
    if input_count is None or output_count is None:
        return "unavailable", {}
    counts = {"input_tokens": input_count, "output_tokens": output_count}
    details = usage.get("prompt_tokens_details")
    detail_map = details if isinstance(details, dict) else {}
    cache_read = first_count(usage, "cache_read_input_tokens")
    if cache_read is None:
        cache_read = first_count(detail_map, "cached_tokens")
    cache_write = first_count(usage, "cache_creation_input_tokens")
    if cache_write is None:
        cache_write = first_count(detail_map, "cache_write_tokens")
    if cache_read is not None:
        counts["cache_read_tokens"] = cache_read
    if cache_write is not None:
        counts["cache_write_tokens"] = cache_write
    return "observed", counts


def extract_text(response: Dict[str, Any]) -> str:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise AdapterError("provider response has no completion choice")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise AdapterError("provider response has no completion message")
    content = message.get("content")
    if not isinstance(content, str):
        raise AdapterError("provider response content is not text")
    return content


def logger_environment() -> Dict[str, str]:
    hidden = {
        "CM_OPENAI_COMPATIBLE_ENABLED",
        "CM_OPENAI_COMPATIBLE_BASE_URL",
        "CM_OPENAI_COMPATIBLE_API_KEY",
    }
    return {key: value for key, value in os.environ.items() if key not in hidden}


def claim_call(
    *,
    args: argparse.Namespace,
    project_root: Path,
    specs_dir: Optional[Path],
) -> None:
    data = {
        "call_id": args.call_id,
        "stage": args.stage,
        "role": args.role,
        "adapter": "openai-compatible",
        "requested_model": args.requested_model,
        "source": "api",
        "purpose": f"{args.workflow}:{args.stage}",
    }
    command = [
        sys.executable,
        str(Path(__file__).resolve().with_name("cm-log-event.py")),
        "--workflow",
        args.workflow,
        "--event",
        "model_call",
        "--phase",
        "claimed",
        "--runtime",
        args.runtime,
        "--project-root",
        str(project_root),
        "--detail",
        f"{args.role} model call claimed",
        "--data-json",
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
    ]
    if specs_dir is not None:
        command.extend(("--specs-dir", str(specs_dir)))
    if args.run_id:
        command.extend(("--run-id", args.run_id))
    try:
        result = subprocess.run(
            command,
            env=logger_environment(),
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )
    except OSError as exc:
        raise AdapterError("model call claim could not be recorded") from exc
    if result.returncode != 0:
        if "model_call call_id already completed" in result.stderr:
            raise AdapterError("call_id already completed; use a new call_id")
        if "model_call call_id already claimed" in result.stderr:
            raise AdapterError("call_id already claimed; use a new call_id")
        raise AdapterError("model call claim could not be recorded")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AdapterError("model call claim returned invalid evidence") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("deduplicated"), bool):
        raise AdapterError("model call claim returned invalid evidence")
    if payload["deduplicated"]:
        raise AdapterError("call_id already claimed; use a new call_id")


def log_usage(
    *,
    args: argparse.Namespace,
    project_root: Path,
    specs_dir: Optional[Path],
    duration_ms: int,
    outcome: str,
    response: Optional[Dict[str, Any]],
) -> bool:
    try:
        usage_state, counts = extract_usage(response or {})
        data: Dict[str, Any] = {
            "call_id": args.call_id,
            "stage": args.stage,
            "role": args.role,
            "adapter": "openai-compatible",
            "requested_model": args.requested_model,
            "source": "api",
            "purpose": f"{args.workflow}:{args.stage}",
            "usage_state": usage_state,
            "duration_ms": duration_ms,
            "outcome": outcome,
        }
        if response is not None:
            effective_model = response.get("model")
            if isinstance(effective_model, str) and MODEL_NAME.fullmatch(effective_model):
                data["effective_model"] = effective_model
        data.update(counts)
        command = [
            sys.executable,
            str(Path(__file__).resolve().with_name("cm-log-event.py")),
            "--workflow",
            args.workflow,
            "--event",
            "model_usage",
            "--phase",
            "complete",
            "--runtime",
            args.runtime,
            "--project-root",
            str(project_root),
            "--detail",
            f"{args.role} model call {outcome}",
            "--data-json",
            json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        ]
        if specs_dir is not None:
            command.extend(("--specs-dir", str(specs_dir)))
        if args.run_id:
            command.extend(("--run-id", args.run_id))
        result = subprocess.run(
            command,
            env=logger_environment(),
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )
    except Exception:
        return False
    return result.returncode == 0


def write_result(content: str) -> bool:
    try:
        sys.stdout.write(content + "\n")
        sys.stdout.flush()
    except (OSError, UnicodeError, ValueError):
        try:
            sys.stdout = open(os.devnull, "w", encoding="utf-8")
        except OSError:
            pass
        return False
    return True


def request_completion(
    endpoint: str,
    api_key: str,
    requested_model: str,
    system_message: str,
    dynamic_packet: Dict[str, Any],
    timeout: int,
) -> Dict[str, Any]:
    body = {
        "model": requested_model,
        "messages": [
            {"role": "system", "content": system_message},
            {
                "role": "user",
                "content": json.dumps(
                    dynamic_packet,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                ),
            },
        ],
        "stream": False,
    }
    try:
        encoded = json.dumps(
            body,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError, RecursionError) as exc:
        raise AdapterError("role packet could not be encoded as strict UTF-8 JSON") from exc
    request = urllib.request.Request(
        endpoint,
        data=encoded,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        NoRedirectHandler(),
    )
    with opener.open(request, timeout=timeout) as response_handle:
        raw = response_handle.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise AdapterError("provider response exceeds 8 MiB")
    response = parse_strict_json(raw, "provider response")
    if not isinstance(response, dict):
        raise AdapterError("provider response must be a JSON object")
    return response


def main() -> int:
    configure_output()
    args = parse_args()
    try:
        validate_identifier("--workflow", args.workflow)
        validate_identifier("--stage", args.stage)
        validate_identifier("--role", args.role)
        if not MODEL_NAME.fullmatch(args.requested_model):
            raise AdapterError("--requested-model is not a valid model alias")
        if not CALL_ID.fullmatch(args.call_id):
            raise AdapterError("--call-id is not valid")
        if args.run_id is not None and not RUN_ID.fullmatch(args.run_id):
            raise AdapterError("--run-id is not valid")
        project_root = resolve_directory("--project-root", args.project_root)
        assert project_root is not None
        specs_dir = resolve_directory("--specs-dir", args.specs_dir)
        if specs_dir is None and args.run_id is None:
            raise AdapterError("--run-id is required without --specs-dir")
        endpoint, api_key = resolve_endpoint()
        system_message, dynamic_packet = read_packet(
            args.workflow,
            args.stage,
            args.role,
        )
        claim_call(args=args, project_root=project_root, specs_dir=specs_dir)
    except AdapterError as exc:
        print(f"cm-openai-compatible-call: {exc}", file=sys.stderr)
        return 2

    started = time.monotonic()
    response: Optional[Dict[str, Any]] = None
    try:
        response = request_completion(
            endpoint,
            api_key,
            args.requested_model,
            system_message,
            dynamic_packet,
            args.timeout_seconds,
        )
        content = extract_text(response)
    except urllib.error.HTTPError as exc:
        exc.close()
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        logged = log_usage(
            args=args,
            project_root=project_root,
            specs_dir=specs_dir,
            duration_ms=duration_ms,
            outcome="error",
            response=None,
        )
        print(f"cm-openai-compatible-call: HTTP {exc.code}", file=sys.stderr)
        if not logged:
            print("cm-openai-compatible-call: usage log failed", file=sys.stderr)
            return 4
        return 1
    except (
        urllib.error.URLError,
        TimeoutError,
        http.client.HTTPException,
        OSError,
    ):
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        logged = log_usage(
            args=args,
            project_root=project_root,
            specs_dir=specs_dir,
            duration_ms=duration_ms,
            outcome="error",
            response=None,
        )
        print("cm-openai-compatible-call: request failed", file=sys.stderr)
        if not logged:
            print("cm-openai-compatible-call: usage log failed", file=sys.stderr)
            return 4
        return 1
    except AdapterError as exc:
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        logged = log_usage(
            args=args,
            project_root=project_root,
            specs_dir=specs_dir,
            duration_ms=duration_ms,
            outcome="error",
            response=response,
        )
        print(f"cm-openai-compatible-call: {exc}", file=sys.stderr)
        if not logged:
            print("cm-openai-compatible-call: usage log failed", file=sys.stderr)
            return 4
        return 1
    except Exception:
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        logged = log_usage(
            args=args,
            project_root=project_root,
            specs_dir=specs_dir,
            duration_ms=duration_ms,
            outcome="error",
            response=response,
        )
        print("cm-openai-compatible-call: response handling failed", file=sys.stderr)
        if not logged:
            print("cm-openai-compatible-call: usage log failed", file=sys.stderr)
            return 4
        return 1

    duration_ms = max(0, round((time.monotonic() - started) * 1000))
    if not write_result(content):
        logged = log_usage(
            args=args,
            project_root=project_root,
            specs_dir=specs_dir,
            duration_ms=duration_ms,
            outcome="error",
            response=response,
        )
        print("cm-openai-compatible-call: result output failed", file=sys.stderr)
        if not logged:
            print("cm-openai-compatible-call: usage log failed", file=sys.stderr)
            return 4
        return 1
    logged = log_usage(
        args=args,
        project_root=project_root,
        specs_dir=specs_dir,
        duration_ms=duration_ms,
        outcome="success",
        response=response,
    )
    if not logged:
        print(
            "cm-openai-compatible-call: model call completed but usage log failed; "
            "do not retry the model call automatically",
            file=sys.stderr,
        )
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
