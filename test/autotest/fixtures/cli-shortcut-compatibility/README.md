<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# CLI shortcut transport contracts

This fixture uses **current official documentation**, reviewed on the date recorded
in `contracts.json`. It is not restricted to the CLI versions installed on the
machine running the tests. Tests are offline and never read user CLI settings,
credentials, clipboard contents, or conversation history.

## Run

```sh
node test/unittest/cli-shortcut-compatibility.test.mjs --report
node test/unittest/cli-shortcut-compatibility.test.mjs --strict --report
```

Both commands work in PowerShell, bash, and zsh. The default command is also
automatically discovered by `pnpm test:unit` and the existing unit-suite runner.
Reports are optional and written only under
`traces/test-logs/cli-shortcut-compatibility/`.

**A passing baseline is not full CLI compatibility.** Default mode accepts only
the individually documented `knownGap` failure codes on their specified
platforms. A different failure, a new failure, or a repaired-but-still-exempt case
fails the gate. Strict mode additionally fails every remaining known gap. Neither
mode certifies the explicitly listed `unverified` integration boundaries.

## Contract model

- `sources`, `context`, and `reviewedAt` identify the documented intent. A chord
  may have different meanings in a composer, menu, transcript, or Vim mode.
- `strokes` describes sequential physical keys. `entry` selects context-menu or
  native DOM paste instead. Simultaneous modifiers use `+` inside one stroke.
- `expect.hex` checks a stable legacy byte contract. `distinctFrom` checks that
  different actions do not collapse to the same bytes without requiring one
  arbitrary enhanced-protocol encoding. This is a minimum transport check, not
  proof that an application parser accepts every non-alias byte sequence.
- `hostShortcut` and `hostLeader` exercise explicit user-owned host bindings.
  These conditional conflicts are intentional ownership tests, not new defaults.
- `knownGap` specifies an exact failure signature and platform list. It is a
  reviewed diagnostic baseline, never a replacement for the desired `expect`.
- `clipboard.json` contains synthetic text and format metadata for pure tests.
  Its image entry is **not a bitmap fixture** and does not prove image decoding
  or attachment creation. Real image integration must use an on-disk binary
  fixture and actual CLI attachment acknowledgment.
- `clipboard.png` is an original generated 1x1 PNG, reproducible with
  `node test/autotest/create-cli-clipboard-fixture.mjs`. Packaged tests use it
  through an Electron clipboard writer held alive for X11 ownership. This proves
  native format classification and trigger transport, not CLI attachment creation.
- `repairs.json` selects explicit repaired profiles: `keyboardFlags=1` requires
  application negotiation; `macOptionIsMeta=true` requires a saved user preference.
  Exact enhanced bytes are pinned by `expect.sequence`. Historical contracts stay
  in `contracts.json`; CLI-KB-08 checks that unnegotiated encoding remains unchanged.
  A green strict repaired profile does not mean an arbitrary CLI negotiated it.

## Implementation boundary

The adapter executes the production window-shortcut function, real Prompt Leader
controller, renderer terminal-hook installation, context-menu paste callback,
session-manager paste method, and installed xterm keyboard/paste functions.
Native Electron objects, DOM mechanics, timers, and clipboard IO are mocked.
AST seams assert their shape and fail closed if the relevant source is refactored.
The installed dependency's MIT-licensed sources are loaded at runtime; no
third-party implementation is copied into this fixture.

Three-platform parameters verify the branches that are expressible in this unit
environment. They do **not** emulate native OS keymaps, Chromium keypress/IME
fallback, menu accelerators, ConPTY, WSL, SSH, or remote clipboard ownership.
Application attachment rendering and action semantics need independent E2E tests.
Existing neighboring suites are `run-window-shortcuts`,
`run-prompt-input-shortcuts`, and `run-prompt-integrity`.

## Packaged transport integration

`run-cli-shortcut-compatibility-autotest.sh` and its PowerShell twin launch an
isolated packaged development app over Playwright CDP. The shared on-disk
`prompt-input-shortcuts/raw-stdin.mjs` fixture runs under real Task PTYs. Its file
control channel emits protocol negotiation; its byte file is the input oracle.
Tests cover five-round stack/buffer isolation, trusted modified keys and repeats,
bracketed text through keyboard/context/native DOM entry points, real mixed-image
clipboard metadata and keyboard/context triggers, RIS recovery,
English/Chinese Option preference save/discard/restart, and diagnostic events.
Native DOM paste injection checks DOM wiring, not OS event synthesis. This runner
writes test text/images into the OS clipboard; it never reads pre-existing clipboard data.
Actual CLI attachment acknowledgments remain outside this transport suite.

The adapter supports enhancement bits 1/2/4, never 8/16 or modifyOtherKeys.
Text/IME, dead keys, explicit AltGr and native macOS Command remain platform-owned.
Pure protocol/clipboard transforms are covered by `terminal-input-adapter.test.mjs`;
runtime lifecycle checks include pending read cancellation, failure recovery and
idempotent disposal. CLI-KB-05 separately identifies the single diagnostic batch
timer and requires zero surviving Leader timers; advancing one reporting interval
must drain the diagnostic timer too. The renderer performs only bounded keyboard decisions;
clipboard format detection and text reads occur in the main process.

## Maintaining the baseline

1. Review the official documentation and update source/context metadata.
2. Add the intended semantic contract, not a snapshot that calls broken bytes
   correct. Run default mode and inspect any new failure.
3. Fix an unintended regression. A newly accepted limitation requires an
   explicit review of its exact failure signature and platform scope.
4. When repairing a known gap, remove its exception after the transport and
   real user-facing behavior are verified; the stale-baseline check enforces it.
5. Re-run strict mode to make the remaining incompatibilities visible.

No network request, CLI installation, model request, or system clipboard access
is necessary to run these unit tests.
