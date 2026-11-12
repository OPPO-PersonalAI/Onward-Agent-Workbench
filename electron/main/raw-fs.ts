/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unpatched filesystem bindings for updater archive extraction and staging.
 *
 * Inside Electron (both main process and worker_threads), `node:fs` intercepts
 * any path ending in `.asar` (such as `_staging/resources/app.asar`) as a
 * read-only virtual archive and throws `Invalid package` during extraction or
 * directory cleanup. Electron's built-in `original-fs` module exposes raw OS
 * file operations without ASAR interception. Outside Electron (plain Node unit
 * tests), `node:fs` is already unpatched.
 */

import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

function loadRawFs(): typeof nodeFs {
  if (process.versions && 'electron' in process.versions) {
    try {
      const req =
        typeof require === 'function'
          ? require
          : createRequire(fileURLToPath(import.meta.url))
      return req('original-fs') as typeof nodeFs
    } catch {
      // Fall back to node:fs if original-fs cannot be resolved.
    }
  }
  return nodeFs
}

export const rawFs: typeof nodeFs = loadRawFs()
