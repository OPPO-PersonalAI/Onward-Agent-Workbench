/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const LEGACY_FIXTURE = path.join(ROOT, 'test/autotest/fixtures/themes-ui/legacy-settings.json')
const compiledModules = new Map()
const legacySettings = () => JSON.parse(readFileSync(LEGACY_FIXTURE, 'utf8'))

/** Only filesystem/Electron/trace boundaries are mocked; storage and normalization run unchanged. */
function createStorageHarness(initial) {
  // This is an opaque mock filesystem key. No real userData or scratch directory is created.
  const userData = path.join(ROOT, 'test/autotest/results/theme-settings-storage/virtual-user-data')
  const settingsPath = path.join(userData, 'settings.json')
  const files = new Map(initial === undefined ? [] : [[settingsPath, JSON.stringify(initial)]])
  const directories = new Set(initial === undefined ? [] : [userData])
  const writes = []
  const traces = []
  let rejectWrites = false
  const fs = {
    existsSync(filename) {
      assert.ok(filename === userData || filename === settingsPath, `Unexpected filesystem path: ${filename}`)
      return files.has(filename) || directories.has(filename)
    },
    readFileSync(filename, encoding) {
      assert.equal(filename, settingsPath)
      assert.equal(encoding, 'utf-8')
      assert.ok(files.has(filename), 'Settings must exist before reading')
      return files.get(filename)
    },
    mkdirSync(filename, options) {
      assert.equal(filename, userData)
      assert.equal(options.recursive, true)
      directories.add(filename)
    },
    writeFileSync(filename, contents, encoding) {
      assert.equal(filename, settingsPath)
      assert.equal(encoding, 'utf-8')
      writes.push({ filename, contents })
      if (rejectWrites) throw Object.assign(new Error('Injected write rejection'), { code: 'EACCES' })
      files.set(filename, contents)
    }
  }
  const mocks = new Map([
    ['electron', { app: { getPath(name) { assert.equal(name, 'userData'); return userData } } }],
    ['fs', fs],
    ['path', path],
    [path.join(ROOT, 'electron/main/performance-trace.ts'), {
      performanceTrace: { record: (name, data) => traces.push({ name, data }) }
    }]
  ])
  const loaded = new Map()
  function load(filename) {
    if (mocks.has(filename)) return mocks.get(filename)
    if (loaded.has(filename)) return loaded.get(filename).exports
    if (!compiledModules.has(filename)) compiledModules.set(filename, ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: filename
    }).outputText)
    const module = { exports: {} }
    loaded.set(filename, module)
    const require = specifier => {
      if (mocks.has(specifier)) return mocks.get(specifier)
      assert.ok(specifier.startsWith('.'), `Unexpected external dependency: ${specifier}`)
      const resolved = path.resolve(path.dirname(filename), specifier)
      return load(existsSync(resolved) ? resolved : `${resolved}.ts`)
    }
    // Keep plain-object inputs in the same realm as the real normalizer's prototype checks.
    new Function('require', 'module', 'exports', 'console', compiledModules.get(filename))(
      require, module, module.exports, { ...console, error() {} }
    )
    return module.exports
  }
  const { getSettingsStorage } = load(path.join(ROOT, 'electron/main/settings-storage.ts'))
  return {
    storage: getSettingsStorage(), writes, traces,
    rejectWrites(value) { rejectWrites = value },
    diskText: () => files.get(settingsPath),
    disk: () => files.has(settingsPath) ? JSON.parse(files.get(settingsPath)) : undefined
  }
}

function withTheme(state, themeId) {
  return { ...state, theme: { ...state.theme, mode: 'manual', themeId } }
}

test('TSS-10: export snapshot excludes unrelated catalogs and machine settings', () => {
  const h = createStorageHarness()
  const state = withTheme(h.storage.get(), 'dracula')
  state.theme.imported = [
    { id: 'import-selected', name: 'Selected', kind: 'dark', colors: { 'editor.background': '#123456' } },
    { id: 'import-other', name: 'Private other theme', kind: 'dark', colors: {} }
  ]
  state.theme.overrides = { 'import-selected': { 'terminal.foreground': '#fedcba' }, dracula: { 'terminal.background': '#123456' } }
  assert(h.storage.save(state))
  const snapshot = h.storage.getThemeExportSnapshot('import-selected')
  assert.deepEqual(snapshot.imported.map(theme => theme.id), ['import-selected'])
  assert.deepEqual(Object.keys(snapshot.overrides), ['import-selected'])
  assert.equal(snapshot.themeId, 'import-selected')
  assert.equal(snapshot.mode, 'manual')
  assert.equal(snapshot.terminalStyles, undefined)
  assert.equal(snapshot.language, undefined)
  assert.equal(h.storage.get().theme.themeId, 'dracula')
})

test('TSS-11: clock snapshots are detached and exclude imported palettes and unrelated settings', () => {
  const h = createStorageHarness()
  const state = h.storage.get()
  state.theme.mode = 'schedule'
  state.theme.schedule.ranges = [{ id: 'day', themeId: 'import-clock', start: 540, end: 1080, days: [1], enabled: true }]
  state.theme.imported = [{ id: 'import-clock', name: 'Clock palette', kind: 'dark', colors: { 'editor.background': '#123456' } }]
  assert(h.storage.save(state))
  const snapshot = h.storage.getThemeScheduleSnapshot()
  assert.deepEqual(Object.keys(snapshot).sort(), ['availableIds', 'mode', 'schedule'])
  assert(snapshot.availableIds.has('import-clock'))
  assert(snapshot.availableIds.has('light-modern'))
  snapshot.schedule.ranges[0].days.push(2)
  snapshot.availableIds.delete('import-clock')
  assert.deepEqual(h.storage.getThemeScheduleSnapshot().schedule.ranges[0].days, [1])
  assert(h.storage.getThemeScheduleSnapshot().availableIds.has('import-clock'))
})

test('TSS-01: a genuinely new profile follows the OS and persists settings v10/theme v4 on its first save', () => {
  const h = createStorageHarness()
  const fresh = h.storage.get()
  assert.equal(fresh.version, 10)
  assert.equal(fresh.theme.version, 4)
  assert.equal(fresh.theme.mode, 'system')
  assert.equal(fresh.theme.lightThemeId, 'light-modern')
  assert.equal(fresh.theme.darkThemeId, 'dark-modern')
  assert.equal(Object.hasOwn(fresh.theme, 'taskOverrides'), false)
  assert.deepEqual(fresh.globalTerminalStyle, { fontFamily: null, fontSize: null, gitDiffFontSize: null })
  assert.equal(h.disk(), undefined)
  assert.equal(h.storage.save(fresh), true)
  assert.deepEqual(createStorageHarness(h.disk()).storage.get(), h.storage.get())
})

test('TSS-02: a full save normalizes theme colors, discards retired fields and preserves fonts on reload', () => {
  const h = createStorageHarness(legacySettings())
  const next = withTheme(h.storage.get(), 'dracula')
  next.version = 7
  next.language = 'zh-CN'
  next.theme.overrides = { dracula: { 'terminal.background': '#123', 'terminal.foreground': '#ABCDEF' } }
  next.theme.taskOverrides = { dracula: { taskA: { foregroundColor: '#FEDCBA' } } }
  next.terminalStyles = { taskA: {
    terminalId: 'stale-id', foregroundColor: '#FEDCBA', backgroundColor: '#000000',
    fontFamily: ' Task Mono ', fontSize: 22, gitDiffFontSize: 17
  } }
  next.globalTerminalStyle = { foregroundColor: '#ABCDEF', backgroundColor: '#FFFFFF', fontFamily: ' Global Mono ', fontSize: 18, gitDiffFontSize: 21 }
  const inputBefore = structuredClone(next)
  assert.equal(h.storage.save(next), true)
  const saved = h.storage.get()
  assert.equal(saved.version, 10)
  assert.equal(saved.theme.version, 4)
  assert.equal(saved.theme.themeId, 'dracula')
  assert.equal(saved.theme.overrides.dracula['terminal.background'], '#112233')
  assert.equal(saved.theme.overrides.dracula['terminal.foreground'], '#abcdef')
  assert.equal(Object.hasOwn(saved.theme, 'taskOverrides'), false)
  assert.deepEqual(saved.terminalStyles.taskA, { terminalId: 'taskA', fontFamily: 'Task Mono', fontSize: 22, gitDiffFontSize: 17 })
  assert.deepEqual(saved.globalTerminalStyle, { fontFamily: 'Global Mono', fontSize: 18, gitDiffFontSize: 21 })
  assert.equal(saved.theme.overrides['onward-classic'], undefined, 'Versioned themes cannot reimport stale global colors')
  assert.equal(saved.language, 'zh-CN')
  assert.deepEqual(next, inputBefore, 'Saving must not mutate the renderer snapshot')
  assert.deepEqual(h.disk(), saved)
  assert.deepEqual(createStorageHarness(h.disk()).storage.get(), saved)
})

test('TSS-03: rejected full writes restore the last successful snapshot, not the boot theme', () => {
  const h = createStorageHarness(legacySettings())
  assert.equal(h.storage.save(withTheme(h.storage.get(), 'dracula')), true)
  const before = h.storage.get()
  const diskBefore = h.diskText()
  const rejected = withTheme(before, 'nord')
  rejected.language = 'zh-CN'
  rejected.theme.overrides = { nord: { 'terminal.background': '#102030' } }
  h.rejectWrites(true)
  assert.equal(h.storage.save(rejected), false)
  assert.equal(h.writes.length, 2, 'The rejected write must reach the filesystem boundary')
  assert.deepEqual(h.storage.get(), before)
  assert.equal(h.diskText(), diskBefore)
  assert.ok(h.traces.some(({ data }) => data.reason === 'save-rejected' && data.ok === false))
  h.rejectWrites(false)
  assert.equal(h.storage.save(rejected), true)
  assert.equal(h.storage.get().theme.themeId, 'nord')
  assert.deepEqual(h.disk(), h.storage.get())
})

test('TSS-04: rejected partial updates restore theme, existing/new Task styles, shortcuts and global fields', () => {
  const raw = legacySettings()
  raw.terminalStyles = { taskA: { fontSize: 16, foregroundColor: '#123456' } }
  raw.shortcuts = { focusTerminal1: 'Alt+1' }
  const h = createStorageHarness(raw)
  const before = h.storage.get()
  const diskBefore = h.diskText()
  const patch = {
    theme: withTheme(before, 'light-modern').theme,
    terminalStyles: { taskA: { fontSize: 24 }, taskB: { fontSize: 30 } },
    globalTerminalStyle: { fontSize: 20, foregroundColor: '#abcdef' },
    shortcuts: { focusTerminal1: 'Alt+2' },
    gitDiffFontSize: 23, autoFollowGitBranchForTaskName: false, performanceDiagnosticsEnabled: true
  }
  const inputBefore = structuredClone(patch)
  h.rejectWrites(true)
  assert.equal(h.storage.update(patch), false)
  assert.equal(h.writes.length, 1)
  assert.deepEqual(h.storage.get(), before, 'Rollback must undo nested map edits as well as theme replacement')
  assert.equal(h.diskText(), diskBefore)
  assert.deepEqual(patch, inputBefore)
  assert.ok(h.traces.some(({ data }) => data.reason === 'update-rejected' && data.ok === false))
  h.rejectWrites(false)
  assert.equal(h.storage.update(patch), true)
  const saved = h.storage.get()
  assert.equal(saved.theme.themeId, 'light-modern')
  assert.equal(saved.terminalStyles.taskA.fontSize, 24)
  assert.equal(saved.terminalStyles.taskB.fontSize, 30)
  assert.equal(saved.globalTerminalStyle.fontSize, 20)
  assert.equal(Object.hasOwn(saved.globalTerminalStyle, 'foregroundColor'), false)
  assert.equal(Object.hasOwn(saved.terminalStyles.taskA, 'foregroundColor'), false)
  assert.equal(saved.shortcuts.focusTerminal1, 'Alt+2')
  assert.equal(saved.gitDiffFontSize, 23)
  assert.equal(saved.autoFollowGitBranchForTaskName, false)
  assert.equal(saved.performanceDiagnosticsEnabled, true)
  assert.deepEqual(createStorageHarness(h.disk()).storage.get(), saved)
})

for (const globalKind of ['custom-colors', 'raw-null']) {
  test(`TSS-05-${globalKind}: legacy colors migrate only at theme scope while Task/global fonts survive`, () => {
    const raw = legacySettings()
    raw.globalTerminalStyle = globalKind === 'raw-null' ? null : {
      foregroundColor: '#abcdef', backgroundColor: '#123456', fontSize: 18
    }
    raw.terminalStyles = {
      rawNull: null,
      nullColors: { foregroundColor: null, backgroundColor: null, fontSize: 20 },
      partial: { foregroundColor: '#fedcba', backgroundColor: null },
      empty: {}
    }
    const h = createStorageHarness(raw)
    const migrated = h.storage.get()
    assert.equal(migrated.version, 10)
    assert.equal(migrated.theme.version, 4)
    assert.equal(migrated.theme.themeId, 'onward-classic')
    assert.equal(migrated.theme.mode, 'manual')
    assert.equal(migrated.theme.classic.presetId, 'graphite')
    assert.equal(Object.hasOwn(migrated.theme, 'taskOverrides'), false)
    assert.equal(migrated.terminalStyles.rawNull, undefined)
    for (const taskId of ['nullColors', 'partial', 'empty']) {
      assert.deepEqual(migrated.terminalStyles[taskId], {
        terminalId: taskId, fontFamily: null, fontSize: taskId === 'nullColors' ? 20 : null, gitDiffFontSize: null
      })
    }
    assert.deepEqual(migrated.theme.overrides['onward-classic'], globalKind === 'raw-null' ? undefined : {
      'terminal.foreground': '#abcdef', 'terminal.background': '#123456'
    })
    assert.deepEqual(migrated.globalTerminalStyle, {
      fontFamily: null, fontSize: globalKind === 'raw-null' ? null : 18, gitDiffFontSize: null
    })
    assert.equal(h.storage.save(migrated), true)
    assert.deepEqual(createStorageHarness(h.disk()).storage.get(), h.storage.get())
  })
}

test('TSS-06: clearing migrated theme colors stays cleared on save/reload despite stale incoming legacy fields', () => {
  const raw = legacySettings()
  raw.globalTerminalStyle.foregroundColor = '#123456'
  raw.terminalStyles = { taskA: { foregroundColor: '#abcdef', backgroundColor: null, fontSize: 24 } }
  const h = createStorageHarness(raw)
  const migrated = h.storage.get()
  assert.equal(migrated.theme.overrides['onward-classic']['terminal.foreground'], '#123456')
  assert.equal(Object.hasOwn(migrated.theme, 'taskOverrides'), false)
  migrated.theme.overrides = {}
  migrated.theme.taskOverrides = { 'onward-classic': { taskA: { foregroundColor: '#abcdef' } } }
  migrated.terminalStyles.taskA.foregroundColor = '#abcdef'
  migrated.globalTerminalStyle.foregroundColor = '#123456'
  assert.equal(h.storage.save(migrated), true)
  const reloaded = createStorageHarness(h.disk()).storage.get()
  assert.deepEqual(reloaded.theme.overrides, {})
  assert.equal(Object.hasOwn(reloaded.theme, 'taskOverrides'), false)
  assert.deepEqual(reloaded.terminalStyles.taskA, { terminalId: 'taskA', fontFamily: null, fontSize: 24, gitDiffFontSize: null })
  assert.equal(Object.hasOwn(reloaded.globalTerminalStyle, 'foregroundColor'), false)
})

test('TSS-07: pre-v2 existing profiles with no theme retain Classic Starlight instead of fresh-install System', () => {
  const raw = legacySettings()
  raw.version = 1
  delete raw.theme
  const existing = createStorageHarness(raw).storage.get()
  assert.equal(existing.theme.mode, 'manual')
  assert.equal(existing.theme.themeId, 'onward-classic')
  assert.equal(existing.theme.classic.presetId, 'starlight')
})

test('TSS-08: legacy telemetry consent mutation keeps its no-throw contract when writing fails', () => {
  const h = createStorageHarness(legacySettings())
  const diskBefore = h.diskText()
  h.rejectWrites(true)
  assert.doesNotThrow(() => h.storage.setTelemetryConsent(true, 'test-instance'))
  assert.equal(h.writes.length, 1, 'The no-throw path must still attempt persistence')
  assert.equal(h.storage.getTelemetryConsent(), true)
  assert.equal(h.storage.getTelemetryInstanceId(), 'test-instance')
  assert.equal(h.diskText(), diskBefore)
  assert.equal(h.storage.get().theme.themeId, 'onward-classic')
})

test('TSS-09: settings v8/theme v2 migration preserves imports and theme colors while retiring Task colors', () => {
  const raw = legacySettings()
  raw.version = 8
  raw.theme = {
    version: 2, mode: 'manual', themeId: 'custom-light', lightThemeId: 'custom-light', darkThemeId: 'nord',
    classic: { mode: 'preset', presetId: 'pine', custom: null },
    imported: [{ id: 'custom-light', name: 'Custom Light', kind: 'light', colors: { 'editor.background': '#fff' } }],
    overrides: { 'custom-light': { 'terminal.background': '#ABCDEF' } },
    taskOverrides: { 'custom-light': { taskA: { foregroundColor: '#123456', backgroundColor: '#654321' } } }
  }
  raw.terminalStyles = { taskA: { foregroundColor: '#123456', backgroundColor: '#654321', fontFamily: 'Task Mono', fontSize: 23, gitDiffFontSize: 17 } }
  raw.globalTerminalStyle = { foregroundColor: '#ffffff', backgroundColor: '#000000', fontFamily: 'Global Mono', fontSize: 20, gitDiffFontSize: 21 }
  const before = structuredClone(raw)
  const h = createStorageHarness(raw)
  const migrated = h.storage.get()
  assert.equal(migrated.version, 10)
  assert.equal(migrated.theme.version, 4)
  assert.equal(migrated.theme.themeId, 'custom-light')
  assert.equal(migrated.theme.lightThemeId, 'custom-light')
  assert.equal(migrated.theme.darkThemeId, 'nord')
  assert.equal(migrated.theme.classic.presetId, 'pine')
  assert.equal(migrated.theme.imported[0].colors['editor.background'], '#ffffff')
  assert.deepEqual(migrated.theme.overrides, { 'custom-light': { 'terminal.background': '#abcdef' } })
  assert.equal(Object.hasOwn(migrated.theme, 'taskOverrides'), false)
  assert.deepEqual(migrated.terminalStyles.taskA, { terminalId: 'taskA', fontFamily: 'Task Mono', fontSize: 23, gitDiffFontSize: 17 })
  assert.deepEqual(migrated.globalTerminalStyle, { fontFamily: 'Global Mono', fontSize: 20, gitDiffFontSize: 21 })
  assert.deepEqual(raw, before)
  assert.equal(h.storage.save(migrated), true)
  assert.deepEqual(createStorageHarness(h.disk()).storage.get(), h.storage.get())
})
