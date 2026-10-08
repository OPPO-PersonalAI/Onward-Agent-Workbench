#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { createWriteStream } from 'node:fs'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'themes-import')
const destination = join(root, 'archives')
await mkdir(destination, { recursive: true })

async function files(directory, prefix = '') {
  const result = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), name + '/'))
    else result.push([name, await readFile(join(directory, entry.name))])
  }
  return result
}

const originals = await files(join(root, 'package'))
const fixedDate = new Date('2026-01-01T00:00:00Z')
async function writeArchive(name, entries) {
  const zip = new yazl.ZipFile()
  for (const [path, data] of entries) zip.addBuffer(data, path, { mtime: fixedDate, mode: 0o100644 })
  const written = pipeline(zip.outputStream, createWriteStream(join(destination, name)))
  zip.end()
  await written
}

await writeArchive('valid.vsix', originals.map(([name, data]) => [name, name.endsWith('.json') || name.endsWith('.jsonc')
  ? Buffer.from('\uFEFF' + data.toString('utf8').replace(/\r?\n/g, '\r\n')) : data]))
await writeArchive('missing-theme.vsix', originals.filter(([name]) => !name.endsWith('/light.jsonc')))
await writeArchive('missing-manifest.vsix', originals.filter(([name]) => name !== 'extension/package.json'))
await writeArchive('duplicate-entry.vsix', [...originals, originals.find(([name]) => name === 'extension/package.json')])
await writeArchive('invalid-theme.vsix', originals.map(([name, data]) => [name, name.endsWith('/light.jsonc') ? Buffer.from('null') : data]))
await writeArchive('outside-root.vsix', originals.map(([name, data]) => [name, name.endsWith('/light.jsonc')
  ? Buffer.from('{"include":"../../outside.json"}') : data]))
await writeArchive('expanded-size.vsix', [...originals, ['extension/unused.txt', Buffer.concat(
  Array.from({ length: 512 }, () => originals.find(([name]) => name === 'extension/main.js')[1])
)]])
await writeFile(join(destination, 'corrupt.vsix'), (await readFile(join(destination, 'valid.vsix'))).subarray(0, 128))
console.log(`Theme import fixtures written to ${resolve(destination)}`)
