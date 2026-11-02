/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure builder for `git status --porcelain=2` argument arrays.
 *
 * Centralizes the status command so the two heavy callers — the Git Diff path
 * (`getGitStatusPorcelainV2`) and the GitStateMirror worker (`computeMirrorState`)
 * — share one definition and one place to tune flags. Pure (no I/O, no Electron)
 * so it is unit-testable in plain `node --test`.
 *
 * # `--ignore-submodules=dirty`
 *
 * Without it, a superproject `git status --untracked-files=all` RECURSES into
 * every submodule's working tree and enumerates its untracked content (e.g. a
 * submodule's `node_modules`). `--ignore-submodules=dirty` skips the submodule
 * WORKING-TREE walk while STILL reporting a submodule whose recorded commit
 * pointer changed (new commits / staged gitlink update). That preserves the
 * only submodule signal the Git Diff path keeps anyway
 * (`filterMeaninglessSubmoduleEntries` drops m/u-only entries), and the
 * per-submodule diff pass still shows each submodule's own changes in its
 * dedicated section.
 */

export interface GitStatusPorcelainArgsOptions {
  /** Include `--branch` (branch/ahead-behind header). */
  branch?: boolean
  /** Include `-z` (NUL-delimited records). */
  z?: boolean
  /** Include `--find-renames=<n>` rename detection. Omit to disable. */
  findRenames?: number
  /** `--untracked-files=<mode>`. Defaults to `all`. */
  untracked?: 'all' | 'normal' | 'no'
  /**
   * `--ignore-submodules=<when>`. `dirty` skips the submodule working-tree walk
   * but still reports commit-pointer changes. Omit for git's default (none).
   */
  ignoreSubmodules?: 'none' | 'untracked' | 'dirty' | 'all'
}

/**
 * Build the full argument array for a porcelain-v2 status invocation, including
 * the leading `-c core.quotepath=false` and the `status --porcelain=2` head.
 */
export function buildGitStatusPorcelainArgs(options: GitStatusPorcelainArgsOptions = {}): string[] {
  const args = ['-c', 'core.quotepath=false', 'status', '--porcelain=2']
  if (options.branch) args.push('--branch')
  if (options.z) args.push('-z')
  if (typeof options.findRenames === 'number') args.push(`--find-renames=${options.findRenames}`)
  args.push(`--untracked-files=${options.untracked ?? 'all'}`)
  if (options.ignoreSubmodules) args.push(`--ignore-submodules=${options.ignoreSubmodules}`)
  return args
}
