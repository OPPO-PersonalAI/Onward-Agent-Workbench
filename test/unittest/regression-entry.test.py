# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
"""Platform-independent decision and failure-path tests for regression setup."""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("entry_under_test", REPO / "test/autotest/run-full-regression.py")
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)
fixture_spec = importlib.util.spec_from_file_location(
    "main_failure_fixture", REPO / "test/autotest/fixtures/orchestrator-entry/main-failure.py",
)
fixture = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixture)


class EntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ow-entry-unit-")
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)

    def fake_git(self):
        root = self.root / "Portable Git With Spaces"
        for rel in ("cmd/git.exe", "bin/bash.exe", "usr/bin/bash.exe", "usr/bin/cygpath.exe", "usr/bin/find.exe"):
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        return root

    def test_cleanup_uses_expected_arm64_path_before_first_linux_build(self):
        with patch.object(m, "REPO_ROOT", self.root), patch.object(m.platform, "system", return_value="Linux"), patch.object(m.platform, "machine", return_value="aarch64"), patch.object(m, "stop_dev_app") as stop:
            m.stop_app_for_build("Exact App")
        stop.assert_called_once_with("Exact App", self.root / "release/linux-arm64-unpacked/Exact App", tool_timeout=m.TOOL_PROBE_TIMEOUT_SEC)

    def test_cleanup_uses_explicit_binary_identity(self):
        binary = self.root / "custom-output" / "Exact App"
        with patch.object(m, "stop_dev_app") as stop:
            m.kill_app("Exact App", binary)
        stop.assert_called_once_with("Exact App", binary, tool_timeout=m.TOOL_PROBE_TIMEOUT_SEC)

    def fake_app(self, directory):
        name = "Under Development 2.0.0-test"
        base = self.root / "release" / directory
        if directory.startswith("mac"):
            binary = base / f"{name}.app" / "Contents" / "MacOS" / name
        else:
            binary = base / (f"{name}.exe" if directory.startswith("win") else name)
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.touch()
        binary.chmod(0o755)
        return name, binary

    def test_app_resolver_selects_only_host_platform_and_architecture(self):
        cases = (
            ("Windows", "AMD64", "win-unpacked"),
            ("Windows", "ARM64", "win-arm64-unpacked"),
            ("Windows", "x86", "win-ia32-unpacked"),
            ("Darwin", "x86_64", "mac"),
            ("Darwin", "arm64", "mac-arm64"),
            ("Linux", "x86_64", "linux-unpacked"),
            ("Linux", "aarch64", "linux-arm64-unpacked"),
            ("Linux", "i686", "linux-ia32-unpacked"),
            ("Linux", "armv7l", "linux-armv7l-unpacked"),
        )
        artifacts = {directory: self.fake_app(directory) for _, _, directory in cases}
        self.fake_app("mac-universal")
        for host, machine, directory in cases:
            name, expected = artifacts[directory]
            with self.subTest(host=host, machine=machine), patch.object(m, "REPO_ROOT", self.root), patch.object(m.platform, "system", return_value=host), patch.object(m.platform, "machine", return_value=machine):
                self.assertEqual(m.resolve_app_bin(name), expected)

    def test_app_resolver_rejects_foreign_artifacts_when_native_missing(self):
        for directory in ("win-unpacked", "linux-unpacked", "mac"):
            name, _ = self.fake_app(directory)
        for host in ("Windows", "Darwin", "Linux"):
            with self.subTest(host=host), patch.object(m, "REPO_ROOT", self.root), patch.object(m.platform, "system", return_value=host), patch.object(m.platform, "machine", return_value="arm64"):
                self.assertIsNone(m.resolve_app_bin(name))

    def test_app_resolver_allows_only_compatible_universal_fallback(self):
        name, universal = self.fake_app("mac-universal")
        for machine in ("arm64", "x86_64"):
            with self.subTest(machine=machine), patch.object(m, "REPO_ROOT", self.root), patch.object(m.platform, "system", return_value="Darwin"), patch.object(m.platform, "machine", return_value=machine):
                self.assertEqual(m.resolve_app_bin(name), universal)
        for host, machine in (("Windows", "ARM64"), ("Linux", "aarch64"), ("Darwin", "unknown"), ("FreeBSD", "x86_64")):
            with self.subTest(host=host, machine=machine), patch.object(m, "REPO_ROOT", self.root), patch.object(m.platform, "system", return_value=host), patch.object(m.platform, "machine", return_value=machine):
                self.assertIsNone(m.resolve_app_bin(name))

    def test_app_resolver_requires_exact_product_and_real_binary(self):
        name, binary = self.fake_app("win-arm64-unpacked")
        with patch.object(m, "REPO_ROOT", self.root), patch.object(m.platform, "system", return_value="Windows"), patch.object(m.platform, "machine", return_value="ARM64"):
            self.assertIsNone(m.resolve_app_bin("Under Development another-branch"))
            binary.unlink()
            binary.mkdir()
            self.assertIsNone(m.resolve_app_bin(name))

    def test_app_resolver_requires_posix_executable_permission(self):
        for host, directory in (("Darwin", "mac-arm64"), ("Linux", "linux-arm64-unpacked"), ("Windows", "win-arm64-unpacked")):
            name, binary = self.fake_app(directory)
            with self.subTest(host=host), patch.object(m, "REPO_ROOT", self.root), patch.object(m.platform, "system", return_value=host), patch.object(m.platform, "machine", return_value="arm64"), patch.object(m.os, "access", return_value=False):
                self.assertEqual(m.resolve_app_bin(name), binary if host == "Windows" else None)

    def test_windows_prefers_portable_git_over_wsl(self):
        git = self.fake_git()
        wsl = self.root / "System32/bash.exe"
        wsl.parent.mkdir(); wsl.touch()
        with patch.object(m, "IS_WINDOWS", True), patch.object(m.shutil, "which", side_effect=lambda name: {
            "git": str(git / "cmd/git.exe"), "bash": str(wsl),
        }.get(name)):
            self.assertEqual(Path(m.find_bash()), git / "bin/bash.exe")

    def test_windows_rejects_wsl_without_git(self):
        with patch.object(m, "IS_WINDOWS", True), patch.object(m.shutil, "which", return_value=None), patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "Git Bash"):
                m.find_bash()

    def test_windows_standard_install_without_path(self):
        git = self.fake_git()
        with patch.object(m, "IS_WINDOWS", True), patch.object(m.shutil, "which", return_value=None), patch.dict(os.environ, {"ProgramFiles": str(git.parent)}, clear=True):
            git.rename(git.parent / "Git")
            self.assertEqual(Path(m.find_bash()), git.parent / "Git/bin/bash.exe")

    def test_posix_uses_native_bash(self):
        for platform in ("darwin", "linux"):
            with self.subTest(platform=platform), patch.object(m, "IS_WINDOWS", False), patch.object(m.shutil, "which", return_value="/opt/tools/bash"):
                self.assertEqual(m.find_bash(), "/opt/tools/bash")

    def test_runner_path_prioritizes_gnu_tools_and_python(self):
        git = self.fake_git()
        with patch.object(m, "IS_WINDOWS", True), patch.dict(os.environ, {"PATH": "original"}):
            env = m.runner_environment(str(git / "bin/bash.exe"))
        self.assertTrue(env["PATH"].startswith(str(git / "usr/bin") + os.pathsep))
        self.assertTrue(env["PATH"].endswith("original"))
        self.assertEqual(env["PYTHON3"], sys.executable)

    def test_filters_avoid_unrelated_fixture(self):
        scripts, _ = m.select_scripts(["run-orchestrator-watchdog"], [], False, "Windows")
        self.assertTrue(scripts)
        self.assertNotIn(m.SUBMODULE_FIXTURE_RUNNER, scripts)
        scripts, _ = m.select_scripts(["run-git-diff-submodules"], [], False, "Darwin")
        self.assertEqual(scripts, [m.SUBMODULE_FIXTURE_RUNNER])
        scripts, _ = m.select_scripts([], ["run-git-diff-submodules"], False, "Linux")
        self.assertNotIn(m.SUBMODULE_FIXTURE_RUNNER, scripts)

    def test_update_e2e_stays_opt_in_and_platform_matched(self):
        for host in ("Windows", "Darwin", "Linux"):
            scripts, _ = m.select_scripts([], [], False, host)
            self.assertFalse(any(s in scripts for s, _ in m.UPDATE_E2E_SCRIPTS))
            scripts, _ = m.select_scripts([], [], True, host)
            for script, required in m.UPDATE_E2E_SCRIPTS:
                self.assertEqual(script in scripts, required == host)

    def test_list_build_is_read_only_even_without_tools_or_app(self):
        with patch.object(sys, "argv", ["runner", "--list", "--build"]), patch.object(m, "REPO_ROOT", self.root), patch.object(m, "find_bash") as bash, patch.object(m, "run_dev_build") as build, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.main(), 0)
        bash.assert_not_called(); build.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_empty_filter_does_not_build(self):
        with patch.object(sys, "argv", ["runner", "--build", "--only", "NO_SUCH_SUITE"]), patch.object(m, "run_dev_build") as build, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(m.main(), 2)
        build.assert_not_called()

    def test_locked_cleanup_aborts_before_build(self):
        (self.root / "release").mkdir()
        with patch.object(m, "REPO_ROOT", self.root), patch.object(m, "stop_app_for_build"), patch.object(m.shutil, "rmtree", side_effect=PermissionError("locked")), patch.object(m.time, "sleep"), patch.object(m, "run_setup_command") as command:
            with self.assertRaises(PermissionError):
                m.run_dev_build(lambda _: None, app_name="fake", pnpm="pnpm", log_path=self.root / "build.log", stage=lambda _, action: action())
        command.assert_not_called()

    def test_clean_removes_readonly_and_missing_directories(self):
        (self.root / "release").mkdir()
        item = self.root / "release/readonly.bin"
        item.write_bytes(b"owned fixture")
        item.chmod(0o444)
        with patch.object(m, "REPO_ROOT", self.root):
            m.clean_build_outputs()
        self.assertFalse((self.root / "release").exists())

    def test_build_order_and_nonzero_failure(self):
        phases = []
        def stage(name, action):
            phases.append(name)
            return action()
        with patch.object(m, "stop_app_for_build"), patch.object(m, "clean_build_outputs"), patch.object(m, "run_setup_command", return_value=7):
            with self.assertRaisesRegex(RuntimeError, "exited with 7"):
                m.run_dev_build(lambda _: None, app_name="fake", pnpm="pnpm", log_path=self.root / "build.log", stage=stage)
        self.assertEqual(phases, ["stop-old-app", "clean-build-outputs", "build"])

    def test_preflight_failure_is_persisted_before_build(self):
        with patch.object(sys, "argv", ["runner", "--build"]), patch.object(m, "REPO_ROOT", self.root), patch.object(m, "preflight_env_check", return_value=True), patch.object(m, "find_bash", side_effect=RuntimeError("missing Git Bash")), patch.object(m, "run_dev_build") as build, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.main(), 3)
        build.assert_not_called()
        summary = json.loads(next(self.root.glob("test/full-regression-results/*/summary.json")).read_text())
        self.assertIn("missing Git Bash", summary["setup_error"])
        self.assertEqual(summary["stages"][0]["status"], "ERROR")

    def test_repeated_runs_build_only_first_iteration(self):
        args = type("Args", (), {"repeat": 3})()
        with patch.object(sys, "argv", ["runner", "--build", "--repeat=3"]), patch.object(m, "REPO_ROOT", self.root), patch.object(m.subprocess, "run", return_value=type("Result", (), {"returncode": 0})()) as run, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.run_repeated(args), 0)
        for i, call in enumerate(run.call_args_list):
            self.assertEqual("--build" in call.args[0], i == 0)
            self.assertNotIn("--repeat=3", call.args[0])

    def main_failure(self, scenario, phase, attempted, unrun):
        with contextlib.redirect_stdout(io.StringIO()):
            rc, calls = fixture.run_case(m, self.root, scenario)
        self.assertEqual(rc, 1)
        path = next(self.root.glob("test/full-regression-results/*/summary.json"))
        summary = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(calls["runner_calls"], attempted)
        self.assertEqual(summary["status"], "ERROR")
        self.assertEqual(summary["errored"], 1)
        self.assertEqual(summary["unrun"], len(unrun))
        self.assertEqual(summary["unrun_scripts"], unrun)
        self.assertEqual(summary["execution_error"]["phase"], phase)
        self.assertEqual(summary["stages"][-1]["status"], "ERROR")
        self.assertEqual(summary["stages"][-2]["phase"], phase)
        self.assertEqual(summary["stages"][-2]["status"], "ERROR")
        self.assertEqual(json.loads(path.with_name("stages.json").read_text()), summary["stages"])
        error = summary["results"][-1]
        self.assertEqual(error["status"], "ERROR")
        self.assertEqual(error["script"], summary["execution_error"]["script"])
        self.assertIn(phase, error["note"])
        log = path.with_name("summary.log").read_text(encoding="utf-8")
        self.assertIn("ABORTED REGRESSION SUMMARY", log)
        self.assertNotIn("FULL REGRESSION SUMMARY", log)
        self.assertTrue(all(not Path(d).exists() for d in calls["user_data_dirs"]))
        return summary, calls

    def test_postrun_cleanup_failure_preserves_pass_and_fail_and_aborts(self):
        summary, calls = self.main_failure("postrun", "postrun-cleanup", 2, fixture.SCRIPTS[2:])
        self.assertEqual(calls["cleanup_calls"], 4)
        self.assertEqual([r["status"] for r in summary["results"]], ["PASS", "FAIL", "ERROR"])
        self.assertEqual([r["exit_code"] for r in summary["results"]], [0, 1, None])
        self.assertEqual((summary["passed"], summary["failed"]), (1, 1))
        self.assertEqual(summary["execution_error"]["type"], "CleanupError")
        self.assertEqual(summary["execution_error"]["script"], fixture.SCRIPTS[1])

    def test_prerun_cleanup_failure_counts_current_runner_as_unrun(self):
        summary, calls = self.main_failure("prerun", "prerun-cleanup", 1, fixture.SCRIPTS[1:])
        self.assertEqual(calls["cleanup_calls"], 3)
        self.assertEqual([r["status"] for r in summary["results"]], ["PASS", "ERROR"])
        self.assertEqual(summary["results"][-1]["log_file"], "")
        self.assertEqual(summary["execution_error"]["script"], fixture.SCRIPTS[1])

    def test_runner_exception_persists_previous_results_and_current_context(self):
        summary, calls = self.main_failure("runner", "runner", 2, fixture.SCRIPTS[2:])
        self.assertEqual(calls["cleanup_calls"], 3)
        self.assertEqual([r["status"] for r in summary["results"]], ["PASS", "ERROR"])
        self.assertEqual(summary["execution_error"]["type"], "RuntimeError")
        self.assertIn("controlled runner failure", summary["results"][-1]["note"])

    def test_last_runner_cleanup_failure_is_not_complete(self):
        summary, _ = self.main_failure("last-postrun", "postrun-cleanup", 3, [])
        self.assertEqual([r["status"] for r in summary["results"]], ["PASS", "FAIL", "PASS", "ERROR"])

    def test_timeout_cleanup_failure_retains_timeout(self):
        summary, _ = self.main_failure("timeout", "timeout-cleanup", 1, fixture.SCRIPTS[1:])
        self.assertEqual(summary["results"][0]["status"], "TIMEOUT")
        self.assertEqual(summary["results"][0]["exit_code"], 124)

    def test_retry_cleanup_failure_retains_first_failed_attempt(self):
        summary, _ = self.main_failure("retry-prerun", "retry-prerun-cleanup", 1, fixture.SCRIPTS[1:])
        self.assertEqual(summary["results"][0]["status"], "FAIL")
        self.assertFalse(summary["results"][0]["retried"])

    def test_retry_exception_retains_first_failed_attempt(self):
        summary, _ = self.main_failure("retry-runner", "retry-runner", 2, fixture.SCRIPTS[1:])
        self.assertEqual(summary["results"][0]["status"], "FAIL")
        self.assertEqual(summary["results"][0]["exit_code"], 1)

    def test_completed_run_retains_existing_failure_verdict(self):
        with contextlib.redirect_stdout(io.StringIO()):
            rc, calls = fixture.run_case(m, self.root, "success")
        summary = json.loads(next(self.root.glob("test/full-regression-results/*/summary.json")).read_text())
        self.assertEqual(rc, 1)
        self.assertEqual(calls["runner_calls"], 3)
        self.assertEqual(summary["status"], "COMPLETE")
        self.assertEqual(summary["unrun_scripts"], [])
        self.assertEqual(summary["errored"], 0)
        self.assertEqual([r["status"] for r in summary["results"]], ["PASS", "FAIL", "PASS"])

    def test_setup_timeout_owns_posix_process_group(self):
        from unittest.mock import Mock
        proc = Mock(pid=12345)
        proc.wait.return_value = -9
        with patch.object(m, "IS_WINDOWS", False), patch.object(m.subprocess, "Popen", return_value=proc) as spawn, patch.object(m.os, "killpg", create=True) as kill_group, patch.object(m.signal, "SIGKILL", 9, create=True):
            rc = m.run_setup_command(["fake-build"], env={}, log_path=self.root / "setup.log", timeout=0, emit=lambda _: None)
        self.assertEqual(rc, 124)
        self.assertTrue(spawn.call_args.kwargs["start_new_session"])
        kill_group.assert_called_once_with(12345, 9)

    def test_setup_timeout_owns_windows_tree(self):
        from unittest.mock import Mock
        proc = Mock()
        proc.wait.return_value = 1
        with patch.object(m, "IS_WINDOWS", True), patch.object(m.subprocess, "Popen", return_value=proc) as spawn, patch.object(m, "force_kill_tree") as kill_tree:
            rc = m.run_setup_command(["fake-build.cmd"], env={}, log_path=self.root / "setup.log", timeout=0, emit=lambda _: None)
        self.assertEqual(rc, 124)
        self.assertFalse(spawn.call_args.kwargs["start_new_session"])
        kill_tree.assert_called_once_with(proc)


if __name__ == "__main__":
    unittest.main()
