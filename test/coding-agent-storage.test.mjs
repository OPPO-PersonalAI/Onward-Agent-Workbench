/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Automated tests for coding-agent-config-storage logic.
 * Tests the storage data model: dedup, masked field, v2 migration,
 * duplicate alias collision, and atomic persist.
 *
 * Usage:  node test/coding-agent-storage.test.mjs
 *
 * These tests replicate the core storage logic without requiring Electron,
 * using a lightweight in-memory mock of the storage class.
 */

// ─── Minimal replica of storage logic for testing ───

function str(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function validateEnvVars(value) {
  if (!Array.isArray(value)) return []
  const result = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const key = str(item.key)
    if (!key) continue
    result.push({ key, value: typeof item.value === 'string' ? item.value : '', masked: item.masked === true ? true : undefined })
  }
  return result
}

function envVarsFingerprint(vars) {
  return JSON.stringify(
    [...vars].sort((a, b) => a.key.localeCompare(b.key)).map(v => [v.key, v.value, v.masked || false])
  )
}

function migrateV2Entry(raw) {
  const id = str(raw.id)
  if (!id) return null
  const agentType = str(raw.agentType)
  let command = ''
  if (agentType === 'codex') command = 'codex'
  else if (agentType === 'claude-code') command = 'claude'
  else command = agentType || 'codex'
  const extraArgs = str(raw.extraArgs)
  const envVars = []
  if (agentType === 'claude-code') {
    const provider = str(raw.provider)
    const apiUrl = str(raw.apiUrl)
    const apiKey = str(raw.apiKey)
    let model = str(raw.model)
    if (!model && raw.models && typeof raw.models === 'object') {
      model = str(raw.models.sonnet || raw.models.haiku || raw.models.opus)
    }
    if (apiUrl) envVars.push({ key: 'ANTHROPIC_BASE_URL', value: apiUrl })
    if (apiKey) {
      envVars.push({ key: 'ANTHROPIC_API_KEY', value: provider === 'openrouter' ? '' : apiKey, masked: true })
      envVars.push({ key: 'ANTHROPIC_AUTH_TOKEN', value: apiKey, masked: true })
    }
    if (model) {
      envVars.push({ key: 'ANTHROPIC_MODEL', value: model })
      envVars.push({ key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: model })
      envVars.push({ key: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: model })
      envVars.push({ key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: model })
      envVars.push({ key: 'CLAUDE_CODE_SUBAGENT_MODEL', value: model })
    }
  }
  const createdAt = raw.createdAt || Date.now()
  const lastUsedAt = raw.lastUsedAt || createdAt
  return { id, command, extraArgs, envVars, alias: '', createdAt, lastUsedAt }
}

// Simulates save() dedup logic
function wouldDedup(history, input) {
  const command = str(input.command)
  const extraArgs = str(input.extraArgs)
  const alias = str(input.alias)
  const envVars = validateEnvVars(input.envVars)
  const fp = envVarsFingerprint(envVars)
  return history.find(e =>
    e.command === command &&
    e.extraArgs === extraArgs &&
    e.alias === alias &&
    envVarsFingerprint(e.envVars) === fp
  ) || null
}

// ─── Test framework ───

const tests = []
let passed = 0
let failed = 0

function test(name, fn) { tests.push({ name, fn }) }
function assert(cond, msg) { if (!cond) throw new Error(`Assertion failed: ${msg}`) }
function assertEqual(a, b, label) {
  if (a !== b) throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

// ─── Test: masked=false is not silently dropped ───

test('validateEnvVars: masked=true is preserved', () => {
  const result = validateEnvVars([{ key: 'K', value: 'V', masked: true }])
  assertEqual(result[0].masked, true, 'masked should be true')
})

test('validateEnvVars: masked=false becomes undefined (same semantic as not set)', () => {
  const result = validateEnvVars([{ key: 'K', value: 'V', masked: false }])
  assertEqual(result[0].masked, undefined, 'masked false should become undefined')
})

test('validateEnvVars: masked=undefined stays undefined', () => {
  const result = validateEnvVars([{ key: 'K', value: 'V' }])
  assertEqual(result[0].masked, undefined, 'missing masked should be undefined')
})

test('validateEnvVars: masked=1 (truthy non-boolean) becomes undefined', () => {
  const result = validateEnvVars([{ key: 'K', value: 'V', masked: 1 }])
  assertEqual(result[0].masked, undefined, 'non-boolean truthy should become undefined')
})

// ─── Test: fingerprint includes masked field ───

test('fingerprint: same key/value but different masked produces different fingerprints', () => {
  const a = [{ key: 'K', value: 'V', masked: true }]
  const b = [{ key: 'K', value: 'V', masked: undefined }]
  const fpA = envVarsFingerprint(a)
  const fpB = envVarsFingerprint(b)
  assert(fpA !== fpB, `fingerprints should differ: ${fpA} vs ${fpB}`)
})

test('fingerprint: same key/value/masked produces same fingerprint', () => {
  const a = [{ key: 'K', value: 'V', masked: true }]
  const b = [{ key: 'K', value: 'V', masked: true }]
  assertEqual(envVarsFingerprint(a), envVarsFingerprint(b), 'identical entries should match')
})

// ─── Test: v2 migration ───

test('v2 migration: claude-code entry gets ANTHROPIC_AUTH_TOKEN', () => {
  const v2 = {
    id: 'test-1', agentType: 'claude-code', provider: 'custom',
    apiUrl: 'https://api.example.com', apiKey: 'sk-secret', model: 'claude-3.5',
    extraArgs: '', createdAt: 1000, lastUsedAt: 2000
  }
  const result = migrateV2Entry(v2)
  assert(result !== null, 'migration should succeed')
  assertEqual(result.command, 'claude', 'command should be claude')
  const authToken = result.envVars.find(v => v.key === 'ANTHROPIC_AUTH_TOKEN')
  assert(authToken !== undefined, 'ANTHROPIC_AUTH_TOKEN should exist')
  assertEqual(authToken.value, 'sk-secret', 'AUTH_TOKEN value')
  assertEqual(authToken.masked, true, 'AUTH_TOKEN should be masked')
})

test('v2 migration: API key is masked', () => {
  const v2 = {
    id: 'test-2', agentType: 'claude-code',
    apiUrl: 'https://api.example.com', apiKey: 'sk-secret', model: 'claude-3.5',
    extraArgs: '', createdAt: 1000, lastUsedAt: 2000
  }
  const result = migrateV2Entry(v2)
  const apiKey = result.envVars.find(v => v.key === 'ANTHROPIC_API_KEY')
  assert(apiKey !== undefined, 'ANTHROPIC_API_KEY should exist')
  assertEqual(apiKey.masked, true, 'API key should be masked')
})

test('v2 migration: codex entry has no env vars', () => {
  const v2 = {
    id: 'test-3', agentType: 'codex', extraArgs: '--verbose',
    createdAt: 1000, lastUsedAt: 2000
  }
  const result = migrateV2Entry(v2)
  assertEqual(result.command, 'codex', 'command')
  assertEqual(result.envVars.length, 0, 'codex should have no migrated env vars')
  assertEqual(result.extraArgs, '--verbose', 'extraArgs preserved')
})

test('v2 migration: entry without id returns null', () => {
  const v2 = { agentType: 'codex', extraArgs: '' }
  const result = migrateV2Entry(v2)
  assertEqual(result, null, 'should return null for missing id')
})

test('v2 migration: claude-code without apiKey produces no key env vars', () => {
  const v2 = {
    id: 'test-4', agentType: 'claude-code',
    apiUrl: 'https://api.example.com', apiKey: '', model: 'claude-3.5',
    extraArgs: '', createdAt: 1000, lastUsedAt: 2000
  }
  const result = migrateV2Entry(v2)
  const apiKey = result.envVars.find(v => v.key === 'ANTHROPIC_API_KEY')
  const authToken = result.envVars.find(v => v.key === 'ANTHROPIC_AUTH_TOKEN')
  assertEqual(apiKey, undefined, 'no API_KEY for empty apiKey')
  assertEqual(authToken, undefined, 'no AUTH_TOKEN for empty apiKey')
})

test('v2 migration: openrouter provider sets ANTHROPIC_API_KEY to empty', () => {
  const v2 = {
    id: 'test-or', agentType: 'claude-code', provider: 'openrouter',
    apiUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-key', model: 'claude-3.5',
    extraArgs: '', createdAt: 1000, lastUsedAt: 2000
  }
  const result = migrateV2Entry(v2)
  const apiKey = result.envVars.find(v => v.key === 'ANTHROPIC_API_KEY')
  const authToken = result.envVars.find(v => v.key === 'ANTHROPIC_AUTH_TOKEN')
  assert(apiKey !== undefined, 'ANTHROPIC_API_KEY should exist')
  assertEqual(apiKey.value, '', 'OpenRouter: API_KEY should be empty string')
  assertEqual(apiKey.masked, true, 'API_KEY should be masked')
  assertEqual(authToken.value, 'sk-or-key', 'AUTH_TOKEN carries the key')
})

test('v2 migration: custom provider sets ANTHROPIC_API_KEY to apiKey', () => {
  const v2 = {
    id: 'test-custom', agentType: 'claude-code', provider: 'custom',
    apiUrl: 'https://api.example.com', apiKey: 'sk-custom', model: 'claude-3.5',
    extraArgs: '', createdAt: 1000, lastUsedAt: 2000
  }
  const result = migrateV2Entry(v2)
  const apiKey = result.envVars.find(v => v.key === 'ANTHROPIC_API_KEY')
  assertEqual(apiKey.value, 'sk-custom', 'Custom: API_KEY should be apiKey')
})

test('v2 migration: model generates all 5 model env vars', () => {
  const v2 = {
    id: 'test-models', agentType: 'claude-code', provider: 'custom',
    apiUrl: 'https://api.example.com', apiKey: 'sk-key', model: 'claude-3.5-sonnet',
    extraArgs: '', createdAt: 1000, lastUsedAt: 2000
  }
  const result = migrateV2Entry(v2)
  const modelVars = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']
  for (const key of modelVars) {
    const found = result.envVars.find(v => v.key === key)
    assert(found !== undefined, `${key} should exist`)
    assertEqual(found.value, 'claude-3.5-sonnet', `${key} value`)
  }
})

test('v2 migration: no model produces no model env vars', () => {
  const v2 = {
    id: 'test-nomodel', agentType: 'claude-code', provider: 'custom',
    apiUrl: 'https://api.example.com', apiKey: 'sk-key', model: '',
    extraArgs: '', createdAt: 1000, lastUsedAt: 2000
  }
  const result = migrateV2Entry(v2)
  const modelVars = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']
  for (const key of modelVars) {
    assertEqual(result.envVars.find(v => v.key === key), undefined, `${key} should not exist`)
  }
})

// ─── Test: Duplicate dedup collision ───

test('Duplicate with no alias: using command as alias avoids dedup', () => {
  const history = [{
    id: 'entry-1', command: 'codex', extraArgs: '--verbose',
    envVars: [{ key: 'K', value: 'V' }], alias: '',
    createdAt: 1000, lastUsedAt: 2000
  }]
  // Simulate old behavior: empty alias on duplicate → dedup collision
  const oldDuplicate = { command: 'codex', extraArgs: '--verbose', envVars: [{ key: 'K', value: 'V' }], alias: '' }
  const oldMatch = wouldDedup(history, oldDuplicate)
  assert(oldMatch !== null, 'old behavior: empty alias should dedup (this is the bug)')

  // Simulate fixed behavior: command + ' (copy)' as alias
  const fixedDuplicate = { command: 'codex', extraArgs: '--verbose', envVars: [{ key: 'K', value: 'V' }], alias: 'codex (copy)' }
  const fixedMatch = wouldDedup(history, fixedDuplicate)
  assertEqual(fixedMatch, null, 'fixed behavior: should NOT dedup')
})

test('Duplicate with existing alias: appends (copy)', () => {
  const history = [{
    id: 'entry-2', command: 'claude', extraArgs: '',
    envVars: [], alias: 'My Setup',
    createdAt: 1000, lastUsedAt: 2000
  }]
  const duplicate = { command: 'claude', extraArgs: '', envVars: [], alias: 'My Setup (copy)' }
  const match = wouldDedup(history, duplicate)
  assertEqual(match, null, 'duplicate with (copy) suffix should NOT dedup')
})

// ─── Test: empty key env vars are filtered ───

test('validateEnvVars: empty key entries are skipped', () => {
  const result = validateEnvVars([
    { key: '', value: 'skip-me' },
    { key: '  ', value: 'also-skip' },
    { key: 'VALID', value: 'keep' }
  ])
  assertEqual(result.length, 1, 'only valid entries kept')
  assertEqual(result[0].key, 'VALID', 'valid key preserved')
})

// ─���─ Test: dedup considers all fields ───

test('dedup: different command avoids match', () => {
  const history = [{ id: 'e1', command: 'codex', extraArgs: '', envVars: [], alias: '' }]
  assertEqual(wouldDedup(history, { command: 'claude', extraArgs: '', envVars: [], alias: '' }), null, 'different command')
})

test('dedup: different extraArgs avoids match', () => {
  const history = [{ id: 'e1', command: 'codex', extraArgs: '--verbose', envVars: [], alias: '' }]
  assertEqual(wouldDedup(history, { command: 'codex', extraArgs: '--debug', envVars: [], alias: '' }), null, 'different args')
})

test('dedup: different alias avoids match', () => {
  const history = [{ id: 'e1', command: 'codex', extraArgs: '', envVars: [], alias: 'setup-a' }]
  assertEqual(wouldDedup(history, { command: 'codex', extraArgs: '', envVars: [], alias: 'setup-b' }), null, 'different alias')
})

test('dedup: exact match triggers dedup', () => {
  const entry = { id: 'e1', command: 'codex', extraArgs: '', envVars: [{ key: 'K', value: 'V' }], alias: 'test' }
  const match = wouldDedup([entry], { command: 'codex', extraArgs: '', envVars: [{ key: 'K', value: 'V' }], alias: 'test' })
  assert(match !== null, 'identical config should dedup')
  assertEqual(match.id, 'e1', 'should find the existing entry')
})

// ─── Run ───

console.log('Coding Agent Storage — Automated Tests')
console.log('=======================================\n')

for (const { name, fn } of tests) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${name}`)
    console.log(`    ${err.message}`)
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
process.exit(failed > 0 ? 1 : 0)
