#!/usr/bin/env python3
"""Run the actual safety CLI against isolated public-tree fixtures."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCANNER = Path(__file__).with_name("scan-public-safety.py")
LOOPBACK = "http://" + "127.0.0.1"
PRIVATE = "http://" + "192.168.40.2"
APPROVED = "scripts/cm-test-host.test.mjs"
LEGACY = "scripts/test-cm-openai-compatible-call.py"


class PublicSafetyTests(unittest.TestCase):
    def scan(self, files, *, git_repo=False, tracked=()):
        with tempfile.TemporaryDirectory(prefix="cm-safety-") as raw:
            root = Path(raw)
            script = root / "scripts" / SCANNER.name
            script.parent.mkdir()
            shutil.copyfile(SCANNER, script)
            if git_repo:
                subprocess.run(["git", "init", "-q", str(root)], check=True, capture_output=True)
            for name, text in files.items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding="utf-8")
            if tracked:
                subprocess.run(
                    ["git", "-C", str(root), "add", "-f", "--", *tracked],
                    check=True, capture_output=True,
                )
            return subprocess.run(
                [sys.executable, str(script)], cwd=root,
                capture_output=True, text=True, check=False,
            )

    def test_reviewed_loopback_literals_and_local_port_templates(self):
        for authority in ["127.0.0.1", "localhost:3000", "localhost:$PORT",
                          "127.0.0.1:${port}", "127.0.0.1:{server.server_port}"]:
            with self.subTest(authority=authority):
                result = self.scan({APPROVED: '"http://' + authority + '/capture"'})
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_loopback_in_unreviewed_path_is_still_reported(self):
        result = self.scan({"docs/unreviewed.md": LOOPBACK + "/capture"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("docs/unreviewed.md:1: private endpoint", result.stderr)

    def test_rfc1918_is_not_exempt_in_any_reviewed_file(self):
        for name in [APPROVED, LEGACY, "templates/dashboard/serve.sh"]:
            for host in ["10.4.5.6", "192.168.40.2", "172.16.4.5", "172.31.4.5"]:
                with self.subTest(name=name, host=host):
                    result = self.scan({name: '"http://' + host + ':3000/"'})
                    self.assertEqual(result.returncode, 1, result.stdout)
                    self.assertIn("private endpoint", result.stderr)

    def test_lookalike_and_credential_authorities_are_not_loopback_exceptions(self):
        for suffix in [".example.invalid", "@example.invalid", ":80@example.invalid",
                       ":3000.evil", "0", ":${untrusted.host}"]:
            with self.subTest(suffix=suffix):
                result = self.scan({APPROVED: '"' + LOOPBACK + suffix + '/"'})
                self.assertEqual(result.returncode, 1, result.stdout)

    def test_other_findings_and_line_numbers_survive_loopback_exception(self):
        # Deliberately constructed fake markers; never use a real credential.
        fake_key = "sk-" + "x" * 24
        personal = "/Users/" + "fixture-owner/project"
        result = self.scan({APPROVED: f'"{LOOPBACK}/"\n{PRIVATE}\n{fake_key}\n{personal}\n'})
        self.assertEqual(result.returncode, 1)
        for expected in [":2: private endpoint", ":3: OpenAI-style key", ":4: personal macOS path"]:
            self.assertIn(APPROVED + expected, result.stderr)
        self.assertNotIn(APPROVED + ":1:", result.stderr)

    def test_tracked_omx_files_are_scanned_at_root_and_nested_paths(self):
        for name in [".omx/sample.txt", "module/.omx/sample.txt"]:
            with self.subTest(name=name):
                result = self.scan(
                    {".gitignore": ".omx/\n", name: "sk-" + "x" * 24},
                    git_repo=True, tracked=[name],
                )
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(name + ":1: OpenAI-style key", result.stderr)

    def test_untracked_omx_state_remains_private(self):
        result = self.scan(
            {".gitignore": ".omx/\n", ".omx/local.txt": "sk-" + "x" * 24,
             "module/.omx/local.txt": "sk-" + "y" * 24},
            git_repo=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_omx_exclusion_is_per_file_not_per_directory(self):
        result = self.scan(
            {".omx/tracked.txt": "sk-" + "x" * 24,
             ".omx/untracked.txt": "sk-" + "y" * 24,
             "docs/ordinary.txt": "sk-" + "z" * 24},
            git_repo=True, tracked=[".omx/tracked.txt"],
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn(".omx/tracked.txt:1: OpenAI-style key", result.stderr)
        self.assertIn("docs/ordinary.txt:1: OpenAI-style key", result.stderr)
        self.assertNotIn(".omx/untracked.txt:", result.stderr)

    def test_git_query_failure_scans_omx_conservatively(self):
        # No Git repository: ls-files fails instead of returning an empty inventory.
        result = self.scan({".omx/sample.txt": "sk-" + "x" * 24})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(".omx/sample.txt:1: OpenAI-style key", result.stderr)

    def test_private_key_header_formats_are_detected(self):
        for label in ["PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "RSA PRIVATE KEY",
                      "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "DSA PRIVATE KEY"]:
            with self.subTest(label=label):
                # Construct marker only; the body is not a usable private key.
                result = self.scan({"docs/example.pem": "-----BEGIN " + label + "-----\nSYNTHETIC\n"})
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn("docs/example.pem:1: private key", result.stderr)

    def test_public_key_headers_are_not_private_keys(self):
        for label in ["PUBLIC KEY", "RSA PUBLIC KEY", "CERTIFICATE"]:
            with self.subTest(label=label):
                result = self.scan({"docs/example.pem": "-----BEGIN " + label + "-----\nSYNTHETIC\n"})
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
