---
name: push-daily-build
description: Push local commits, create a daily build tag, trigger GitHub Actions CI, and verify the entire release pipeline. Use this skill when the user asks to push and trigger a daily build, create a release tag, publish a daily build, or trigger a build.
---

# Push and Trigger Daily Build

Push local commits to `origin/master`, generate and confirm the release Change Log, create a versioned daily build tag, trigger GitHub Actions CI, and verify the full pipeline including GitHub Release artifacts and update manifests.

## User Input

The user may provide:

- **version** — The semver prefix for the tag (e.g., `2.1.0`, `2.2.0`, `3.0.0`). If omitted, detect the latest existing daily tag and reuse its version prefix.
- **date** — The date stamp (e.g., `20260405`). If omitted, use today's date in `YYYYMMDD` format.
- **sequence** — The sequence number (e.g., `1`, `2`). If omitted, auto-detect: find existing tags for the same version+date and increment. Default to `1` if none exist.

The resulting tag format is: `v{VERSION}-daily.{DATE}.{SEQ}`

Example: `v2.1.0-daily.20260405.1`

## Execution Flow

### Phase 1: Pre-flight Checks

```bash
# 1. Confirm on master branch
git branch --show-current
# Must be "master". If not, stop and warn the user.

# 2. Check for uncommitted changes
git status --short
# If dirty, warn the user and ask whether to proceed.

# 3. Check if there are commits to push
git log origin/master..HEAD --oneline
# If no commits, inform the user — they may only want to create a tag on HEAD.
```

### Phase 2: Determine Tag

```bash
# Find the latest daily tag to detect the current version prefix
git tag -l "v*-daily.*" --sort=-version:refname | head -1

# Find existing tags for the target date to determine sequence number
git tag -l "v*-daily.{DATE}.*" --sort=-version:refname | head -1
```

If the user specified a version, use it. Otherwise, extract the version prefix from the latest daily tag (e.g., `2.1.0` from `v2.1.0-daily.20260402.1`).

If there are existing tags for the same version+date, increment the sequence number. Otherwise, start at `1`.

Present the resolved tag to the user for confirmation before proceeding:

> Tag to create: `v2.1.0-daily.20260405.1`
> Commits to push: 12
> Proceed?

### Phase 3: Generate Change Log Draft

Before any push, tag, or release action, generate the Change Log draft for the resolved tag:

```bash
node scripts/generate-changelog.js --tag {TAG}
```

This script writes the draft files:

- `resources/changelog/en/daily/{TAG}.md`
- `resources/changelog/index.json`
- derived HTML assets under `resources/changelog/html/**`

The draft is always written in English, based on the current `HEAD` diff against the previous Daily tag. It is only a starting point.
The HTML assets are generated automatically from the Markdown and should not be edited by hand.

After generation, **stop and ask the user to review the draft**. Do not continue automatically.

Show the generated file paths and explicitly request confirmation:

> Change Log draft generated for `{TAG}`.
> Review the generated draft:
> - `resources/changelog/en/daily/{TAG}.md`
> Continue after confirmation?

Rules for this pause:

- The user must have a chance to edit the English draft before release.
- Do not push commits, create the tag, or publish anything before the user confirms.
- If the user requests edits, apply them first and re-show the final draft state.

### Phase 4: Commit Approved Change Log and Push

After the user confirms the draft, ensure the Change Log files are included in git history before tagging:

```bash
git status --short
git add resources/changelog
git commit -m "docs(changelog): add release notes for {TAG}"
```

Notes:

- The commit message must stay in English.
- If the user prefers to fold the Change Log into an existing unreleased commit, follow that instruction instead.
- If `git status --short` shows unexpected unrelated changes, stop and ask before committing them.

Then push local commits:

```bash
git push origin master
```

### Phase 5: Create and Push Tag

```bash
# Create and push the tag
git tag {TAG}
git push origin {TAG}
```

### Phase 6: Monitor CI Build

```bash
# Verify the workflow was triggered
gh run list --limit 1

# Get the run ID and watch it
gh run watch {RUN_ID} --exit-status
```

This step waits for the GitHub Actions workflow to complete. Typical duration is ~7 minutes. Use `--exit-status` so it returns non-zero on failure.

If the build fails, show the failing job logs:
```bash
gh run view {RUN_ID} --log-failed
```

### Phase 7: Verify Release Pipeline

After the build succeeds, verify all outputs:

```bash
# 1. GitHub Release exists and has artifacts
gh release view {TAG}

# 2. arm64 manifest is updated
curl -s "https://raw.githubusercontent.com/OPPO-PersonalAI/Onward/gh-pages/updates/daily/macos/arm64/latest.json"

# 3. x64 manifest is updated
curl -s "https://raw.githubusercontent.com/OPPO-PersonalAI/Onward/gh-pages/updates/daily/macos/x64/latest.json"

# 4. Download links are accessible (expect HTTP 302)
curl -sI "{ARTIFACT_URL}" | head -3
```

Verify the following conditions:

| Check | Expected |
|---|---|
| GitHub Release title | `Daily Build {TAG}` |
| Release assets | 4 files: arm64 dmg+zip, x64 dmg+zip |
| GitHub Release notes | Matches `resources/changelog/en/daily/{TAG}.md` |
| arm64 manifest version | Matches the tag version |
| x64 manifest version | Matches the tag version |
| Manifest `releaseNotes` | Matches the approved English Change Log |
| Artifact download URL | HTTP 302 (redirect to CDN) |

### Phase 8: Report

Present a summary table:

```
## Daily Build Release Complete

| Step | Status |
|---|---|
| Push code | {N} commits pushed |
| Create tag {TAG} | done |
| GitHub Actions build | arm64: Xm, x64: Xm |
| GitHub Release | 4 artifacts |
| Manifest update | arm64 + x64 |
| Download links | accessible |

Release URL: https://github.com/OPPO-PersonalAI/Onward/releases/tag/{TAG}
```

## Version Management

The version in the tag (e.g., `2.1.0`) is the **sole source of truth** for the app version in release builds. The build script `scripts/dist-release.js` reads `ONWARD_TAG` and overrides `package.json`'s version field at build time.

To bump the major version (e.g., from `2.1.0` to `2.2.0` or `3.0.0`), simply pass the new version when invoking this skill. No source files need to be modified.

The `package.json` version field (`2.0.1`) is only used for development builds and is independent of the release tag version.

## Error Handling

- **Not on master**: Stop immediately. Do not push or tag from other branches.
- **Dirty working tree**: Warn the user. They may want to commit first.
- **Change Log draft missing**: Stop. Generate `resources/changelog/**` first.
- **Change Log not yet confirmed**: Stop. Wait for explicit user approval before Phase 4.
- **Push fails**: Check network and authentication. Show the error.
- **Tag already exists**: Increment the sequence number or ask the user.
- **CI build fails**: Show failed job logs. Do not proceed to verification.
- **Manifest not updated**: The gh-pages push may have failed. Check the publish job logs.
