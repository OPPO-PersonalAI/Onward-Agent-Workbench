#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { join } = require('path')
const { compileChangelogAssets } = require('./changelog-compiler')

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      args[key] = 'true'
      continue
    }
    args[key] = next
    index += 1
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const changelogRoot = String(args.root || '').trim() || join(process.cwd(), 'resources', 'changelog')
  const result = compileChangelogAssets(changelogRoot)
  console.log(`Compiled ${result.compiledCount} Change Log HTML files from ${result.entries} index entries.`)
  console.log(`Index file: ${result.indexPath}`)
}

main()
