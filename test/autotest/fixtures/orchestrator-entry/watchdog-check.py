# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
"""Controlled runner check for PowerShell exit-code propagation tests."""
import os
from pathlib import Path
import sys

name = Path(__file__).name
print(f"CHECK {name}")
print("Expected fixture diagnostic on stderr", file=sys.stderr)
sys.exit(7 if os.environ.get("ONWARD_FIXTURE_FAIL_CHECK") == name else 0)
