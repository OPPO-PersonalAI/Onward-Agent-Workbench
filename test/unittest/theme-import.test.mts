/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { IPC } from '../../electron/shared/ipc-channels.ts'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names.ts'
import { parseThemeImport, normalizeImportColor, resolveImportReference } from '../../electron/main/theme-import-parser.ts'
import { importThemeFile } from '../../electron/main/theme-import-source.ts'
import { runThemeImportWorker } from '../../electron/main/theme-import-worker-client.ts'
import { THEME_IMPORT_LIMITS } from '../../electron/main/theme-import-types.ts'
import * as themeImportTypes from '../../electron/main/theme-import-types.ts'
import * as themeImportTrace from '../../electron/main/theme-import-trace.ts'
import type { ThemeImportTraceData } from '../../electron/main/theme-import-types.ts'
import { normalizeThemeDefinition, normalizeThemeSettings, resolveTheme, THEME_LIMITS } from '../../src/themes/theme-engine.ts'
import { DEFAULT_THEME_SETTINGS } from '../../src/constants/themes.ts'
import { FakeWorker, handlerHarness, preloadBridge } from './support/theme-import-harness.mjs'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'autotest', 'fixtures', 'themes-import')
const standalone = join(fixtures, 'standalone')
const cases = JSON.parse(await readFile(join(fixtures, 'cases.json'), 'utf8'))
const reader = async (path: string) => ({ text: await readFile(join(standalone, ...path.split('/')), 'utf8'), identity: path })
const memory = (text: string) => async () => ({ text, identity: 'theme.json' })
const errorCode = (code: string) => (error: unknown) => {
  assert.equal((error as { code: string }).code, code)
  return true
}

test('TI-U-01 JSONC inheritance retains parent tokens, child colors and explicit empty font style', async () => {
  const [theme] = await parseThemeImport('entry.jsonc', reader)
  assert.equal(theme.name, 'Fixture // theme /* label */')
  assert.equal(theme.kind, 'dark')
  assert.deepEqual(theme.colors, {
    'editor.background': '#112233', 'editor.foreground': '#fedcba',
    'terminal.ansiRed': '#ff000088', 'terminal.background': '#101820'
  })
  assert.equal(theme.tokenColors?.length, 3)
  assert.equal(theme.tokenColors?.[2].settings.fontStyle, '')
})

test('TI-U-02 BOM and CRLF preserve equivalent content identity', async () => {
  const normal = await parseThemeImport('entry.jsonc', reader)
  const windows = await parseThemeImport('entry.jsonc', async path => {
    const value = await reader(path)
    return { ...value, text: '\uFEFF' + value.text.replace(/\r?\n/g, '\r\n') }
  })
  assert.deepEqual(windows, normal)
})

for (const [input, expected] of Object.entries(cases.validColors)) {
  test(`TI-U-03 canonical color ${input}`, () => assert.equal(normalizeImportColor(input), expected))
}
for (const input of cases.invalidColors) {
  test(`TI-U-04 invalid color ${JSON.stringify(input)}`, () => assert.equal(normalizeImportColor(input), null))
}
for (const [index, text] of cases.invalidDocuments.entries()) {
  test(`TI-U-05 invalid structure ${index}`, async () => {
    await assert.rejects(parseThemeImport('theme.json', memory(text)), errorCode(text === '{ broken' || text === '' ? 'invalid-json' : 'invalid-theme'))
  })
}

test('TI-U-06 malformed sibling colors preserve valid siblings and inherited fallback with diagnostics', async () => {
  const [theme] = await parseThemeImport('diagnostics.jsonc', reader)
  assert.equal(theme.colors['editor.foreground'], '#abcdef')
  assert.equal(theme.colors['terminal.ansiGreen'], '#01fe98')
  assert.equal(theme.colors['terminal.foreground'], undefined)
  assert.ok(theme.unsupported?.includes('invalid-color:editor.foreground'))
  assert.ok(theme.unsupported?.includes('workbench:unknown.fixtureColor'))
  assert.ok(theme.unsupported?.includes('semanticTokenColors'))
  assert.ok(theme.unsupported?.includes('property:fixtureUnknownProperty'))
  assert.ok(theme.unsupported?.some(value => value.startsWith('syntax:')))
  assert.deepEqual(theme.unsupported, [...new Set(theme.unsupported)].sort())
})

test('TI-U-07 external tmTheme is reported and never opened', async () => {
  const paths: string[] = []
  const [theme] = await parseThemeImport('external-token.jsonc', async path => { paths.push(path); return reader(path) })
  assert.deepEqual(paths, ['external-token.jsonc'])
  assert.ok(theme.unsupported?.includes('tokenColors:external'))
})

test('TI-U-08 include cycle and normalized aliases fail', async () => {
  await assert.rejects(parseThemeImport('cycle-a.jsonc', reader), errorCode('include-cycle'))
  await assert.rejects(parseThemeImport('theme.json', memory(cases.selfCycle)), errorCode('include-cycle'))
})

test('TI-U-09 missing include is distinct from malformed content', async () => {
  await assert.rejects(parseThemeImport('theme.json', async path => path === 'theme.json'
    ? { text: cases.missingInclude, identity: path } : reader(path)), errorCode('file-not-found'))
})

for (const reference of cases.escapingReferences) {
  test(`TI-U-10 escaping reference ${JSON.stringify(reference)}`, () => {
    assert.throws(() => resolveImportReference('theme.json', reference), errorCode('path-outside-root'))
  })
}

test('TI-U-11 Windows reference separators and child-to-parent traversal stay inside selected root', () => {
  assert.equal(resolveImportReference('nested/theme.json', '..\\base.jsonc'), 'base.jsonc')
  assert.equal(resolveImportReference('theme.json', '.\\nested\\child.jsonc'), 'nested/child.jsonc')
})

test('TI-U-12 depth, byte and theme count ceilings are enforced at boundaries', async () => {
  await assert.rejects(parseThemeImport('entry.jsonc', reader, { limits: { maxDepth: 1 } }), errorCode('include-depth-limit'))
  await assert.rejects(parseThemeImport('entry.jsonc', reader, { limits: { maxTotalBytes: 10 } }), errorCode('size-limit'))
  await assert.rejects(parseThemeImport('entry.jsonc', reader, { limits: { maxFileBytes: 10 } }), errorCode('size-limit'))
  const manifest = JSON.parse(await readFile(join(fixtures, 'package', 'extension', 'package.json'), 'utf8'))
  await assert.rejects(parseThemeImport('package.json', memory(JSON.stringify(manifest)), { package: true, limits: { maxThemes: 1 } }), errorCode('theme-count-limit'))
})

test('TI-U-13 kind inference is deterministic and reported; contribution kind takes precedence', async () => {
  for (const [text, kind] of [[cases.inferredLight, 'light'], [cases.inferredDark, 'dark'], [cases.emptyTheme, 'dark']]) {
    const [theme] = await parseThemeImport('theme.json', memory(text))
    assert.equal(theme.kind, kind)
    assert.ok(theme.unsupported?.includes('kind:inferred'))
  }
  const themes = await importThemeFile(join(fixtures, 'archives', 'valid.vsix'))
  assert.deepEqual(themes.map(theme => theme.kind), ['dark', 'light'])
})

test('TI-U-14 identity ignores labels, source names, comments and color insertion order; color changes create a new identity', async () => {
  const source = JSON.parse(cases.inferredLight)
  const [first] = await parseThemeImport('first.json', memory(JSON.stringify(source)))
  const [renamed] = await parseThemeImport('renamed.json', memory(JSON.stringify({ name: 'Another name', ...source })))
  assert.equal(first.id, renamed.id)
  assert.match(first.id, /^import-[a-f0-9]{64}$/)
  const [changed] = await parseThemeImport('first.json', memory(cases.inferredDark))
  assert.notEqual(first.id, changed.id)
  const [reordered] = await parseThemeImport('theme.json', memory(JSON.stringify({ ...source, colors: { 'editor.foreground': '#123', ...source.colors } })))
  const [sorted] = await parseThemeImport('theme.json', memory(JSON.stringify({ ...source, colors: { ...source.colors, 'editor.foreground': '#112233' } })))
  assert.equal(reordered.id, sorted.id)
})

test('TI-U-15 VSIX keeps same-label distinct themes, shared parents and common token arrays', async () => {
  const themes = await importThemeFile(join(fixtures, 'archives', 'valid.vsix'))
  assert.equal(themes.length, 2)
  assert.equal(themes[0].name, themes[1].name)
  assert.notEqual(themes[0].id, themes[1].id)
  assert.equal(themes[0].tokenColors?.[0].scope, 'keyword')
  assert.equal(themes[0].colors['editor.background'], '#202020')
  assert.equal(themes[1].colors['editor.background'], '#ffffff')
})

for (const [file, code] of [
  ['missing-theme.vsix', 'file-not-found'], ['missing-manifest.vsix', 'invalid-package'],
  ['duplicate-entry.vsix', 'duplicate-entry'], ['invalid-theme.vsix', 'invalid-theme'],
  ['outside-root.vsix', 'path-outside-root'], ['corrupt.vsix', 'invalid-archive']
]) {
  test(`TI-U-16 whole invalid package fails: ${file}`, async () => {
    await assert.rejects(importThemeFile(join(fixtures, 'archives', file)), errorCode(code))
  })
}

test('TI-U-17 source import is read-only; snapshot survives source deletion and JSON round-trip', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'onward-theme-import-'))
  try {
    const copy = join(scratch, 'copy')
    await cp(standalone, copy, { recursive: true })
    const before = await readdir(copy, { recursive: true })
    const themes = await importThemeFile(join(copy, 'entry.jsonc'))
    assert.deepEqual(await readdir(copy, { recursive: true }), before)
    await rm(copy, { recursive: true })
    assert.deepEqual(JSON.parse(JSON.stringify(themes)), themes)
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('TI-U-18 realpath rejects symlink escape and detects alias cycle', async t => {
  if (process.platform === 'win32') return t.skip('File symlink creation requires Windows developer mode; lexical Windows confinement is covered by TI-U-10/11')
  const scratch = await mkdtemp(join(tmpdir(), 'onward-theme-import-links-'))
  try {
    await cp(standalone, join(scratch, 'inside'), { recursive: true })
    await cp(join(standalone, 'base.jsonc'), join(scratch, 'outside.jsonc'))
    await rm(join(scratch, 'inside', 'base.jsonc'))
    await symlink(join(scratch, 'outside.jsonc'), join(scratch, 'inside', 'base.jsonc'))
    await assert.rejects(importThemeFile(join(scratch, 'inside', 'entry.jsonc')), errorCode('path-outside-root'))
    await rm(join(scratch, 'inside', 'base.jsonc'))
    await symlink(join(scratch, 'inside', 'entry.jsonc'), join(scratch, 'inside', 'base.jsonc'))
    await assert.rejects(importThemeFile(join(scratch, 'inside', 'entry.jsonc')), errorCode('include-cycle'))
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('TI-U-19 cancellation terminates the worker, settles once and removes subscriptions', async () => {
  for (let trial = 0; trial < 5; trial++) {
    const controller = new AbortController()
    const worker = new FakeWorker()
    const task = runThemeImportWorker(() => worker, { signal: controller.signal })
    controller.abort()
    assert.deepEqual(await task, { success: false, canceled: true })
    assert.equal(worker.terminated, 1)
    assert.equal(worker.eventNames().length, 0)
  }
})

test('TI-U-20 worker error, early exit, malformed result and spawn failure become typed failures', async () => {
  for (const event of ['error', 'exit', 'message']) {
    const worker = new FakeWorker()
    const task = runThemeImportWorker(() => worker)
    worker.emit(event, event === 'error' ? new Error('private/path') : event === 'exit' ? 0 : { invalid: true })
    assert.deepEqual(await task, { success: false, error: { code: 'worker-failed' } })
    assert.equal(worker.terminated, 1)
  }
  assert.deepEqual(await runThemeImportWorker(() => { throw new Error('private/path') }), { success: false, error: { code: 'worker-failed' } })
})

test('TI-U-21 pre-aborted request never spawns; trace packets contain only aggregate data', async () => {
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await runThemeImportWorker(() => { throw new Error('must not spawn') }, { signal: controller.signal }), { success: false, canceled: true })
  const worker = new FakeWorker()
  const traces: unknown[] = []
  const task = runThemeImportWorker(() => worker, { onTrace: data => traces.push(data) })
  worker.emit('message', { type: 'trace', data: { stage: 'worker-result', durationMs: 1, ok: true, count: 0, path: '/private/fixture.json' } })
  worker.emit('message', { type: 'result', result: { success: false, error: { code: 'invalid-theme' } } })
  assert.deepEqual(await task, { success: false, error: { code: 'invalid-theme' } })
  assert.deepEqual(traces.find((trace: any) => trace.stage === 'worker-result'), {
    stage: 'worker-result', durationMs: 1, ok: true, canceled: false, count: 0
  })
  assert.equal(traces.some((trace: any) => trace.stage === 'worker-settled' && trace.code === 'invalid-theme'), true)
  assert.equal(JSON.stringify(traces).includes('/private/'), false)
})

test('TI-U-22 actual worker executes import off-thread and exits after settlement', async () => {
  let worker: Worker | undefined
  const traces: ThemeImportTraceData[] = []
  const result = await runThemeImportWorker(() => {
    worker = new Worker(new URL('../../electron/main/theme-import-worker-entry.ts', import.meta.url), {
      workerData: { path: join(fixtures, 'archives', 'valid.vsix') },
      execArgv: ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON']
    })
    return worker
  }, { onTrace: trace => traces.push(trace) })
  assert.equal(result.success, true)
  assert.equal(result.themes?.length, 2)
  assert.equal(worker?.threadId, -1)
  const source = traces.find(trace => trace.stage === 'source-complete')!
  assert.equal(source.format, 'vsix')
  assert.ok(source.includeReads! > 0)
  assert.ok(source.streamsOpened! > 0)
  assert.equal(traces.at(-1)?.stage, 'worker-settled')
  assert.equal(traces.at(-1)?.cleanup, 'complete')
  assert.equal(JSON.stringify(traces).includes('valid.vsix'), false)
  assert.ok(traces.every(trace => Buffer.byteLength(JSON.stringify(trace)) <= 1024))
})

test('TI-U-23 archive compressed/uncompressed, entry and document read limits', async () => {
  const path = join(fixtures, 'archives', 'valid.vsix')
  for (const limits of [{ maxArchiveBytes: 1 }, { maxArchiveEntries: 1 }, { maxFileBytes: 1 }, { maxTotalBytes: 1 }]) {
    await assert.rejects(importThemeFile(path, limits), errorCode('size-limit'))
  }
  const expanded = join(fixtures, 'archives', 'expanded-size.vsix')
  assert.ok((await stat(expanded)).size < 32 * 1024)
  await assert.rejects(importThemeFile(expanded, { maxArchiveBytes: 32 * 1024 }), errorCode('size-limit'))
  const text = cases.inferredDark
  const size = Buffer.byteLength(text)
  assert.equal((await parseThemeImport('theme.json', memory(text), { limits: { maxFileBytes: size, maxTotalBytes: size } })).length, 1)
  await assert.rejects(parseThemeImport('theme.json', memory(text), { limits: { maxTotalBytes: size - 1 } }), errorCode('size-limit'))
})

test('TI-U-24 cancellation/timeout cleanup and private failure trace, five deterministic trials', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (let trial = 0; trial < 5; trial++) {
    const worker = new FakeWorker()
    const traces: unknown[] = []
    const task = runThemeImportWorker(() => worker, { onTrace: data => traces.push(data) })
    t.mock.timers.tick(30_000)
    assert.deepEqual(await task, { success: false, error: { code: 'timeout' } })
    assert.equal(worker.terminated, 1)
    assert.equal(worker.eventNames().length, 0)
    assert.equal(traces.some((trace: any) => trace.stage === 'worker-timeout' && trace.code === 'timeout'), true)
  }
})

test('TI-U-25 identical content in two contributions deduplicates despite distinct labels', async () => {
  const manifest = JSON.parse(await readFile(join(fixtures, 'package', 'extension', 'package.json'), 'utf8'))
  manifest.contributes.themes[1] = { ...manifest.contributes.themes[0], label: 'Another label' }
  const themes = await parseThemeImport('package.json', async path => ({
    text: path === 'package.json' ? JSON.stringify(manifest) : await readFile(join(fixtures, 'package', 'extension', ...path.split('/')), 'utf8'),
    identity: path
  }), { package: true })
  assert.equal(themes.length, 1)
  assert.equal(themes[0].name, 'Same label')
})

test('TI-U-26 filesystem errors and unsupported format have stable codes without paths', async () => {
  await assert.rejects(importThemeFile(join(fixtures, 'absent.json')), errorCode('file-not-found'))
  await assert.rejects(importThemeFile(join(fixtures, 'absent.txt')), errorCode('unsupported-format'))
  await assert.rejects(parseThemeImport('theme.json', async () => { throw Object.assign(new Error('/private/source'), { code: 'EACCES' }) }), errorCode('file-unreadable'))
  assert.equal(THEME_IMPORT_LIMITS.maxDepth, 16)
})

test('TI-U-27 native dialog cancellation is typed; autotest selector is strictly gated', async () => {
  for (const value of ['', 'true', '0']) {
    const h = await handlerHarness(value)
    try {
      assert.throws(() => h.handlers.get(IPC.THEMES_AUTOTEST_SELECT_FILE)!(h.event, join(standalone, 'entry.jsonc')), /autotest-disabled/)
       const result = await h.import()
      assert.equal(result.canceled, true)
      assert.equal(h.dialogCalls.length, 1)
      assert.equal(h.workers.length, 0)
      assert.equal(h.traces[0].event, PERF_TRACE_EVENT.MAIN_THEME_IMPORT)
      assert.equal(h.traces.find(trace => trace.data.stage === 'handler-result')?.data.canceled, true)
    } finally { await h.cleanupThemeImportHandlers() }
    assert.equal(h.handlers.size, 0)
    assert.equal(h.sender.eventNames().length, 0)
  }
})

test('TI-U-28 autotest path persists until replaced or canceled; busy import does not cancel owner; cleanup joins worker', async () => {
  const h = await handlerHarness('1')
  try {
    h.handlers.get(IPC.THEMES_AUTOTEST_SELECT_FILE)!(h.event, join(standalone, 'entry.jsonc'))
    for (let trial = 0; trial < 5; trial++) {
      const first = h.import()
      await Promise.resolve()
      assert.equal((await h.import()).error.code, 'busy')
      assert.equal(h.workers.length, trial + 1)
      h.workers[trial].emit('message', { type: 'result', result: { success: false, error: { code: 'invalid-json' } } })
      assert.equal((await first).error.code, 'invalid-json')
      assert.equal(h.workers[trial].terminated, 1)
    }
    const pending = h.import()
    await Promise.resolve()
    await h.cleanupThemeImportHandlers()
    assert.equal((await pending).canceled, true)
    assert.equal(h.workers[5].terminated, 1)
    assert.equal(h.dialogCalls.length, 0)
    assert.equal(h.sender.eventNames().length, 0)
    assert.equal(h.traces.some(trace => JSON.stringify(trace).includes(standalone)), false)
  } finally { await h.cleanupThemeImportHandlers() }
})

test('TI-U-29 main-frame navigation cancels; in-page/subframe navigation leaves import active', async () => {
  const h = await handlerHarness('1')
  try {
    h.handlers.get(IPC.THEMES_AUTOTEST_SELECT_FILE)!(h.event, join(standalone, 'entry.jsonc'))
    const pending = h.import()
    await Promise.resolve()
    h.sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    h.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    assert.equal(h.workers[0].terminated, 0)
    h.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    assert.equal((await pending).canceled, true)
    assert.equal(h.workers[0].terminated, 1)
  } finally { await h.cleanupThemeImportHandlers() }
})

test('TI-U-30 imported snapshot survives core storage normalization without silent palette/report changes', async () => {
  for (const entry of ['entry.jsonc', 'diagnostics.jsonc', 'external-token.jsonc']) {
    const [theme] = await parseThemeImport(entry, reader)
    assert.deepEqual(normalizeThemeDefinition(theme), theme)
  }
})

test('TI-U-31 core palette/token/scope capacities reject whole import before save can truncate it', async () => {
  const text = await readFile(join(standalone, 'base.jsonc'), 'utf8')
  const [base] = await parseThemeImport('base.jsonc', memory(text))
  const colors = Object.fromEntries(Array.from({ length: THEME_LIMITS.colors + 1 }, (_, i) => [`fixture.color${i}`, '#123456']))
  await assert.rejects(parseThemeImport('theme.json', memory(JSON.stringify({ colors }))), errorCode('size-limit'))
  const tokenColors = Array.from({ length: THEME_LIMITS.tokenRules + 1 }, () => base.tokenColors![0])
  await assert.rejects(parseThemeImport('theme.json', memory(JSON.stringify({ tokenColors }))), errorCode('size-limit'))
  const scope = Array.from({ length: THEME_LIMITS.scopesPerRule + 1 }, () => 'comment')
  await assert.rejects(parseThemeImport('theme.json', memory(JSON.stringify({ tokenColors: [{ scope, settings: base.tokenColors![0].settings }] }))), errorCode('size-limit'))
})

test('TI-U-32 compatibility report includes actually unmapped workbench and syntax fields', async () => {
  const document = JSON.parse(cases.inferredDark)
  document.colors['activityBar.background'] = '#123456'
  document.tokenColors = [{ scope: 'markup.heading', settings: { foreground: '#12345678', background: '#ffffff' } }]
  const [theme] = await parseThemeImport('theme.json', memory(JSON.stringify(document)))
  assert.ok(theme.unsupported?.includes('workbench:activityBar.background'))
  assert.ok(theme.unsupported?.includes('markup.heading'))
})

test('TI-U-33 invalid prototype-like colors cannot pollute objects or disappear without a report', async () => {
  const document = JSON.parse(cases.inferredDark)
  Object.defineProperty(document.colors, '__proto__', { value: '#123456', enumerable: true })
  const [theme] = await parseThemeImport('theme.json', memory(JSON.stringify(document)))
  assert.equal(Object.hasOwn(theme.colors, '__proto__'), false)
  assert.equal(Object.getPrototypeOf(theme.colors), Object.prototype)
  assert.ok(theme.unsupported?.includes('workbench:__proto__'))
  assert.deepEqual(normalizeThemeDefinition(theme), theme)
})

test('TI-U-34 oversized compatibility report is bounded with an explicit truncation diagnostic', async () => {
  const colors = Object.fromEntries(Array.from({ length: THEME_LIMITS.unsupported + 2 }, (_, i) => [`fixture.color${i}`, '#123456']))
  const [theme] = await parseThemeImport('theme.json', memory(JSON.stringify({ colors })))
  assert.equal(theme.unsupported?.length, THEME_LIMITS.unsupported)
  assert.ok(theme.unsupported?.includes('compatibility:report-truncated'))
  assert.deepEqual(normalizeThemeDefinition(theme), theme)
})

test('TI-U-35 null injects one cancellation, replaces persistent paths and restores the native dialog on the next import', async () => {
  const h = await handlerHarness('1')
  try {
    for (let trial = 0; trial < 5; trial++) {
      // Cover cancellation both without a prior stub and after a persistent path.
      if (trial > 0) h.handlers.get(IPC.THEMES_AUTOTEST_SELECT_FILE)!(h.event, join(standalone, 'entry.jsonc'))
      h.handlers.get(IPC.THEMES_AUTOTEST_SELECT_FILE)!(h.event, null)
      const injected = await h.import()
      assert.equal(injected.success, false)
      assert.equal(injected.canceled, true)
      assert.equal(h.dialogCalls.length, trial)
      assert.equal(h.workers.length, 0)
      assert.equal(h.sender.eventNames().length, 0)
      assert.equal(h.traces.at(-1)?.data.canceled, true)

      // The harness's native dialog also cancels, but its call proves the marker was consumed.
      const unstubbed = await h.import()
      assert.equal(unstubbed.canceled, true)
      assert.equal(h.dialogCalls.length, trial + 1)
    }
  } finally { await h.cleanupThemeImportHandlers() }
})

test('TI-U-36 imported compatibility reports agree with actual Monaco mappings and preserve unknown colors', async () => {
  const [theme] = await importThemeFile(join(standalone, 'editor-compatibility.jsonc'))
  assert.deepEqual(theme.unsupported, ['workbench:activityBar.background', 'workbench:diffEditor.fixtureUnknownColor'])
  const settings = normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, mode: 'manual', themeId: theme.id, imported: [theme] })
  const resolved = resolveTheme(settings, false)
  for (const key of [
    'foreground', 'focusBorder', 'diffEditorGutter.insertedLineBackground', 'diffEditorGutter.removedLineBackground',
    'diffEditorOverview.insertedForeground', 'diffEditorOverview.removedForeground',
    'diffEditor.unchangedCodeBackground', 'diffEditor.move.border', 'editorIndentGuide.activeBackground',
    'editorIndentGuide.background6', 'editorCursor.background', 'editor.findMatchBackground',
    'editor.wordHighlightTextBorder', 'editorOverviewRuler.wordHighlightStrongForeground',
    'editorSuggestWidget.selectedForeground', 'editorWidget.resizeBorder', 'list.focusForeground', 'peekView.border'
  ]) assert.equal(resolved.editor.colors[key], theme.colors[key], key)
  assert.equal(resolved.colors['--accent'], '#aa0000')
  assert.equal(resolved.editor.colors['editor.foreground'], '#ff0000')
  assert.equal(resolved.colors['--editor-fg'], '#ff0000')
  assert.equal(theme.colors['activityBar.background'], '#654321')
  assert.equal(theme.colors['diffEditor.fixtureUnknownColor'], '#456789')
  assert.deepEqual(settings.imported[0], theme)
  assert.deepEqual(normalizeThemeDefinition(theme), theme)
  const [crlf] = await parseThemeImport('editor-compatibility.jsonc', async path => {
    const source = await reader(path)
    return { ...source, text: source.text.replace(/\r?\n/g, '\r\n') }
  })
  assert.deepEqual(crlf, theme)
})

test('TI-U-37 chooser receipt/entry precede pending native UI; idle lifecycle and user cancellation are visible', async () => {
  let choose!: (value: { canceled: boolean; filePaths: string[] }) => void
  const h = await handlerHarness('0', () => new Promise(resolve => { choose = resolve }))
  try {
    const pending = h.import()
    assert.deepEqual(h.traces.map(trace => trace.data.stage), ['registered', 'handler-received', 'chooser-open'])
    choose({ canceled: true, filePaths: [] })
    assert.equal((await pending).canceled, true)
    assert.equal(h.traces.find(trace => trace.data.stage === 'chooser-result')?.data.cause, 'user')
    assert.equal(h.traces.find(trace => trace.data.stage === 'handler-result')?.data.cause, 'user')
  } finally { await h.cleanupThemeImportHandlers() }
  assert.deepEqual(h.traces.slice(-2).map(trace => trace.data.stage), ['shutdown-start', 'shutdown-complete'])
  assert.equal(h.traces.at(-1)?.data.pending, 0)
})

for (const cause of ['navigation', 'destroy', 'shutdown'] as const) {
  test(`TI-U-38 canceled cause survives chooser and worker settlement: ${cause}`, async () => {
    for (const phase of ['chooser', 'worker']) {
      const h = await handlerHarness('1', () => new Promise(() => {}))
      try {
        if (phase === 'worker') h.handlers.get(IPC.THEMES_AUTOTEST_SELECT_FILE)!(h.event, join(standalone, 'entry.jsonc'))
        const pending = h.import()
        await Promise.resolve()
        if (cause === 'navigation') h.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
        else if (cause === 'destroy') h.sender.emit('destroyed')
        else await h.cleanupThemeImportHandlers()
        assert.equal((await pending).canceled, true)
        assert.equal(h.traces.find(trace => trace.data.stage === 'handler-result')?.data.cause, cause)
        if (phase === 'worker') assert.equal(h.traces.find(trace => trace.data.stage === 'worker-aborted')?.data.cause, cause)
        assert.equal(h.sender.listenerCount('did-start-navigation'), 0)
      } finally { await h.cleanupThemeImportHandlers() }
    }
  })
}

test('TI-U-39 earlier worker trace never hides crash/termination failure; pre-abort emits without spawning', async () => {
  const traces: ThemeImportTraceData[] = []
  const controller = new AbortController()
  controller.abort('/private/reason')
  assert.deepEqual(await runThemeImportWorker(() => { throw new Error('must not spawn') }, {
    signal: controller.signal, onTrace: trace => traces.push(trace)
  }), { success: false, canceled: true })
  assert.equal(traces.some(trace => trace.stage === 'worker-pre-abort'), true)
  class FailedTerminationWorker extends FakeWorker {
    async terminate(): Promise<number> { this.terminated++; throw new Error('/private/terminate') }
  }
  const worker = new FailedTerminationWorker()
  const pending = runThemeImportWorker(() => worker, { onTrace: trace => traces.push(trace) })
  worker.emit('message', { type: 'trace', data: { stage: 'worker-start', durationMs: 0, ok: true, canceled: false, count: 0 } })
  worker.emit('error', new Error('/private/crash'))
  assert.deepEqual(await pending, { success: false, error: { code: 'worker-failed' } })
  for (const stage of ['worker-start', 'worker-error', 'worker-terminate', 'worker-terminate-failed', 'worker-settled']) {
    assert.ok(traces.some(trace => trace.stage === stage), stage)
  }
  assert.equal(traces.at(-1)?.cleanup, 'failed')
  assert.equal(worker.eventNames().length, 0)
  assert.equal(JSON.stringify(traces).includes('/private/'), false)
})

test('TI-U-40 typed trace envelopes redact arbitrary values and stay below 1 KiB', () => {
  const trace = themeImportTrace.normalizeThemeImportTraceData({
    stage: 'source-complete', durationMs: 1, ok: true, canceled: false, count: Number.MAX_SAFE_INTEGER,
    cause: '/private/reason', format: '/private/file', cleanup: 'complete', code: '/private/error',
    reads: Number.MAX_SAFE_INTEGER, includeReads: -1, bytes: Infinity, depth: 16, pending: 0,
    filesOpened: 100, filesClosed: 100, cleanupFailures: 0, entries: 4096,
    archiveBytes: Number.MAX_SAFE_INTEGER, streamsOpened: 100, streamsClosed: 100, streamsDestroyed: 0,
    path: '/private/theme', name: 'secret theme', content: 'secret colors'
  })!
  assert.equal(trace.stage, 'source-complete')
  assert.equal(trace.cause, undefined)
  assert.equal(trace.format, undefined)
  assert.equal(trace.code, undefined)
  assert.equal(trace.includeReads, undefined)
  assert.equal(trace.bytes, undefined)
  assert.ok(Buffer.byteLength(JSON.stringify(trace)) <= 1024)
  assert.equal(JSON.stringify(trace).includes('private'), false)
  assert.equal(themeImportTrace.normalizeThemeImportTraceData({ stage: '/private/stage', durationMs: 0 }), null)
  const maximum = themeImportTrace.normalizeThemeImportTraceData({
    ...trace, durationMs: 1e9, cause: 'navigation', format: 'vsix', code: 'include-depth-limit',
    reads: 1e9, includeReads: 1e9, readFailures: 1e9, bytes: 1e9, depth: 1e9,
    filesOpened: 1e9, filesClosed: 1e9, cleanupFailures: 1e9, entries: 1e9, archiveBytes: 1e9,
    streamsOpened: 1e9, streamsClosed: 1e9, streamsDestroyed: 1e9, pending: 1e9
  })!
  assert.ok(Buffer.byteLength(JSON.stringify({ type: 'trace', data: maximum })) <= 1024)
})

test('TI-U-41 file/include I/O counters and cleanup are aggregated without per-file events', async () => {
  const traces: ThemeImportTraceData[] = []
  const imported = await importThemeFile(join(standalone, 'entry.jsonc'), {}, trace => traces.push(trace))
  assert.equal(imported.length, 1)
  const final = traces.find(trace => trace.stage === 'source-complete')!
  assert.equal(final.reads, 3)
  assert.equal(final.includeReads, 2)
  assert.equal(final.filesOpened, 3)
  assert.equal(final.filesClosed, 3)
  assert.equal(final.cleanup, 'complete')
  assert.equal(final.pending, 0)
  for (const stage of ['file-read', 'include-read', 'file-cleanup']) assert.equal(traces.filter(trace => trace.stage === stage).length, 1)
  assert.equal(JSON.stringify(traces).includes(standalone), false)
  assert.ok(traces.every(trace => Buffer.byteLength(JSON.stringify(trace)) <= 1024))
})

test('TI-U-42 ZIP success/rejection exposes index, stream, include and asynchronous close stages', async () => {
  for (const name of ['valid.vsix', 'missing-theme.vsix']) {
    const traces: ThemeImportTraceData[] = []
    let closed!: () => void
    const cleanup = new Promise<void>(resolve => { closed = resolve })
    const pending = importThemeFile(join(fixtures, 'archives', name), {}, trace => {
      traces.push(trace)
      if (trace.stage === 'archive-closed') closed()
    })
    if (name === 'valid.vsix') assert.equal((await pending).length, 2)
    else await assert.rejects(pending, errorCode('file-not-found'))
    await cleanup
    for (const stage of ['archive-open', 'archive-index', 'archive-indexed', 'stream-read', 'include-read', 'archive-cleanup', 'archive-closed']) {
      assert.equal(traces.filter(trace => trace.stage === stage).length, 1, stage)
    }
    assert.equal(traces.at(-1)?.cleanup, 'complete')
    assert.equal(traces.at(-1)?.pending, 0)
    assert.equal(JSON.stringify(traces).includes(name), false)
  }
})

test('TI-U-43 preload sends a breadcrumb before invoke settles and distinguishes transport rejection', async () => {
  const source = await readFile(new URL('../../electron/preload/index.ts', import.meta.url), 'utf8')
  const wrapper = source.slice(source.indexOf('async function traceIpc<'), source.indexOf('export interface TerminalOptions'))
  const block = source.slice(source.indexOf('const themesAPI: ThemesAPI ='), source.indexOf('const settingsAPI: SettingsAPI ='))
  for (const rejected of [false, true]) {
    const traces: { data: Record<string, unknown> }[] = []
    let settle!: (value: unknown) => void
    const result = new Promise((resolve, reject) => { settle = rejected ? reject : resolve })
    const module = { exports: {} as { import: () => Promise<{ success: boolean }> } }
    runInNewContext(ts.transpileModule(wrapper + block + '\nmodule.exports = themesAPI', {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText, {
      module, exports: module.exports, performance, IPC, PERF_TRACE_EVENT,
      preloadPerfTraceEnabled: true, preloadAutotestEnabled: false,
      ipcRenderer: {
        send: (_channel: string, value: { data: Record<string, unknown> }) => traces.push(value),
        invoke: () => { assert.equal(traces[0].data.stage, 'ipc-send'); return result }
      }
    })
    const pending = module.exports.import()
    assert.equal(traces.length, 1)
    settle(rejected ? new Error('/private/transport') : { success: false, canceled: true })
    assert.equal((await pending).success, false)
    assert.ok(traces.some(trace => trace.data.stage === (rejected ? 'ipc-rejected' : 'ipc-received')))
    assert.equal(JSON.stringify(traces).includes('/private/'), false)
  }
})

test('TI-U-44 file-close failure is reported without changing the public error or leaking exception text', async () => {
  const require = createRequire(import.meta.url)
  const traces: ThemeImportTraceData[] = []
  const text = Buffer.from(cases.inferredDark)
  let consumed = false
  const source = await readFile(new URL('../../electron/main/theme-import-source.ts', import.meta.url), 'utf8')
  const module = { exports: {} as { importThemeFile: typeof importThemeFile } }
  const mocks: Record<string, unknown> = {
    'node:fs/promises': {
      realpath: async (path: string) => path,
      open: async () => ({
        stat: async () => ({ isFile: () => true, size: text.length }),
        read: async (buffer: Buffer) => {
          if (consumed) return { bytesRead: 0 }
          consumed = true
          text.copy(buffer)
          return { bytesRead: text.length }
        },
        close: async () => { throw new Error('/private/close-failed') }
      })
    },
    './theme-import-parser.ts': { parseThemeImport, resolveImportReference },
    './theme-import-types.ts': themeImportTypes,
    './theme-import-trace.ts': themeImportTrace
  }
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText, {
    module, exports: module.exports, process, Buffer, performance,
    require: (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : require(name)
  })
  await assert.rejects(module.exports.importThemeFile(join(standalone, 'base.jsonc'), {}, trace => traces.push(trace)), errorCode('file-unreadable'))
  assert.equal(traces.find(trace => trace.stage === 'file-cleanup-failed')?.cleanupFailures, 1)
  const final = traces.at(-1)!
  assert.equal(final.stage, 'source-complete')
  assert.equal(final.cleanup, 'failed')
  assert.equal(final.filesOpened, 1)
  assert.equal(final.filesClosed, 0)
  assert.equal(final.readFailures, 1)
  assert.equal(JSON.stringify(traces).includes('/private/'), false)
})

test('TI-U-45 stage event volume remains constant across many shared includes', async () => {
  const counts: number[] = []
  for (const size of [1, 32]) {
    const manifest = JSON.parse(await readFile(join(fixtures, 'package', 'extension', 'package.json'), 'utf8'))
    manifest.contributes.themes = Array.from({ length: size }, () => manifest.contributes.themes[0])
    const traces: ThemeImportTraceData[] = []
    const io = themeImportTrace.createThemeImportIoTrace(trace => traces.push(trace), 'vsix')
    await parseThemeImport('package.json', async path => ({
      text: path === 'package.json' ? JSON.stringify(manifest) : await readFile(join(fixtures, 'package', 'extension', ...path.split('/')), 'utf8'),
      identity: path
    }), { package: true, io })
    assert.equal(traces.at(-1)?.reads, 1 + size * 3)
    assert.equal(traces.at(-1)?.includeReads, size * 2)
    counts.push(traces.length)
  }
  assert.equal(counts[0], counts[1])
})

test('TI-U-46 request ID guard rejects unbounded/non-UUID input without coercion', () => {
  for (const value of [undefined, null, 1, {}, [], '', 'x'.repeat(1000), randomUUID() + 'x', '00000000-0000-0000-0000-000000000000']) {
    assert.equal(themeImportTypes.isThemeImportRequestId(value), false)
  }
  const id = randomUUID()
  assert.equal(themeImportTypes.isThemeImportRequestId(id), true)
  assert.equal(themeImportTypes.isThemeImportRequestId(id.toUpperCase()), true)
})

const turn = () => new Promise<void>(resolve => setImmediate(resolve))

test('TI-U-47 request ownership: stale IDs, wrong senders, malformed IPC and cleanup ACK before retry', async () => {
  for (let trial = 0; trial < 5; trial++) {
    const h = await handlerHarness('1')
    const api = await preloadBridge(h)
    let join!: (code: number) => void
    try {
      await api.setImportPathForAutotest(joinPath())
      const id = randomUUID()
      const first = api.import(id)
      await turn()
      const worker = h.workers[0]
      const joined = new Promise<number>(resolve => { join = resolve })
      worker.termination = () => joined
      assert.equal((await h.cancel(randomUUID())).canceled, false)
      const other = { sender: Object.assign(new EventEmitter(), { id: 18, isDestroyed: () => false }) }
      assert.equal((await h.cancel(id, 'escape', other)).canceled, false)
      assert.equal((await h.cancel(id, 'private-invalid-cause')).canceled, false)
      assert.equal((await h.cancel('private-invalid-id')).canceled, false)
      assert.equal((await h.import('private-invalid-id')).error.code, 'worker-failed')
      assert.equal(worker.terminated, 0)
      let acknowledged = false
      const canceled = api.cancelImport(id, 'escape').then((result: any) => { acknowledged = true; return result })
      const nextId = randomUUID()
      const next = api.import(nextId)
      await turn()
      assert.equal(acknowledged, false)
      assert.equal(worker.terminated, 1)
      assert.equal(h.workers.length, 1)
      assert.equal((await h.cancel(id)).canceled, false, 'Delayed cancellation of the old ID cannot cancel the reserved successor')
      join(0)
      assert.equal((await canceled).canceled, true)
      assert.equal((await first).canceled, true)
      await turn()
      assert.equal(h.workers.length, 2)
      assert.equal((await h.cancel(id)).canceled, false, 'Stale cancellation cannot cancel the running successor')
      assert.equal(h.workers[1].terminated, 0)
      h.workers[1].emit('message', { type: 'result', result: { success: true, themes: [] } })
      assert.equal((await next).success, true)
      const traceText = JSON.stringify(h.traces)
      for (const privateValue of [id, nextId, 'private-invalid', joinPath()]) assert.equal(traceText.includes(privateValue), false)
      assert(h.traces.every((trace: any) => Buffer.byteLength(JSON.stringify(trace.data)) <= 1024))
    } finally { join?.(0); await h.cleanupThemeImportHandlers() }
  }
})

function joinPath() { return join(standalone, 'entry.jsonc') }

test('TI-U-48 abort before worker and cancel a queued retry before prior termination, five trials', async () => {
  for (let trial = 0; trial < 5; trial++) {
    const h = await handlerHarness('1')
    const api = await preloadBridge(h)
    let join!: (code: number) => void
    try {
      await api.setImportPathForAutotest(joinPath(), { pauseAt: 'before-worker' })
      const id = randomUUID()
      const first = api.import(id)
      await api.setImportPathForAutotest(null, { waitUntilPaused: true })
      assert.equal(h.workers.length, 0)
      assert.equal((await api.cancelImport(id, 'unmount')).canceled, true)
      assert.equal((await first).canceled, true)
      const nextId = randomUUID()
      const next = api.import(nextId)
      await turn()
      assert.equal(h.workers.length, 1, 'The autotest pause is consumed by one request')
      const joined = new Promise<number>(resolve => { join = resolve })
      h.workers[0].termination = () => joined
      const cancel = api.cancelImport(nextId, 'escape')
      const queuedId = randomUUID()
      const queued = api.import(queuedId)
      const cancelQueued = api.cancelImport(queuedId, 'unmount')
      await turn()
      assert.equal(h.workers.length, 1)
      join(0)
      await Promise.all([cancel, cancelQueued])
      assert.equal((await next).canceled, true)
      assert.equal((await queued).canceled, true)
      assert.equal(h.workers.length, 1, 'Canceled waiting request must never spawn')
      assert.equal(h.sender.listenerCount('did-start-navigation'), 0)
    } finally { join?.(0); await h.cleanupThemeImportHandlers() }
  }
})

test('TI-U-49 canceled native chooser ignores its eventual path and excludes parallel choosers', async () => {
  for (let trial = 0; trial < 5; trial++) {
    let choose!: (result: { canceled: boolean; filePaths: string[] }) => void
    const h = await handlerHarness('0', () => new Promise(resolve => { choose = resolve }))
    try {
      const id = randomUUID()
      const pending = h.import(id)
      assert.equal((await h.cancel(id)).canceled, true)
      assert.equal((await pending).canceled, true)
      assert.equal((await h.import()).error.code, 'busy')
      assert.equal(h.dialogCalls.length, 1)
      choose({ canceled: false, filePaths: [joinPath()] })
      await turn()
      assert.equal(h.workers.length, 0, 'A canceled chooser cannot dispatch its late path')
      const retry = h.import()
      assert.equal(h.dialogCalls.length, 2)
      choose({ canceled: true, filePaths: [] })
      assert.equal((await retry).canceled, true)
      assert.equal(h.sender.eventNames().length, 0)
    } finally { await h.cleanupThemeImportHandlers() }
  }
})

test('TI-U-50 teardown drains an already canceled worker and reserved successor before ack', async () => {
  for (const cause of ['shutdown', 'destroy', 'navigation']) {
    for (let trial = 0; trial < 5; trial++) {
      const h = await handlerHarness('1')
      const api = await preloadBridge(h)
      let join!: (code: number) => void
      try {
        await api.setImportPathForAutotest(joinPath())
        const id = randomUUID()
        const first = api.import(id)
        await turn()
        const joined = new Promise<number>(resolve => { join = resolve })
        h.workers[0].termination = () => joined
        const cancel = api.cancelImport(id, 'escape')
        const successor = api.import(randomUUID())
        let cleanup: Promise<void> | undefined
        if (cause === 'shutdown') cleanup = h.cleanupThemeImportHandlers()
        else if (cause === 'destroy') h.sender.emit('destroyed')
        else h.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
        join(0)
        await Promise.all([cancel, cleanup])
        assert.equal((await first).canceled, true)
        assert.equal((await successor).canceled, true)
        assert.equal(h.workers.length, 1)
        assert.equal(h.workers[0].eventNames().length, 0)
        assert.equal(h.sender.listenerCount('did-start-navigation'), 0)
      } finally { join?.(0); await h.cleanupThemeImportHandlers() }
      assert.equal(h.handlers.size, 0)
      assert.equal(h.sender.eventNames().length, 0)
    }
  }
})

test('TI-U-51 real autotest worker pause is abortable and joined, five trials', async () => {
  for (let trial = 0; trial < 5; trial++) {
    const controller = new AbortController()
    let worker!: Worker
    let ready!: () => void
    const paused = new Promise<void>(resolve => { ready = resolve })
    const pending = runThemeImportWorker(() => {
      worker = new Worker(new URL('../../electron/main/theme-import-worker-entry.ts', import.meta.url), {
        workerData: { path: joinPath(), pauseForAutotest: true },
        env: { ...process.env, ONWARD_AUTOTEST: '1' },
        execArgv: ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON']
      })
      return worker
    }, { signal: controller.signal, onTrace: data => { if (data.stage === 'worker-start') ready() } })
    try {
      await Promise.race([paused, pending.then(() => { throw new Error('Worker exited before pause') })])
      controller.abort()
      assert.equal((await pending).canceled, true)
      assert.equal(worker.threadId, -1)
    } finally { controller.abort(); await pending }
  }
})

test('TI-U-52 cancellation preload transport failure is sanitized and never logs request IDs', async () => {
  const h = await handlerHarness('1')
  try {
    const api = await preloadBridge(h)
    h.handlers.set(IPC.THEMES_CANCEL_IMPORT, () => { throw new Error('/private/cancel-transport') })
    const id = randomUUID()
    assert.equal((await api.cancelImport(id, 'escape')).canceled, false)
    for (const stage of ['cancel-ipc-send', 'cancel-ipc-rejected', 'cancel-ipc-complete']) assert(h.traces.some((trace: any) => trace.data.stage === stage))
    assert.equal(JSON.stringify(h.traces).includes('/private/'), false)
    assert.equal(JSON.stringify(h.traces).includes(id), false)
  } finally { await h.cleanupThemeImportHandlers() }
})
