<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Auto Update Architecture

## Overview

Onward uses a custom updater path for macOS Daily builds.

This is intentionally different from Electron's official `autoUpdater` path because the current product plan does not include macOS code signing. The official Electron update flow for macOS depends on signed builds, so this repository uses a repository-hosted manifest plus a local installer helper instead.

## Current Scope

Current implementation:

- Supports `Daily` builds only
- Supports `macOS` only
- Checks for updates at startup
- Checks again every 1 hour
- Downloads updates in the background
- Uses a 1 hour download timeout for update archives
- Shows a persistent title-bar banner after the update is downloaded
- Lets the user restart to apply the update

Reserved for later:

- Stable channel switching
- Windows updater implementation
- Linux updater implementation
- Signed macOS update path

## Version and Channel Rules

Daily tags use semver plus a date-stamped prerelease suffix:

- `v2.1.0-daily.20260402.1`

Stable tags will later use plain semver:

- `v2.1.0`

The packaged app keeps the raw tag for display, and stores the normalized version in package metadata so the updater can compare versions reliably.

## Update Source Layout

Binary packages are published to GitHub Releases.

Static update manifests are published to the `gh-pages` branch under:

- `updates/daily/macos/arm64/latest.json`
- `updates/daily/macos/x64/latest.json`

Each manifest includes:

- `channel`
- `version`
- `tag`
- `platform`
- `arch`
- `artifactName`
- `artifactUrl`
- `sha256`
- `releaseNotes`
- `publishedAt`

The application reads the base URL from:

1. `ONWARD_UPDATE_BASE_URL` when set
2. `package.json > onward.updateManifestBaseUrl`
3. The repository fallback `https://raw.githubusercontent.com/<owner>/<repo>/gh-pages/updates`

## Download Failure Behavior

Current download behavior is intentionally conservative:

- Manifest requests use a 60 second timeout
- Update archive downloads use a 1 hour timeout
- The updater does not currently support resumable downloads
- If a download is interrupted and leaves a partial file behind, the next verification pass will fail checksum validation
- A checksum failure deletes the broken archive and the next check starts a fresh full download
- After a newer version downloads successfully, older cached version directories are removed

This means the current implementation prioritizes correctness and simple recovery over bandwidth efficiency.

## Runtime Flow

1. Main process starts `UpdateService`
2. Service resolves current `channel / os / arch`
3. Service fetches the matching `latest.json`
4. Service compares `manifest.version` with the packaged app version
5. If newer, the `.zip` archive is downloaded to `~/Library/Application Support/Onward 2/updates/<version>/`
6. The SHA-256 checksum is verified
7. Renderer receives updater status over IPC
8. Title bar shows a persistent update banner
9. User clicks `Restart app`
10. A detached shell helper replaces the `.app` bundle after the main process exits and relaunches the app

## UI Behavior

Current update UX:

- The title bar shows a persistent banner after download completes
- The banner contains:
  - an update message
  - a `Restart app` button
  - a close button
- Closing the banner hides the current notice only
- The downloaded archive stays on disk until the user explicitly chooses to restart and install

Settings behavior:

- The current channel and updater status are shown
- Channel switching UI is visible but disabled
- Stable and cross-platform controls are marked as placeholders

## Debugging and Local Verification

The application exposes local updater debug routes only when `ONWARD_DEBUG=1`.

Available routes:

- `GET /api/debug/updater/status`
- `POST /api/debug/updater/check`
- `POST /api/debug/updater/restart`

Example local flow:

1. Build an older production package
2. Build a newer production package
3. Generate a local manifest that points to the newer `.zip`
4. Serve the manifest directory with a local HTTP server
5. Launch the older package with:

```bash
ONWARD_DEBUG=1 ONWARD_UPDATE_BASE_URL=http://127.0.0.1:8765/updates \
  "release/mac-arm64/Onward 2.app/Contents/MacOS/Onward 2"
```

6. Query updater status:

```bash
curl http://127.0.0.1:<port>/api/debug/updater/status
```

7. Trigger an immediate install-and-restart flow:

```bash
curl -X POST http://127.0.0.1:<port>/api/debug/updater/restart
```

## Constraints

Current known limits:

- The updater is not based on Electron's official signed macOS update path
- The updater does not yet support HTTP range resume / breakpoint continuation
- Replacing an app bundle inside a protected system directory may fail without sufficient permissions
- The helper currently expects the update archive to extract to a top-level `.app`
- Windows and Linux are reserved but not implemented yet

## Future Direction

Recommended next steps:

1. Add Stable manifests and a Stable release workflow
2. Persist downloaded update state across crashes
3. Add automated integration tests for manifest parsing and download verification
4. Add platform-specific installer helpers for Windows and Linux
