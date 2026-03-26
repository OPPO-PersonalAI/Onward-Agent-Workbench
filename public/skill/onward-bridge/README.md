<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# onward-bridge

`onward-bridge` is a CLI utility for cross-task terminal interaction inside Onward 2.

## Overview

The tool allows a coding agent running in one task terminal to discover, inspect, and control other task terminals in the same active tab. It communicates with the Onward 2 local API server and reads terminal content from the xterm.js buffer exposed by the application.

## Prerequisites

- Onward 2 is running
- The current terminal was created by Onward 2
- The Onward runtime injected `ONWARD_API_PORT` or `ONWARD_USER_DATA`

## Commands

### Health Check

```bash
node tools/onward-bridge/index.js health
```

Returns the status of the local Onward API server.

### List Tasks

```bash
node tools/onward-bridge/index.js tasks
```

Lists all task terminals in the active tab.

### Read Terminal Output

```bash
# Read the latest 200 lines by default
node tools/onward-bridge/index.js read <task>

# Read a fixed number of lines
node tools/onward-bridge/index.js read <task> --lines 500

# Read by character count
node tools/onward-bridge/index.js read <task> --chars 500
node tools/onward-bridge/index.js read <task> --chars 2000

# Read the full buffer
node tools/onward-bridge/index.js read <task> --all

# Select the target buffer explicitly
node tools/onward-bridge/index.js read <task> --buffer active
node tools/onward-bridge/index.js read <task> --buffer normal
node tools/onward-bridge/index.js read <task> --buffer alternate
```

`<task>` may be:

- A numeric task index such as `1`, `2`, or `3`
- A full terminal identifier such as `terminal-1`

### Execute a Command

```bash
# Send text and press Enter
node tools/onward-bridge/index.js exec <task> "ls -la"
node tools/onward-bridge/index.js exec <task> "npm test"

# Clear nested environment variables before execution
node tools/onward-bridge/index.js exec <task> "claude" --clean-env
node tools/onward-bridge/index.js exec <task> "claude" -E
```

### Send Text Without Enter

```bash
node tools/onward-bridge/index.js send <task> "some text"
```

### Send Special Keys

```bash
# Send a single key
node tools/onward-bridge/index.js key <task> enter
node tools/onward-bridge/index.js key <task> escape
node tools/onward-bridge/index.js key <task> tab

# Send multiple keys in sequence
node tools/onward-bridge/index.js key <task> down down enter
node tools/onward-bridge/index.js key <task> shift+tab

# Send Ctrl combinations
node tools/onward-bridge/index.js key <task> ctrl+c
```

Supported keys include:

`enter`, `tab`, `escape`, `esc`, `space`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `shift+tab`, `ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+l`, `ctrl+a`, `ctrl+e`, `ctrl+u`, `ctrl+k`, `ctrl+w`, `ctrl+r`, `ctrl+o`, `ctrl+b`, and `f1` through `f12`.

## Output Format

All commands return JSON for machine-readable integration.

Successful `read` response:

```json
{
  "success": true,
  "terminalId": "terminal-1",
  "content": "...",
  "totalLines": 150,
  "returnedLines": 150,
  "truncated": false,
  "bufferType": "normal"
}
```

`bufferType` indicates the currently active buffer:

- `"normal"`: regular shell screen
- `"alternate"`: an alternate screen used by TUI programs such as `vim`, `less`, or `htop`

Error example:

```json
{
  "error": "terminal terminal-99 does not exist"
}
```

## Environment Variables

| Variable | Purpose |
|---------|---------|
| `ONWARD_API_PORT` | API server port injected by Onward 2 |
| `ONWARD_USER_DATA` | User-data directory used as a fallback for lock-file discovery |

## Architecture

```text
onward-bridge (CLI)
    ↓ HTTP (127.0.0.1)
Onward Main Process (API Server)
    ↓ IPC
Renderer (React / xterm.js)
```

Read path:

```text
API Server → IPC → Renderer → xterm.js buffer → IPC → API Server → CLI
```

Write path:

```text
API Server → Prompt Bridge IPC → Renderer
  → existing prompt send logic
  → Prompt Bridge response
  → API Server → CLI
```

All communication remains local to the machine.
