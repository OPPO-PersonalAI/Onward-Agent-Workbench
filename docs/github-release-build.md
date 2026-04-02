<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GitHub Daily Build

## Current Flow

The repository now includes a GitHub Actions workflow at `.github/workflows/release.yml`.

When a tag matching the release convention is pushed, GitHub Actions will:

1. Start a macOS build matrix:
   - `macos-latest` for Apple Silicon (`arm64`)
   - `macos-13` for Intel (`x64`)
2. Inject the pushed tag into `scripts/dist-release.js` through `ONWARD_TAG`
3. Build a production package
4. Upload the packaged `.dmg` and `.zip` files as workflow artifacts
5. Collect those artifacts in a publish job
6. Create or update a prerelease GitHub Release for the same tag

## Tag Convention

Supported release tags:

- `v2026.04.02`
- `v2026.04.02.2`

Release behavior:

- The app window title displays the raw tag, for example `Onward 2 v2026.04.02`
- The packaged app version is normalized to Electron-compatible semver, for example `2026.4.2`
- Release artifacts keep the original tag in the filename, for example `Onward 2-v2026.04.02-arm64.dmg`

## Local Verification

Run a local production-style build with a tag:

```bash
rm -rf out release && ONWARD_TAG=v2026.04.02 pnpm dist:release
```

Typical macOS output paths:

- `release/mac-arm64/Onward 2.app`
- `release/Onward 2-v2026.04.02-arm64.dmg`
- `release/Onward 2-v2026.04.02-arm64.zip`

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
- Production build path using `dist:release`

### Still required on the GitHub side

The repository or organization must allow GitHub Actions to run.

No extra personal access token is required for the current unsigned draft-release flow because the workflow explicitly requests `contents: write` and uses the built-in `GITHUB_TOKEN`.

If the organization overrides `GITHUB_TOKEN` permissions globally, make sure workflow jobs are allowed to write repository contents and releases.

## What Is Not Configured Yet

The current workflow publishes an unsigned macOS prerelease and does not sign or notarize packages.

For a real public macOS release later, add Apple signing and notarization secrets such as:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
