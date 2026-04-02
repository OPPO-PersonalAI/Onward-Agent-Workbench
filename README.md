<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onward 2

Onward 2 is a terminal-first desktop workspace for developers. It combines multi-terminal workflows, Git inspection, project editing, prompt management, and lightweight task automation in a single Electron application built with React, xterm.js, and node-pty.

## Overview

Onward 2 is designed for developers who want to stay in a terminal-centered workflow without losing access to project context. Instead of switching between a terminal emulator, a Git client, a file editor, a prompt notebook, and a scheduling tool, Onward 2 keeps those capabilities inside one desktop workspace.

The product is especially strong when your workflow revolves around multiple tasks running in parallel. Its core value is not just that it includes terminals, diffs, or prompts, but that it keeps those capabilities attached to the task that produced them. That makes common workflows easier to repeat, easier to inspect, and much less dependent on context switching.

Core capabilities include:

- Multi-terminal tabs and task-oriented grid layouts
- Batch prompt sending and execution tracking across tasks
- Task-scoped Git Diff, Git History, and project editing flows
- Built-in project editor and SQLite viewer
- Prompt notebook, scheduling, and execution history
- Task-to-task agent coordination through terminal bridge workflows
- Cross-platform packaging for macOS, Linux, and Windows

## Why Onward 2

- Terminal-first workflow: keep shell interaction at the center
- Context-rich development: inspect diffs, history, and files without leaving the workspace
- AI-friendly operation model: keep prompts, execution, inspection, and task-to-task control close together
- Cross-platform architecture: one desktop codebase across major operating systems

## Installation

Source build is currently the primary distribution model.

### Prerequisites

- Node.js 20 or later
- pnpm
- A supported desktop environment on macOS, Linux, or Windows

### Install dependencies

```bash
pnpm install
```

## Quick Start

### Development

```bash
pnpm dev
```

### Development package build

- macOS / Linux

```bash
rm -rf out release && pnpm dist:dev
```

- Windows (PowerShell)

```powershell
if (Test-Path out) { Remove-Item -Recurse -Force out }
if (Test-Path release) { Remove-Item -Recurse -Force release }
pnpm dist:dev
```

### Production package build

- macOS / Linux

```bash
rm -rf out release && pnpm dist
```

- Windows (PowerShell)

```powershell
if (Test-Path out) { Remove-Item -Recurse -Force out }
if (Test-Path release) { Remove-Item -Recurse -Force release }
pnpm dist
```

## Project Structure

- `src/`: renderer process UI and feature modules
- `electron/main/`: Electron main process and native integration
- `electron/preload/`: secure bridge APIs exposed to the renderer
- `test/`: automation scripts and quality validation documents
- `docs/`: architecture and design notes
- `resources/`: application icons and packaged resources

## Documentation

- Architecture: `docs/architecture.md`
- Auto update: `docs/auto-update.md`
- Build and release guide: `docs/build-and-release.md`
- Design decisions: `docs/design-decisions.md`
- API reference: `docs/api-reference.md`
- GitHub daily build: `docs/github-release-build.md`
- Daily build operations: `docs/daily-build-operations.md`
- Test guide: `test/README.md`

## Testing

The repository includes built-in automation entry points and debug-assisted validation flows. See `test/README.md` for the current suites and execution instructions.

## Acknowledgments

This project was developed with the assistance of [Claude Code](https://claude.ai) and [Codex](https://openai.com/codex) to optimize logic and documentation.

## License

This project is licensed under the Apache License 2.0. See `LICENSE` for details.
