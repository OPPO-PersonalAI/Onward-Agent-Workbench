# File Index Cache Fixture

Committed test asset used by the file-search UI autotest
(`src/autotest/test-file-index-cache-ui.ts`) and its runner
(`test/run-file-index-cache-ui-autotest.sh`).

Purpose: provide a small but realistically shaped project tree so that the
filename-search cache (Cmd+P) can be exercised end-to-end without the test
ever touching the user's home directory, system root, or the live
Onward-Agent-Workbench repository.

Design notes:

- **Simple cases** live near the top (`package.json`, `tsconfig.json`, a flat
  `config/` folder).
- **Medium cases** exercise typical frontend layouts
  (`src/components`, `src/hooks`, `src/utils`).
- **Complex cases** stress directory depth and polyphase naming
  (`src/api/handlers`, `src/api/middleware`, nested `tests/integration`).
- **Non-code assets** cover non-TS extensions (`docs/**/*.md`,
  `assets/images/*.png.placeholder`, `assets/styles/*.css`).

Scratch files that the autotest creates during the run (prefixed with
`onward-fic-`) are added and then cleaned up by the test itself. They are
**not** committed here — anything starting with that prefix in a diff
indicates a crashed test run and can be deleted.
