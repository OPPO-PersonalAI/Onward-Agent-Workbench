// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

// A generated, opaque 1x1 RGBA PNG; no external artwork or encoded source blobs.
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const header = Buffer.alloc(4), checksum = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([header, body, checksum])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4)
ihdr[8] = 8; ihdr[9] = 6
writeFileSync(new URL('./fixtures/cli-shortcut-compatibility/clipboard.png', import.meta.url), Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.from([0, 80, 130, 220, 255]))), chunk('IEND', Buffer.alloc(0))
]))
