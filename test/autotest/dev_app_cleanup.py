# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
"""Exact-identity development-app cleanup shared by runners and orchestration."""

import argparse
import ctypes
from ctypes import wintypes
import csv
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


TOOL_TIMEOUT_SEC = 30.0
GRACE_SEC = 8.0
SHUTDOWN_TIMEOUT_SEC = 60.0
TH32CS_SNAPPROCESS = 0x00000002
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ('dwSize', wintypes.DWORD),
        ('cntUsage', wintypes.DWORD),
        ('th32ProcessID', wintypes.DWORD),
        ('th32DefaultHeapID', ctypes.c_size_t),
        ('th32ModuleID', wintypes.DWORD),
        ('cntThreads', wintypes.DWORD),
        ('th32ParentProcessID', wintypes.DWORD),
        ('pcPriClassBase', wintypes.LONG),
        ('dwFlags', wintypes.DWORD),
        ('szExeFile', wintypes.WCHAR * 260),
    ]


class CleanupError(RuntimeError):
    pass


class AppCleanup:
    def __init__(self, app_name, app_bin=None, *, platform=None,
                 tool_timeout=TOOL_TIMEOUT_SEC):
        self.platform = platform or sys.platform
        if not app_name or any(c in app_name for c in ('/', '\\', '\0', '*', '?')):
            raise ValueError('An exact application name is required')
        self.name = app_name
        self.image = app_name if app_name.lower().endswith('.exe') else app_name + '.exe'
        self.binary = os.path.abspath(app_bin) if app_bin else None
        if self.platform.startswith('linux') and not self.binary:
            raise ValueError('Linux cleanup requires the full application executable path')
        if self.platform != 'win32' and self.platform != 'darwin' and not self.platform.startswith('linux'):
            raise ValueError(f'Unsupported platform: {self.platform}')
        # pgrep/pkill take an ERE even with -x; version dots must be literal.
        self.pattern = re.sub(r'([.\[\]{}()^$+*?|\\])', r'\\\1', self.name)
        self.tool_timeout = tool_timeout
        self.deadline = 0.0

    def run(self, command):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise CleanupError('Development-app shutdown deadline exceeded')
        try:
            return subprocess.run(command, capture_output=True, text=True,
                                  errors='replace', timeout=min(self.tool_timeout, remaining))
        except OSError as error:
            raise CleanupError(f'Cannot execute cleanup command {command[0]}: {error}') from error

    def linux_identity(self, entry):
        try:
            if os.readlink(entry / 'exe') != self.binary:
                return None
            argv = (entry / 'cmdline').read_bytes().split(b'\0')
            if any(arg == b'--type' or arg.startswith(b'--type=') for arg in argv):
                return None
            # starttime protects against reuse of a PID by the same executable.
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            return fields[19]
        except (FileNotFoundError, ProcessLookupError):
            return None
        except PermissionError as error:
            # Cleanup only owns this user's app. Other users' protected entries
            # are outside that scope, but an unreadable owned entry is an error.
            try:
                if entry.stat().st_uid != os.geteuid():
                    return None
            except (FileNotFoundError, ProcessLookupError):
                return None
            raise CleanupError(f'Cannot inspect process identity at {entry}: {error}') from error

    def win32_toolhelp_snapshot(self):
        if not hasattr(ctypes, 'windll'):
            return None
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
        kernel32.Process32FirstW.restype = wintypes.BOOL
        kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
        kernel32.Process32NextW.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

        snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snap is None or snap == INVALID_HANDLE_VALUE:
            raise CleanupError('CreateToolhelp32Snapshot failed')
        try:
            entry = _PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
            found = {}
            target = self.image.casefold()
            ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
            while ok:
                if entry.szExeFile.casefold() == target:
                    found[int(entry.th32ProcessID)] = target
                ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
            return found
        finally:
            kernel32.CloseHandle(snap)

    def snapshot(self):
        if self.platform.startswith('linux'):
            found = {}
            for entry in Path('/proc').iterdir():
                if entry.name.isdigit():
                    identity = self.linux_identity(entry)
                    if identity is not None:
                        found[int(entry.name)] = identity
            return found
        if self.platform == 'win32':
            try:
                result = self.run(['tasklist', '/FI', f'IMAGENAME eq {self.image}', '/FO', 'CSV', '/NH'])
            except subprocess.TimeoutExpired as error:
                fallback = self.win32_toolhelp_snapshot()
                if fallback is not None:
                    self.deadline = max(self.deadline, time.monotonic() + self.tool_timeout)
                    print('[cleanup] tasklist timed out; Toolhelp32 snapshot succeeded')
                    return fallback
                raise CleanupError('tasklist timed out') from error
            if result.returncode:
                raise CleanupError(f'tasklist failed ({result.returncode}): {result.stderr.strip()}')
            found = {}
            for row in csv.reader(result.stdout.splitlines()):
                if row and row[0].casefold() == self.image.casefold():
                    if len(row) < 2 or not row[1].isdigit():
                        raise CleanupError('tasklist returned an invalid PID')
                    found[int(row[1])] = self.image.casefold()
            return found
        result = self.run(['pgrep', '-x', self.pattern])
        if result.returncode == 1:
            return {}
        if result.returncode:
            raise CleanupError(f'pgrep failed ({result.returncode}): {result.stderr.strip()}')
        try:
            return {int(pid): self.name for pid in result.stdout.split()}
        except ValueError as error:
            raise CleanupError('pgrep returned an invalid PID') from error

    def signal_matching(self, parents, sig):
        for pid, identity in parents.items():
            # Re-read identity immediately before every signal, including escalation.
            if self.platform.startswith('linux'):
                current = self.linux_identity(Path('/proc') / str(pid))
            else:
                current = self.snapshot().get(pid)
            if current != identity:
                continue
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass

    def command_kill(self, command):
        try:
            result = self.run(command)
        except subprocess.TimeoutExpired as error:
            # taskkill can finish termination but stall before returning. Exactly
            # one bounded identity check distinguishes that case from survivors.
            if self.snapshot():
                raise CleanupError(f'{command[0]} timed out; application is still running') from error
            print(f'[cleanup] {command[0]} timed out; exact identity check confirmed absence')
            return True
        if result.returncode:
            if self.snapshot():
                raise CleanupError(f'{command[0]} failed ({result.returncode}): {result.stderr.strip()}')
            print(f'[cleanup] {command[0]} exited {result.returncode}; exact identity check confirmed absence')
            return True
        return False

    def stop(self):
        # All PIDs share one grace period and one outer deadline. A timed-out
        # 30-second command still has a bounded verification window.
        self.deadline = time.monotonic() + SHUTDOWN_TIMEOUT_SEC
        parents = self.snapshot()
        if not parents:
            return
        if self.platform == 'win32':
            if self.command_kill(['taskkill', '/F', '/IM', self.image]):
                return
            if self.snapshot():
                raise CleanupError(f'Development app is still running: {self.image}')
            return
        if self.platform == 'darwin':
            if self.command_kill(['pkill', '-x', self.pattern]):
                return
        else:
            self.signal_matching(parents, signal.SIGTERM)
        grace_deadline = min(self.deadline, time.monotonic() + GRACE_SEC)
        while True:
            current = self.snapshot()
            if not current:
                return
            remaining = grace_deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(0.5, remaining))
        self.signal_matching(parents, signal.SIGKILL)
        # Reaping is asynchronous, but never extend the shared shutdown deadline.
        while self.snapshot():
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise CleanupError(f'Development app is still running: {self.name}')
            time.sleep(min(0.1, remaining))


def stop_dev_app(app_name, app_bin=None, *, tool_timeout=TOOL_TIMEOUT_SEC):
    AppCleanup(app_name, app_bin, tool_timeout=tool_timeout).stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-name', required=True)
    parser.add_argument('--app-bin')
    args = parser.parse_args()
    try:
        app = AppCleanup(args.app_name, args.app_bin)
        app.stop()
    except (CleanupError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f'[cleanup] ERROR: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
