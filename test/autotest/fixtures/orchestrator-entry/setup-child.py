# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
"""Real subprocess fixture for setup exit, log and process-tree contracts."""
import json
import subprocess
import sys
import time
from pathlib import Path

mode = sys.argv[1]
if mode == "success":
    print(json.dumps({"argument": sys.argv[2], "status": "ready"}), flush=True)
elif mode == "failure":
    print("deliberate setup failure", file=sys.stderr, flush=True)
    sys.exit(7)
elif mode == "child":
    time.sleep(60)
elif mode == "hang":
    child = subprocess.Popen([sys.executable, __file__, "child"])
    Path(sys.argv[2]).write_text(str(child.pid), encoding="ascii")
    print("owned child started", flush=True)
    time.sleep(60)
else:
    raise ValueError(mode)
