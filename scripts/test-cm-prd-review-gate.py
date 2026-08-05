#!/usr/bin/env python3
"""Recovery fixtures for single-attempt CM PRD reviews."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "cm-prd-review-gate.py"


def invoke(*args: str, expected_exit: int = 0) -> dict[str, object]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != expected_exit:
        raise AssertionError(
            f"expected exit {expected_exit}, got {result.returncode}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return json.loads(result.stdout) if result.stdout.strip() else {"stderr": result.stderr}


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="cm-prd-review-gate-") as raw:
        root = Path(raw)
        reviews = root / ".reviews"
        reviews.mkdir()
        artifact = root / "design.md"
        artifact.write_text("# design v1\n", encoding="utf-8")
        evidence = reviews / "prd-1.login-design-r1.md"
        receipt = reviews / "prd-1.login-design-disposition.json"

        fresh = invoke(
            "inspect",
            "--stage",
            "design",
            "--feature",
            "1.login",
            "--evidence",
            str(evidence),
            "--receipt",
            str(receipt),
        )
        assert fresh["outcome"] == "dispatch_once"

        fake_header_evidence = reviews / "prd-2.fake-design-r1.md"
        fake_header_evidence.write_text(
            "---\n"
            "at: 2026-08-04T12:00:00-07:00\n"
            "notreviewer: codex-subagent\n"
            "notindependent: true\n"
            "notscope:\n"
            "  - design.md\n"
            "---\n\n"
            "伪字段不能通过。\n",
            encoding="utf-8",
        )
        fake_header = invoke(
            "inspect",
            "--stage",
            "design",
            "--feature",
            "2.fake",
            "--evidence",
            str(fake_header_evidence),
            "--receipt",
            str(reviews / "prd-2.fake-design-disposition.json"),
            expected_exit=1,
        )
        assert "stderr" in fake_header

        degraded_evidence = reviews / "prd-3.degraded-design-r1.md"
        degraded_evidence.write_text(
            "---\n"
            "at: 2026-08-04T12:00:00-07:00\n"
            "reviewer: self-degraded\n"
            "independent: false\n"
            "degraded_reason: independent channels unavailable\n"
            "scope:\n"
            "  - design.md\n"
            "---\n\n"
            "主执行者完成降级对抗检查，零发现。\n",
            encoding="utf-8",
        )
        degraded = invoke(
            "inspect",
            "--stage",
            "design",
            "--feature",
            "3.degraded",
            "--evidence",
            str(degraded_evidence),
            "--receipt",
            str(reviews / "prd-3.degraded-design-disposition.json"),
        )
        assert degraded["outcome"] == "resume_disposition"

        evidence_body = (
            "---\n"
            "at: 2026-08-04T12:00:00-07:00\n"
            "reviewer: codex-subagent\n"
            "independent: true\n"
            "scope:\n"
            "  - design.md\n"
            "---\n\n"
            "发现一项边界问题。\n"
        )
        evidence.write_text(evidence_body, encoding="utf-8")
        recovering = invoke(
            "inspect",
            "--stage",
            "design",
            "--feature",
            "1.login",
            "--evidence",
            str(evidence),
            "--receipt",
            str(receipt),
        )
        assert recovering["outcome"] == "resume_disposition"

        recorded = invoke(
            "record",
            "--stage",
            "design",
            "--feature",
            "1.login",
            "--evidence",
            str(evidence),
            "--receipt",
            str(receipt),
            "--artifact",
            str(artifact),
            "--disposition",
            "applied",
            "--finding-count",
            "1",
            "--unresolved-count",
            "0",
        )
        assert recorded["outcome"] == "recorded"
        completed = invoke(
            "inspect",
            "--stage",
            "design",
            "--feature",
            "1.login",
            "--evidence",
            str(evidence),
            "--receipt",
            str(receipt),
        )
        assert completed["outcome"] == "completed"

        artifact.write_text("# changed after disposition\n", encoding="utf-8")
        artifact_mismatch = invoke(
            "inspect",
            "--stage",
            "design",
            "--feature",
            "1.login",
            "--evidence",
            str(evidence),
            "--receipt",
            str(receipt),
            expected_exit=1,
        )
        assert "stderr" in artifact_mismatch
        artifact.write_text("# design v1\n", encoding="utf-8")

        receipt_value = json.loads(receipt.read_text(encoding="utf-8"))
        invalid_receipt = dict(receipt_value)
        invalid_receipt["disposition"] = "no_findings"
        invalid_receipt["finding_count"] = 1
        receipt.write_text(
            json.dumps(invalid_receipt, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        receipt_mismatch = invoke(
            "inspect",
            "--stage",
            "design",
            "--feature",
            "1.login",
            "--evidence",
            str(evidence),
            "--receipt",
            str(receipt),
            expected_exit=1,
        )
        assert "stderr" in receipt_mismatch
        receipt.write_text(
            json.dumps(receipt_value, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )

        evidence.write_text(evidence.read_text(encoding="utf-8") + "tampered\n", encoding="utf-8")
        mismatch = invoke(
            "inspect",
            "--stage",
            "design",
            "--feature",
            "1.login",
            "--evidence",
            str(evidence),
            "--receipt",
            str(receipt),
            expected_exit=1,
        )
        assert "stderr" in mismatch

        r2 = reviews / "prd-2.profile-split-r2.md"
        r2.write_text("forbidden second review\n", encoding="utf-8")
        blocked = invoke(
            "inspect",
            "--stage",
            "split",
            "--feature",
            "2.profile",
            "--evidence",
            str(reviews / "prd-2.profile-split-r1.md"),
            "--receipt",
            str(reviews / "prd-2.profile-split-disposition.json"),
            expected_exit=1,
        )
        assert "stderr" in blocked

    print("cm-prd review recovery fixtures: PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
