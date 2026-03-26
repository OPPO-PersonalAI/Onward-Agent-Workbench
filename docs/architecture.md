<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Terminal Application Architecture

## Overview

This document describes the high-level architecture of Onward 2, an Electron-based terminal workspace inspired by the integrated terminal model used in modern developer tools such as Visual Studio Code.

## System Layout

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                               Electron App                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                     Renderer Process (React)                            │ │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────────────┐ │ │
│  │  │   Terminal UI    │  │ Project / Git UI │  │  State + Theme Layer  │ │ │
│  │  └────────┬─────────┘  └────────┬─────────┘  └──────────┬────────────┘ │ │
│  │           └─────────────────────┴───────────────────────┘              │ │
│  │                           window.electronAPI                           │ │
│  └──────────────────────────────────┬──────────────────────────────────────┘ │
│                                     │                                        │
│                           contextBridge + IPC                                │
│                                     │                                        │
│  ┌──────────────────────────────────▼──────────────────────────────────────┐ │
│  │                         Preload Process                                  │ │
│  │        Type-safe bridge exposed to the untrusted renderer                │ │
│  └──────────────────────────────────┬──────────────────────────────────────┘ │
│                                     │                                        │
│  ┌──────────────────────────────────▼──────────────────────────────────────┐ │
│  │                           Main Process                                   │ │
│  │  ┌────────────────┐  ┌────────────────┐  ┌──────────────────────────┐  │ │
│  │  │ IPC Handlers   │  │ PtyManager     │  │ App / Tray / API Server │  │ │
│  │  └────────┬───────┘  └────────┬───────┘  └────────────┬─────────────┘  │ │
│  │           └───────────────────┴───────────────────────┘                │ │
│  └──────────────────────────────────┬──────────────────────────────────────┘ │
│                                     │                                        │
│                          node-pty managed shell sessions                     │
└─────────────────────────────────────┼────────────────────────────────────────┘
                                      │
                           zsh / bash / PowerShell / cmd
```

## Main Architectural Layers

### Main Process

The main process owns the native integration boundary:

- Window creation and lifecycle management
- Tray integration and quit flow
- PTY creation and disposal through `node-pty`
- File system, Git, and project-level operations
- Local API server and application identity management

Key modules include:

- `electron/main/index.ts`
- `electron/main/ipc-handlers.ts`
- `electron/main/pty-manager.ts`
- `electron/main/git-utils.ts`
- `electron/main/project-editor-utils.ts`

### Preload Layer

The preload layer exposes a constrained and typed bridge to the renderer:

- Wraps IPC calls in focused APIs
- Prevents direct Node.js access in the renderer
- Preserves a narrow, auditable surface area for desktop capabilities

Primary entry point:

- `electron/preload/index.ts`

### Renderer Process

The renderer is a React application responsible for user-facing workflows:

- Terminal grids and tab management
- Git Diff and Git History UIs
- Prompt notebook and scheduling
- Project editor and SQLite viewer
- Settings, theme, and interaction state

Primary entry points:

- `src/main.tsx`
- `src/App.tsx`

## Data Flow

### Terminal Input Path

```text
User input
  → xterm.js
  → renderer callback
  → window.electronAPI.terminal.write(...)
  → IPC
  → main process
  → PtyManager.write(...)
  → node-pty
  → shell
```

### Terminal Output Path

```text
Shell output
  → node-pty
  → PtyManager data event
  → IPC
  → preload bridge
  → renderer subscription
  → xterm.js write(...)
  → visible terminal output
```

### Resize Path

```text
Window resize
  → ResizeObserver / layout change
  → xterm fit addon
  → renderer requests terminal.resize(...)
  → IPC
  → PtyManager.resize(...)
  → shell receives size update
```

## Isolation Model

The security model is based on process separation:

- The renderer is treated as untrusted
- Node.js APIs are not exposed directly to the renderer
- The preload layer provides a limited `window.electronAPI`
- Native process creation, file access, and OS integration remain in the main process

This keeps terminal capabilities available without collapsing the security boundary between web UI code and desktop privileges.

## IPC Design

Representative terminal channels include:

| Channel | Direction | Purpose |
|--------|-----------|---------|
| `terminal:create` | Renderer → Main | Create a PTY session |
| `terminal:write` | Renderer → Main | Send input to a PTY |
| `terminal:resize` | Renderer → Main | Resize a PTY |
| `terminal:dispose` | Renderer → Main | Dispose a PTY |
| `terminal:data` | Main → Renderer | Stream PTY output |
| `terminal:exit` | Main → Renderer | Report PTY termination |

Other IPC groups cover:

- Git inspection and polling
- Prompt storage and scheduling
- Project editor file operations
- Application settings and shortcuts
- Claude Code integration

## State Ownership

### Main Process State

The main process owns native and durable runtime state:

- PTY process map
- App identity and packaged runtime information
- Persistent JSON-based storage under `userData`
- Local API server state and port lock file

### Renderer State

The renderer owns interactive UI state:

- Tabs and terminal focus
- Prompt editing state
- Project editor view state
- Dialog and panel visibility
- Theme and settings state

Persistent UI state is synchronized through Electron APIs instead of accessing the file system directly from the renderer.

## Lifecycle

### Application Startup

1. Electron starts the main process
2. App identity and storage paths are initialized
3. IPC handlers are registered
4. The main window is created
5. The preload script is attached
6. The renderer application is loaded
7. Initial tabs and terminal state are restored
8. PTY sessions are created on demand

### Terminal Lifecycle

1. A tab or terminal cell is created in the renderer
2. The renderer requests PTY creation through IPC
3. `PtyManager` starts the shell process
4. Input and output are streamed between xterm.js and the shell
5. On close, the renderer disposes the PTY and releases subscriptions

### Application Shutdown

1. A close or quit request is triggered
2. Window and tray handlers route through the unified quit flow
3. `PtyManager` shuts down active PTY sessions
4. IPC handlers are cleaned up
5. The application exits

## Design Priorities

The architecture prioritizes:

- Terminal responsiveness
- Safe desktop capability exposure
- Cross-platform behavior consistency
- Clear ownership between renderer and native layers
- Extensibility for Git, editor, and agent-oriented workflows

## Related Documents

- `docs/design-decisions.md`
- `docs/api-reference.md`
- `test/README.md`
