<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Design Decisions and Technology Choices

## Technology Stack Summary

| Layer | Technology | Purpose |
|------|------------|---------|
| Desktop runtime | Electron | Cross-platform desktop shell |
| UI framework | React | Component-based renderer UI |
| Language | TypeScript | Type safety and maintainability |
| Terminal frontend | xterm.js | Terminal rendering and interaction |
| PTY backend | node-pty | Real shell integration |
| Build tooling | electron-vite | Modern build pipeline for main, preload, and renderer |
| Packaging | electron-builder | Distribution artifacts for desktop platforms |

## Why Electron

Electron was selected because this project depends on:

- Mature desktop packaging
- Strong support for complex web-based developer tools
- Production-ready integration with xterm.js and node-pty
- Established debugging and build tooling

Alternatives such as Tauri or native UI frameworks may reduce package size, but they would raise migration cost and reduce alignment with the existing architecture.

## Why React + TypeScript

React and TypeScript were selected because the renderer contains multiple interacting workflows:

- Terminal management
- Git views
- Project editing
- Prompt workflows
- Settings and state synchronization

The combination provides:

- A predictable component model
- Good tooling and ecosystem support
- Strong type checking around Electron APIs and UI state
- Low friction for larger refactors

## Why xterm.js

xterm.js is the terminal frontend because it is the most established web terminal in the Electron ecosystem.

Reasons:

- Production use in major developer tools
- Support for fit, search, link detection, and WebGL acceleration
- Good Unicode and terminal behavior support
- Active maintenance

## Why node-pty

`node-pty` provides the real shell boundary for the application.

Reasons:

- Mature PTY support across macOS, Linux, and Windows
- Widely used in editor and terminal tooling
- Better fit for shell semantics than plain child process APIs

Tradeoff:

- Native module rebuilds are required per Electron runtime

## Why electron-vite

`electron-vite` was chosen to keep the build setup modern and manageable.

Benefits:

- Separate build targets for main, preload, and renderer
- Fast iteration for renderer development
- A smaller and simpler configuration surface than many webpack-based alternatives

## Security Decisions

### Context Isolation

The renderer does not receive unrestricted Node.js access.

Design choices:

- `nodeIntegration: false`
- `contextIsolation: true`
- Desktop capabilities exposed through the preload bridge only

This keeps the renderer focused on presentation logic while the main process retains native privileges.

### Narrow API Surface

The preload layer exposes purpose-built methods instead of generic IPC pipes. This keeps the interface:

- Easier to reason about
- Easier to type
- Easier to review for security regressions

### `sandbox: false`

The project keeps `sandbox: false` in the window configuration because the runtime still depends on native modules and PTY-related integration that would otherwise complicate the desktop boundary. The safety model therefore depends on strict separation between the renderer and main process rather than full Chromium sandboxing.

## Performance Decisions

### WebGL Terminal Rendering

WebGL is used when available for better terminal rendering performance under heavy output.

Benefits:

- Lower CPU usage during high-volume terminal updates
- Better scrolling performance
- Better fit for multi-terminal layouts

Fallback behavior remains available when WebGL is not usable.

### Renderer / Main Process Split

Terminal processes, Git inspection, storage, and file system operations remain in the main process. This avoids pushing native or high-I/O work into the renderer and keeps the UI boundary clearer.

### Caching and Polling Discipline

The codebase already contains targeted runtime caching and request de-duplication for Git and terminal metadata. This reflects a broader design rule:

- Prefer bounded polling
- Avoid overlapping background work
- Add instrumentation when diagnosing hot paths

## Product-Level Design Decisions

### Terminal-First Model

The terminal is the primary interaction surface. Other features, such as Git views and the project editor, are designed to be entered from the terminal context instead of replacing it.

### Workspace Context Preservation

The product intentionally keeps related tasks close together:

- Shell sessions
- Git state
- Prompt history
- Project editing state

This reduces context switching for developer workflows.

### Cross-Platform Consistency

The project targets macOS, Linux, and Windows. Design choices for scripts, packaging, shortcuts, and terminal behavior should therefore account for all three platforms instead of assuming one operating system.

## Tradeoffs Accepted

The current architecture intentionally accepts:

- Larger binary size than native desktop alternatives
- Native dependency rebuild complexity
- A broader maintenance surface than a terminal-only application

These tradeoffs are considered acceptable because they support a richer integrated developer workflow.

## Future Direction

Areas that still deserve continued design work:

- Stronger CI and repository automation
- Release workflow hardening for public distribution
- Further modularization of large renderer components
- More explicit third-party license tracking and compliance automation
