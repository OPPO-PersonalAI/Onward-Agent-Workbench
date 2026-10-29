# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
"""ORE: real setup commands and native shell entrypoints; no app interaction."""
import ctypes
import importlib.util
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("regression_entry_e2e", REPO / "test/autotest/run-full-regression.py")
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)

if "--probe-tools" in sys.argv:
    bash, node = m.find_bash(), m.find_node()
    m.validate_runner_tools(bash, node, print)
    print("ORE_TOOLS_OK", flush=True)
    sys.exit(0)

TRIALS = 5
FIXTURE = REPO / "test/autotest/fixtures/orchestrator-entry/setup-child.py"
LOGS = REPO / "traces/test-logs/regression-entry"
LOGS.mkdir(parents=True, exist_ok=True)


def alive(pid):
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x00100000, False, pid)
        if not handle:
            return False
        try:
            return kernel.WaitForSingleObject(handle, 0) == 258
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        proc_stat = Path(f"/proc/{pid}/stat")
        return not (proc_stat.exists() and proc_stat.read_text().split(")", 1)[1].split()[0] == "Z")
    except ProcessLookupError:
        return False


def check_commands(scratch):
    child_pids = []
    try:
        for trial in range(TRIALS):
            log = LOGS / f"command-{trial}.log"
            rc = m.run_setup_command(
                [sys.executable, str(FIXTURE), "success", "argument with spaces"],
                env=os.environ.copy(), log_path=log, timeout=30, emit=print,
            )
            assert rc == 0 and json.loads(log.read_text())["argument"] == "argument with spaces"
            rc = m.run_setup_command(
                [sys.executable, str(FIXTURE), "failure"],
                env=os.environ.copy(), log_path=log, timeout=30, emit=print,
            )
            assert rc == 7 and "deliberate setup failure" in log.read_text()
            marker = scratch / f"child-{trial}.pid"
            rc = m.run_setup_command(
                [sys.executable, str(FIXTURE), "hang", str(marker)],
                env=os.environ.copy(), log_path=log, timeout=3, emit=print,
            )
            assert marker.exists(), "hang fixture did not start its child"
            pid = int(marker.read_text())
            child_pids.append(pid)
            assert rc == 124
            deadline = time.monotonic() + 10
            while alive(pid) and time.monotonic() < deadline:
                time.sleep(0.1)
            assert not alive(pid), f"timeout leaked owned child {pid}"
        print(f"PASS ORE-01/02/03: argv, complete failure log, timeout tree cleanup ({TRIALS}/{TRIALS})")
    finally:
        # Only PIDs created by this fixture can enter this list.
        for pid in child_pids:
            if alive(pid):
                if os.name == "nt":
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, timeout=30)
                else:
                    os.kill(pid, 9)


def check_shells():
    source = str(Path(__file__).resolve())
    bash = m.find_bash()
    shells = [("Git Bash" if m.IS_WINDOWS else "Bash", [
        bash, "--noprofile", "--norc", "-c", '"$PYTHON3" "$1" --probe-tools', "entry-probe", source,
    ])]
    if m.IS_WINDOWS:
        # cmd.exe parses its /c tail itself. Passing that tail through Python's
        # MSVCRT argv quoting would insert literal backslashes before its quotes.
        cmd = subprocess.list2cmdline([os.environ.get("COMSPEC", "cmd.exe")])
        shells.append(("CMD", f'{cmd} /d /s /c ""{sys.executable}" "{source}" --probe-tools"'))
        for executable in ("powershell.exe", "pwsh.exe"):
            resolved = shutil.which(executable)
            if resolved:
                quoted = lambda value: "'" + value.replace("'", "''") + "'"
                shells.append((executable, [resolved, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                    f"& {quoted(sys.executable)} {quoted(source)} --probe-tools; exit $LASTEXITCODE"]))
    elif shutil.which("zsh"):
        shells.append(("zsh", [shutil.which("zsh"), "-f", "-c",
                       f"{shlex.quote(sys.executable)} {shlex.quote(source)} --probe-tools"]))
    for name, command in shells:
        # Keep the outer native environment, including System32's WSL bash. The
        # imported orchestrator must resolve Git Bash itself in every shell.
        env = dict(os.environ, PYTHON3=sys.executable)
        for trial in range(TRIALS):
            proc = subprocess.run(command, cwd=REPO, env=env, capture_output=True,
                                  text=True, encoding="utf-8", errors="replace", timeout=45)
            (LOGS / f"shell-{name.replace(' ', '-')}-{trial}.log").write_text(
                proc.stdout + proc.stderr, encoding="utf-8",
            )
            assert proc.returncode == 0 and "ORE_TOOLS_OK" in proc.stdout, (name, proc.returncode, proc.stdout, proc.stderr)
        print(f"PASS ORE-04: {name} real pre-flight ({TRIALS}/{TRIALS})")


def check_result_persistence(scratch):
    fixture = REPO / "test/autotest/fixtures/orchestrator-entry/main-failure.py"
    scripts = [f"test/autotest/run-fixture-{i}-autotest.sh" for i in range(3)]
    for scenario, phase, statuses, calls, unrun in (
        ("postrun", "postrun-cleanup", ["PASS", "FAIL", "ERROR"], 2, scripts[2:]),
        ("prerun", "prerun-cleanup", ["PASS", "ERROR"], 1, scripts[1:]),
        ("runner", "runner", ["PASS", "ERROR"], 2, scripts[2:]),
    ):
        root = scratch / scenario
        root.mkdir()
        proc = subprocess.run(
            [sys.executable, str(fixture), scenario, str(root)],
            cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )
        (LOGS / f"persistence-{scenario}.log").write_text(proc.stdout + proc.stderr, encoding="utf-8")
        assert proc.returncode == 1, (scenario, proc.returncode, proc.stdout, proc.stderr)
        path = next(root.glob("test/full-regression-results/*/summary.json"))
        summary = json.loads(path.read_text(encoding="utf-8"))
        assert summary["errored"] == 1 and summary["status"] == "ERROR", summary
        assert summary["execution_error"]["phase"] == phase, summary
        assert summary["execution_error"]["script"] == scripts[1], summary
        assert summary["stages"][-1]["status"] == "ERROR", summary
        assert summary["unrun"] == len(unrun) and summary["unrun_scripts"] == unrun, summary
        assert [r["status"] for r in summary["results"]] == statuses, summary
        assert "FULL REGRESSION SUMMARY" not in proc.stdout, proc.stdout
        assert "ABORTED REGRESSION SUMMARY" in proc.stdout, proc.stdout
        counts = json.loads((root / "calls.json").read_text(encoding="utf-8"))
        assert counts["runner_calls"] == calls, counts
        assert all(not Path(d).exists() for d in counts["user_data_dirs"]), counts
    print("PASS ORE-05: aborted main() subprocess persists results and unrun context (3/3)")


with tempfile.TemporaryDirectory(prefix="ow-entry-e2e-") as scratch:
    check_commands(Path(scratch))
    check_shells()
    check_result_persistence(Path(scratch))
print("ORE: ALL PASS")
