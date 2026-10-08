<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Theme import fixtures

These are original test data, not third-party theme palettes.

- `standalone/`: JSONC includes, nested parent-relative references, cycles, invalid sibling colors, unsupported syntax and external token references.
- `package/extension/`: VSIX source tree. Both contributions intentionally have the same label; their colors and identities differ. The extension entry point throws if executed.
- `archives/`: real, reproducible VSIX binaries, including malformed packages. `valid.vsix` contains UTF-8 BOMs and CRLF in its JSON/JSONC entries.
- `cases.json`: parser and path decision-table inputs.

Regenerate archives from the repository root:

```sh
node test/autotest/create-themes-import-fixture.mjs
```

Run the paired plain-Node import suite:

```sh
node --experimental-strip-types test/unittest/theme-import.test.mts
```

The suite copies mutable fixtures into its own OS-temp directory and removes them in `finally`. It never changes source fixtures or the user's settings. Windows path semantics are covered on every host; the real-file symlink case is explicitly skipped on Windows because creating file symlinks there may require developer mode.
