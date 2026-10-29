# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
"""Controlled main() dependencies: never launch an app or perform real cleanup."""
import contextlib
import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPTS = [f"test/autotest/run-fixture-{i}-autotest.sh" for i in range(3)]


def run_case(module, root, scenario):
    binary = root / "fake-app"
    binary.touch()
    cleanup_error = module._cleanup_module.CleanupError("controlled cleanup failure")
    cleanup = {
        "postrun": [None, None, None, cleanup_error],
        "prerun": [None, None, cleanup_error],
        "runner": [None, None, None],
        "last-postrun": [None, None, None, None, None, cleanup_error],
        "timeout": [None, cleanup_error],
        "retry-prerun": [None, cleanup_error],
        "retry-runner": [None, None],
        "success": [None] * 6,
    }[scenario]
    attempts = {
        "runner": [(0, 1.0), RuntimeError("controlled runner failure")],
        "timeout": [(124, 1.0)],
        "retry-prerun": [(1, 1.0)],
        "retry-runner": [(1, 1.0), RuntimeError("controlled retry failure")],
    }.get(scenario, [(0, 1.0), (1, 2.0), (0, 1.0)])
    argv = ["fixture", "--skip-env-check"]
    if not scenario.startswith("retry-"):
        argv.append("--no-flake-retry")
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.object(sys, "argv", argv))
        for name, value in {
            "REPO_ROOT": root,
            "PER_SCRIPT_TIMEOUT_OVERRIDES_SEC": {},
        }.items():
            stack.enter_context(patch.object(module, name, value))
        for name, value in {
            "select_scripts": (SCRIPTS, []), "find_bash": "fake-bash",
            "find_node": "fake-node", "detect_app_name": "fixture-app",
            "resolve_app_bin": binary, "validate_runner_tools": None,
            "sweep_crash_reports": [], "sweep_crash_dumps": [],
            "scan_hard_floor_tokens": [], "sweep_autotest_root_leftovers": None,
        }.items():
            stack.enter_context(patch.object(module, name, return_value=value))
        stack.enter_context(patch.object(module.time, "sleep"))
        kill = stack.enter_context(patch.object(module, "kill_app", side_effect=cleanup))
        run = stack.enter_context(patch.object(module, "run_one", side_effect=attempts))
        rc = module.main()
    return rc, {
        "cleanup_calls": kill.call_count, "runner_calls": run.call_count,
        "user_data_dirs": [call.kwargs["user_data_dir"] for call in run.call_args_list],
    }


if __name__ == "__main__":
    repo = Path(__file__).resolve().parents[4]
    spec = importlib.util.spec_from_file_location("fixture_orchestrator", repo / "test/autotest/run-full-regression.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    root = Path(sys.argv[2])
    rc, calls = run_case(module, root, sys.argv[1])
    (root / "calls.json").write_text(json.dumps(calls), encoding="utf-8")
    sys.exit(rc)
