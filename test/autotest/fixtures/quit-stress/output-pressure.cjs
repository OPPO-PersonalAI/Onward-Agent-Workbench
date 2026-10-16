/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
const fs = require('node:fs')
if (process.argv[2]) fs.writeFileSync(process.argv[2], String(process.pid))
const line = 'quit-pressure '.repeat(128) + '\n'
setInterval(() => process.stdout.write(line), 10)
