/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs'

// ConPTY must own the screen so later window resizes preserve the fixture output.
process.stdout.write(readFileSync(new URL('./terminal-screen.txt', import.meta.url), 'utf8').replaceAll('\\x1b', '\x1b').replace(/\r?\n/g, '\r\n'))
