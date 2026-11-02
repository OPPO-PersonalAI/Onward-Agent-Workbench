<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Git Diff Staleness + Submodule Filter Fixture

`test/autotest/create-git-diff-staleness-fixture.mjs` materializes three parent-with-submodule
repos under `runtime/repos/` for the GDS-* assertions in
`src/autotest/test-git-diff-staleness-and-submodule.ts` and the runner
`test/autotest/run-git-diff-staleness-and-submodule-autotest.sh`.

The fixture is generated on demand and the `runtime/` dir is gitignored. Re-running
the builder wipes and recreates `runtime/`, so each run starts from a known-good
state.

## Layout

```
runtime/
├── sources/
│   └── sub/                  # baseline submodule source (used by all four parents)
└── repos/
    ├── clean/root/           # parent + submodule, both clean (GDS-01..03, 05..10, 15)
    ├── pointer-changed/root/ # parent index records commit-A, submodule HEAD = commit-B (GDS-04)
    ├── staged-pointer/root/  # like pointer-changed, but `git add modules/sub` ran:
                              # parent index now has new pointer, `<c>=.`, X=`M`.
                              # GDS-14 asserts the filter still surfaces this row
                              # (otherwise the user can't review or unstage it).
    └── uninitialized/root/   # .gitmodules declares submodule, but the path is an
                              # empty non-repo directory (`git submodule deinit -f` +
                              # rm -rf + mkdir). Used by GDS-13 to assert the parent's
                              # file list does NOT surface a phantom submodule row.
```

## Manifest

The builder prints a JSON manifest to stdout containing absolute paths for every
parent / submodule the runner needs (also written to `runtime/manifest.json`):

```json
{
  "tempRoot":            "<runtime/>",
  "cleanRoot":           "<runtime/repos/clean/root>",
  "pointerChangedRoot":  "<runtime/repos/pointer-changed/root>",
  "stagedPointerRoot":   "<runtime/repos/staged-pointer/root>",
  "uninitializedRoot":   "<runtime/repos/uninitialized/root>",
  "submoduleRelPath":    "modules/sub",
  "parentEditableFile":  "src/main.txt",
  "submoduleEditableFile":  "README.md",
  "submoduleUntrackedRelPath": "modules/sub/lib/new-untracked.txt",
  "manifestPath":        "<runtime/manifest.json>"
}
```

## Regenerate

```bash
# Direct (manifest goes to stdout)
node test/autotest/create-git-diff-staleness-fixture.mjs

# Via the runner (also runs the GDS-* autotest suite end-to-end)
bash test/autotest/run-git-diff-staleness-and-submodule-autotest.sh
```
