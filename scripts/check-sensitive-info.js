#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { execFileSync } = require('child_process')
const { existsSync, readFileSync } = require('fs')
const { resolve } = require('path')
const zlib = require('zlib')
const { containsChinese } = require('./check-chinese-comments.js')

const ROOT = resolve(__dirname, '..')
const BINARY_RE = /\0/

// Helper to join fragments so literal grep across the repo does not match the
// scanner definition itself.
const p = (...parts) => parts.join('')

const ALLOWED_PATH_USERNAMES = new Set([
  'example',
  'user',
  'username',
  'me',
  'alice',
  'bob',
  'test',
  'tester',
  'admin',
  'runner',
  'ubuntu',
  'dev',
  'developer',
  'you',
  'your-name',
  'yourname',
  'someone',
  'x',
  'foo',
  'bar',
  'default',
  'public',
  'shared'
])

const DISALLOWED_DIRECT_USERS_SUBDIRS = new Set([
  'documents',
  'desktop',
  'downloads',
  'projects',
  'appdata',
  'workspaces'
])

const SENSITIVE_TOKEN_RULES = [
  // Category 2: Employee/contractor IDs, internal domains, and handles
  {
    id: 'employee-id-8025',
    category: 'employee-id-or-handle',
    regex: new RegExp(p('8025', '3146'), 'i'),
    description: 'Leaked numeric employee ID'
  },
  {
    id: 'contractor-id-w907',
    category: 'employee-id-or-handle',
    regex: new RegExp(p('w907', '7731'), 'i'),
    description: 'Leaked contractor employee ID'
  },
  {
    id: 'internal-adc-domain',
    category: 'employee-id-or-handle',
    regex: new RegExp(p('@adc', '\\.com\\b'), 'i'),
    description: 'Leaked internal contractor email domain'
  },
  {
    id: 'internal-intranet-host',
    category: 'employee-id-or-handle',
    regex: new RegExp(p('\\b(?:gitlab|gerrit|oa|intranet| internal|corp)\\.', 'oppo\\.com\\b'), 'i'),
    description: 'Leaked internal intranet hostname'
  },
  {
    id: 'developer-handle-yy',
    category: 'employee-id-or-handle',
    regex: new RegExp(p('\\bying', 'yun\\b'), 'i'),
    description: 'Leaked developer machine handle'
  },
  {
    id: 'tester-handle-lx',
    category: 'employee-id-or-handle',
    regex: new RegExp(p('\\blan', 'xi\\b'), 'i'),
    description: 'Leaked internal tester handle'
  },

  // Category 3: Internal R&D & unrelated personal project/branch/file names
  {
    id: 'internal-project-1',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('OPPO', '-KAR'), 'i'),
    description: 'Leaked internal project identifier'
  },
  {
    id: 'internal-project-2',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('KAR-Game', '-Develop'), 'i'),
    description: 'Leaked internal project identifier'
  },
  {
    id: 'internal-submodule-1',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('kar', '-?qemu'), 'i'),
    description: 'Leaked internal submodule identifier'
  },
  {
    id: 'path-third-party-sub',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('third_party', '[/\\\\]+KAR\\b'), 'i'),
    description: 'Leaked internal third_party path'
  },
  {
    id: 'file-internal-air-control',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('kar_air', '_control'), 'i'),
    description: 'Leaked internal source filename'
  },
  {
    id: 'project-internal-rtos-1',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('winWatch', 'RTOS'), 'i'),
    description: 'Leaked internal RTOS project identifier'
  },
  {
    id: 'project-internal-rtos-2',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('RTOS-', 'stablity'), 'i'),
    description: 'Leaked internal RTOS workspace directory'
  },
  {
    id: 'project-internal-rtos-worktree',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('win-rtos-build', '-worktree'), 'i'),
    description: 'Leaked internal RTOS worktree identifier'
  },
  {
    id: 'branch-internal-036',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('\\bkae', '-0\\.36\\b'), 'i'),
    description: 'Leaked internal release branch name'
  },
  {
    id: 'project-internal-compiler',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('\\bkae_', 'compiler\\b'), 'i'),
    description: 'Leaked internal compiler repo name'
  },
  {
    id: 'branch-internal-feature',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('\\bkae-', 'feature\\b'), 'i'),
    description: 'Leaked internal feature branch name'
  },
  {
    id: 'project-internal-ai',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('\\bwf', '[-_]ai\\b'), 'i'),
    description: 'Leaked internal AI repo name'
  },
  {
    id: 'project-internal-tool',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('\\bwf', '[-_]tool\\b'), 'i'),
    description: 'Leaked internal tool repo name'
  },
  {
    id: 'project-internal-report-material',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('Onward_report', '_material'), 'i'),
    description: 'Leaked internal report material directory name'
  },
  {
    id: 'project-personal-forward',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('Project', '(?:[_\\s]|%20)Forward\\b'), 'i'),
    description: 'Leaked unrelated personal project name'
  },
  {
    id: 'project-personal-battle',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('\\bBattle', 'Project\\b'), 'i'),
    description: 'Leaked unrelated personal project name'
  },
  {
    id: 'project-personal-books',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('Books_', 'Translation'), 'i'),
    description: 'Leaked unrelated personal project name'
  },
  {
    id: 'project-personal-pdf',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('Dark_PDF', '_Reader'), 'i'),
    description: 'Leaked unrelated personal project name'
  },
  {
    id: 'project-personal-asr',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('\\bProject_', 'ASR\\b'), 'i'),
    description: 'Leaked unrelated personal project name'
  },
  {
    id: 'project-legacy-folder-1',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('\\bProject_', 'Onward2\\b'), 'i'),
    description: 'Leaked pre-open-source local folder name'
  },
  {
    id: 'project-legacy-folder-2',
    category: 'internal-or-unrelated-project',
    regex: new RegExp(p('\\bOnward-', 'Github\\b'), 'i'),
    description: 'Leaked pre-open-source local folder name'
  },

  // Category 4: Corporate IT / MDM / EDR vendor names
  {
    id: 'corporate-mdm-vendor',
    category: 'corporate-it-edr-vendor',
    regex: new RegExp(p('\\bIn', 'tune\\b'), 'i'),
    description: 'Leaked corporate MDM vendor name'
  },
  {
    id: 'corporate-edr-vendor',
    category: 'corporate-it-edr-vendor',
    regex: new RegExp(p('\\bSang', 'for\\b'), 'i'),
    description: 'Leaked corporate security vendor name'
  },
  {
    id: 'corporate-zt-vendor',
    category: 'corporate-it-edr-vendor',
    regex: new RegExp(p('\\ba', 'Trust\\b'), 'i'),
    description: 'Leaked corporate zero-trust client name'
  },
  {
    id: 'corporate-dlp-vendor',
    category: 'corporate-it-edr-vendor',
    regex: new RegExp(p('\\bIsa', 'Agent\\b'), 'i'),
    description: 'Leaked corporate DLP agent name'
  },
  {
    id: 'diagnostic-bundle-filename',
    category: 'diagnostic-analysis-artifact',
    regex: new RegExp(
      p('\\bonward-diagnostic-', '\\d{4}-\\d{2}-\\d{2}(?:[_T-]\\d{2}-\\d{2}-\\d{2})?'),
      'i'
    ),
    description: 'Leaked concrete Onward diagnostic bundle or report filename/timestamp'
  }
]

const FORBIDDEN_FILE_PATH_RULES = [
  {
    id: 'forbidden-handoff-file',
    category: 'temporary-session-file',
    regex: /(?:^|[/\\])HANDOFF[^/\\]*\.html$/i,
    description: 'Temporary session handoff HTML file must not be committed'
  },
  {
    id: 'forbidden-logs-dir',
    category: 'diagnostic-analysis-artifact',
    regex: /(?:^|[/\\])Logs[/\\]/i,
    description: 'Local diagnostic analysis directory (Logs/) must never be committed'
  },
  {
    id: 'forbidden-bug-tracking-artifact',
    category: 'diagnostic-analysis-artifact',
    regex: /(?:^|[/\\])bug-tracking(?:[/\\]|$)|(?:^|[/\\])BUG-\d{4}-[^/\\]*\.(?:md|html)$/i,
    description: 'ow_log_analysis bug-tracking notes are strictly for local analysis and must never be committed'
  },
  {
    id: 'forbidden-diagnostic-bundle-or-report',
    category: 'diagnostic-analysis-artifact',
    regex: /(?:^|[/\\])[^/\\]*onward-diagnostic-[^/\\]*(?:[/\\]|$)|(?:^|[/\\])onward-diag-[A-Za-z0-9_-]+(?:[/\\]|$)/i,
    description: 'Onward diagnostic bundle or ow_log_analysis HTML report must never be committed'
  }
]

const TAR_GZ_EXTENSIONS = ['.tar.gz', '.tgz']
const TAR_EXTENSIONS = ['.tar']

// Known binary extensions that should not be read as UTF-8 text
const KNOWN_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.icns',
  '.bmp',
  '.pdf',
  '.epub',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  '.pfb',
  '.bcmap',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
  '.ogg',
  '.zip',
  '.7z',
  '.rar',
  '.vsix',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.wasm',
  '.bin',
  '.dat',
  '.vhdx'
])

function decodeObfuscatedText(input) {
  let decoded = String(input)
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (match, hex) => {
      const cp = parseInt(hex, 16)
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : match
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (match, hex) => {
      const cp = parseInt(hex, 16)
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : match
    })
    .replace(/&#([0-9]{1,7});/g, (match, dec) => {
      const cp = parseInt(dec, 10)
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : match
    })

  // Also decode %XX URL percent escapes for ASCII range (0x20..0x7E)
  decoded = decoded.replace(/%([2-7][0-9a-fA-F])/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  )
  return decoded
}

function isAllowedUsernameSegment(segment) {
  if (!segment) return true
  const cleaned = segment.trim()
  if (!cleaned) return true
  // Template/wildcard/ellipsis placeholders such as <user>, ${USER}, $USER, ..., *
  if (
    cleaned.startsWith('<') ||
    cleaned.startsWith('$') ||
    cleaned.startsWith('{') ||
    cleaned.startsWith('%') ||
    cleaned.includes('*') ||
    cleaned === '...' ||
    cleaned === '…'
  ) {
    return true
  }
  const lower = cleaned.toLowerCase()
  if (DISALLOWED_DIRECT_USERS_SUBDIRS.has(lower)) {
    return false
  }
  return ALLOWED_PATH_USERNAMES.has(lower)
}

function detectLocalUserPaths(text) {
  const hits = []

  // 1. Windows drive user paths: C:\Users\<seg> or D:/Users/<seg>
  const winRegex = /(?:^|[^A-Za-z0-9_])([A-Za-z]:(?:[/\\]+Users[/\\]+)([A-Za-z0-9._-]+))/g
  let match
  while ((match = winRegex.exec(text)) !== null) {
    const fullMatch = match[1]
    const userSeg = match[2]
    if (!isAllowedUsernameSegment(userSeg)) {
      hits.push({
        ruleId: 'local-user-path-windows',
        category: 'local-user-path',
        match: fullMatch,
        description: `Non-placeholder Windows user path (${fullMatch})`
      })
    }
  }

  // 2. macOS user paths: /Users/<seg>
  const macRegex = /(?:^|[^A-Za-z0-9_])(\/Users\/([A-Za-z0-9._-]+))/g
  while ((match = macRegex.exec(text)) !== null) {
    const fullMatch = match[1]
    const userSeg = match[2]
    if (!isAllowedUsernameSegment(userSeg)) {
      hits.push({
        ruleId: 'local-user-path-macos',
        category: 'local-user-path',
        match: fullMatch,
        description: `Non-placeholder macOS user path (${fullMatch})`
      })
    }
  }

  // 3. Linux user paths: /home/<seg>
  const linuxRegex = /(?:^|[^A-Za-z0-9_])(\/home\/([A-Za-z0-9._-]+))/g
  while ((match = linuxRegex.exec(text)) !== null) {
    const fullMatch = match[1]
    const userSeg = match[2]
    if (!isAllowedUsernameSegment(userSeg)) {
      hits.push({
        ruleId: 'local-user-path-linux',
        category: 'local-user-path',
        match: fullMatch,
        description: `Non-placeholder Linux user path (${fullMatch})`
      })
    }
  }

  // 4. Personal Windows drive root workspaces (e.g. Y:\oppo_...)
  const driveWorkspaceRegex = new RegExp(
    p('(?:^|[^A-Za-z0-9_])([A-Za-z]:[/\\\\]+(?:oppo_[A-Za-z0-9_-]+))'),
    'gi'
  )
  while ((match = driveWorkspaceRegex.exec(text)) !== null) {
    hits.push({
      ruleId: 'local-user-path-drive-workspace',
      category: 'local-user-path',
      match: match[1],
      description: `Leaked personal drive workspace path (${match[1]})`
    })
  }

  return hits
}

function scanLineForSensitiveInfo(lineText) {
  const candidates = [String(lineText)]
  const decoded = decodeObfuscatedText(lineText)
  if (decoded !== lineText) {
    candidates.push(decoded)
  }

  const hits = []
  const seenKeys = new Set()

  for (const candidate of candidates) {
    for (const pathHit of detectLocalUserPaths(candidate)) {
      const key = `${pathHit.ruleId}:${pathHit.match}`
      if (!seenKeys.has(key)) {
        seenKeys.add(key)
        hits.push(pathHit)
      }
    }

    for (const rule of SENSITIVE_TOKEN_RULES) {
      const m = rule.regex.exec(candidate)
      if (m) {
        const key = `${rule.id}:${m[0]}`
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          hits.push({
            ruleId: rule.id,
            category: rule.category,
            match: m[0],
            description: rule.description
          })
        }
      }
    }
  }

  return hits
}

function scanTextContent(content, relPath = '<memory>') {
  if (BINARY_RE.test(content.slice(0, 4096))) {
    return []
  }

  const findings = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]
    const lineHits = scanLineForSensitiveInfo(lineText)
    for (const hit of lineHits) {
      findings.push({
        file: relPath,
        line: i + 1,
        ruleId: hit.ruleId,
        category: hit.category,
        match: hit.match,
        description: hit.description,
        snippet: lineText.trim().slice(0, 200)
      })
    }
  }
  return findings
}

function readNullTerminatedAscii(buf, start, end) {
  let s = ''
  for (let i = start; i < end; i++) {
    const byte = buf[i]
    if (byte === 0) break
    s += String.fromCharCode(byte)
  }
  return s.trim()
}

function scanTarBuffer(tarBuf, relPath = '<archive.tar>') {
  const findings = []
  const BLOCK = 512
  let offset = 0

  while (offset + BLOCK <= tarBuf.length) {
    let allZero = true
    for (let i = 0; i < BLOCK; i++) {
      if (tarBuf[offset + i] !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) {
      offset += BLOCK
      continue
    }

    const entryName = readNullTerminatedAscii(tarBuf, offset, offset + 100)
    const uidOctal = readNullTerminatedAscii(tarBuf, offset + 108, offset + 116)
    const gidOctal = readNullTerminatedAscii(tarBuf, offset + 116, offset + 124)
    const sizeOctal = readNullTerminatedAscii(tarBuf, offset + 124, offset + 136)
    const magic = readNullTerminatedAscii(tarBuf, offset + 257, offset + 263)
    const uname = readNullTerminatedAscii(tarBuf, offset + 265, offset + 297)
    const gname = readNullTerminatedAscii(tarBuf, offset + 297, offset + 329)

    if (magic.startsWith('ustar')) {
      const uid = parseInt(uidOctal || '0', 8)
      const gid = parseInt(gidOctal || '0', 8)

      if (uname && uname !== 'root' && uname !== '0') {
        findings.push({
          file: relPath,
          line: 0,
          ruleId: 'tar-ustar-uname',
          category: 'tar-archive-leak',
          match: uname,
          description: `Tar header for "${entryName}" leaks OS username in uname field ("${uname}")`,
          snippet: `entry=${entryName} uname=${uname}`
        })
      }

      if (gname && gname !== 'root' && gname !== '0') {
        findings.push({
          file: relPath,
          line: 0,
          ruleId: 'tar-ustar-gname',
          category: 'tar-archive-leak',
          match: gname,
          description: `Tar header for "${entryName}" leaks OS group name in gname field ("${gname}")`,
          snippet: `entry=${entryName} gname=${gname}`
        })
      }

      if (Number.isFinite(uid) && uid > 0) {
        findings.push({
          file: relPath,
          line: 0,
          ruleId: 'tar-ustar-uid',
          category: 'tar-archive-leak',
          match: uidOctal,
          description: `Tar header for "${entryName}" contains non-zero UID (${uid})`,
          snippet: `entry=${entryName} uid=${uidOctal}`
        })
      }

      if (Number.isFinite(gid) && gid > 0) {
        findings.push({
          file: relPath,
          line: 0,
          ruleId: 'tar-ustar-gid',
          category: 'tar-archive-leak',
          match: gidOctal,
          description: `Tar header for "${entryName}" contains non-zero GID (${gid})`,
          snippet: `entry=${entryName} gid=${gidOctal}`
        })
      }
    }

    for (const hit of scanLineForSensitiveInfo(entryName)) {
      findings.push({
        file: relPath,
        line: 0,
        ruleId: hit.ruleId,
        category: hit.category,
        match: hit.match,
        description: `Tar entry path "${entryName}": ${hit.description}`,
        snippet: entryName
      })
    }

    const size = parseInt(sizeOctal || '0', 8) || 0
    const payloadStart = offset + BLOCK
    const payloadEnd = Math.min(tarBuf.length, payloadStart + size)
    if (size > 0 && payloadEnd > payloadStart) {
      const payloadBuf = tarBuf.subarray(payloadStart, payloadEnd)
      // Scan text payloads inside the tar archive
      if (!payloadBuf.subarray(0, Math.min(512, payloadBuf.length)).includes(0)) {
        const text = payloadBuf.toString('utf-8')
        const innerFindings = scanTextContent(text, `${relPath}::${entryName}`)
        findings.push(...innerFindings)
      }
    }

    const dataBlocks = Math.ceil(size / BLOCK)
    offset += BLOCK + dataBlocks * BLOCK
  }

  return findings
}

function scanTarGzBuffer(gzBuf, relPath = '<archive.tar.gz>') {
  const tarBuf = zlib.gunzipSync(gzBuf)
  return scanTarBuffer(tarBuf, relPath)
}

function validateGitAuthorIdentity({ name, email }) {
  const trimmedName = String(name || '').trim()
  const trimmedEmail = String(email || '').trim()
  const issues = []

  if (!trimmedName) {
    issues.push({
      ruleId: 'git-author-empty-name',
      description: 'Git user.name is empty'
    })
  }
  if (!trimmedEmail) {
    issues.push({
      ruleId: 'git-author-empty-email',
      description: 'Git user.email is empty'
    })
  }

  // Check if name or email is a raw numeric employee ID or contractor ID
  const employeeIdPattern = /^(?:\d{6,10}|[a-z]\d{6,10}|oppo_[a-z0-9_]+)$/i
  if (employeeIdPattern.test(trimmedName)) {
    issues.push({
      ruleId: 'git-author-employee-id-name',
      description: `Git user.name "${trimmedName}" looks like an internal employee/contractor ID`
    })
  }

  const emailLocalPart = trimmedEmail.split('@')[0] || ''
  if (employeeIdPattern.test(emailLocalPart)) {
    issues.push({
      ruleId: 'git-author-employee-id-email',
      description: `Git user.email "${trimmedEmail}" local-part looks like an internal employee/contractor ID`
    })
  }

  for (const hit of scanLineForSensitiveInfo(`${trimmedName} <${trimmedEmail}>`)) {
    issues.push({
      ruleId: hit.ruleId,
      description: `Git author identity "${trimmedName} <${trimmedEmail}>" matched ${hit.ruleId}: ${hit.description}`
    })
  }

  return {
    ok: issues.length === 0,
    issues
  }
}

function scanCommitMessageText(messageText) {
  const issues = []
  const lines = String(messageText || '').split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Ignore git commit comment lines starting with #
    if (line.trimStart().startsWith('#')) continue

    if (containsChinese(line)) {
      issues.push({
        line: i + 1,
        ruleId: 'commit-msg-chinese',
        description: 'Commit message must be written in English only (no Chinese characters or Unicode escapes)',
        snippet: line.trim()
      })
    }

    for (const hit of scanLineForSensitiveInfo(line)) {
      issues.push({
        line: i + 1,
        ruleId: hit.ruleId,
        description: hit.description,
        snippet: line.trim()
      })
    }
  }

  return {
    ok: issues.length === 0,
    issues
  }
}

function isTextFilePath(relPath) {
  const lower = relPath.toLowerCase()
  for (const ext of TAR_GZ_EXTENSIONS) {
    if (lower.endsWith(ext)) return false
  }
  for (const ext of TAR_EXTENSIONS) {
    if (lower.endsWith(ext)) return false
  }
  const baseName = lower.slice(Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\')) + 1)
  const lastDot = baseName.lastIndexOf('.')
  // Dotfiles without a secondary extension (e.g. .zshrc, .gitignore) or files with no extension
  if (lastDot <= 0) return true
  const ext = baseName.slice(lastDot)
  return !KNOWN_BINARY_EXTENSIONS.has(ext)
}

function isTarGzFilePath(relPath) {
  const lower = relPath.toLowerCase()
  return TAR_GZ_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function isTarFilePath(relPath) {
  const lower = relPath.toLowerCase()
  return TAR_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function getCandidateFiles(stagedOnly = false) {
  const args = stagedOnly
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
    : ['ls-files', '--cached', '--others', '--exclude-standard']
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf-8'
  })
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean)
}

function scanFilePathForForbiddenRules(relPath) {
  const findings = []
  for (const rule of FORBIDDEN_FILE_PATH_RULES) {
    const m = rule.regex.exec(relPath)
    if (m) {
      findings.push({
        file: relPath,
        line: 0,
        ruleId: rule.id,
        category: rule.category,
        match: m[0],
        description: `File path "${relPath}": ${rule.description}`,
        snippet: relPath
      })
    }
  }
  for (const pathHit of scanLineForSensitiveInfo(relPath)) {
    findings.push({
      file: relPath,
      line: 0,
      ruleId: pathHit.ruleId,
      category: pathHit.category,
      match: pathHit.match,
      description: `File path "${relPath}": ${pathHit.description}`,
      snippet: relPath
    })
  }
  return findings
}

function scanRepositoryFile(relPath) {
  const absPath = resolve(ROOT, relPath)
  if (!existsSync(absPath)) return []

  // Also check the tracked file path itself for forbidden filenames or sensitive tokens
  const findings = scanFilePathForForbiddenRules(relPath)

  if (isTarGzFilePath(relPath)) {
    const gzBuf = readFileSync(absPath)
    findings.push(...scanTarGzBuffer(gzBuf, relPath))
    return findings
  }

  if (isTarFilePath(relPath)) {
    const tarBuf = readFileSync(absPath)
    findings.push(...scanTarBuffer(tarBuf, relPath))
    return findings
  }

  if (isTextFilePath(relPath)) {
    const content = readFileSync(absPath, 'utf-8')
    findings.push(...scanTextContent(content, relPath))
  }

  return findings
}

function checkCurrentGitAuthor() {
  let configName = ''
  let configEmail = ''
  try {
    configName = execFileSync('git', ['config', 'user.name'], {
      cwd: ROOT,
      encoding: 'utf-8'
    }).trim()
  } catch {
    // handled by validateGitAuthorIdentity
  }
  try {
    configEmail = execFileSync('git', ['config', 'user.email'], {
      cwd: ROOT,
      encoding: 'utf-8'
    }).trim()
  } catch {
    // handled by validateGitAuthorIdentity
  }

  const authorRes = validateGitAuthorIdentity({
    name: process.env.GIT_AUTHOR_NAME || configName,
    email: process.env.GIT_AUTHOR_EMAIL || configEmail
  })

  if (process.env.GIT_COMMITTER_NAME || process.env.GIT_COMMITTER_EMAIL) {
    const committerRes = validateGitAuthorIdentity({
      name: process.env.GIT_COMMITTER_NAME || configName,
      email: process.env.GIT_COMMITTER_EMAIL || configEmail
    })
    const combinedIssues = [...authorRes.issues, ...committerRes.issues]
    return {
      ok: combinedIssues.length === 0,
      issues: combinedIssues
    }
  }

  return authorRes
}

function main() {
  const args = process.argv.slice(2)

  if (args.includes('--git-author') || args.includes('--check-author')) {
    const result = checkCurrentGitAuthor()
    if (!result.ok) {
      console.error('[sensitive-info-lint] Failed: Git author identity check failed.')
      for (const issue of result.issues) {
        console.error(`  - [${issue.ruleId}] ${issue.description}`)
      }
      process.exit(1)
    }
    console.log('[sensitive-info-lint] Passed: Git author identity is clean.')
    if (args.length === 1) return
  }

  const commitMsgIdx = args.indexOf('--commit-msg')
  if (commitMsgIdx !== -1) {
    const msgFile = args[commitMsgIdx + 1]
    if (!msgFile || !existsSync(msgFile)) {
      console.error('[sensitive-info-lint] Failed: --commit-msg requires a valid commit message file path.')
      process.exit(1)
    }
    const content = readFileSync(msgFile, 'utf-8')
    const result = scanCommitMessageText(content)
    if (!result.ok) {
      console.error('[sensitive-info-lint] Failed: Commit message contains forbidden or sensitive content.')
      for (const issue of result.issues) {
        console.error(`  line ${issue.line} [${issue.ruleId}]: ${issue.description} -> ${issue.snippet}`)
      }
      process.exit(1)
    }
    console.log('[sensitive-info-lint] Passed: Commit message is clean.')
    return
  }

  const stagedOnly = args.includes('--staged')
  const files = getCandidateFiles(stagedOnly)
  const findings = files.flatMap(scanRepositoryFile)

  if (findings.length === 0) {
    console.log(
      `[sensitive-info-lint] Passed: scanned ${files.length} ${stagedOnly ? 'staged' : 'tracked'} files (text + .tar.gz fixtures) with 0 sensitive-info findings.`
    )
    return
  }

  console.error(`[sensitive-info-lint] Failed: found ${findings.length} sensitive-information leak(s):`)
  for (const f of findings) {
    const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file
    console.error(`  ${loc} [${f.ruleId}] (${f.description}): ${f.snippet}`)
  }
  process.exit(1)
}

if (require.main === module) {
  main()
}

module.exports = {
  decodeObfuscatedText,
  detectLocalUserPaths,
  scanLineForSensitiveInfo,
  scanTextContent,
  scanTarBuffer,
  scanTarGzBuffer,
  validateGitAuthorIdentity,
  scanCommitMessageText,
  isTextFilePath,
  scanFilePathForForbiddenRules,
  scanRepositoryFile
}
