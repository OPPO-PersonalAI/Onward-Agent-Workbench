/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const appBin = resolve(process.argv[2])
const logFile = resolve(process.argv[3] || join(repo, 'traces/test-logs/change-log-autotest.log'))
const fixture = join(repo, 'test/autotest/fixtures/change-log')
const tag = 'v9.9.9-daily.20990101.1'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'onward-change-log-')))
const notes = join(root, 'changelog')
const workspace = join(root, 'workspace')
let cleaned = false
function stopApp() {
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/IM', basename(appBin), '/F'], { stdio: 'ignore' })
  else spawnSync('pkill', ['-x', basename(appBin)], { stdio: 'ignore' })
}
function cleanup() {
  if (cleaned) return
  cleaned = true
  stopApp()
  rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
  for (const name of readdirSync(repo)) {
    if (name.startsWith('__autotest_')) rmSync(join(repo, name), { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
  }
}
process.once('SIGINT', () => { cleanup(); process.exit(130) })
process.once('SIGTERM', () => { cleanup(); process.exit(143) })
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: workspace, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 70_000 })
  appendFileSync(logFile, (result.stdout || '') + (result.stderr || ''))
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, `Command failed; see ${logFile}`)
  return result.stdout + result.stderr
}
function launch(mode, userData, changelogRoot = notes) {
  stopApp()
  appendFileSync(logFile, `\n=== SCENARIO ${mode} ===\n`)
  const output = run(process.execPath, [join(repo, 'test/autotest/run-with-timeout.mjs'), '45', appBin], {
    ONWARD_DEBUG: '1', ONWARD_AUTOTEST: '1', ONWARD_AUTOTEST_SUITE: 'change-log',
    ONWARD_AUTOTEST_FIXTURE_EXTRA: mode, ONWARD_AUTOTEST_CWD: workspace,
    ONWARD_AUTOTEST_EXIT: '1', ONWARD_AUTOTEST_SKIP_CONSENT: '1',
    ONWARD_USER_DATA_DIR: userData, ONWARD_TAG: tag, ONWARD_CHANGELOG_ROOT: changelogRoot,
    ONWARD_SIMULATE_UPGRADE: '0'
  })
  stopApp()
  assert.ok(!output.includes('[AutoTest] FAIL'), `Failed assertion in ${mode}`)
  const marker = mode === 'fresh-install' ? 'CL-11-escape-closes-modal'
    : mode === 'missing-content' ? 'CL-UPG-05-missing-content-keeps-pending'
    : mode === 'upgrade-second-launch' || mode === 'downgrade' ? 'CL-UPG-04-relaunch-does-not-reopen'
    : 'CL-UPG-03-persists-shown-after-paint'
  assert.ok(output.includes(marker), `Missing ${marker}`)
  console.log(`PASS ${mode}`)
}
function seed(name) {
  const userData = join(root, name)
  mkdirSync(userData)
  cpSync(join(fixture, 'startup/session-ledger.json'), join(userData, 'session-ledger.json'))
  cpSync(join(fixture, 'startup/settings.json'), join(userData, 'settings.json'))
  return userData
}
try {
  mkdirSync(dirname(logFile), { recursive: true })
  closeSync(openSync(logFile, 'w'))
  mkdirSync(workspace)
  cpSync(join(fixture, 'startup/README.md'), join(workspace, 'README.md'))
  cpSync(fixture, notes, { recursive: true })
  run(process.execPath, ['--test', join(repo, 'test/autotest/test-changelog-generation.mjs'), join(repo, 'test/autotest/test-changelog-manifest.mjs')])
  run(process.execPath, ['--experimental-strip-types', '--test', join(repo, 'test/unittest/changelog-upgrade.test.mts')])
  const staleFile = join(notes, 'en/daily/v9.9.1-daily.20980101.1.md')
  cpSync(join(fixture, `en/daily/${tag}.md`), staleFile)
  run(process.execPath, [join(repo, 'scripts/compile-changelog.js'), '--root', notes])
  assert.equal(existsSync(staleFile), false, 'Compilation must prune stale release notes')
  assert.ok(existsSync(join(notes, `html/en/daily/${tag}.html`)))
  const fresh = join(root, 'fresh')
  mkdirSync(fresh)
  launch('fresh-install', fresh)
  for (let trial = 0; trial < 5; trial++) {
    const userData = seed(`upgrade-${trial}`)
    assert.equal(existsSync(join(userData, 'release-notes-state.json')), false)
    launch('upgrade-first-launch', userData)
    const statePath = join(userData, 'release-notes-state.json')
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), { schemaVersion: 1, lastRunVersion: tag.slice(1), pendingVersion: null })
    launch('upgrade-second-launch', userData)
  }
  const retry = seed('retry')
  const missing = join(root, 'missing-notes')
  mkdirSync(missing)
  launch('missing-content', retry, missing)
  assert.equal(JSON.parse(readFileSync(join(retry, 'release-notes-state.json'), 'utf8')).pendingVersion, tag.slice(1))
  launch('upgrade-first-launch', retry)
  const down = seed('downgrade')
  cpSync(join(fixture, 'startup/downgrade.json'), join(down, 'release-notes-state.json'))
  launch('downgrade', down)
  console.log('PASS change-log startup: all 5 upgrade/restart trials, unavailable-content retry and downgrade')
} finally { cleanup() }
