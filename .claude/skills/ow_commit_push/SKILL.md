---
name: ow_commit_push
description: Audit staged changes, git author identity, commit messages, and binary fixtures for sensitive information or non-English leaks before creating a git commit or pushing to remote. Use this skill whenever the user explicitly asks to commit or push code.
---

# Safe Commit and Push (`/ow_commit_push`)

Enforce the repository's dual-layer security and hygiene gate before every `git commit` or `git push`.

> **Hard rule reminder (`AGENTS.md` / `CLAUDE.md`):** Never create git commits automatically. Only run `git commit` or `git push` when the user explicitly requests it or invokes this skill. Never pass `--no-verify` to `git commit` or `git push`.

---

## Mandatory Pre-Commit & Pre-Push Audit SOP

Execute the following steps in order and stop immediately if any check fails:

### Step 1: Working Tree & Staged File Audit

```bash
git status --short
git diff --cached --stat
```

Verify that:
- Temporary scratch files, handoff HTML files (`HANDOFF*.html`), local trace dumps (`traces/`), and `__autotest_*` directories are **not** staged or tracked.
- Only files relevant to the user-approved change are staged.

### Step 2: Git Author / Committer Identity Verification

```bash
node scripts/check-sensitive-info.js --git-author
```

Verify that `git config user.name` and `git config user.email`:
- Are non-empty.
- Do **not** use internal numeric employee IDs, contractor IDs, or internal contractor email domains.
- Note: Official `@oppo.com` and `@users.noreply.github.com` addresses are permitted when paired with a public display name / handle rather than an internal employee ID.

### Step 3: Automated Sensitive-Information & Language Gate

Run the repository-wide linters and typecheck:

```bash
pnpm lint:sensitive
pnpm lint:comments
pnpm typecheck
```

`pnpm lint:sensitive` (`scripts/check-sensitive-info.js`) inspects all tracked and untracked non-ignored text files as well as binary `.tar.gz` / `.tgz` / `.tar` fixture archives (including 512-byte `ustar` headers `uname`/`gname`/`uid`/`gid` and inner file payloads) for:
1. **Local OS user paths** — Windows `<Drive>:\Users\<real-user>`, macOS `/Users/<real-user>`, Linux `/home/<real-user>`, and personal drive workspaces. Only generic placeholders (`example`, `user`, `me`, `dev`, `test`, `alice`, `bob`) are permitted.
2. **Employee / contractor IDs, internal domains, and handles** — numeric employee IDs, contractor IDs, internal domains, and personal machine/tester handles.
3. **Internal R&D & unrelated personal project/branch/file names** — any project, submodule, branch, source file, or diagnostic bundle filename from non-Onward repositories or user incidents must be deleted outright from code comments and documentation rather than replaced with pseudonyms.
4. **Corporate IT / MDM / EDR vendor names** — internal endpoint security or MDM product names must be removed or described only in generic OS-mechanism terms.
5. **Diagnostic analysis & session handoff artifacts** — `HANDOFF*.html`, `Logs/`, `docs/bug-tracking/`, `BUG-NNNN-*.md`, and `*onward-diagnostic-*` bundles/reports are strictly for local analysis and blocked from ever entering Git.
6. **Unicode / HTML / URL escape smuggling** — `\uXXXX`, `\u{XXXXX}`, `\xXX`, `&#xXXXX;`, `&#DDDD;`, and `%XX` sequences are decoded before matching.

### Step 4: Commit Message Verification

Before running `git commit`, draft the commit message in English and verify:
- The commit message contains **only English** text (no Simplified/Traditional Chinese characters or Unicode escapes).
- The commit message does **not** reference internal project/submodule/branch names, employee IDs, or local filesystem paths.
- `.husky/commit-msg` will automatically validate the message via `node scripts/check-sensitive-info.js --commit-msg "$1"`.

### Step 5: Execute Commit / Push (With Hooks Enabled)

```bash
git commit -m "<type>(<scope>): <english summary>"
```

If the user also requested pushing to the remote:

```bash
git push origin <branch>
```

Never use `--no-verify`. If any hook (`pre-commit`, `commit-msg`, or `pre-push`) fails, fix the underlying leak or lint error and re-run from Step 1.
