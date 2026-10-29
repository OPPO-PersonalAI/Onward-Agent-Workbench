// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const python = process.env.PYTHON3 || (process.platform === 'win32' ? 'py' : 'python3')
const source = fileURLToPath(new URL('./dev-app-cleanup.test.py', import.meta.url))
const args = !process.env.PYTHON3 && process.platform === 'win32' ? ['-3', source] : [source]
const result = spawnSync(python, args, { stdio: 'inherit', timeout: 45_000 })
if (result.error) console.error(result.error)
process.exit(result.status ?? 1)
