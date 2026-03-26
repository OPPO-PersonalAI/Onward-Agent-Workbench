---
name: onward-bridge
description: >
  Cross-task terminal bridge for Onward 2. Use it when you need to inspect output
  from another task terminal, monitor another agent, execute commands in another
  task, or coordinate work across multiple task terminals.
allowed-tools: Bash, Read
---

<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onward Bridge

## Directory Layout

This skill is self-contained and lives entirely in one directory:

```text
onward-bridge/
├── SKILL.md   # Skill metadata and usage guide
├── index.js   # Zero-dependency CLI entry
└── README.md  # Developer-facing reference
```

Invocation model:

```bash
BRIDGE="$(dirname "$0")/index.js"
node <path-to-this-directory>/index.js <command> [args]
```

## What This Skill Does

You are running inside a task terminal created by Onward 2. A single Onward tab may contain multiple task terminals, but the default shell environment only gives you direct visibility into the current one.

`onward-bridge` lets you:

- List the task terminals in the active tab
- Read output from any task terminal
- Execute commands in another task terminal
- Send text without pressing Enter
- Send special keys to another task, including keys used by TUI applications

## Preconditions

This tool only works inside terminals created by Onward 2.

The CLI discovers the local API server through:

1. `ONWARD_API_PORT` when it is present
2. `ONWARD_USER_DATA` plus the `onward-api.lock` file as a fallback

You usually do not need to care about discovery details because Onward injects the required environment automatically.

Quick validation:

```bash
node <path-to-this-directory>/index.js health
```

If the tool returns `{"status":"ok", ...}`, the environment is ready.

## Command Reference

In the examples below, `onward-bridge` is shorthand for:

```bash
node <path-to-this-directory>/index.js
```

### `help`

```bash
onward-bridge help
```

Shows all available commands and options.

### `health`

```bash
onward-bridge health
```

Returns the current API server status.

### `tasks`

```bash
onward-bridge tasks
```

Lists all task terminals in the active tab.

### `read`

```bash
# Read the latest 100 lines
onward-bridge read <task>

# Read the latest N lines
onward-bridge read <task> --lines 500

# Read by character count
onward-bridge read <task> --chars 1000

# Read the entire buffer
onward-bridge read <task> --all

# Select a specific buffer
onward-bridge read <task> --buffer active
onward-bridge read <task> --buffer normal
onward-bridge read <task> --buffer alternate
```

### `exec`

```bash
# Send a command and press Enter
onward-bridge exec <task> "git status"

# Launch a tool after clearing nested environment variables
onward-bridge exec <task> "claude" --clean-env
onward-bridge exec <task> "claude" -E
```

### `send`

```bash
# Send text without pressing Enter
onward-bridge send <task> "draft text"
```

### `key`

```bash
# Send a single key
onward-bridge key <task> enter

# Send multiple keys
onward-bridge key <task> down down enter

# Send control sequences
onward-bridge key <task> ctrl+c
onward-bridge key <task> shift+tab
```

Supported identifiers include:

- `enter`
- `tab`
- `escape` / `esc`
- `space`
- `backspace`
- `delete`
- `up`, `down`, `left`, `right`
- `home`, `end`, `pageup`, `pagedown`
- `shift+tab`
- `ctrl+a`, `ctrl+b`, `ctrl+c`, `ctrl+d`, `ctrl+e`, `ctrl+k`, `ctrl+l`, `ctrl+o`, `ctrl+r`, `ctrl+u`, `ctrl+w`, `ctrl+z`
- `f1` through `f12`

## Task Identifiers

The `<task>` argument accepts:

- A numeric task index such as `1` or `2`
- A terminal identifier such as `terminal-abc-1`

## Return Format

All commands return JSON.

Typical successful response:

```json
{
  "success": true,
  "successIds": ["terminal-abc-1"],
  "failedIds": []
}
```

## Typical Workflows

### Inspect another task terminal

```bash
onward-bridge tasks
onward-bridge read 2 --lines 200
```

### Run a command in another task

```bash
onward-bridge exec 2 "npm test"
```

### Interact with a TUI

```bash
onward-bridge key 2 down down enter
onward-bridge key 2 ctrl+c
```

### Start Claude Code in another task

```bash
onward-bridge exec 2 "claude" -E
```

## Failure Cases

Typical error conditions include:

- Not running inside an Onward-managed terminal
- Onward 2 is not currently running
- The target task does not exist
- The API server port cannot be discovered

## Implementation Notes

- Communication is local-only
- Reads come from the renderer-side xterm.js buffer
- Writes reuse the existing prompt-dispatch path
- Raw-mode and split-write behavior are preserved through the existing renderer implementation

Use this skill when you need coordination across multiple task terminals without leaving the Onward 2 runtime.
