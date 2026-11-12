#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, statSync } = require('node:fs')
const { dirname, join } = require('node:path')

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2

function resolveCscPath() {
  const windir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const candidates = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error(`Unable to locate .NET Framework csc.exe under ${windir}\\Microsoft.NET`)
}

function readPeSubsystem(filePath) {
  const bytes = readFileSync(filePath)
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) {
    return null
  }
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset < 64 || peOffset + 24 + 70 > bytes.length) {
    return null
  }
  if (bytes.readUInt32LE(peOffset) !== 0x00004550) {
    return null
  }
  const optionalHeaderOffset = peOffset + 24
  return bytes.readUInt16LE(optionalHeaderOffset + 68)
}

function isUpdaterUpToDate(sourcePath, outputPath) {
  if (!existsSync(outputPath)) return false
  try {
    const srcMtime = statSync(sourcePath).mtimeMs
    const outMtime = statSync(outputPath).mtimeMs
    if (outMtime < srcMtime) return false
    return readPeSubsystem(outputPath) === IMAGE_SUBSYSTEM_WINDOWS_GUI
  } catch {
    return false
  }
}

function ensureWindowsUpdater(options = {}) {
  if (process.platform !== 'win32') {
    return null
  }

  const rootDir = join(__dirname, '..')
  const sourcePath = join(rootDir, 'resources', 'updater', 'win32', 'OnwardUpdater.cs')
  const outputPath = options.outputPath || join(rootDir, 'resources', 'updater', 'win32', 'onward-updater.exe')

  if (!existsSync(sourcePath)) {
    throw new Error(`Windows updater source file is missing: ${sourcePath}`)
  }

  if (!options.force && isUpdaterUpToDate(sourcePath, outputPath)) {
    return outputPath
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  const cscPath = resolveCscPath()
  const args = [
    '/nologo',
    '/optimize+',
    '/target:winexe',
    '/platform:anycpu',
    '/r:System.Runtime.Serialization.dll',
    '/r:System.Xml.dll',
    `/out:${outputPath}`,
    sourcePath
  ]

  const result = spawnSync(cscPath, args, {
    encoding: 'utf-8',
    windowsHide: true
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`Failed to compile onward-updater.exe (exit ${result.status}):\n${details}`)
  }

  const subsystem = readPeSubsystem(outputPath)
  if (subsystem !== IMAGE_SUBSYSTEM_WINDOWS_GUI) {
    throw new Error(`Expected onward-updater.exe PE subsystem ${IMAGE_SUBSYSTEM_WINDOWS_GUI} (WINDOWS_GUI), got ${String(subsystem)}`)
  }

  console.log(`[windows-updater] Built pure GUI updater helper: ${outputPath}`)
  return outputPath
}

module.exports = {
  IMAGE_SUBSYSTEM_WINDOWS_GUI,
  ensureWindowsUpdater,
  readPeSubsystem
}

if (require.main === module) {
  try {
    ensureWindowsUpdater()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
