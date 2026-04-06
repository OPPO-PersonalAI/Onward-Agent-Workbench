#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { spawnSync } = require('child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')
const { join, dirname } = require('path')
const { compileChangelogAssets } = require('./changelog-compiler')

function fail(message) {
  console.error(`Error: ${message}`)
  process.exit(1)
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf-8'
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'git command failed').trim())
  }
  return result.stdout.trim()
}

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

function parseReleaseTag(tag) {
  const semverMatch = /^v(\d+\.\d+\.\d+(?:-(daily)\.(\d{8})\.(\d+))?)$/.exec(tag)
  if (semverMatch) {
    return {
      tag,
      version: semverMatch[1],
      channel: semverMatch[2] === 'daily' ? 'daily' : 'stable'
    }
  }

  const legacyMatch = /^v(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/.exec(tag)
  if (legacyMatch) {
    const rebuild = legacyMatch[4] ? `-${Number(legacyMatch[4])}` : ''
    return {
      tag,
      version: `${Number(legacyMatch[1])}.${Number(legacyMatch[2])}.${Number(legacyMatch[3])}${rebuild}`,
      channel: 'daily'
    }
  }

  return null
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim())
  if (!match) {
    throw new Error(`Invalid version "${version}".`)
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  }
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index]
    const rightValue = right[index]
    if (leftValue === undefined) return -1
    if (rightValue === undefined) return 1

    const leftNumber = Number(leftValue)
    const rightNumber = Number(rightValue)
    const leftIsNumber = Number.isInteger(leftNumber) && String(leftNumber) === leftValue
    const rightIsNumber = Number.isInteger(rightNumber) && String(rightNumber) === rightValue

    if (leftIsNumber && rightIsNumber) {
      if (leftNumber !== rightNumber) {
        return leftNumber > rightNumber ? 1 : -1
      }
      continue
    }

    if (leftIsNumber !== rightIsNumber) {
      return leftIsNumber ? -1 : 1
    }

    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1
    }
  }

  return 0
}

function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion)
  const right = parseVersion(rightVersion)

  if (left.major !== right.major) return left.major > right.major ? 1 : -1
  if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1
  if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1
  return comparePrerelease(left.prerelease, right.prerelease)
}

function listReleaseTags(channel) {
  const raw = runGit(['tag', '--sort=-version:refname'])
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((tag) => parseReleaseTag(tag))
    .filter((entry) => entry && entry.channel === channel)
}

function resolvePreviousTag(release) {
  const candidates = listReleaseTags(release.channel)
    .filter((entry) => entry.tag !== release.tag)
    .filter((entry) => compareVersions(entry.version, release.version) < 0)
    .sort((left, right) => compareVersions(right.version, left.version))
  return candidates[0]?.tag || ''
}

function stripCommitPrefix(subject) {
  return subject
    .replace(/^(feat|fix|refactor|perf|chore|docs|test|build|ci)(\([^)]+\))?!?:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isChangelogCommit(subject) {
  return /(^|[\s:])changelog/i.test(subject) || /release notes/i.test(subject)
}

function classifyCommit(subject, body) {
  const normalized = `${subject}\n${body}`.toLowerCase()
  if (/\b(fix|bug|regress|crash|error|issue|broken|correct|repair)\b/.test(normalized)) {
    return 'bugFixes'
  }
  if (/\b(feat|feature|add|support|introduce|implement|create|new)\b/.test(normalized)) {
    return 'newFeatures'
  }
  return 'newFeatures'
}

function collectCommits(previousTag) {
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD'
  const format = '%H%x1f%s%x1f%b%x1e'
  const raw = runGit(['log', '--reverse', `--format=${format}`, range])
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', subject = '', body = ''] = record.split('\x1f')
      return {
        sha,
        subject: subject.trim(),
        body: body.trim()
      }
    })
    .filter((commit) => commit.subject.length > 0 && !isChangelogCommit(commit.subject))
}

function buildDraftSections(commits) {
  const sections = {
    newFeatures: [],
    bugFixes: []
  }

  for (const commit of commits) {
    const subject = stripCommitPrefix(commit.subject)
    if (!subject) continue
    const section = classifyCommit(commit.subject, commit.body)
    sections[section].push(subject)
  }

  sections.newFeatures = Array.from(new Set(sections.newFeatures))
  sections.bugFixes = Array.from(new Set(sections.bugFixes))
  return sections
}

function ensureArrayWithFallback(items, fallback) {
  return items.length > 0 ? items : [fallback]
}

function buildEnglishMarkdown(tag, previousTag, sections) {
  const intro = previousTag
    ? `Changes since \`${previousTag}\`.`
    : 'Initial tagged release. Review and refine the sections below before publishing.'
  const newFeatures = ensureArrayWithFallback(
    sections.newFeatures,
    'Review the commits in this range and add the user-facing new features here.'
  )
  const bugFixes = ensureArrayWithFallback(
    sections.bugFixes,
    'Review the commits in this range and add the user-facing bug fixes here.'
  )

  return [
    `# Onward Daily Build ${tag}`,
    '',
    intro,
    '',
    '## New Features',
    ...newFeatures.map((item) => `- ${item}`),
    '',
    '## Bug Fixes',
    ...bugFixes.map((item) => `- ${item}`),
    ''
  ].join('\n')
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function writeFile(path, content) {
  ensureDir(dirname(path))
  writeFileSync(path, content, 'utf-8')
}

function readIndex(indexPath) {
  if (!existsSync(indexPath)) {
    return { entries: [] }
  }
  const parsed = JSON.parse(readFileSync(indexPath, 'utf-8'))
  return Array.isArray(parsed.entries)
    ? parsed
    : { entries: [] }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const tag = String(args.tag || '').trim()
  if (!tag) {
    fail('Missing required argument --tag')
  }

  const release = parseReleaseTag(tag)
  if (!release) {
    fail(`Unsupported tag format "${tag}".`)
  }

  const previousTag = String(args['previous-tag'] || '').trim() || (() => {
    return resolvePreviousTag(release)
  })()

  const commits = collectCommits(previousTag || null)
  const sections = buildDraftSections(commits)
  const changelogRoot = String(args.output || '').trim() || join(process.cwd(), 'resources', 'changelog')
  const englishRelativePath = join('en', release.channel, `${tag}.md`)
  const englishPath = join(changelogRoot, englishRelativePath)
  const indexPath = join(changelogRoot, 'index.json')

  writeFile(englishPath, buildEnglishMarkdown(tag, previousTag || null, sections))

  const index = readIndex(indexPath)
  const publishedAt = new Date().toISOString()
  const nextEntry = {
    tag,
    version: release.version,
    channel: release.channel,
    previousTag: previousTag || null,
    publishedAt,
    markdown: {
      en: englishRelativePath.replace(/\\/g, '/')
    }
  }

  const remainingEntries = index.entries.filter((entry) => entry && entry.tag !== tag)
  const nextIndex = {
    entries: [nextEntry, ...remainingEntries]
  }
  writeFile(indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`)
  compileChangelogAssets(changelogRoot)

  console.log(`Generated Change Log draft for ${tag}`)
  console.log(`Previous tag: ${previousTag || '(none)'}`)
  console.log(`English draft: ${englishPath}`)
  console.log(`Index file: ${indexPath}`)
  console.log(`Commit count analyzed: ${commits.length}`)
}

main()
