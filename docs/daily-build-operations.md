<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Daily Build Operations

## Purpose

This document is the operational checklist for Daily builds.

Use it when you want to:

- publish a new Daily build tag
- delete a wrong Daily build tag
- restart the numbering for a specific date
- run a local development package from `master`

## Current Daily Tag Rule

Daily tags use this format:

```bash
v2.1.0-daily.YYYYMMDD.N
```

Example:

```bash
v2.1.0-daily.20260402.1
```

Meaning:

- `2.1.0` is the current base application version line
- `20260402` is the date
- `1` is the sequence number for that date

## Publish A New Daily Build

Update local `master` first:

```bash
git checkout master
git pull --ff-only
```

Create and push a new tag:

```bash
git tag v2.1.0-daily.20260402.2
git push origin refs/tags/v2.1.0-daily.20260402.2
```

After the push:

1. GitHub Actions starts the Daily Build workflow
2. macOS `arm64` and `x64` packages are built
3. A GitHub prerelease is created for the same tag
4. Update manifests are published to `gh-pages`

## Delete A Wrong Daily Tag

If a Daily tag was pushed by mistake, delete in this order:

```bash
gh release delete v2.1.0-daily.20260402.2 --repo OPPO-PersonalAI/Onward --yes
git tag -d v2.1.0-daily.20260402.2
git push origin :refs/tags/v2.1.0-daily.20260402.2
```

This removes:

- the GitHub prerelease
- the local tag
- the remote tag

## Restart The First Tag For Today

If you want to clear all Daily tags for one date and recreate the first one, first delete the wrong tags:

```bash
gh release delete v2.1.0-daily.20260402.2 --repo OPPO-PersonalAI/Onward --yes
git tag -d v2.1.0-daily.20260402.2
git push origin :refs/tags/v2.1.0-daily.20260402.2
```

Then recreate the first official tag for that date:

```bash
git checkout master
git pull --ff-only
git tag v2.1.0-daily.20260402.1
git push origin refs/tags/v2.1.0-daily.20260402.1
```

## Local Development Build From Master

Build and launch the development package:

```bash
rm -rf out release && pnpm dist:dev
open "/Users/yingyun/Projects/Onward-Github/release/mac-arm64/Onward 2-master.app"
```

## Verification Checklist

After pushing a Daily tag, verify these pages:

- Actions run:
  `https://github.com/OPPO-PersonalAI/Onward/actions`
- Releases page:
  `https://github.com/OPPO-PersonalAI/Onward/releases`

Expected result:

- the workflow is green
- the GitHub prerelease exists
- `macos-arm64` and `macos-x64` assets exist
- the updater manifest points to the same tag

## Notes

- Daily build titles show the date only, not the full sequence suffix
- Daily build package filenames still keep the full tag, so the exact build can be traced
- Git commit messages in this repository must use English
