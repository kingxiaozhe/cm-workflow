#!/usr/bin/env python3
"""End-to-end fixture for the OpenAI-compatible CM call boundary."""

from __future__ import annotations

import argparse
import io
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional, Tuple


ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "scripts" / "cm-openai-compatible-call.py"
WRITER = ROOT / "scripts" / "cm-log-event.py"
REPORTER = ROOT / "scripts" / "cm-usage-report.py"
RUN_ID = "adapter-fixture-0001"


def verify_stdout_failure_boundary() -> None:
    spec = importlib.util.spec_from_file_location("cm_adapter_fixture", ADAPTER)
    if spec is None or spec.loader is None:
        raise AssertionError("cannot load adapter module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix="cm-adapter-stdout-") as tmp:
        root = Path(tmp)
        module.parse_args = lambda: argparse.Namespace(
            workflow="cm-prd",
            stage="design_generation",
            role="planner",
            runtime="codex",
            requested_model="planner-default",
            call_id="stdout-failure-0001",
            project_root=str(root),
            specs_dir=None,
            run_id="stdout-failure-run-0001",
            timeout_seconds=1,
        )
        module.resolve_endpoint = lambda: (
            "https://example.invalid/v1/chat/completions",
            "fixture-secret",
        )
        module.read_packet = lambda *args: ("system", {})
        module.claim_call = lambda **kwargs: None
        module.request_completion = lambda *args, **kwargs: {
            "model": "provider-model",
            "choices": [{"message": {"content": "RESULT"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }
        outcomes: List[str] = []
        module.log_usage = lambda **kwargs: outcomes.append(kwargs["outcome"]) or True

        class BrokenStdout:
            def write(self, value: str) -> int:
                raise BrokenPipeError("closed stdout")

            def flush(self) -> None:
                return

        original_stdout = module.sys.stdout
        original_stderr = module.sys.stderr
        captured_stderr = io.StringIO()
        module.sys.stdout = BrokenStdout()
        module.sys.stderr = captured_stderr
        try:
            result = module.main()
        finally:
            module.sys.stdout = original_stdout
            module.sys.stderr = original_stderr
        assert result == 1
        assert outcomes == ["error"]
        assert "result output failed" in captured_stderr.getvalue()


class FixtureHandler(BaseHTTPRequestHandler):
    captured: List[Dict[str, object]] = []
    responses: List[Tuple[int, Dict[str, object]]] = [
        (
            200,
            {
                "id": "response-1",
                "model": "provider-model-v2",
                "choices": [{"message": {"content": "PLAN_OK"}}],
                "usage": {
                    "prompt_tokens": 123,
                    "completion_tokens": 45,
                    "prompt_tokens_details": {"cached_tokens": 100},
                },
            },
        ),
        (
            200,
            {
                "id": "response-2",
                "model": "provider-model-v2",
                "choices": [{"message": {"content": "NO_USAGE_OK"}}],
            },
        ),
        (503, {"error": {"message": "DO_NOT_ECHO_PROVIDER_BODY"}}),
    ]

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        self.__class__.captured.append(
            {
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "body": body,
            }
        )
        status, payload = self.__class__.responses.pop(0)
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        return


class RedirectTargetHandler(BaseHTTPRequestHandler):
    captured_authorization: List[object] = []

    def _capture(self) -> None:
        self.__class__.captured_authorization.append(self.headers.get("Authorization"))
        payload = {
            "model": "redirected-model",
            "choices": [{"message": {"content": "REDIRECTED"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        self._capture()

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        self._capture()

    def log_message(self, format: str, *args: object) -> None:
        return


class RedirectSourceHandler(BaseHTTPRequestHandler):
    location = ""

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        self.send_response(302)
        self.send_header("Location", self.__class__.location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        return


class DisconnectHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        self.connection.close()

    def log_message(self, format: str, *args: object) -> None:
        return


class DeepResponseHandler(BaseHTTPRequestHandler):
    request_count = 0

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        self.__class__.request_count += 1
        encoded = (
            b'{"model":"deep-model","choices":[{"message":{"content":"DEEP"}}],'
            b'"extra":'
            + b"[" * 2000
            + b"0"
            + b"]" * 2000
            + b"}"
        )
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        return


class ClaimRaceHandler(BaseHTTPRequestHandler):
    request_count = 0
    count_lock = threading.Lock()

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        with self.__class__.count_lock:
            self.__class__.request_count += 1
        payload = {
            "model": "race-model",
            "choices": [{"message": {"content": "RACE_OK"}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2},
        }
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        return


class ProxyCaptureHandler(BaseHTTPRequestHandler):
    captured: List[Dict[str, object]] = []

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        length = int(self.headers.get("Content-Length", "0"))
        self.__class__.captured.append(
            {
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "body": self.rfile.read(length).decode("utf-8"),
            }
        )
        payload = {
            "model": "proxy-model",
            "choices": [{"message": {"content": "PROXY_INTERCEPTED"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        return


class UsageLogFailureHandler(BaseHTTPRequestHandler):
    project_log: Optional[Path] = None

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        assert self.__class__.project_log is not None
        self.__class__.project_log.chmod(0o400)
        payload = {"error": {"message": "fixture failure"}}
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        return


class SuccessfulUsageLogFailureHandler(BaseHTTPRequestHandler):
    project_log: Optional[Path] = None

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        assert self.__class__.project_log is not None
        self.__class__.project_log.chmod(0o400)
        payload = {
            "model": "provider-model-v2",
            "choices": [{"message": {"content": "RESULT_WITHOUT_USAGE_LOG"}}],
            "usage": {"prompt_tokens": 2, "completion_tokens": 1},
        }
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        return


def start_run(
    project: Path,
    specs: Path,
    log_home: Path,
    run_id: str = RUN_ID,
) -> None:
    env = os.environ.copy()
    env["CM_WORKFLOW_LOG_HOME"] = str(log_home)
    result = subprocess.run(
        [
            sys.executable,
            str(WRITER),
            "--workflow",
            "cm-prd",
            "--event",
            "run_start",
            "--phase",
            "start",
            "--runtime",
            "codex",
            "--project-root",
            str(project),
            "--specs-dir",
            str(specs),
            "--run-id",
            run_id,
            "--detail",
            "adapter fixture started",
        ],
        cwd=ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr)


def invoke_adapter(
    project: Path,
    specs: Optional[Path],
    log_home: Path,
    base_url: str,
    call_id: str,
    expected_exit: Optional[int],
    enabled: bool = True,
    run_id: Optional[str] = RUN_ID,
    extra_env: Optional[Dict[str, str]] = None,
    dynamic_packet: Optional[Dict[str, object]] = None,
    raw_packet: Optional[str] = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["CM_WORKFLOW_LOG_HOME"] = str(log_home)
    env["CM_OPENAI_COMPATIBLE_BASE_URL"] = base_url
    env["CM_OPENAI_COMPATIBLE_API_KEY"] = "fixture-api-secret"
    if enabled:
        env["CM_OPENAI_COMPATIBLE_ENABLED"] = "true"
    else:
        env.pop("CM_OPENAI_COMPATIBLE_ENABLED", None)
    if extra_env:
        env.update(extra_env)
    packet = {
        "stable_prefix": {
            "safety": "DO_NOT_LOG_STABLE safety boundary",
            "workflow": "cm-prd design generation",
            "project_rules": "stay inside the approved requirement",
            "role": "planner",
            "output_schema": "return the compact plan only",
        },
        "dynamic_packet": dynamic_packet if dynamic_packet is not None else {
            "workflow": "cm-prd",
            "stage": "design_generation",
            "role": "planner",
            "objective": "DO_NOT_LOG_DYNAMIC create one plan",
            "identifiers": {"feature": "1.fixture"},
            "constraints": ["no implementation"],
            "expected_output": "plan",
        },
    }
    command = [
            sys.executable,
            str(ADAPTER),
            "--workflow",
            "cm-prd",
            "--stage",
            "design_generation",
            "--role",
            "planner",
            "--runtime",
            "codex",
            "--requested-model",
            "planner-default",
            "--call-id",
            call_id,
            "--timeout-seconds",
            "2",
            "--project-root",
            str(project),
        ]
    if specs is not None:
        command.extend(("--specs-dir", str(specs)))
    if run_id is not None:
        command.extend(("--run-id", run_id))
    result = subprocess.run(
        command,
        cwd=ROOT,
        env=env,
        input=raw_packet if raw_packet is not None else json.dumps(packet, sort_keys=True),
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    if expected_exit is not None and result.returncode != expected_exit:
        raise AssertionError(
            f"expected exit {expected_exit}, got {result.returncode}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def write_usage(
    project: Path,
    specs: Path,
    log_home: Path,
    run_id: str,
    call_id: str,
) -> None:
    env = os.environ.copy()
    env["CM_WORKFLOW_LOG_HOME"] = str(log_home)
    result = subprocess.run(
        [
            sys.executable,
            str(WRITER),
            "--workflow",
            "cm-prd",
            "--event",
            "model_usage",
            "--phase",
            "complete",
            "--runtime",
            "codex",
            "--project-root",
            str(project),
            "--specs-dir",
            str(specs),
            "--run-id",
            run_id,
            "--detail",
            "planner model call completed",
            "--data-json",
            json.dumps(
                {
                    "call_id": call_id,
                    "stage": "design_generation",
                    "role": "planner",
                    "adapter": "openai-compatible",
                    "requested_model": "planner-default",
                    "source": "api",
                    "purpose": "cm-prd:design_generation",
                    "usage_state": "observed",
                    "input_tokens": 1,
                    "output_tokens": 1,
                    "outcome": "success",
                }
            ),
        ],
        cwd=ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr)


def write_claim(
    project: Path,
    specs: Path,
    log_home: Path,
    run_id: str,
    call_id: str,
) -> None:
    env = os.environ.copy()
    env["CM_WORKFLOW_LOG_HOME"] = str(log_home)
    result = subprocess.run(
        [
            sys.executable,
            str(WRITER),
            "--workflow",
            "cm-prd",
            "--event",
            "model_call",
            "--phase",
            "claimed",
            "--runtime",
            "codex",
            "--project-root",
            str(project),
            "--specs-dir",
            str(specs),
            "--run-id",
            run_id,
            "--detail",
            "planner model call claimed",
            "--data-json",
            json.dumps(
                {
                    "call_id": call_id,
                    "stage": "design_generation",
                    "role": "planner",
                    "adapter": "openai-compatible",
                    "requested_model": "planner-default",
                    "source": "api",
                    "purpose": "cm-prd:design_generation",
                }
            ),
        ],
        cwd=ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr)


def read_jsonl(path: Path) -> List[Dict[str, object]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def main() -> int:
    verify_stdout_failure_boundary()
    FixtureHandler.captured = []
    with tempfile.TemporaryDirectory(prefix="cm-openai-adapter-") as tmp:
        root = Path(tmp).resolve()
        project = root / "project"
        specs = root / "specs"
        log_home = root / "logs"
        project.mkdir()
        specs.mkdir()
        start_run(project, specs, log_home)

        server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_port}/v1"
        try:
            malformed_endpoint = invoke_adapter(
                project,
                specs,
                log_home,
                "http://[::1",
                "planner-malformed-endpoint",
                2,
            )
            assert "Traceback" not in malformed_endpoint.stderr
            assert "valid HTTP(S) URL" in malformed_endpoint.stderr
            assert FixtureHandler.captured == []
            malformed_port = invoke_adapter(
                project,
                specs,
                log_home,
                "https://models.example.invalid:bad/v1",
                "planner-malformed-port",
                2,
            )
            assert "Traceback" not in malformed_port.stderr
            assert "valid HTTP(S) URL" in malformed_port.stderr
            assert FixtureHandler.captured == []
            for unsafe_url_call, unsafe_url in (
                (
                    "planner-control-url",
                    "http://127.0.0.1:9/v1\r\nX-Test: injected",
                ),
                ("planner-unicode-host", "https://mødel.example/v1"),
            ):
                unsafe_endpoint = invoke_adapter(
                    project,
                    specs,
                    log_home,
                    unsafe_url,
                    unsafe_url_call,
                    2,
                )
                assert "Traceback" not in unsafe_endpoint.stderr
                assert "unsupported characters" in unsafe_endpoint.stderr
            assert FixtureHandler.captured == []
            missing_global_run = invoke_adapter(
                project,
                None,
                log_home,
                base_url,
                "planner-global-without-run",
                2,
                run_id=None,
            )
            assert "--run-id is required without --specs-dir" in (
                missing_global_run.stderr
            )
            assert FixtureHandler.captured == []
            disabled = invoke_adapter(
                project,
                specs,
                log_home,
                base_url,
                "planner-disabled-0001",
                2,
                enabled=False,
            )
            assert "not explicitly enabled" in disabled.stderr
            assert FixtureHandler.captured == []
            for invalid_key_call, unsafe_key, secret_fragments in (
                (
                    "planner-invalid-key-lines",
                    "fixture-secret-line-one\r\nfixture-secret-line-two",
                    ("fixture-secret-line-one", "fixture-secret-line-two"),
                ),
                (
                    "planner-invalid-key-unicode",
                    "fixture-secret-密钥",
                    ("fixture-secret", "密钥"),
                ),
            ):
                invalid_key = invoke_adapter(
                    project,
                    specs,
                    log_home,
                    base_url,
                    invalid_key_call,
                    2,
                    extra_env={"CM_OPENAI_COMPATIBLE_API_KEY": unsafe_key},
                )
                assert "Traceback" not in invalid_key.stderr
                assert "API key contains unsupported characters" in invalid_key.stderr
                for secret_fragment in secret_fragments:
                    assert secret_fragment not in invalid_key.stderr
            assert FixtureHandler.captured == []
            empty_packet = invoke_adapter(
                project,
                specs,
                log_home,
                base_url,
                "planner-empty-packet",
                2,
                dynamic_packet={},
            )
            assert "dynamic_packet requires" in empty_packet.stderr
            mismatched_packet = invoke_adapter(
                project,
                specs,
                log_home,
                base_url,
                "planner-mismatched-packet",
                2,
                dynamic_packet={
                    "workflow": "cm-prd",
                    "stage": "design_generation",
                    "role": "coder",
                    "objective": "return a plan",
                    "identifiers": {},
                    "constraints": [],
                    "expected_output": "plan",
                },
            )
            assert "dynamic_packet.role must match --role" in (
                mismatched_packet.stderr
            )
            extra_packet = invoke_adapter(
                project,
                specs,
                log_home,
                base_url,
                "planner-extra-packet",
                2,
                dynamic_packet={
                    "workflow": "cm-prd",
                    "stage": "design_generation",
                    "role": "planner",
                    "objective": "return a plan",
                    "identifiers": {},
                    "constraints": [],
                    "expected_output": "plan",
                    "full_repository": "must not be an undeclared field",
                },
            )
            assert "dynamic_packet contains unsupported fields" in extra_packet.stderr
            valid_dynamic = {
                "workflow": "cm-prd",
                "stage": "design_generation",
                "role": "planner",
                "objective": "return a plan",
                "identifiers": {},
                "constraints": [],
                "expected_output": "plan",
            }
            non_finite_packet = dict(valid_dynamic)
            non_finite_packet["context"] = {"temperature": float("nan")}
            non_finite = invoke_adapter(
                project,
                specs,
                log_home,
                base_url,
                "planner-non-finite-packet",
                2,
                dynamic_packet=non_finite_packet,
            )
            assert "strict UTF-8 JSON" in non_finite.stderr
            surrogate_packet = dict(valid_dynamic)
            surrogate_packet["objective"] = "\ud800"
            surrogate = invoke_adapter(
                project,
                specs,
                log_home,
                base_url,
                "planner-surrogate-packet",
                2,
                dynamic_packet=surrogate_packet,
            )
            assert "valid Unicode" in surrogate.stderr
            deep_packet_template = {
                "stable_prefix": {
                    "safety": "safety",
                    "workflow": "workflow",
                    "project_rules": "rules",
                    "role": "role",
                    "output_schema": "schema",
                },
                "dynamic_packet": {
                    **valid_dynamic,
                    "context": None,
                },
            }
            deep_packet = json.dumps(deep_packet_template, sort_keys=True).replace(
                '"context": null',
                '"context": {"nested":' + "[" * 2000 + "0" + "]" * 2000 + "}",
                1,
            )
            deep = invoke_adapter(
                project,
                specs,
                log_home,
                base_url,
                "planner-deep-packet",
                2,
                raw_packet=deep_packet,
            )
            assert "Traceback" not in deep.stderr
            assert "stdin is not valid strict UTF-8 JSON" in deep.stderr
            for invalid_type_call, field, value, expected_error in (
                (
                    "planner-invalid-identifiers",
                    "identifiers",
                    [],
                    "dynamic_packet.identifiers must be a JSON object",
                ),
                (
                    "planner-invalid-constraints",
                    "constraints",
                    [""],
                    "dynamic_packet.constraints must be a list of strings",
                ),
                (
                    "planner-invalid-context",
                    "context",
                    [],
                    "dynamic_packet.context must be a JSON object",
                ),
            ):
                typed_packet = dict(valid_dynamic)
                typed_packet[field] = value
                invalid_type = invoke_adapter(
                    project,
                    specs,
                    log_home,
                    base_url,
                    invalid_type_call,
                    2,
                    dynamic_packet=typed_packet,
                )
                assert expected_error in invalid_type.stderr
            preflight_log = (specs / "运行日志.jsonl").read_text(encoding="utf-8")
            for rejected_call in (
                "planner-empty-packet",
                "planner-mismatched-packet",
                "planner-extra-packet",
                "planner-invalid-identifiers",
                "planner-invalid-constraints",
                "planner-invalid-context",
                "planner-non-finite-packet",
                "planner-surrogate-packet",
                "planner-deep-packet",
                "planner-control-url",
                "planner-unicode-host",
            ):
                assert rejected_call not in preflight_log
            assert FixtureHandler.captured == []
            observed = invoke_adapter(
                project, specs, log_home, base_url, "planner-call-0001", 0
            )
            requests_after_first_call = len(FixtureHandler.captured)
            duplicate = invoke_adapter(
                project, specs, log_home, base_url, "planner-call-0001", 2
            )
            assert "call_id already completed" in duplicate.stderr, duplicate.stderr
            assert len(FixtureHandler.captured) == requests_after_first_call
            unavailable = invoke_adapter(
                project, specs, log_home, base_url, "planner-call-0002", 0
            )
            failed = invoke_adapter(
                project, specs, log_home, base_url, "planner-call-0003", 1
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

        assert observed.stdout == "PLAN_OK\n"
        assert unavailable.stdout == "NO_USAGE_OK\n"
        assert failed.stdout == ""
        assert "HTTP 503" in failed.stderr
        assert "DO_NOT_ECHO_PROVIDER_BODY" not in failed.stderr
        assert "fixture-api-secret" not in observed.stdout + observed.stderr + failed.stderr

        assert len(FixtureHandler.captured) == 3
        first_request = FixtureHandler.captured[0]
        assert first_request["path"] == "/v1/chat/completions"
        assert first_request["authorization"] == "Bearer fixture-api-secret"
        body = first_request["body"]
        assert isinstance(body, dict)
        assert body["model"] == "planner-default"
        assert body["messages"][0]["role"] == "system"
        assert "DO_NOT_LOG_STABLE" in body["messages"][0]["content"]
        assert body["messages"][1]["role"] == "user"
        assert "DO_NOT_LOG_DYNAMIC" in body["messages"][1]["content"]

        project_log = specs / "运行日志.jsonl"
        rows = [row for row in read_jsonl(project_log) if row.get("event") == "model_usage"]
        assert len(rows) == 3
        assert rows[0]["usage_state"] == "observed"
        assert rows[0]["input_tokens"] == 123
        assert rows[0]["output_tokens"] == 45
        assert rows[0]["cache_read_tokens"] == 100
        assert rows[0]["effective_model"] == "provider-model-v2"
        assert rows[0]["outcome"] == "success"
        assert rows[1]["usage_state"] == "unavailable"
        assert "input_tokens" not in rows[1]
        assert rows[1]["outcome"] == "success"
        assert rows[2]["usage_state"] == "unavailable"
        assert rows[2]["outcome"] == "error"
        serialized_log = project_log.read_text(encoding="utf-8")
        for forbidden in (
            "fixture-api-secret",
            "DO_NOT_LOG_STABLE",
            "DO_NOT_LOG_DYNAMIC",
            "PLAN_OK",
            "NO_USAGE_OK",
            "DO_NOT_ECHO_PROVIDER_BODY",
        ):
            assert forbidden not in serialized_log

        report_result = subprocess.run(
            [
                sys.executable,
                str(REPORTER),
                "--log-home",
                str(log_home),
                "--last",
                "1",
                "--json",
            ],
            cwd=ROOT,
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )
        assert report_result.returncode == 0, report_result.stderr
        report = json.loads(report_result.stdout)
        assert report["summary"]["observed_calls"] == 1
        assert report["summary"]["unavailable_calls"] == 2
        assert report["summary"]["unresolved_claims"] == 0
        assert report["summary"]["outcomes"]["success"] == 2
        assert report["summary"]["outcomes"]["error"] == 1

        UsageLogFailureHandler.project_log = project_log
        log_failure_server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            UsageLogFailureHandler,
        )
        log_failure_thread = threading.Thread(
            target=log_failure_server.serve_forever,
            daemon=True,
        )
        log_failure_thread.start()
        try:
            unlogged_failure = invoke_adapter(
                project,
                specs,
                log_home,
                f"http://127.0.0.1:{log_failure_server.server_port}/v1",
                "planner-call-unlogged-error",
                4,
            )
        finally:
            project_log.chmod(0o600)
            log_failure_server.shutdown()
            log_failure_server.server_close()
            log_failure_thread.join(timeout=5)
        assert "HTTP 503" in unlogged_failure.stderr
        assert "usage log failed" in unlogged_failure.stderr
        unlogged_rows = [
            row
            for row in read_jsonl(project_log)
            if row.get("call_id") == "planner-call-unlogged-error"
        ]
        assert [row["event"] for row in unlogged_rows] == ["model_call"]

        SuccessfulUsageLogFailureHandler.project_log = project_log
        success_log_failure_server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            SuccessfulUsageLogFailureHandler,
        )
        success_log_failure_thread = threading.Thread(
            target=success_log_failure_server.serve_forever,
            daemon=True,
        )
        success_log_failure_thread.start()
        try:
            unlogged_success = invoke_adapter(
                project,
                specs,
                log_home,
                f"http://127.0.0.1:{success_log_failure_server.server_port}/v1",
                "planner-call-unlogged-success",
                3,
            )
        finally:
            project_log.chmod(0o600)
            success_log_failure_server.shutdown()
            success_log_failure_server.server_close()
            success_log_failure_thread.join(timeout=5)
        assert unlogged_success.stdout == "RESULT_WITHOUT_USAGE_LOG\n"
        assert "do not retry the model call automatically" in unlogged_success.stderr
        unlogged_success_rows = [
            row
            for row in read_jsonl(project_log)
            if row.get("call_id") == "planner-call-unlogged-success"
        ]
        assert [row["event"] for row in unlogged_success_rows] == ["model_call"]

        RedirectTargetHandler.captured_authorization = []
        target = ThreadingHTTPServer(("127.0.0.1", 0), RedirectTargetHandler)
        target_thread = threading.Thread(target=target.serve_forever, daemon=True)
        target_thread.start()
        source = ThreadingHTTPServer(("127.0.0.1", 0), RedirectSourceHandler)
        RedirectSourceHandler.location = (
            f"http://127.0.0.1:{target.server_port}/capture"
        )
        source_thread = threading.Thread(target=source.serve_forever, daemon=True)
        source_thread.start()
        try:
            redirected = invoke_adapter(
                project,
                specs,
                log_home,
                f"http://127.0.0.1:{source.server_port}/v1",
                "planner-call-redirect",
                1,
            )
        finally:
            source.shutdown()
            source.server_close()
            source_thread.join(timeout=5)
            target.shutdown()
            target.server_close()
            target_thread.join(timeout=5)
        assert "HTTP 302" in redirected.stderr
        assert RedirectTargetHandler.captured_authorization == []

        before_disconnect = len(
            [row for row in read_jsonl(project_log) if row.get("event") == "model_usage"]
        )
        disconnect = ThreadingHTTPServer(("127.0.0.1", 0), DisconnectHandler)
        disconnect_thread = threading.Thread(
            target=disconnect.serve_forever,
            daemon=True,
        )
        disconnect_thread.start()
        try:
            disconnected = invoke_adapter(
                project,
                specs,
                log_home,
                f"http://127.0.0.1:{disconnect.server_port}/v1",
                "planner-call-disconnect",
                1,
            )
        finally:
            disconnect.shutdown()
            disconnect.server_close()
            disconnect_thread.join(timeout=5)
        assert "Traceback" not in disconnected.stderr
        assert "request failed" in disconnected.stderr
        after_disconnect_rows = [
            row for row in read_jsonl(project_log) if row.get("event") == "model_usage"
        ]
        assert len(after_disconnect_rows) == before_disconnect + 1
        assert after_disconnect_rows[-1]["outcome"] == "error"
        assert after_disconnect_rows[-1]["call_id"] == "planner-call-disconnect"

        DeepResponseHandler.request_count = 0
        deep_response_server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            DeepResponseHandler,
        )
        deep_response_thread = threading.Thread(
            target=deep_response_server.serve_forever,
            daemon=True,
        )
        deep_response_thread.start()
        try:
            deep_response = invoke_adapter(
                project,
                specs,
                log_home,
                f"http://127.0.0.1:{deep_response_server.server_port}/v1",
                "planner-call-deep-response",
                1,
            )
        finally:
            deep_response_server.shutdown()
            deep_response_server.server_close()
            deep_response_thread.join(timeout=5)
        assert DeepResponseHandler.request_count == 1
        assert "Traceback" not in deep_response.stderr
        assert "provider response is not valid strict UTF-8 JSON" in deep_response.stderr
        deep_response_rows = [
            row
            for row in read_jsonl(project_log)
            if row.get("call_id") == "planner-call-deep-response"
        ]
        assert [row["event"] for row in deep_response_rows] == [
            "model_call",
            "model_usage",
        ]
        assert deep_response_rows[-1]["outcome"] == "error"

        ProxyCaptureHandler.captured = []
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), ProxyCaptureHandler)
        proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        proxy_thread.start()
        try:
            proxied = invoke_adapter(
                project,
                specs,
                log_home,
                f"http://127.0.0.2:{proxy.server_port}/v1",
                "planner-call-proxy",
                1,
                extra_env={
                    "HTTP_PROXY": f"http://127.0.0.1:{proxy.server_port}",
                    "http_proxy": f"http://127.0.0.1:{proxy.server_port}",
                    "NO_PROXY": "",
                    "no_proxy": "",
                },
            )
        finally:
            proxy.shutdown()
            proxy.server_close()
            proxy_thread.join(timeout=5)
        assert "request failed" in proxied.stderr
        assert ProxyCaptureHandler.captured == []

        ClaimRaceHandler.request_count = 0
        race_server = ThreadingHTTPServer(("127.0.0.1", 0), ClaimRaceHandler)
        race_server_thread = threading.Thread(
            target=race_server.serve_forever,
            daemon=True,
        )
        race_server_thread.start()
        race_results: List[subprocess.CompletedProcess[str]] = []
        race_results_lock = threading.Lock()

        def invoke_race() -> None:
            result = invoke_adapter(
                project,
                specs,
                log_home,
                f"http://127.0.0.1:{race_server.server_port}/v1",
                "planner-call-race",
                None,
            )
            with race_results_lock:
                race_results.append(result)

        race_threads = [threading.Thread(target=invoke_race) for _ in range(2)]
        try:
            for race_thread in race_threads:
                race_thread.start()
            for race_thread in race_threads:
                race_thread.join(timeout=15)
        finally:
            race_server.shutdown()
            race_server.server_close()
            race_server_thread.join(timeout=5)
        assert all(not race_thread.is_alive() for race_thread in race_threads)
        assert sorted(result.returncode for result in race_results) == [0, 2]
        assert ClaimRaceHandler.request_count == 1
        rejected = next(result for result in race_results if result.returncode == 2)
        assert (
            "call_id already claimed" in rejected.stderr
            or "call_id already completed" in rejected.stderr
        )
        race_usage_rows = [
            row
            for row in read_jsonl(project_log)
            if row.get("event") == "model_usage"
            and row.get("call_id") == "planner-call-race"
        ]
        assert len(race_usage_rows) == 1
        assert race_usage_rows[0]["outcome"] == "success"

        completed_specs = root / "completed-specs"
        completed_specs.mkdir()
        completed_run_id = "adapter-completed-0001"
        completed_call_id = "planner-call-already-completed"
        start_run(project, completed_specs, log_home, completed_run_id)
        write_claim(
            project,
            completed_specs,
            log_home,
            completed_run_id,
            completed_call_id,
        )
        write_usage(
            project,
            completed_specs,
            log_home,
            completed_run_id,
            completed_call_id,
        )
        ClaimRaceHandler.request_count = 0
        completed_server = ThreadingHTTPServer(("127.0.0.1", 0), ClaimRaceHandler)
        completed_thread = threading.Thread(
            target=completed_server.serve_forever,
            daemon=True,
        )
        completed_thread.start()
        try:
            already_completed = invoke_adapter(
                project,
                completed_specs,
                log_home,
                f"http://127.0.0.1:{completed_server.server_port}/v1",
                completed_call_id,
                2,
                run_id=completed_run_id,
            )
        finally:
            completed_server.shutdown()
            completed_server.server_close()
            completed_thread.join(timeout=5)
        assert "call_id already completed" in already_completed.stderr
        assert ClaimRaceHandler.request_count == 0

    print("cm openai-compatible adapter fixture: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
