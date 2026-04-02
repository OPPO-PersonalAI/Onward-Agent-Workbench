/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type ReleaseChannel = 'daily' | 'stable' | 'unknown'

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

export interface ParsedReleaseTag {
  tag: string
  version: string
  releaseChannel: ReleaseChannel
}

function parseNumericPart(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric version component "${value}".`)
  }
  return parsed
}

export function parseVersion(version: string): ParsedVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim())
  if (!match) {
    throw new Error(`Invalid version "${version}".`)
  }

  return {
    major: parseNumericPart(match[1]),
    minor: parseNumericPart(match[2]),
    patch: parseNumericPart(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1

    const leftNumber = Number(left)
    const rightNumber = Number(right)
    const leftIsNumber = Number.isInteger(leftNumber) && String(leftNumber) === left
    const rightIsNumber = Number.isInteger(rightNumber) && String(rightNumber) === right

    if (leftIsNumber && rightIsNumber) {
      if (leftNumber !== rightNumber) {
        return leftNumber > rightNumber ? 1 : -1
      }
      continue
    }

    if (leftIsNumber !== rightIsNumber) {
      return leftIsNumber ? -1 : 1
    }

    if (left !== right) {
      return left > right ? 1 : -1
    }
  }

  return 0
}

export function compareVersions(leftVersion: string, rightVersion: string): number {
  const left = parseVersion(leftVersion)
  const right = parseVersion(rightVersion)

  if (left.major !== right.major) return left.major > right.major ? 1 : -1
  if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1
  if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1
  return comparePrerelease(left.prerelease, right.prerelease)
}

export function parseReleaseTag(tag: string | null | undefined): ParsedReleaseTag | null {
  if (!tag) return null

  const semverMatch = /^v(\d+\.\d+\.\d+(?:-(daily)\.(\d{8})\.(\d+))?)$/.exec(tag)
  if (semverMatch) {
    return {
      tag,
      version: semverMatch[1],
      releaseChannel: semverMatch[2] === 'daily' ? 'daily' : 'stable'
    }
  }

  const legacyMatch = /^v(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/.exec(tag)
  if (legacyMatch) {
    const year = Number(legacyMatch[1])
    const month = Number(legacyMatch[2])
    const day = Number(legacyMatch[3])
    const rebuild = legacyMatch[4] ? Number(legacyMatch[4]) : null
    return {
      tag,
      version: `${year}.${month}.${day}${rebuild !== null ? `-${rebuild}` : ''}`,
      releaseChannel: 'daily'
    }
  }

  return null
}
