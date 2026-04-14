/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Automated test: verify that user-specified environment variables
 * are correctly passed to a spawned child process, including
 * quote-stripping behaviour.
 *
 * Usage:  node test/coding-agent-env-vars.test.mjs
 *
 * This test replicates the env-building logic from
 * electron/main/ipc-handlers.ts (coding-agent:launch handler)
 * and spawns a lightweight probe script to verify the vars arrive.
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Replicate the env-building logic from ipc-handlers.ts ──
function buildEnv(envVars) {
  const env = { ...process.env }
  for (const entry of envVars) {
    let key = (entry.key || '').trim()
    let value = entry.value ?? ''
    // Strip surrounding quotes
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1)
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) env[key] = value
  }
  return env
}

// ── Spawn a node process that dumps specific env vars as JSON ──
function spawnProbe(env, keysToCheck) {
  return new Promise((resolve, reject) => {
    // The probe script: reads requested keys from process.env and prints JSON
    const script = `
      const keys = JSON.parse(process.argv[1]);
      const result = {};
      for (const k of keys) result[k] = process.env[k] ?? null;
      process.stdout.write(JSON.stringify(result));
    `
    const child = spawn(process.execPath, ['-e', script, JSON.stringify(keysToCheck)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Probe exited ${code}: ${stderr}`))
      try {
        resolve(JSON.parse(stdout))
      } catch (e) {
        reject(new Error(`Failed to parse probe output: ${stdout}`))
      }
    })
    child.on('error', reject)
  })
}

// ── Test cases ──
const tests = []
let passed = 0
let failed = 0

function test(name, fn) {
  tests.push({ name, fn })
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// ── Test 1: Basic key-value pairs are set ──
test('basic env vars are passed to child process', async () => {
  const envVars = [
    { key: 'TEST_API_KEY', value: 'sk-test-12345' },
    { key: 'TEST_BASE_URL', value: 'https://api.example.com' },
    { key: 'TEST_DEBUG', value: '1' }
  ]
  const env = buildEnv(envVars)
  const result = await spawnProbe(env, ['TEST_API_KEY', 'TEST_BASE_URL', 'TEST_DEBUG'])
  assertEqual(result.TEST_API_KEY, 'sk-test-12345', 'TEST_API_KEY')
  assertEqual(result.TEST_BASE_URL, 'https://api.example.com', 'TEST_BASE_URL')
  assertEqual(result.TEST_DEBUG, '1', 'TEST_DEBUG')
})

// ── Test 2: Double-quoted values are stripped ──
test('double-quoted values are stripped', async () => {
  const envVars = [
    { key: 'TEST_QUOTED', value: '"hello world"' },
    { key: '"TEST_QUOTED_KEY"', value: 'plain' }
  ]
  const env = buildEnv(envVars)
  const result = await spawnProbe(env, ['TEST_QUOTED', 'TEST_QUOTED_KEY'])
  assertEqual(result.TEST_QUOTED, 'hello world', 'value quotes stripped')
  assertEqual(result.TEST_QUOTED_KEY, 'plain', 'key quotes stripped')
})

// ── Test 3: Single-quoted values are stripped ──
test('single-quoted values are stripped', async () => {
  const envVars = [
    { key: 'TEST_SINGLE', value: "'my-secret'" },
    { key: "'TEST_SINGLE_KEY'", value: 'val' }
  ]
  const env = buildEnv(envVars)
  const result = await spawnProbe(env, ['TEST_SINGLE', 'TEST_SINGLE_KEY'])
  assertEqual(result.TEST_SINGLE, 'my-secret', 'single-quoted value stripped')
  assertEqual(result.TEST_SINGLE_KEY, 'val', 'single-quoted key stripped')
})

// ── Test 4: Non-matching quotes are NOT stripped ──
test('mismatched quotes are preserved', async () => {
  const envVars = [
    { key: 'TEST_MISMATCH', value: '"hello\'' },
    { key: 'TEST_PARTIAL', value: '"open' }
  ]
  const env = buildEnv(envVars)
  const result = await spawnProbe(env, ['TEST_MISMATCH', 'TEST_PARTIAL'])
  assertEqual(result.TEST_MISMATCH, '"hello\'', 'mismatched quotes preserved')
  assertEqual(result.TEST_PARTIAL, '"open', 'partial quote preserved')
})

// ── Test 5: Empty keys are skipped ──
test('empty keys are skipped', async () => {
  const envVars = [
    { key: '', value: 'should-not-appear' },
    { key: '  ', value: 'also-skip' },
    { key: 'TEST_VALID', value: 'yes' }
  ]
  const env = buildEnv(envVars)
  const result = await spawnProbe(env, ['TEST_VALID', ''])
  assertEqual(result.TEST_VALID, 'yes', 'valid key set')
  assertEqual(result[''], null, 'empty key not set')
})

// ── Test 6: Empty values are set as empty string ──
test('empty values are set as empty string', async () => {
  const envVars = [
    { key: 'TEST_EMPTY_VAL', value: '' }
  ]
  const env = buildEnv(envVars)
  const result = await spawnProbe(env, ['TEST_EMPTY_VAL'])
  assertEqual(result.TEST_EMPTY_VAL, '', 'empty value is empty string, not null')
})

// ── Test 7: User env vars override inherited env ──
test('user env vars override inherited process env', async () => {
  // PATH exists in every env — verify we can override it
  const envVars = [
    { key: 'TEST_OVERRIDE_CHECK', value: 'overridden' }
  ]
  // Pre-set a value in process.env
  process.env.TEST_OVERRIDE_CHECK = 'original'
  const env = buildEnv(envVars)
  delete process.env.TEST_OVERRIDE_CHECK
  const result = await spawnProbe(env, ['TEST_OVERRIDE_CHECK'])
  assertEqual(result.TEST_OVERRIDE_CHECK, 'overridden', 'override works')
})

// ── Test 8: Multiple env vars with same key — last wins ──
test('duplicate keys — last value wins', async () => {
  const envVars = [
    { key: 'TEST_DUP', value: 'first' },
    { key: 'TEST_DUP', value: 'second' }
  ]
  const env = buildEnv(envVars)
  const result = await spawnProbe(env, ['TEST_DUP'])
  assertEqual(result.TEST_DUP, 'second', 'last value wins')
})

// ── Run all tests ──
console.log('Coding Agent Environment Variables — Automated Tests')
console.log('====================================================\n')

for (const { name, fn } of tests) {
  try {
    await fn()
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
