#!/usr/bin/env python3
"""Behavior fixtures for the CM approved-spec manifest."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "cm-spec-manifest.py"


def invoke(*args: str, expected_exit: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    # The compatibility CLI and JS are checked against the frozen old algorithm,
    # not against two entrypoints which now execute the same implementation.
    oracle = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "fixtures" / "spec-manifest-python-oracle.py"), *args],
        cwd=ROOT, text=True, capture_output=True, check=False,
    )
    javascript = subprocess.run(
        [os.environ.get("CM_NODE_BIN", "node"), str(ROOT / "scripts" / "cm-spec-manifest.mjs"), *args],
        cwd=ROOT, text=True, capture_output=True, check=False,
    )
    if javascript.returncode != result.returncode or oracle.returncode != result.returncode:
        raise AssertionError(f"JS/Python exit mismatch: {javascript.stderr} / {result.stderr}")
    if result.returncode == 0 and not (
        json.loads(javascript.stdout) == json.loads(result.stdout) == json.loads(oracle.stdout)
    ):
        raise AssertionError("JS/Python semantic manifest mismatch")
    if result.returncode != expected_exit:
        raise AssertionError(
            f"expected exit {expected_exit}, got {result.returncode}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="cm-spec-manifest-") as raw:
        root = Path(raw)
        specs = root / "specs"
        feature = specs / "1.login"
        feature.mkdir(parents=True)
        requirements_unchecked = (
            "# requirements\n\n"
            "- [ ] [AC-001] user can log in\n"
            "- [ ] review privacy\n\n"
            "```md\n"
            "- [ ] [AC-999] fenced example\n"
            "```\n\n"
            "    - [ ] [AC-998] indented example\n"
        )
        requirements_completed = requirements_unchecked.replace(
            "- [ ] [AC-001] user can log in",
            "- [x] [AC-001] user can log in",
        )
        tasks_unchecked = (
            "- [ ] T-001: login\n\n"
            "```md\n"
            "- [ ] T-999: fenced example\n"
            "```\n\n"
            "    - [ ] T-998: indented example\n"
        )
        tasks_completed = tasks_unchecked.replace(
            "- [ ] T-001: login",
            "- [x] T-001: login",
        )
        for name, body in (
            ("requirements.md", requirements_unchecked),
            ("design.md", "# design\n"),
            ("tasks.md", tasks_unchecked),
            ("test-cases.json", '{"schemaVersion":"1.0","feature":"login","cases":[]}\n'),
        ):
            (feature / name).write_text(body, encoding="utf-8")

        generated = invoke(str(specs))
        # A symlink must be followed before consuming '..', as pathlib does.
        alias = root / "feature-link"
        alias.symlink_to(feature, target_is_directory=True)
        assert json.loads(invoke(str(alias) + "/..").stdout) == json.loads(generated.stdout)
        unusual_feature = specs / "2.line\u2028separator"
        unusual_feature.mkdir()
        invoke(str(specs), expected_exit=1)  # cannot silently omit an incomplete feature
        unusual_feature.rmdir()
        payload = json.loads(generated.stdout)
        assert payload["schema_version"] == 1
        assert [row["path"] for row in payload["specFiles"]] == [
            "1.login/design.md",
            "1.login/requirements.md",
            "1.login/tasks.md",
            "1.login/test-cases.json",
        ]
        generated_rows = {row["path"]: row["sha256"] for row in payload["specFiles"]}
        invalid_status = specs / "invalid-status.json"
        valid_status_bytes = json.dumps({"status": "approved", "specFiles": payload["specFiles"],
                                       "note": "INVALID"}).encode("utf-8")
        invalid_status.write_bytes(valid_status_bytes.replace(b"INVALID", b"\xff"))
        invoke(str(specs), "--status-file", str(invalid_status), expected_exit=1)
        invalid_status.write_bytes(b"\xef\xbb\xbf" + valid_status_bytes)
        invoke(str(specs), "--status-file", str(invalid_status), expected_exit=1)
        assert generated_rows["1.login/design.md"] == digest(feature / "design.md")
        assert generated_rows["1.login/requirements.md"] == digest(
            feature / "requirements.md"
        )
        assert generated_rows["1.login/tasks.md"] == digest(feature / "tasks.md")

        status = specs / ".cm-specs-status"
        status.write_text(
            json.dumps(
                {
                    "status": "approved",
                    "at": "2026-08-04T12:00:00-07:00",
                    "features": ["1.login"],
                    "specFiles": payload["specFiles"],
                },
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
        checked = invoke(str(specs), "--status-file", str(status))
        assert json.loads(invoke("--status-file", str(status), str(specs)).stdout) == json.loads(checked.stdout)
        assert json.loads(invoke("--status-file=" + str(status), str(specs)).stdout) == json.loads(checked.stdout)
        assert json.loads(checked.stdout)["status"] == "matched"

        (feature / "tasks.md").write_text(tasks_completed, encoding="utf-8")
        (feature / "requirements.md").write_text(requirements_completed, encoding="utf-8")
        runtime_state = invoke(str(specs), "--status-file", str(status))
        assert json.loads(runtime_state.stdout)["status"] == "matched"

        (feature / "tasks.md").write_text(
            tasks_completed.replace(
                "- [ ] T-999: fenced example",
                "- [x] T-999: fenced example",
            ),
            encoding="utf-8",
        )
        fenced_example = invoke(
            str(specs),
            "--status-file",
            str(status),
            expected_exit=1,
        )
        assert "approved spec manifest does not match" in fenced_example.stderr

        (feature / "tasks.md").write_text(
            tasks_completed.replace(
                "    - [ ] T-998: indented example",
                "    - [x] T-998: indented example",
            ),
            encoding="utf-8",
        )
        indented_example = invoke(
            str(specs),
            "--status-file",
            str(status),
            expected_exit=1,
        )
        assert "approved spec manifest does not match" in indented_example.stderr

        (feature / "tasks.md").write_text(tasks_completed, encoding="utf-8")

        (feature / "requirements.md").write_text(
            requirements_completed.replace("- [ ] review privacy", "- [x] review privacy"),
            encoding="utf-8",
        )
        unrelated_checkbox = invoke(
            str(specs),
            "--status-file",
            str(status),
            expected_exit=1,
        )
        assert "approved spec manifest does not match" in unrelated_checkbox.stderr

        (feature / "requirements.md").write_text(requirements_completed, encoding="utf-8")

        (feature / "tasks.md").write_text(
            tasks_completed.replace("T-001: login", "T-001: login with audit logging"),
            encoding="utf-8",
        )
        semantic_task_change = invoke(
            str(specs),
            "--status-file",
            str(status),
            expected_exit=1,
        )
        assert "approved spec manifest does not match" in semantic_task_change.stderr

        (feature / "tasks.md").write_text(tasks_completed, encoding="utf-8")
        (feature / "requirements.md").write_text(
            requirements_completed.replace(
                "[AC-001] user can log in",
                "[AC-001] user can log in with MFA",
            ),
            encoding="utf-8",
        )
        semantic_ac_change = invoke(
            str(specs),
            "--status-file",
            str(status),
            expected_exit=1,
        )
        assert "approved spec manifest does not match" in semantic_ac_change.stderr

        (feature / "requirements.md").write_text("# changed after approval\n", encoding="utf-8")
        mismatch = invoke(
            str(specs),
            "--status-file",
            str(status),
            expected_exit=1,
        )
        assert "approved spec manifest does not match" in mismatch.stderr

        missing = root / "missing"
        (missing / "1.partial").mkdir(parents=True)
        (missing / "1.partial" / "requirements.md").write_text("# only one\n", encoding="utf-8")
        invalid = invoke(str(missing), expected_exit=1)
        assert "missing required spec file" in invalid.stderr

        if hasattr(Path, "symlink_to"):
            linked = root / "linked"
            linked_feature = linked / "1.linked"
            linked_feature.mkdir(parents=True)
            source = root / "source.md"
            source.write_text("# source\n", encoding="utf-8")
            (linked_feature / "requirements.md").symlink_to(source)
            (linked_feature / "design.md").write_text("# design\n", encoding="utf-8")
            (linked_feature / "tasks.md").write_text("- [ ] T-001: x\n", encoding="utf-8")
            symlinked = invoke(str(linked), expected_exit=1)
            assert "must not be a symlink" in symlinked.stderr

    print("cm spec manifest fixtures: PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
