/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { basename } from 'node:path'
import type { ReleaseChannel, ReleaseOs } from './app-info.ts'

export interface ArchiveArtifactDescriptor {
  artifactName: string
  artifactUrl: string
  sha256: string
}

export interface RawUpdateManifest {
  channel?: unknown
  version?: unknown
  tag?: unknown
  platform?: unknown
  arch?: unknown
  artifactName?: unknown
  artifactUrl?: unknown
  sha256?: unknown
  archive?: unknown
  releaseNotes?: unknown
  publishedAt?: unknown
}

export interface NormalizedUpdateManifest {
  channel: ReleaseChannel
  version: string
  tag: string
  platform: ReleaseOs
  arch: 'arm64' | 'x64'
  artifactName: string
  artifactUrl: string
  sha256: string
  releaseNotes: string | null
  publishedAt: string
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isValidSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_RE.test(value)
}

export function isSafeArtifactFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value === basename(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes(':')
  )
}

export function isSafeZipArtifactName(value: string): boolean {
  return isSafeArtifactFileName(value) && value.toLowerCase().endsWith('.zip')
}

export function isSafeArtifactNameForPlatform(value: string, platform: ReleaseOs): boolean {
  if (!isSafeArtifactFileName(value)) return false
  if (platform === 'windows' || platform === 'macos' || platform === 'linux') {
    return value.toLowerCase().endsWith('.zip')
  }
  return false
}

function parseArchiveDescriptor(raw: unknown): ArchiveArtifactDescriptor | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Record<string, unknown>
  if (
    !isNonEmptyString(candidate.artifactName) ||
    !isNonEmptyString(candidate.artifactUrl) ||
    !isValidSha256(candidate.sha256)
  ) {
    return null
  }
  if (!isSafeZipArtifactName(candidate.artifactName)) {
    throw new Error(`Manifest archive artifact name is invalid: ${candidate.artifactName}`)
  }
  return {
    artifactName: candidate.artifactName,
    artifactUrl: candidate.artifactUrl,
    sha256: candidate.sha256.toLowerCase()
  }
}

export function normalizeUpdateManifest(
  raw: unknown,
  expected: {
    channel: ReleaseChannel
    platform: ReleaseOs
    arch: 'arm64' | 'x64' | null
  }
): NormalizedUpdateManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Manifest payload is not an object.')
  }

  const manifest = raw as RawUpdateManifest
  if (
    !isNonEmptyString(manifest.version) ||
    !isNonEmptyString(manifest.tag) ||
    !isNonEmptyString(manifest.artifactUrl) ||
    !isNonEmptyString(manifest.sha256) ||
    !isNonEmptyString(manifest.artifactName)
  ) {
    throw new Error('Manifest is missing required fields.')
  }

  if (!isValidSha256(manifest.sha256)) {
    throw new Error('Manifest SHA-256 is invalid.')
  }
  if (manifest.channel !== expected.channel) {
    throw new Error(`Manifest channel mismatch: expected ${expected.channel}, got ${String(manifest.channel)}`)
  }
  if (manifest.platform !== expected.platform) {
    throw new Error(`Manifest platform mismatch: expected ${expected.platform}, got ${String(manifest.platform)}`)
  }
  if (!expected.arch || manifest.arch !== expected.arch) {
    throw new Error(`Manifest architecture mismatch: expected ${expected.arch || 'unknown'}, got ${String(manifest.arch)}`)
  }

  const publishedAt = isNonEmptyString(manifest.publishedAt)
    ? manifest.publishedAt
    : new Date().toISOString()
  const releaseNotes = typeof manifest.releaseNotes === 'string' ? manifest.releaseNotes : null

  if (expected.platform === 'windows') {
    const archive = parseArchiveDescriptor(manifest.archive)
    if (archive) {
      return {
        channel: expected.channel,
        version: manifest.version,
        tag: manifest.tag,
        platform: expected.platform,
        arch: expected.arch,
        artifactName: archive.artifactName,
        artifactUrl: archive.artifactUrl,
        sha256: archive.sha256,
        releaseNotes,
        publishedAt
      }
    }

    if (isSafeZipArtifactName(manifest.artifactName)) {
      return {
        channel: expected.channel,
        version: manifest.version,
        tag: manifest.tag,
        platform: expected.platform,
        arch: expected.arch,
        artifactName: manifest.artifactName,
        artifactUrl: manifest.artifactUrl,
        sha256: manifest.sha256.toLowerCase(),
        releaseNotes,
        publishedAt
      }
    }

    throw new Error(
      `Windows update manifest must provide a .zip archive artifact (received ${manifest.artifactName}).`
    )
  }

  if (!isSafeArtifactNameForPlatform(manifest.artifactName, expected.platform)) {
    throw new Error(`Manifest artifact name is invalid for ${expected.platform}: ${manifest.artifactName}`)
  }

  return {
    channel: expected.channel,
    version: manifest.version,
    tag: manifest.tag,
    platform: expected.platform,
    arch: expected.arch,
    artifactName: manifest.artifactName,
    artifactUrl: manifest.artifactUrl,
    sha256: manifest.sha256.toLowerCase(),
    releaseNotes,
    publishedAt
  }
}
