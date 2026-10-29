// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const python = process.env.PYTHON3 || (process.platform === 'win32' ? 'py' : 'python3')
const source = fileURLToPath(new URL('./regression-entry.test.py', import.meta.url))
const result = spawnSync(python, [source], { stdio: 'inherit', timeout: 45_000 })
if (result.error) console.error(result.error)
process.exit(result.status ?? 1)
