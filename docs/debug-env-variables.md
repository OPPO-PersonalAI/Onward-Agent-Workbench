<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Debug Environment Variables

Onward uses `ONWARD_*` environment variables as feature-level debug switches. Each variable controls a single, isolated behavior — enabling verbose logging, simulating a specific state, or disabling a subsystem. This design keeps debug logic out of UI menus and build flags, and makes it trivially reproducible across machines.

## Design Principles

1. **One variable, one concern.** Each env var toggles exactly one debug behavior. Never overload a single variable to control multiple unrelated features.
2. **Prefix `ONWARD_`.** All debug variables share the `ONWARD_` namespace so they are easy to discover and unlikely to collide with system env vars.
3. **Value convention.** Use `1` to enable, absence or any other value to disable. Example: `ONWARD_DEBUG=1`.
4. **Read at startup.** Variables are read once from `process.env` during main-process initialization. They are not watched for changes at runtime.
5. **No side effects when absent.** The application must behave identically to a normal build when no debug variables are set.
6. **Log when active.** When a debug variable takes effect, log a message to the console so the developer knows it is active. Example: `[Telemetry] Consent reset for debugging (ONWARD_TELEMETRY_RESET_CONSENT=1)`.

## How to Launch with Environment Variables

### macOS / Linux

Set the variable before the `open` command (packaged build):

```bash
ONWARD_TELEMETRY_RESET_CONSENT=1 open "release/mac-arm64/Onward 2-<branch>.app"
```

Multiple variables:

```bash
ONWARD_DEBUG=1 ONWARD_TELEMETRY_RESET_CONSENT=1 open "release/mac-arm64/Onward 2-<branch>.app"
```

Development mode (electron-vite):

```bash
ONWARD_DEBUG=1 pnpm dev
```

### Windows (PowerShell)

```powershell
$env:ONWARD_TELEMETRY_RESET_CONSENT = "1"
& "release\win-unpacked\Onward 2.exe"
```

### Windows (cmd)

```cmd
set ONWARD_TELEMETRY_RESET_CONSENT=1
"release\win-unpacked\Onward 2.exe"
```

## Variable Reference

| Variable | Value | Effect |
|----------|-------|--------|
| `ONWARD_DEBUG` | `1` | Enable verbose console logging in main process, IPC, and git-watch |
| `ONWARD_DEBUG_CAPTURE` | `1` | Auto-capture renderer screenshots to temp dir after load |
| `ONWARD_DISABLE_GPU` | `1` | Disable hardware acceleration and GPU compositing |
| `ONWARD_USER_DATA_DIR` | path | Override the userData directory (settings, state, telemetry) |
| `ONWARD_BUILD` | `dev` / `prod` | Override build channel detection |
| `ONWARD_BRANCH` | string | Override branch name in app identity |
| `ONWARD_TAG` | string | Override release tag in app identity |
| `ONWARD_TELEMETRY_CONNECTION_STRING` | connection string | Override the Application Insights connection string |
| `ONWARD_TELEMETRY_DISABLED` | `1` | Completely disable telemetry at build level (SDK never loaded) |
| `ONWARD_TELEMETRY_RESET_CONSENT` | `1` | Reset telemetry consent on launch (autotest: set to true; manual: set to null for consent dialog) |
| `ONWARD_TELEMETRY_FAST_HEARTBEAT` | `1` | Reduce heartbeat interval from 5 minutes to 5 seconds for telemetry testing |
| `ONWARD_TELEMETRY_FORCE_UPLOAD` | `1` | Force daily summary upload on the next heartbeat cycle (skip 24h wait) |
| `ONWARD_DIST_DEV_OPEN` | `0` / `1` / unset | Controls whether `pnpm dist:dev` opens the packaged app after a successful build: **unset** = open on local machines (skipped when `CI` is truthy); **`1`** = always open (including in CI); **`0`** = never open. |

## Adding a New Debug Variable

When implementing a new debug switch:

1. **Define the constant** in the relevant module file (e.g., `telemetry-constants.ts`, or inline in `index.ts`):
   ```typescript
   export const MY_DEBUG_FLAG = process.env.ONWARD_MY_FEATURE === '1'
   ```
2. **Use it** at the point of effect with a guarded block and a console log:
   ```typescript
   if (MY_DEBUG_FLAG) {
     console.log('[MyFeature] Debug mode active (ONWARD_MY_FEATURE=1)')
     // debug-only logic
   }
   ```
3. **Document it** by adding a row to the table above.
4. **Never ship user-facing behavior** behind a debug variable — these are developer-only switches.
