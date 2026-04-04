<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onward

Onward runs an AI engineering team from your laptop

Given a task, you can use Onward to
1. split your intent into multiple prompts,
2. send them to multiple agent terminals,
3. Agents execute in parallel
where prompts are orchestrated and you can track git diff/logs to monitor your agent team. 


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
