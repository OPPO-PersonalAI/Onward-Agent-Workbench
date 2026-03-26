# License Audit Report

**Project:** Onward2
**License:** Apache-2.0
**Audit Date:** 2026-03-20
**Tool:** license-checker-rseidelsohn v4.4.2
**Scope:** Production dependencies only (`--production`)

## Summary

All **15** production dependencies (including the project itself) use licenses
compatible with Apache-2.0. **No GPL / LGPL / AGPL / SSPL / copyleft licenses detected.**

| License | Count | Packages |
|---------|-------|----------|
| MIT | 12 | @monaco-editor/react, @xterm/addon-fit, @xterm/addon-search, @xterm/addon-web-links, @xterm/addon-webgl, @xterm/xterm, better-sqlite3, katex, marked, marked-katex-extension, monaco-editor, node-pty |
| Apache-2.0 | 2 | onward2 (self), @pierre/diffs (*) |
| MPL-2.0 OR Apache-2.0 | 1 | dompurify (dual-licensed; Apache-2.0 chosen) |
| BSD-3-Clause | 1 | highlight.js |

> (*) `@pierre/diffs` — license inferred from LICENSE.md file content (Apache-2.0),
> not from package.json `license` field. Verified manually.

## Compatibility Notes

- **MIT, BSD-3-Clause** — permissive, fully compatible with Apache-2.0.
- **MPL-2.0 OR Apache-2.0** (dompurify) — dual-licensed; selecting Apache-2.0 eliminates any MPL file-level copyleft concern.
- **Apache-2.0** — same license as the project.

## Incompatible License Check

Ran `--failOn` with the following copyleft / restrictive license list:

```
GPL-2.0, GPL-3.0, AGPL-1.0, AGPL-3.0, LGPL-2.0, LGPL-2.1, LGPL-3.0,
SSPL-1.0, EUPL-1.1, EUPL-1.2, OSL-3.0, RPL-1.1, RPL-1.5, CPAL-1.0,
CPL-1.0, Sleepycat, Watcom-1.0
```

**Result: PASS** — no packages matched.

## Electron / Chromium

Electron bundles Chromium and FFmpeg. Their licenses are covered by
`LICENSES.chromium.html`, which Electron includes automatically in the
packaged application. No additional declaration is required.

## Source Code Risk Scan

**Scan Date:** 2026-03-20
**Scope:** `src/`, `electron/`, `scripts/` (123 files)

| Check | Result |
|-------|--------|
| SPDX headers present | 122/123 — `src/monaco-env.ts` was missing, now fixed |
| Third-party copyright notices | None found (all files: `OPPO` only) |
| Copied-code indicators (stackoverflow, adapted from, etc.) | None found |
| GPL/LGPL/AGPL license references | None found |
| Suspicious external URLs | 1 legitimate doc link (`git-scm.com`) |
| Hardcoded secrets (API keys, tokens, passwords) | None found |
| Unexpected binary files | None found |

**Conclusion:** No source code compliance risks detected.

## Development Guidelines (claude-safe)

To maintain compliance during AI-assisted development:

1. **CLAUDE.md rules** — The project enforces Apache-2.0 compatibility constraints
   in `CLAUDE.md`. All AI-generated code must comply with these rules:
   - No copyleft-licensed code or dependencies (GPL/LGPL/AGPL/SSPL)
   - No unverified external code snippets
   - SPDX headers required on every new source file
   - `pnpm generate-notices` after adding dependencies
2. **Dependency gate** — Before adding any new production dependency, verify its
   license. Safe: MIT, BSD, ISC, Apache-2.0. Requires review: MPL-2.0.
   Forbidden: GPL, LGPL, AGPL, SSPL.
3. **Periodic audit** — Re-run `pnpm generate-notices` and review
   `npx license-checker-rseidelsohn --production --summary` before each release.

## Recommendations

1. Re-run this audit before each release (`pnpm generate-notices`).
2. Review any new production dependency additions for license compatibility.
3. Keep the CLAUDE.md rule enforcing Apache-2.0 compatibility for all generated code.
