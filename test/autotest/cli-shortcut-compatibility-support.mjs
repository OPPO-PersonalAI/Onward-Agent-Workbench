/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const PLATFORMS = ['win32', 'darwin', 'linux']
export const FIXTURE_ROOT = path.join(ROOT, 'test/autotest/fixtures/cli-shortcut-compatibility')
export const historicalContracts = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, 'contracts.json'), 'utf8'))
export const repairs = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, 'repairs.json'), 'utf8'))
export const contracts = { ...historicalContracts, cases: historicalContracts.cases.map(item => repairs.cases[item.id]
  ? { ...item, ...repairs.cases[item.id], knownGap: undefined } : item) }
export const clipboards = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, 'clipboard.json'), 'utf8'))
const XTERM_ROOT = path.join(ROOT, 'node_modules/@xterm/xterm/src')
const parsed = new Map()
const compiled = new Map()

function source(relative) {
  const filename = path.isAbsolute(relative) ? relative : path.join(ROOT, relative)
  if (!parsed.has(filename)) parsed.set(filename, ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true,
    filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS))
  return parsed.get(filename)
}

function nodes(root, predicate) {
  const matches = []
  function visit(node) { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit) }
  visit(root)
  return matches
}

function one(root, predicate, label) {
  const matches = nodes(root, predicate)
  assert.equal(matches.length, 1, `${label}: source seam changed; review the adapter instead of silently skipping it`)
  return matches[0]
}

function compile(text) {
  if (!compiled.has(text)) compiled.set(text, ts.transpileModule(text, {
    fileName: 'audit-adapter.ts', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText)
  return compiled.get(text)
}

function evaluate(text, exported, globals = {}) {
  const module = { exports: {} }
  new Function('module', 'exports', ...Object.keys(globals), compile(`${text}\nmodule.exports = ${exported};`))(
    module, module.exports, ...Object.values(globals))
  return module.exports
}

function namedFunction(relative, name, globals = {}) {
  const file = source(relative)
  const node = one(file, node => ts.isFunctionDeclaration(node) && node.name?.text === name, name)
  return evaluate(node.getText(file), name, globals)
}

/** Load actual pure/controller modules; replace only native logging and timer IO. */
function loader(platform, timers = new Map()) {
  const cache = new Map()
  let clock = 1000
  let timerId = 0
  class Clock extends Date { static now() { return clock } }
  function load(filename) {
    if (!existsSync(filename)) filename = existsSync(`${filename}.ts`) ? `${filename}.ts` : filename.replace(/\.ts$/, '.d.ts')
    if (filename === path.join(ROOT, 'electron/main/performance-trace.ts')) return { performanceTrace: { record() {} } }
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }
    cache.set(filename, module)
    const require = specifier => {
      const target = specifier.startsWith('.') ? path.resolve(path.dirname(filename), specifier)
        : specifier.startsWith('common/') ? path.join(XTERM_ROOT, specifier) : null
      assert(target, `Unexpected runtime dependency: ${specifier}`)
      return load(target.endsWith('.ts') ? target : `${target}.ts`)
    }
    new Function('require', 'module', 'exports', 'process', 'Date', 'setTimeout', 'clearTimeout', compile(readFileSync(filename, 'utf8')))(
      require, module, module.exports, { platform, env: {} }, Clock,
      (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id },
      id => timers.delete(id))
    return module.exports
  }
  return { load, advance(ms) { clock += ms; for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.callback() } } }
}

export function loadProductionModule(relative) { return loader('win32').load(path.join(ROOT, relative)) }

function terminalInstaller(globals) {
  const file = source('src/terminal/terminal-session-manager.ts')
  const method = one(file, node => ts.isMethodDeclaration(node) && node.name.getText(file) === 'createSession', 'createSession')
  const adapter = one(method, node => ts.isVariableDeclaration(node) && node.name.getText(file) === 'inputAdapter', 'terminal input adapter installation')
  return evaluate(`function install(terminal, navigator) { const ${adapter.getText(file)}; return inputAdapter; }`, 'install', globals)
}

function terminalOptions() {
  const optionsFile = source(path.join(XTERM_ROOT, 'common/services/OptionsService.ts'))
  const defaults = one(optionsFile, node => ts.isVariableDeclaration(node) && node.name.getText(optionsFile) === 'DEFAULT_OPTIONS', 'xterm default options')
  const file = source('src/terminal/terminal-session-manager.ts')
  const expression = one(file, node => ts.isNewExpression(node) && node.expression.getText(file) === 'XTerm', 'terminal constructor')
  const inherited = evaluate(`const defaults = ${defaults.initializer.getText(optionsFile)};`, 'defaults', { isMac: false })
  const explicit = evaluate(`const explicit = ${expression.arguments[0].getText(file)};`, 'explicit', {
    options: {}, buildTheme: () => ({}), resolveTerminalFontSize: () => 12, resolveTerminalFontFamily: () => 'monospace'
  })
  return { ...inherited, ...explicit }
}

function xtermKeyMethods(dependencies) {
  const file = source(path.join(XTERM_ROOT, 'browser/Terminal.ts'))
  const methods = ['_keyDown', '_isThirdLevelShift'].map(name =>
    one(file, node => ts.isMethodDeclaration(node) && node.name.getText(file) === name, `xterm ${name}`).getText(file))
  return evaluate(`class KeyboardProbe { ${methods.join('\n')} }`, 'KeyboardProbe', dependencies)
}

export function keyEvent(stroke, type = 'keydown') {
  const parts = stroke.split('+')
  const key = parts.pop()
  const flags = new Set(parts)
  for (const flag of flags) assert(['Control', 'Shift', 'Alt', 'Meta'].includes(flag), `Unknown modifier: ${flag}`)
  let code, keyCode, value = key
  if (/^[a-z]$/i.test(key)) {
    code = `Key${key.toUpperCase()}`; keyCode = key.toUpperCase().charCodeAt(0)
    value = flags.has('Shift') ? key.toUpperCase() : key.toLowerCase()
  } else if (/^\d$/.test(key)) {
    code = `Digit${key}`; keyCode = key.charCodeAt(0)
    value = flags.has('Shift') ? ')!@#$%^&*('[Number(key)] : key
  } else if (/^F(?:[1-9]|1[0-2])$/.test(key)) { code = key; keyCode = 111 + Number(key.slice(1)) }
  else {
    const named = {
      Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
      Up: ['ArrowUp', 38], Down: ['ArrowDown', 40], Left: ['ArrowLeft', 37], Right: ['ArrowRight', 39],
      Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
      Space: ['Space', 32], '-': ['Minus', 189], '.': ['Period', 190]
    }
    assert(named[key], `Unknown fixture key: ${key}`)
    ;[code, keyCode] = named[key]
    value = key === 'Space' ? ' ' : key.length === 1 ? key : code
  }
  return {
    type, key: value, code, keyCode, ctrlKey: flags.has('Control'), shiftKey: flags.has('Shift'),
    altKey: flags.has('Alt'), metaKey: flags.has('Meta'), isComposing: false,
    defaultPrevented: false, getModifierState: () => false,
    preventDefault() { this.defaultPrevented = true }, stopPropagation() {}
  }
}

/** An extraction seam fails closed when production function boundaries change. */
export function createHarness(platform, options = {}) {
  assert(PLATFORMS.includes(platform))
  const timers = new Map()
  const modules = loader(platform, timers)
  const { load } = modules
  const { evaluateKeyboardEvent } = load(path.join(XTERM_ROOT, 'common/input/Keyboard.ts'))
  const { KeyboardResultType } = load(path.join(XTERM_ROOT, 'common/Types.d.ts'))
  const { C0 } = load(path.join(XTERM_ROOT, 'common/data/EscapeSequences.ts'))
  const clipboard = load(path.join(XTERM_ROOT, 'browser/Clipboard.ts'))
  const core = load(path.join(ROOT, 'src/utils/prompt-input.ts'))
  const { PromptInputShortcuts } = load(path.join(ROOT, 'electron/main/prompt-input-shortcuts.ts'))
  const { windowShortcutKey } = load(path.join(ROOT, 'src/utils/shortcut-key.ts'))
  const { IPC } = load(path.join(ROOT, 'electron/shared/ipc-channels.ts'))
  const { PERF_TRACE_EVENT } = load(path.join(ROOT, 'src/utils/perf-trace-names.ts'))
  const data = [], copied = [], actions = [], promptEvents = [], routes = [], textReads = []
  const native = new EventEmitter()
  Object.assign(native, { id: 1, isDestroyed: () => false, isFocused: () => true, setIgnoreMenuShortcuts() {},
    send(channel, event) {
      if (channel === IPC.SHORTCUT_WINDOW_TRIGGERED) actions.push(event)
      else if (channel === IPC.PROMPT_INPUT_SHORTCUT) promptEvents.push(event)
    } })
  const window = Object.assign(new EventEmitter(), { webContents: native, isDestroyed: () => false, isFocused: () => true })
  const settings = core.createDefaultPromptInputSettings()
  if (options.hostLeader) settings.leader = options.hostLeader
  const controller = new PromptInputShortcuts()
  controller.init(window, settings, id => id === 'fixture-terminal')
  controller.setContext({ tabId: 'fixture-tab', visibleTerminalIds: ['fixture-terminal'], activeTerminalId: 'fixture-terminal', blocked: false })
  const shortcuts = namedFunction('electron/main/settings-storage.ts', 'createDefaultShortcuts')()
  if (options.hostShortcut) shortcuts.focusPromptEditor = options.hostShortcut
  const setup = namedFunction('electron/main/ipc-handlers.ts', 'setupWindowShortcuts', {
    promptInputShortcuts: controller, windowShortcutSnapshot: shortcuts, windowShortcutKey,
    performanceTrace: { record() {} }, PERF_TRACE_EVENT, IPC
  })
  setup(window)
  const rawOptions = { ...terminalOptions(), macOptionIsMeta: options.macOptionIsMeta === true }
  const Keyboard = xtermKeyMethods({ evaluateKeyboardEvent, KeyboardResultType, C0 })
  const keyboard = new Keyboard()
  const coreService = {
    decPrivateModes: { applicationCursorKeys: Boolean(options.applicationCursor), bracketedPasteMode: Boolean(options.bracketed) },
    triggerDataEvent(value) { data.push(value) }
  }
  let selected = Boolean(options.selection)
  let activeClipboard = clipboards[options.clipboard ?? 'empty']
  assert(activeClipboard, 'Unknown clipboard fixture')
  const csiHandlers = new Map(), escHandlers = new Map(), domHandlers = new Map()
  let bufferListener
  const element = { addEventListener(name, listener) { domHandlers.set(name, listener) }, removeEventListener(name) { domHandlers.delete(name) } }
  const terminal = {
    options: rawOptions, element,
    parser: {
      registerCsiHandler(id, handler) { csiHandlers.set(id.prefix, handler); return { dispose() { csiHandlers.delete(id.prefix) } } },
      registerEscHandler(id, handler) { escHandlers.set(id.final, handler); return { dispose() { escHandlers.delete(id.final) } } }
    },
    buffer: { active: { type: 'normal' }, onBufferChange(handler) { bufferListener = handler; return { dispose() { bufferListener = undefined } } } },
    input(value) { data.push(value) },
    attachCustomKeyEventHandler(handler) { keyboard._customKeyEventHandler = handler },
    hasSelection: () => selected, getSelection: () => selected ? clipboards.plain.text : '', clearSelection() { selected = false },
    paste(text) { clipboard.paste(text, keyboard.textarea, coreService, { rawOptions }) }, focus() {}
  }
  Object.assign(keyboard, {
    browser: { isMac: platform === 'darwin', isWindows: platform === 'win32' }, options: rawOptions,
    optionsService: { rawOptions }, coreService, buffer: { ybase: 0, ydisp: 0 }, rows: 24, textarea: { value: '' },
    _compositionHelper: { keydown: () => true }, _onKey: { fire() {} }, _showCursor() {}, updateCursorStyle() {},
    selectAll() { selected = true }, scrollLines() { routes.push('viewport') },
    cancel(event) { event.preventDefault(); event.stopPropagation(); return false }
  })
  const navigator = {
    userAgent: platform === 'darwin' ? 'Macintosh; Mac OS X' : platform === 'win32' ? 'Windows NT' : 'Linux',
    clipboard: {
      async readText() { textReads.push(activeClipboard.formats.slice()); return activeClipboard.text },
      async writeText(value) { copied.push(value) }
    }
  }
  const { TerminalInputAdapter } = load(path.join(ROOT, 'src/terminal/terminal-input-adapter.ts'))
  const { terminalClipboardPayload } = load(path.join(ROOT, 'src/terminal/terminal-clipboard.ts'))
  const traces = []
  const inputAdapter = terminalInstaller({
    TerminalInputAdapter, id: 'fixture-terminal', PERF_TRACE_EVENT,
    perfTraceDiagnostic: (name, detail) => traces.push({ name, ...detail }),
    window: { electronAPI: { platform, clipboard: { async readTerminal() {
      textReads.push(activeClipboard.formats.slice())
      return terminalClipboardPayload(activeClipboard.formats, () => activeClipboard.text)
    } } } }
  })(terminal, navigator)
  inputAdapter.bindElement()
  if (options.keyboardFlags) csiHandlers.get('>')([options.keyboardFlags])
  const gridFile = source('src/components/TerminalGrid/TerminalGrid.tsx')
  const context = one(gridFile, node => ts.isVariableDeclaration(node) && node.name.getText(gridFile) === 'handleTermCtxPaste', 'context paste')
  assert(ts.isCallExpression(context.initializer))
  const managerFile = source('src/terminal/terminal-session-manager.ts')
  const pasteMethod = one(managerFile, node => ts.isMethodDeclaration(node) && node.name.getText(managerFile) === 'pasteClipboard', 'session manager clipboard paste')
  const PasteManager = evaluate(`class PasteManager { ${pasteMethod.getText(managerFile)} }`, 'PasteManager')
  const manager = new PasteManager()
  manager.sessions = new Map([['fixture-terminal', { terminal, inputAdapter }]])
  manager.focus = () => {}
  const contextPaste = evaluate(`const callback = ${context.initializer.arguments[0].getText(gridFile)};`, 'callback', {
    termCtxMenu: { terminalId: 'fixture-terminal' }, navigator, terminalSessionManager: manager, closeTermCtxMenu() {}
  })
  async function settle() { for (let turn = 0; turn < 12; turn++) await Promise.resolve() }
  async function press(stroke, modifiers = {}) {
    const event = Object.assign(keyEvent(stroke), modifiers)
    const input = {
      type: 'keyDown', key: event.key, code: event.code, control: event.ctrlKey, shift: event.shiftKey, alt: event.altKey,
      meta: event.metaKey, isAutoRepeat: Boolean(modifiers.repeat), isComposing: event.isComposing,
      modifiers: modifiers.altGr ? ['altgr'] : []
    }
    native.emit('before-input-event', event, input)
    if (event.defaultPrevented) routes.push('main-consumed')
    else {
      const before = data.length
      const thirdLevel = keyboard._isThirdLevelShift(keyboard.browser, event)
      const result = keyboard._keyDown(event)
      if (data.length === before && thirdLevel && result === true) routes.push('third-level-shift')
      else if (data.length === before && event.defaultPrevented) routes.push('host-consumed')
    }
    await settle()
    const release = keyEvent(stroke, 'keyup')
    native.emit('before-input-event', release, { ...input, type: 'keyUp' })
    if (!release.defaultPrevented) keyboard._customKeyEventHandler?.(release)
    await settle()
  }
  const result = () => ({ data: data.slice(), hex: Buffer.from(data.join(''), 'utf8').toString('hex'),
    copied: copied.slice(), actions: structuredClone(actions), promptEvents: structuredClone(promptEvents), routes: routes.slice(), textReads: textReads.slice() })
  return {
    press, result, core, settings, shortcuts, controller, timers, inputAdapter, terminal, traces, csiHandlers, escHandlers, domHandlers,
    switchBuffer(type) { terminal.buffer.active = { type }; bufferListener?.({ type }) },
    setClipboard(name) { assert(clipboards[name]); activeClipboard = clipboards[name] },
    async paste(entry) {
      if (entry === 'context') contextPaste()
      else {
        assert.equal(entry, 'nativePaste')
        domHandlers.get('paste')({ preventDefault() {}, stopImmediatePropagation() {},
          clipboardData: { types: activeClipboard.formats, files: [], getData(type) { assert.equal(type, 'text/plain'); return activeClipboard.text } } })
      }
      await settle()
    },
    advance: modules.advance,
    dispose() {
      controller.dispose()
      inputAdapter.dispose()
      native.removeAllListeners('before-input-event')
      assert.equal(csiHandlers.size + escHandlers.size + domHandlers.size, 0, 'Input subscriptions leaked')
      assert.equal(timers.size, 0, 'Pending leader timers leaked')
      assert.equal(window.eventNames().length, 0, 'Window listeners leaked')
      assert.equal(native.eventNames().length, 0, 'Native listeners leaked')
    }
  }
}

export async function observe(contract, platform) {
  const harness = createHarness(platform, contract)
  try {
    if (contract.entry) await harness.paste(contract.entry)
    else for (const stroke of contract.strokes) await harness.press(stroke)
    return harness.result()
  } finally { harness.dispose() }
}

export function compareDelivery(contract, observation, references = {}) {
  if (contract.expect.hostAction) return observation.hex === '' && observation.actions.length === 1 &&
    observation.actions[0].type === contract.expect.hostAction ? null : 'wrong-host-owner'
  if (contract.expect.leaderActive) return observation.hex === '' && observation.promptEvents.some(event => event.kind === 'state' && event.active)
    ? null : 'wrong-leader-owner'
  if (observation.actions.length) return 'unexpected-host-action'
  if (contract.expect.delivery && observation.hex) return null
  if (!observation.hex) return observation.routes.includes('third-level-shift') ? 'third-level-shift'
    : observation.routes.includes('main-consumed') ? 'main-consumed'
      : observation.routes.includes('host-consumed') ? 'host-consumed' : 'no-delivery'
  if (contract.expect.distinctFrom) {
    for (const key of contract.expect.distinctFrom) {
      assert(Object.hasOwn(references, key), `Missing independent reference: ${key}`)
      if (observation.hex === references[key]) return `aliases:${key}`
    }
    return null
  }
  let expected = contract.expect.hex
  if (contract.expect.sequence) expected = Buffer.from(contract.expect.sequence).toString('hex')
  if (contract.expect.textFixture) {
    const text = clipboards[contract.expect.textFixture].text.replace(/\r\n|\n/g, '\r')
    expected = Buffer.from(contract.expect.bracketed ? `\x1b[200~${text}\x1b[201~` : text).toString('hex')
  }
  assert.equal(typeof expected, 'string', 'Missing transport oracle')
  if (observation.hex !== expected) return 'wrong-bytes'
  if (contract.entry && observation.data.length !== 1) return 'duplicate-paste'
  return null
}

export function baselineVerdict(contract, platform, failure, strict = false) {
  const gap = contract.knownGap?.platforms.includes(platform) ? contract.knownGap : null
  const expected = typeof gap?.code === 'object' ? gap.code[platform] : gap?.code
  if (!gap) return failure ? 'REGRESSION' : 'PASS'
  if (!failure) return 'BASELINE_STALE'
  if (failure !== expected) return 'REGRESSION'
  return strict ? 'FAIL_KNOWN_GAP' : 'KNOWN_GAP'
}

export async function auditContracts() {
  const rows = []
  const referenceCache = new Map()
  for (const contract of contracts.cases) for (const platform of contract.platforms ?? PLATFORMS) {
    const references = {}
    for (const key of contract.expect.distinctFrom ?? []) {
      const cacheKey = `${platform}:${contract.keyboardFlags ?? 0}:${key}`
      if (!referenceCache.has(cacheKey)) referenceCache.set(cacheKey, (await observe({ strokes: [key], keyboardFlags: contract.keyboardFlags, macOptionIsMeta: contract.macOptionIsMeta }, platform)).hex)
      references[key] = referenceCache.get(cacheKey)
    }
    const observation = await observe(contract, platform)
    const failure = compareDelivery(contract, observation, references)
    rows.push({ id: contract.id, platform, keyboardFlags: contract.keyboardFlags ?? 0, macOptionIsMeta: contract.macOptionIsMeta === true,
      sources: contract.sources, context: contract.context, observation, failure,
      status: baselineVerdict(contract, platform, failure), reason: contract.knownGap?.reason ?? null })
  }
  return rows
}
