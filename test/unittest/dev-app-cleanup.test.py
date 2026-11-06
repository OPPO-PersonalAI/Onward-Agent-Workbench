# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
"""Mock-only cleanup contracts: never enumerate, signal, or launch real apps."""

import contextlib
import importlib.util
from pathlib import Path
import signal
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[1] / 'autotest' / 'dev_app_cleanup.py'
SPEC = importlib.util.spec_from_file_location('dev_app_cleanup', SOURCE)
cleanup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup)


def result(code=0, stdout='', stderr=''):
    return SimpleNamespace(returncode=code, stdout=stdout, stderr=stderr)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.enterContext = stack.enter_context
        self.now = 0.0
        # Exercise POSIX branches on Windows without requiring POSIX signals.
        self.enterContext(patch.object(cleanup.signal, 'SIGKILL', 9, create=True))
        self.kill = self.enterContext(patch.object(cleanup.os, 'kill'))
        self.run = self.enterContext(patch.object(cleanup.subprocess, 'run',
                                                 side_effect=AssertionError('Unexpected process command')))
        self.enterContext(patch.object(cleanup.Path, 'iterdir',
                                      side_effect=AssertionError('Real /proc access forbidden')))
        self.enterContext(patch.object(cleanup.os, 'readlink',
                                      side_effect=AssertionError('Real /proc access forbidden')))
        self.toolhelp = self.enterContext(
            patch.object(cleanup.AppCleanup, 'win32_toolhelp_snapshot',
                         side_effect=AssertionError('Real Toolhelp32 access forbidden')))
        self.enterContext(patch.object(cleanup.time, 'monotonic', side_effect=lambda: self.now))
        self.enterContext(patch.object(cleanup.time, 'sleep', side_effect=self.sleep))

    def sleep(self, seconds):
        self.now += seconds

    def app(self, platform='win32'):
        return cleanup.AppCleanup('Under Development 2.1.0-test',
                                  str(Path('release') / 'linux-unpacked' / 'app'), platform=platform)

    def test_windows_exact_image_and_no_tree_kill(self):
        app = self.app()
        listing = f'"{app.image}","10","Console","1","10 K"\n"{app.image} Helper","20"\n'
        self.run.side_effect = [result(stdout=listing), result(), result(stdout='INFO: No tasks')]
        app.stop()
        self.assertEqual(self.run.call_args_list[1].args[0], ['taskkill', '/F', '/IM', app.image])
        self.assertEqual(self.run.call_args_list[1].kwargs['timeout'], 30)
        self.kill.assert_not_called()

    def test_timeout_then_absence_is_verified_exactly_once(self):
        app = self.app()
        self.run.side_effect = [result(stdout=f'"{app.image}","10"'),
                               subprocess.TimeoutExpired('taskkill', 30), result(stdout='INFO: No tasks')]
        with patch('sys.stdout') as diagnostic:
            app.stop()
        self.assertEqual(self.run.call_count, 3)
        self.assertTrue(diagnostic.write.called)

    def test_timeout_keeps_thirty_second_verification_budget(self):
        app = self.app()

        def command(argv, **kwargs):
            if argv[0] == 'taskkill':
                self.now += 30
                raise subprocess.TimeoutExpired(argv, 30)
            if self.now:
                self.assertEqual(kwargs['timeout'], 30)
                return result(stdout='INFO: No tasks')
            return result(stdout=f'"{app.image}","10"')

        self.run.side_effect = command
        with patch('sys.stdout'):
            app.stop()
        self.assertEqual(self.now, 30)

    def test_timeout_with_survivor_fails(self):
        app = self.app()
        listing = result(stdout=f'"{app.image}","10"')
        self.run.side_effect = [listing, subprocess.TimeoutExpired('taskkill', 30), listing]
        with self.assertRaisesRegex(cleanup.CleanupError, 'still running'):
            app.stop()

    def test_missing_kill_command_is_not_absence(self):
        app = self.app()
        self.run.side_effect = [result(stdout=f'"{app.image}","10"'), FileNotFoundError('taskkill')]
        with self.assertRaisesRegex(cleanup.CleanupError, 'Cannot execute'):
            app.stop()
        self.assertEqual(self.run.call_count, 2)

    def test_failed_probe_does_not_claim_absence(self):
        self.run.side_effect = None
        self.run.return_value = result(1, stderr='denied')
        with self.assertRaisesRegex(cleanup.CleanupError, 'tasklist failed'):
            self.app().stop()

    def test_tasklist_timeout_falls_back_to_toolhelp_snapshot(self):
        app = self.app()
        self.run.side_effect = [subprocess.TimeoutExpired('tasklist', 30)]
        self.toolhelp.side_effect = [{}]
        with patch('sys.stdout') as diagnostic:
            app.stop()
        self.assertEqual(self.run.call_count, 1)
        self.assertEqual(self.toolhelp.call_count, 1)
        self.assertTrue(diagnostic.write.called)

    def test_failed_kill_with_survivor_propagates(self):
        app = self.app()
        listing = result(stdout=f'"{app.image}","10"')
        self.run.side_effect = [listing, result(5, stderr='denied'), listing]
        with self.assertRaisesRegex(cleanup.CleanupError, 'failed.*denied'):
            app.stop()

    def test_nonmatching_windows_image_is_ignored(self):
        app = self.app()
        self.run.side_effect = None
        self.run.return_value = result(stdout=f'"{app.image} Helper","10"')
        app.stop()
        self.assertEqual(self.run.call_count, 1)

    def test_mac_exact_name_escapes_version_dots(self):
        app = self.app('darwin')
        self.run.side_effect = [result(stdout='10\n'), result(), result(1)]
        app.stop()
        self.assertEqual(self.run.call_args_list[0].args[0], ['pgrep', '-x', app.pattern])
        self.assertEqual(self.run.call_args_list[1].args[0], ['pkill', '-x', app.pattern])
        self.assertIn(r'2\.1\.0', app.pattern)

    def test_mac_probe_error_is_not_absence(self):
        self.run.side_effect = None
        self.run.return_value = result(2, stderr='invalid')
        with self.assertRaisesRegex(cleanup.CleanupError, 'pgrep failed'):
            self.app('darwin').stop()

    def test_linux_excludes_helpers_and_requires_full_path(self):
        app = self.app('linux')
        entry = Mock()
        entry.__truediv__ = Mock(return_value=entry)
        entry.read_text.return_value = '10 (app name) ' + ' '.join(['S'] + ['0'] * 18 + ['123'])
        with patch.object(cleanup.os, 'readlink', return_value=app.binary):
            entry.read_bytes.return_value = b'app\0--type=renderer\0'
            self.assertIsNone(app.linux_identity(entry))
            entry.read_bytes.return_value = b'app\0--type\0gpu-process\0'
            self.assertIsNone(app.linux_identity(entry))
            entry.read_bytes.return_value = b'app\0'
            self.assertEqual(app.linux_identity(entry), '123')
        with patch.object(cleanup.os, 'readlink', return_value=app.binary + '-other'):
            self.assertIsNone(app.linux_identity(entry))

    def test_linux_pid_reuse_or_helper_transition_skips_signal(self):
        app = self.app('linux')
        with patch.object(app, 'linux_identity', side_effect=['new-starttime', None, 'original']):
            app.signal_matching({10: 'original', 20: 'original', 30: 'original'}, signal.SIGTERM)
        self.kill.assert_called_once_with(30, signal.SIGTERM)

    def test_mac_rechecks_pid_before_escalation(self):
        app = self.app('darwin')
        with patch.object(app, 'snapshot', side_effect=[{}, {20: app.name}]):
            app.signal_matching({10: app.name, 20: app.name}, signal.SIGKILL)
        self.kill.assert_called_once_with(20, signal.SIGKILL)

    def test_owned_linux_identity_permission_failure_is_explicit(self):
        app = self.app('linux')
        entry = Mock()
        entry.__truediv__ = Mock(return_value=entry)
        entry.stat.return_value.st_uid = 1000
        with patch.object(cleanup.os, 'readlink', side_effect=PermissionError('denied')), \
                patch.object(cleanup.os, 'geteuid', return_value=1000, create=True):
            with self.assertRaisesRegex(cleanup.CleanupError, 'Cannot inspect'):
                app.linux_identity(entry)

    def test_unowned_linux_protected_entry_is_not_a_cleanup_target(self):
        app = self.app('linux')
        entry = Mock()
        entry.__truediv__ = Mock(return_value=entry)
        entry.stat.return_value.st_uid = 0
        with patch.object(cleanup.os, 'readlink', side_effect=PermissionError('denied')), \
                patch.object(cleanup.os, 'geteuid', return_value=1000, create=True):
            self.assertIsNone(app.linux_identity(entry))

    def test_kill_permission_error_is_not_swallowed(self):
        app = self.app('linux')
        self.kill.side_effect = PermissionError('denied')
        with patch.object(app, 'linux_identity', return_value='original'):
            with self.assertRaises(PermissionError):
                app.signal_matching({10: 'original'}, signal.SIGTERM)

    def test_many_parents_share_one_grace_period(self):
        app = self.app('linux')
        parents = {pid: 'original' for pid in range(100)}
        forced = False

        def send(_parents, sig):
            nonlocal forced
            if sig == signal.SIGKILL:
                forced = True

        with patch.object(app, 'snapshot', side_effect=lambda: {} if forced else parents), \
                patch.object(app, 'signal_matching', side_effect=send) as send_mock:
            app.stop()
        self.assertEqual(self.now, cleanup.GRACE_SEC)
        self.assertEqual(send_mock.call_count, 2)

    def test_survivors_cannot_extend_outer_deadline(self):
        app = self.app('linux')
        with patch.object(app, 'snapshot', return_value={10: 'original'}), \
                patch.object(app, 'signal_matching'):
            with self.assertRaisesRegex(cleanup.CleanupError, 'still running'):
                app.stop()
        self.assertAlmostEqual(self.now, cleanup.SHUTDOWN_TIMEOUT_SEC)

    def test_command_budget_uses_remaining_deadline(self):
        app = self.app()
        app.deadline = 5
        self.run.side_effect = None
        self.run.return_value = result()
        app.run(['tasklist'])
        self.assertEqual(self.run.call_args.kwargs['timeout'], 5)
        self.now = 5
        with self.assertRaisesRegex(cleanup.CleanupError, 'deadline'):
            app.run(['tasklist'])


if __name__ == '__main__':
    unittest.main()
