"""Real terminal setup: no installed providers, network, auth, or model calls."""
import json
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().with_name('cm-model-setup.mjs')
NODE = shutil.which('node')


class TerminalSetup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cm-external-terminal-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.settings = self.root / 'external-models-v1.json'

    def interact(self, arguments, steps):
        master, slave = pty.openpty()
        process = subprocess.Popen([NODE, str(SCRIPT)] + arguments,
                                   stdin=slave, stdout=slave, stderr=slave,
                                   env=dict(os.environ, CM_WORKFLOW_HOME=str(self.root)))
        os.close(slave)
        output = b''
        try:
            for prompt, answer, before in steps:
                deadline = time.monotonic() + 5
                while prompt.encode() not in output:
                    if time.monotonic() > deadline:
                        self.fail('missing prompt: ' + prompt + '\n' + output.decode(errors='replace'))
                    if select.select([master], [], [], 0.1)[0]:
                        output += os.read(master, 65536)
                if before:
                    before()
                os.write(master, answer.encode() + b'\r')
                output = b''
            # Drain the terminal while waiting: TTY writes can block without a reader.
            deadline = time.monotonic() + 5
            while process.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        output += os.read(master, 65536)
                    except OSError:
                        break
            return process.wait(timeout=1)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            os.close(master)

    def test_codex_free_model_and_default_effort(self):
        status = self.interact(['configure', '--provider', 'codex'], [
            ('codex external model ID:', 'fixture-codex', None),
            ('Effort (Enter = adapter default):', '', None),
            ('Save this provider pair?', 'y', None)])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(self.settings.read_text())['providers']['codex'],
                         dict(model='fixture-codex', effort='high'))

    def test_claude_optional_effort_is_not_sent(self):
        status = self.interact(['configure', '--provider', 'claude'], [
            ('claude external model ID:', 'fixture-claude', None),
            ('Effort (Enter = adapter default):', '', None),
            ('Save this provider pair?', 'yes', None)])
        self.assertEqual(status, 0)
        self.assertIsNone(json.loads(self.settings.read_text())['providers']['claude']['effort'])

    def test_cancel_keeps_absent_file(self):
        self.assertEqual(self.interact(['configure', '--provider', 'codex', '--model', 'fixture'],
                                      [('Save this provider pair?', 'n', None)]), 0)
        self.assertFalse(self.settings.exists())

    def test_confirmation_cannot_overwrite_concurrent_bytes(self):
        old = dict(schemaVersion=1, providers=dict(codex=dict(model='old', effort='high')))
        self.settings.write_text(json.dumps(old))
        changed = json.dumps(old, indent=4).encode()
        status = self.interact(['configure', '--provider', 'codex', '--model', 'new'],
                              [('Save this provider pair?', 'y', lambda: self.settings.write_bytes(changed))])
        self.assertEqual(status, 1)
        self.assertEqual(self.settings.read_bytes(), changed)


if __name__ == '__main__':
    unittest.main()
