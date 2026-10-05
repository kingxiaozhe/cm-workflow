"""Synthetic publication interleavings; no provider/global configuration access."""
import base64
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[1] / 'runtime/js/cm-ai/model_configuration_write.py'
spec = importlib.util.spec_from_file_location('publisher', HELPER)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class Publication(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cm-publisher-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.target = self.root / 'choice.json'

    def request(self, content=b'{"new":true}\n', existing=b'{"old":true}\n', target=None):
        target = target or self.target
        if existing is not None:
            target.write_bytes(existing)
        return dict(target=str(target), bytes=base64.b64encode(content).decode(),
                    expectedSha256=None if existing is None else hashlib.sha256(existing).hexdigest(),
                    replace=True, createParents=False, sourceGuard=None)

    def run_helper(self, request):
        result = subprocess.run([sys.executable, '-I', '-B', str(HELPER)], input=json.dumps(request),
                                text=True, capture_output=True, timeout=5)
        return json.loads(result.stdout)

    def test_first_publication_collision(self):
        request = self.request(existing=None)
        original = os.link
        def collide(source, destination, **kwargs):
            self.target.write_bytes(b'concurrent original')
            original(source, destination, **kwargs)
        with patch.object(os, 'link', collide), self.assertRaisesRegex(publisher.Refusal, 'model_configuration_changed'):
            publisher.publish(request)
        self.assertEqual(self.target.read_bytes(), b'concurrent original')
        self.assertEqual(set(os.listdir(self.root)), {'choice.json', publisher.LOCK})

    def test_pre_replace_failure(self):
        request = self.request()
        with patch.object(os, 'replace', side_effect=OSError(errno.EIO, 'fixture')), self.assertRaises(OSError):
            publisher.publish(request)
        self.assertEqual(self.target.read_bytes(), b'{"old":true}\n')
        self.assertEqual(set(os.listdir(self.root)), {'choice.json', publisher.LOCK})

    def test_post_publication_failure_is_unknown(self):
        for existing in (None, b'{"old":true}\n'):
            self.target.unlink(missing_ok=True)
            request = self.request(existing=existing)
            original = os.fsync
            def fail_directory(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode):
                    raise OSError(errno.EIO, 'fixture')
                return original(fd)
            with patch.object(os, 'fsync', fail_directory), self.assertRaisesRegex(publisher.Refusal, 'model_configuration_write_unknown'):
                publisher.publish(request)
            self.assertEqual(self.target.read_bytes(), b'{"new":true}\n')

    def test_two_processes_same_byte_snapshot_one_winner(self):
        request = self.request()
        processes = [subprocess.Popen([sys.executable, '-I', '-B', str(HELPER)], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        for child in processes:
            child.stdin.write(json.dumps(request)); child.stdin.close(); child.stdin = None
        results = [json.loads(child.communicate(timeout=5)[0]) for child in processes]
        self.assertEqual(sum(result['ok'] for result in results), 1)
        failure = next(result for result in results if not result['ok'])
        self.assertIn(failure['code'], ('model_configuration_busy', 'model_configuration_changed'))
        self.assertEqual(self.target.read_bytes(), b'{"new":true}\n')
        self.assertEqual(self.run_helper(request)['code'], 'model_configuration_changed')

    def test_repeated_temporary_unlink_failure_after_link_is_unknown(self):
        request = self.request(existing=None)
        with patch.object(os, 'unlink', side_effect=OSError(errno.EIO, 'fixture')):
            with self.assertRaisesRegex(publisher.Refusal, 'model_configuration_write_unknown'):
                publisher.publish(request)
        self.assertEqual(self.target.read_bytes(), b'{"new":true}\n')

    def test_lock_close_failure_after_publication_is_unknown(self):
        request = self.request(existing=None)
        original = os.close
        def close(fd):
            info = os.fstat(fd)
            is_lock = (self.root / publisher.LOCK).exists() and info.st_ino == (self.root / publisher.LOCK).stat().st_ino
            original(fd)
            if is_lock and self.target.exists():
                raise OSError(errno.EIO, 'fixture')
        with patch.object(os, 'close', close):
            with self.assertRaisesRegex(publisher.Refusal, 'model_configuration_write_unknown'):
                publisher.publish(request)
        self.assertEqual(self.target.read_bytes(), b'{"new":true}\n')

    def test_second_writer_at_replace_cannot_enter(self):
        request = self.request()
        original = os.replace
        def interleave(source, destination, **kwargs):
            self.assertEqual(self.run_helper(request)['code'], 'model_configuration_busy')
            return original(source, destination, **kwargs)
        with patch.object(os, 'replace', interleave):
            publisher.publish(request)
        inode = (self.root / publisher.LOCK).stat().st_ino
        publisher.publish(self.request(existing=self.target.read_bytes()))
        self.assertEqual((self.root / publisher.LOCK).stat().st_ino, inode)

    def test_ancestor_swap_never_redirects_into_run_evidence(self):
        for move_temporary in (False, True):
            with self.subTest(move_temporary=move_temporary), tempfile.TemporaryDirectory(dir=self.root) as temp:
                root = Path(temp); safe = root / 'safe'; safe.mkdir()
                evidence = root / '.reviews'; evidence.mkdir()
                target = safe / 'choice.json'; request = self.request(target=target)
                original = os.replace
                def swap(source, destination, **kwargs):
                    os.rename(safe, root / 'old-safe')
                    if move_temporary:
                        os.rename(root / 'old-safe' / source, evidence / source)
                    safe.symlink_to(evidence, target_is_directory=True)
                    return original(source, destination, **kwargs)
                with patch.object(os, 'replace', swap):
                    if move_temporary:
                        with self.assertRaises(FileNotFoundError): publisher.publish(request)
                    else:
                        with self.assertRaisesRegex(publisher.Refusal, 'model_configuration_write_unknown'):
                            publisher.publish(request)
                        self.assertEqual((root / 'old-safe' / 'choice.json').read_bytes(), b'{"new":true}\n')
                self.assertFalse((evidence / 'choice.json').exists())
                # Moving the pinned directory itself is deliberately outside the same-UID trust boundary.

    def test_legacy_source_guard_rejects_changed_bytes(self):
        source = self.root / 'v1.json'; source.write_bytes(b'{}\n')
        request = self.request(existing=None)
        request['sourceGuard'] = dict(file=str(source), sha256=hashlib.sha256(source.read_bytes()).hexdigest())
        source.write_bytes(b'{ }\n')
        with self.assertRaisesRegex(publisher.Refusal, 'model_configuration_changed'): publisher.publish(request)
        self.assertFalse(self.target.exists()); self.assertEqual(source.read_bytes(), b'{ }\n')

    def test_initial_bytes_not_just_semantics(self):
        request = self.request(existing=b'{"old":true}\n')
        self.target.write_bytes(b'{ "old": true }\n')
        with self.assertRaisesRegex(publisher.Refusal, 'model_configuration_changed'): publisher.publish(request)
        self.assertEqual(self.target.read_bytes(), b'{ "old": true }\n')

    def test_forbidden_names_have_no_side_effects(self):
        for target in (self.root / '.REVIEWS' / 'x.json', self.root / '.CM-MODEL-CONFIG.LOCK',
                       self.root / '.cm-model-snapshot-v1.json'):
            request = self.request(existing=None, target=target); request['createParents'] = True
            with self.assertRaisesRegex(publisher.Refusal, 'model_output_run_path_forbidden'): publisher.publish(request)
        self.assertEqual(os.listdir(self.root), [])

    def test_symlink_parent_is_not_followed(self):
        outside = self.root / 'outside'; outside.mkdir(); alias = self.root / 'alias'; alias.symlink_to(outside)
        request = self.request(existing=None, target=alias / 'nested' / 'x.json'); request['createParents'] = True
        with self.assertRaises(OSError): publisher.publish(request)
        self.assertEqual(os.listdir(outside), [])

    def test_lock_symlink_and_hardlink_refused(self):
        request = self.request(); lock = self.root / publisher.LOCK
        lock.symlink_to(self.target)
        with self.assertRaises(OSError): publisher.publish(request)
        lock.unlink(); os.link(self.target, lock)
        with self.assertRaisesRegex(publisher.Refusal, 'invalid_model_configuration_lock'): publisher.publish(request)
        self.assertEqual(self.target.read_bytes(), b'{"old":true}\n')

    def test_group_writable_parent_refused(self):
        request = self.request(existing=None); self.root.chmod(0o770)
        with self.assertRaisesRegex(publisher.Refusal, 'model_configuration_untrusted_directory'): publisher.publish(request)
        self.root.chmod(0o700); self.assertEqual(os.listdir(self.root), [])

    def test_unsupported_platform_refuses_before_mkdir(self):
        request = self.request(existing=None, target=self.root / 'new' / 'choice.json'); request['createParents'] = True
        with patch.object(publisher, 'SECURE_PLATFORM', False), self.assertRaisesRegex(publisher.Refusal, 'model_secure_write_unavailable'):
            publisher.publish(request)
        self.assertEqual(os.listdir(self.root), [])

    def test_fifo_target_refused_without_blocking(self):
        request = self.request(existing=None); os.mkfifo(self.target)
        self.assertEqual(self.run_helper(request)['code'], 'invalid_model_configuration_file')

    def test_valid_publication_creates_private_parents(self):
        request = self.request(existing=None, target=self.root / 'nested' / 'choice.json'); request['createParents'] = True
        self.assertTrue(self.run_helper(request)['ok'])
        self.assertEqual(stat.S_IMODE((self.root / 'nested').stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.root / 'nested' / 'choice.json').stat().st_mode), 0o600)


if __name__ == '__main__':
    unittest.main()
