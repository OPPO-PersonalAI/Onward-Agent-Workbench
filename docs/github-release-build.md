<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GitHub Daily Build

## Current Flow

The repository now includes a GitHub Actions workflow at `.github/workflows/release.yml`.

When a tag matching the release convention is pushed, GitHub Actions will:

1. Start a macOS build matrix:
   - `macos-latest` for Apple Silicon (`arm64`)
   - `macos-15-intel` for Intel (`x64`)
2. Inject the pushed tag into `scripts/dist-release.js` through `ONWARD_TAG`
3. Inject the operating system label through `ONWARD_RELEASE_OS`
4. Build a production package
5. Upload the packaged `.dmg` and `.zip` files as workflow artifacts
6. Collect those artifacts in a publish job
7. Create or update a prerelease GitHub Release for the same tag
8. Generate update manifests and publish them to the `gh-pages` branch under `updates/`

## Tag Convention

Supported release tags:

- `v2.1.0`
- `v2.1.0-daily.20260402.1`
- `v2026.04.02`
- `v2026.04.02.2`

Release behavior:

- Daily build titles display the date only, for example `Onward 2 v2026.04.02`
- Stable build titles continue to display the full stable tag
- The packaged app version is normalized to Electron-compatible semver
- Release artifacts include the operating system name and arch, for example `Onward 2-v2.1.0-daily.20260402.1-macos-arm64.dmg`
- CI also publishes `channel / os / arch` update manifests for the in-app updater

## Local Verification

Run a local production-style build with a tag:

```bash
rm -rf out release && ONWARD_TAG=v2.1.0-daily.20260402.1 ONWARD_RELEASE_OS=macos pnpm dist:release
```

Typical macOS output paths:

- `release/mac-arm64/Onward 2.app`
- `release/Onward 2-v2.1.0-daily.20260402.1-macos-arm64.dmg`
- `release/Onward 2-v2.1.0-daily.20260402.1-macos-arm64.zip`

Launch the packaged app directly:

```bash
open "release/mac-arm64/Onward 2.app"
```

## GitHub Configuration

### Already encoded in the repository

The following is already handled by the committed workflow file:

- Tag push triggers
- macOS matrix build
- `GITHUB_TOKEN`-based prerelease upload
- Release artifact aggregation
- Update manifest generation and `gh-pages` publication
- Production build path using `dist:release`
- Explicit operating system naming for release artifacts
- Node 24 runtime opt-in for GitHub-hosted JavaScript actions

### Still required on the GitHub side

The repository or organization must allow GitHub Actions to run.

No extra personal access token is required for the current unsigned draft-release flow because the workflow explicitly requests `contents: write` and uses the built-in `GITHUB_TOKEN`.

If the organization overrides `GITHUB_TOKEN` permissions globally, make sure workflow jobs are allowed to write repository contents and releases.

The build script itself does not consume GitHub tokens.

Current token usage boundaries:

- `GITHUB_TOKEN` is passed only to the dependency installation step that needs GitHub API access for `@vscode/ripgrep`
- `GITHUB_TOKEN` is passed only to the publish step that creates the prerelease
- The package build step receives only `ONWARD_TAG` and `ONWARD_RELEASE_OS`
- `scripts/dist-release.js` aborts if `GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_API_TOKEN` are injected into the package build step

## Update Manifest Layout

The updater reads static JSON manifests by channel, operating system, and architecture.

Current layout:

- `updates/daily/macos/arm64/latest.json`
- `updates/daily/macos/x64/latest.json`

Reserved layouts for future expansion:

- `updates/daily/windows/x64/latest.json`
- `updates/daily/linux/x64/latest.json`
- `updates/stable/<os>/<arch>/latest.json`

## What Is Not Configured Yet

The current workflow publishes an unsigned macOS prerelease and does not sign or notarize packages.

For a real public macOS release later, add Apple signing and notarization secrets such as:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
