<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Build And Release Guide

## Overview

This project now has two different packaging lanes:

1. Development package builds
2. Release package builds

They serve different goals and should not be mixed.

## 1. Development Package Build

Use this when developing or debugging locally.

Default command on macOS and Linux:

```bash
rm -rf out release && pnpm dist:dev
```

Behavior:

- Uses the development packaging path
- Injects the current Git branch into the app display name
- Keeps development builds clearly separated from release builds

Typical result:

- App title example: `Onward 2-feature-branch`

## 2. Release Package Build

Use this when preparing a release-style package.

Local command:

```bash
rm -rf out release && ONWARD_TAG=v2.1.0-daily.20260402.1 ONWARD_RELEASE_OS=macos pnpm dist:release
```

Behavior:

- Uses the production packaging path
- Reads the release tag from `ONWARD_TAG`
- Reads the release operating system from `ONWARD_RELEASE_OS` when provided
- Displays the raw tag in the app title
- Converts the tag date into an Electron-compatible version number

Examples:

- Tag: `v2.1.0-daily.20260402.1`
- App title: `Onward 2 v2.1.0-daily.20260402.1`
- App version: `2.1.0-daily.20260402.1`
- Artifact name example: `Onward 2-v2.1.0-daily.20260402.1-macos-arm64.dmg`

Supported tag formats:

- `vMAJOR.MINOR.PATCH`
- `vMAJOR.MINOR.PATCH-daily.YYYYMMDD.N`
- `vYYYY.MM.DD`
- `vYYYY.MM.DD.N`

Examples:

- `v2.1.0`
- `v2.1.0-daily.20260402.1`
- `v2026.04.02`
- `v2026.04.02.2`

Version mapping rules:

- `v2.1.0` -> `2.1.0`
- `v2.1.0-daily.20260402.1` -> `2.1.0-daily.20260402.1`
- `v2026.04.02` -> `2026.4.2`
- `v2026.04.02.2` -> `2026.4.2-2`

## 3. GitHub Actions Release Build

Workflow file:

- `.github/workflows/release.yml`

Current trigger:

- Push a tag matching `v[0-9]*`

Current build behavior:

1. Build on `macos-latest` for `arm64`
2. Build on `macos-15-intel` for `x64`
3. Upload packaged artifacts as workflow artifacts
4. Generate update manifests for `channel / os / arch`
5. Publish a GitHub prerelease for the same tag
6. Publish manifests to the `gh-pages` branch

Current command executed in CI:

```bash
rm -rf out release && pnpm dist:release
```

The workflow injects the pushed tag through `ONWARD_TAG`.
The workflow injects the platform label through `ONWARD_RELEASE_OS`.

Current artifact naming rule:

- `${productName}-${tag}-${releaseOs}-${arch}.${ext}`

Examples:

- `Onward 2-v2.1.0-daily.20260402.1-macos-arm64.dmg`
- `Onward 2-v2.1.0-daily.20260402.1-macos-x64.zip`

Reserved operating system labels for future expansion:

- `macos`
- `windows`
- `linux`

## 4. Daily Build vs Formal Release

A tag-triggered build is not limited to Daily Build usage.

In open-source projects, the most common patterns are:

1. Branch push builds for continuous verification
2. Nightly or canary builds for frequent preview packages
3. Tag-triggered builds for release candidates and formal releases

Recommended release discipline for this repository:

- `pnpm dist:dev` for local developer packages
- Branch-based CI for verification only
- Optional nightly workflow for preview packages
- Tag-based workflow for Daily packages, release candidates, and formal release packages

In this repository, the current plan is:

- `Daily` packages come from Daily tags such as `v2.1.0-daily.20260402.1`
- `Stable` packages will later come from stable tags such as `v2.1.0`
- The same artifact naming and manifest structure will be reused across macOS, Linux, and Windows

## 5. How To Publish A Formal Release

There are three practical choices.

### Option A: GitHub UI publish flow

Recommended for future formal releases.

Flow:

1. Push a release tag
2. Let GitHub Actions build the binaries
3. Let the workflow create a draft GitHub Release
4. Review the generated artifacts and release notes on the GitHub Releases page
5. Click Publish release manually

This is the safest flow for future formal releases because it adds a human review gate.

### Option B: GitHub CLI publish flow

Also valid for future formal releases.

GitHub provides an official CLI command for release creation and management:

```bash
gh release create v2026.04.02 --draft --generate-notes
```

You can also inspect or edit a release:

```bash
gh release view v2026.04.02
gh release edit v2026.04.02 --draft=false
```

Typical usage in this repository would be:

1. Push the tag
2. Wait for GitHub Actions to finish packaging
3. Publish the draft by GitHub UI or `gh release edit`

### Option C: Fully automatic release publish

Possible, but not recommended yet for formal releases.

You can change the workflow from `draft: true` to automatic publishing, but this should be done only after:

- Release notes are stable
- Packaging is stable
- Signing and notarization are configured
- You are comfortable with publishing without a manual review step

## 6. Unsigned macOS App: What Users Experience

If the app is not signed and notarized by Apple:

- Users can still download it
- Users usually cannot just double-click and run it without warnings
- macOS Gatekeeper will block the first launch or show security warnings

Typical user path for an unsigned app:

1. Download the `.dmg` or `.zip`
2. Move the app to `Applications` if needed
3. Try to open it
4. See a warning that the app is from an unidentified developer or cannot be checked for malicious software
5. Open `System Settings > Privacy & Security`
6. Click `Open Anyway`
7. Confirm again

After that first override, the app becomes an exception and can usually be opened normally on that Mac.

## 7. Signed vs Unsigned macOS App

Unsigned:

- No developer identity attached
- Gatekeeper warnings are stronger
- Higher friction for first launch
- Lower user trust
- Not suitable for polished public distribution

Signed only:

- Has an Apple Developer identity
- macOS can verify the app comes from an identified developer
- Better trust than unsigned
- Still not ideal on modern macOS if it is not notarized

Signed and notarized:

- Best distribution experience outside the Mac App Store
- Lower launch friction
- Better trust and fewer warnings
- Preferred for formal public releases

## 8. Recommended Release Stages

Suggested channel model:

1. Development build
   - Local only
   - Branch name in title
2. Preview or nightly build
   - Optional
   - Branch or scheduled trigger
   - Can remain unsigned in early stages
3. Release candidate
   - Tag-triggered
   - Prefer signed packages
4. Formal release
   - Tag-triggered
   - Signed and notarized
   - Manual publish gate recommended

## 9. Current Repository Status

Already implemented:

- `dist:release` script
- Tag injection through `ONWARD_TAG`
- Release OS injection through `ONWARD_RELEASE_OS`
- Release title display with tag
- Version mapping from tag date
- GitHub Actions macOS matrix build
- GitHub prerelease upload for tag-triggered Daily Build

Not implemented yet:

- Formal stable release workflow
- Apple signing
- Apple notarization
- Windows release build lane
- Linux release build lane
- Separate nightly build workflow if needed

## 10. Common Commands

Development package build:

```bash
rm -rf out release && pnpm dist:dev
```

Local release package build:

```bash
rm -rf out release && ONWARD_TAG=v2026.04.02 pnpm dist:release
```

Create and push a release tag:

```bash
git tag v2026.04.02
git push origin v2026.04.02
```

Launch the locally packaged macOS app:

```bash
open "release/mac-arm64/Onward 2.app"
```

Local release build with explicit operating system label:

```bash
rm -rf out release && ONWARD_TAG=v2026.04.02.4 ONWARD_RELEASE_OS=macos pnpm dist:release
```

View a release with GitHub CLI:

```bash
gh release view v2026.04.02
```

Create a release with GitHub CLI:

```bash
gh release create v2026.04.02 --draft --generate-notes
```

Publish an existing draft release with GitHub CLI:

```bash
gh release edit v2026.04.02 --draft=false
```

## 11. Recommended Policy For Now

For the current repository stage, the most practical policy is:

1. Keep tag-triggered packaging
2. Keep GitHub Release as draft
3. Review artifacts manually
4. Publish manually from GitHub UI or GitHub CLI
5. Add Apple signing and notarization before claiming a public formal release

## References

- GitHub Actions events that trigger workflows:
  https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows
- GitHub release management:
  https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository
- GitHub CLI release create:
  https://cli.github.com/manual/gh_release_create
- Apple support on safely opening apps on macOS:
  https://support.apple.com/en-us/HT202491
- Apple support on opening apps from unknown developers:
  https://support.apple.com/en-lamr/guide/mac-help/mh40616/mac
