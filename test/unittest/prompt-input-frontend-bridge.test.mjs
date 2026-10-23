/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const compiled = new Map()
const sameDependencies = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
const noop = () => {}

function findNode(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null
  if (predicate(tree)) return tree
  for (const child of tree.children ?? []) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return null
}

/** Run the actual components and their registered callbacks with deterministic host scheduling. */
function harness(t, autotest = true, traceEnabled = false) {
  let rendering
  let timerId = 0
  let traceTimeMs = 0
  let inputState = { selectedIds: [], busy: false, notice: null }
  const instances = []
  const components = new Map()
  const timers = new Map()
  const flowTimers = new Map()
  const traces = []
  const legacyTraces = []
  const contexts = []
  const dispatches = []
  const dispatchResults = []
  const shortcutListeners = new Set()
  const modalListeners = new Set()
  const controllers = new Map()
  const dispatchers = new Map()
  const eventListeners = new Set()
  const suspensions = []
  const leaderViews = []
  const cancellations = []
  let suspendHook
  class Element {
    textContent = ''
    get innerText() { return this.textContent }
    set innerText(value) { this.textContent = value }
    closest() { return null }
    contains(node) { return node === this }
  }
  const editorElement = new Element()
  const previewElement = new Element()
  const eventTarget = () => {
    const listeners = new Map()
    return { listeners,
      addEventListener: (name, listener, capture = false) => {
        if (!listeners.has(name)) listeners.set(name, new Map())
        listeners.get(name).set(listener, capture)
        eventListeners.add(listener)
      },
      removeEventListener: (name, listener) => { listeners.get(name)?.delete(listener); eventListeners.delete(listener) }
    }
  }
  const document = { ...eventTarget(), activeElement: new Element() }
  const window = {
    ...eventTarget(),
    setTimeout: (callback, delay) => { flowTimers.set(++timerId, { callback, delay }); return timerId },
    clearTimeout: id => flowTimers.delete(id),
    electronAPI: { platform: process.platform, debug: {
      autotest, perfTraceEnabled: traceEnabled,
      recordPerfTrace: event => legacyTraces.push(structuredClone(event))
    }, promptInput: {
      setContext: async value => { contexts.push(structuredClone(value)) },
      cancel: async reason => { cancellations.push(reason) },
      onShortcut: callback => { shortcutListeners.add(callback); return () => shortcutListeners.delete(callback) }
    } }
  }
  const effect = (kind, create, dependencies) => {
    const index = rendering.cursor++
    const previous = rendering.hooks[index]
    if (sameDependencies(previous?.dependencies, dependencies)) return
    const next = { dependencies, cleanup: previous?.cleanup, create }
    rendering.hooks[index] = next
    rendering[kind].push(next)
  }
  const react = {
    memo(component) { components.set(component.name, component); return component },
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      if (props?.className === 'prompt-editor-content' && props.ref) props.ref.current = editorElement
      if (props?.['data-testid'] === 'prompt-input-preview-test' && props.ref) props.ref.current = previewElement
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    startTransition: callback => callback(),
    useState(initial) {
      const owner = rendering
      const index = owner.cursor++
      owner.hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [owner.hooks[index].value, next => {
        const value = typeof next === 'function' ? next(owner.hooks[index].value) : next
        if (!Object.is(value, owner.hooks[index].value)) { owner.hooks[index].value = value; owner.dirty = true }
      }]
    },
    useRef(initial) { const index = rendering.cursor++; return rendering.hooks[index] ??= { current: initial } },
    useMemo(create, dependencies) {
      const index = rendering.cursor++
      if (!sameDependencies(rendering.hooks[index]?.dependencies, dependencies)) rendering.hooks[index] = { value: create(), dependencies }
      return rendering.hooks[index].value
    },
    useCallback(callback, dependencies) { return react.useMemo(() => callback, dependencies) },
    useLayoutEffect(create, dependencies) { effect('layout', create, dependencies) },
    useEffect(create, dependencies) { effect('passive', create, dependencies) }
  }
  const actions = {
    publishLeaderState: value => { leaderViews.push(value) },
    setActiveInputTab: noop, setInputBlocked: noop,
    dispatchInputAction: (...args) => {
      dispatches.push(args)
      const [tabId, ...invocation] = args
      const result = dispatchers.get(tabId)?.(...invocation) ?? Promise.resolve(true)
      dispatchResults.push(result)
      return result
    },
    registerFocusEditor: noop, registerSubmitEditor: noop, publishInputState: noop,
    isActiveInputTab: () => true, isInputBlocked: () => false,
    registerDraftController: (id, controller) => { controllers.set(id, controller); return () => controllers.delete(id) },
    getDraftController: id => controllers.get(id),
    registerInputDispatcher: (id, dispatcher) => { dispatchers.set(id, dispatcher); return () => dispatchers.delete(id) }
  }
  const translate = key => key
  const boundaries = new Map([
    ['react', react],
    [resolve(ROOT, 'src/components/Settings/ShortcutInput.tsx'), { setRecordingSuspended: value => { suspensions.push(value); return suspendHook?.(value) ?? Promise.resolve() } }],
    [resolve(ROOT, 'src/contexts/PromptActionsContext.tsx'), { usePromptActions: () => actions, usePromptInputTabState: () => inputState }],
    [resolve(ROOT, 'src/contexts/SettingsContext.tsx'), { useSettings: () => ({ settings: {} }) }],
    [resolve(ROOT, 'src/i18n/useI18n.ts'), { useI18n: () => ({ t: translate, locale: 'en' }) }],
    [resolve(ROOT, 'src/utils/perf-trace.ts'), { perfTraceDiagnostic: (name, data) => traces.push({ name, data }) }],
    [resolve(ROOT, 'src/utils/keyboard.ts'), { buildAccelerator: () => '' }],
    [resolve(ROOT, 'src/utils/modal-dismiss.ts'), { isAnyModalOpen: () => false,
      subscribeOpenModals: callback => { modalListeners.add(callback); return () => modalListeners.delete(callback) } }],
    [resolve(ROOT, 'src/hooks/useModalEscape.ts'), { useModalEscape: noop, useModalOpenRegistration: noop }]
  ])
  for (const [filename, exports] of [
    ['PromptSearch', ['PromptSearch']], ['PromptList', ['PromptList']], ['PromptSender', ['PromptSender']],
    ['PromptEditorContextMenu', ['PromptEditorContextMenu']], ['ScheduleConfigModal', ['ScheduleConfigModal']],
    ['ScheduleNotification', ['ScheduleNotificationBar']]
  ]) boundaries.set(resolve(ROOT, `src/components/PromptNotebook/${filename}.tsx`), Object.fromEntries(exports.map(name => [name, noop])))
  const loaded = new Map()
  function load(filename) {
    if (boundaries.has(filename)) return boundaries.get(filename)
    if (filename.endsWith('.css')) return {}
    if (loaded.has(filename)) return loaded.get(filename).exports
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true }
    }).outputText)
    const module = { exports: {} }
    loaded.set(filename, module)
    const require = specifier => {
      if (boundaries.has(specifier)) return boundaries.get(specifier)
      assert(specifier.startsWith('.'), `Unexpected host dependency: ${specifier}`)
      const base = resolve(dirname(filename), specifier)
      const dependency = [base, `${base}.ts`, `${base}.tsx`].find(path => boundaries.has(path) || existsSync(path))
      assert(dependency, `Unresolved module: ${specifier}`)
      return load(dependency)
    }
    new Function('require', 'module', 'exports', 'window', 'document', 'HTMLElement', 'Node', 'setTimeout', 'clearTimeout', 'React', 'performance', compiled.get(filename))(
      require, module, module.exports, window, document, Element, Element,
      (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId }, id => timers.delete(id), react,
      { timeOrigin: 1000, now: () => traceTimeMs }
    )
    return module.exports
  }
  const h = {
    window, document, timers, traces, legacyTraces, contexts, dispatches, dispatchResults, shortcutListeners, controllers, dispatchers, editorElement, previewElement, suspensions, leaderViews, cancellations, load,
    advanceTraceTime(ms) { traceTimeMs += ms },
    setSuspensionHook(callback) { suspendHook = callback },
    mount(name, props) {
      const exports = load(resolve(ROOT, name === 'PromptShortcutPreview' ? 'src/components/Settings/PromptShortcutPreview.tsx'
        : `src/components/PromptNotebook/${name === 'PromptInputShortcuts' ? name : 'PromptNotebook'}.tsx`))
      const component = components.get(name) ?? exports[name]
      assert(component, `Missing component: ${name}`)
      const instance = { component, props, dirty: true, hooks: [], layout: [], passive: [], cursor: 0, closed: false }
      instance.update = patch => { instance.props = { ...instance.props, ...patch }; instance.dirty = true; h.flush() }
      instance.close = () => {
        if (instance.closed) return
        instance.closed = true
        for (const hook of instance.hooks) hook.cleanup?.()
      }
      instances.push(instance)
      h.flush()
      return instance
    },
    flush() {
      for (let iteration = 0; iteration < 30; iteration++) {
        for (const instance of instances) {
          if (instance.closed || !instance.dirty) continue
          rendering = instance
          instance.dirty = false
          instance.cursor = 0
          instance.tree = instance.component(instance.props)
          for (const queue of [instance.layout, instance.passive]) {
            for (const item of queue.splice(0)) { item.cleanup?.(); item.cleanup = item.create() }
          }
        }
        if (instances.every(instance => instance.closed || !instance.dirty)) return
      }
      assert.fail('Frontend hooks did not settle')
    },
    emit(event) { for (const listener of shortcutListeners) listener(event); h.flush() },
    focus(element) {
      const previous = document.activeElement
      document.activeElement = element
      for (const listener of document.listeners.get('focusout')?.keys() ?? []) listener({ target: previous, relatedTarget: element })
      for (const listener of document.listeners.get('focusin')?.keys() ?? []) listener({ target: element, relatedTarget: previous })
      h.flush()
    },
    previewKey(key, fields = {}) {
      const event = { type: 'keydown', key, target: previewElement, repeat: false,
        preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true },
        stopImmediatePropagation() { this.stopped = true }, ...fields }
      for (const [listener, capture] of window.listeners.get(event.type) ?? []) {
        assert.equal(capture, true, 'Preview interception precedes document-capture editor handlers')
        listener(event)
      }
      h.flush()
      return event
    },
    setInputState(next) { inputState = next; for (const instance of instances) instance.dirty = true; h.flush() },
    debounce() {
      assert.equal(timers.size, 1, 'The editor owns one coalesced parent-sync timer')
      const [id, { callback, delay }] = [...timers][0]
      assert.equal(delay, 300)
      timers.delete(id)
      callback()
      h.flush()
    }
  }
  t.after(() => {
    for (const instance of [...instances].reverse()) instance.close()
    for (const [id, timer] of flowTimers) {
      assert.equal(timer.delay, 1200, 'Terminal correlation retains the existing idle expiry')
      flowTimers.delete(id)
      timer.callback()
    }
    assert.equal(timers.size, 0)
    assert.equal(shortcutListeners.size, 0)
    assert.equal(modalListeners.size, 0)
    assert.equal(eventListeners.size, 0)
  })
  return h
}

const bridgeProps = () => ({ tabId: 'tab-a', terminals: [{ id: 'task-a', title: 'A' }, { id: 'task-b', title: 'B' }],
  visibleCount: 2, activeTerminalId: 'task-a', blocked: false, promptHidden: false })
const indicator = h => h.window.__onwardPromptInputShortcutsDebug?.getLeaderState() ?? null

test('PIFB-24: same-generation selector and target updates require a live DOM owner, while fresh arm still works', t => {
  const h = harness(t)
  h.mount('PromptInputShortcuts', bridgeProps())
  const generation = h.contexts.at(-1).generation
  const arm = { kind: 'state', active: true, tabId: 'tab-a', generation }
  for (let trial = 0; trial < 5; trial++) {
    for (const fields of [{ selecting: true }, { selecting: false }, { targetId: 'task-b' }, { targetId: 'task-b', selecting: false }]) {
      const update = { ...arm, ...fields }
      const dispatch = { kind: 'dispatch', active: false, tabId: 'tab-a', generation, actionId: 'queue', targetId: fields.targetId }
      const before = h.dispatches.length
      h.emit(update)
      assert.equal(indicator(h), null, 'An ownerless continuation cannot become an initial arm')
      h.emit(arm)
      h.emit(update)
      assert.deepEqual(indicator(h), update, 'The same continuation is valid with an existing owner')
      h.focus(h.document.activeElement === h.editorElement ? h.previewElement : h.editorElement)
      assert.equal(h.cancellations.at(-1), 'context-changed')
      assert.equal(indicator(h), null)
      assert.equal(h.leaderViews.at(-1), null)
      h.emit(update)
      assert.equal(indicator(h), null, 'Late selecting=true, selecting=false and target updates remain canceled')
      assert.equal(h.leaderViews.at(-1), null)
      h.emit(dispatch)
      assert.equal(h.dispatches.length, before, 'A late state cannot authorize the queued action')
      h.emit(arm)
      h.emit(update)
      h.emit(dispatch)
      assert.equal(h.dispatches.length, before + 1)
      assert.deepEqual(h.dispatches.at(-1), ['tab-a', 'queue', fields.targetId, 'shortcut'])
      assert.equal(indicator(h), null)
      assert(h.contexts.every(context => context.generation === generation), 'Local cancellation is not a Tab-generation rejection')
    }
  }
  assert.equal(h.traces.filter(({ data }) => data.reason === 'stale-owner-state').length, 40)
  assert.equal(h.traces.filter(({ data }) => data.reason === 'stale-owner-dispatch').length, 20)
})

test('PIFB-25: continuation barrier holds real subscription updates in order, never initial arm or cancellation', t => {
  const h = harness(t)
  h.mount('PromptInputShortcuts', bridgeProps())
  const api = h.window.__onwardPromptInputShortcutsDebug
  const generation = h.contexts.at(-1).generation
  const arm = { kind: 'state', active: true, tabId: 'tab-a', generation }
  const dispatch = { kind: 'dispatch', active: false, tabId: 'tab-a', generation, actionId: 'queue', targetId: 'task-b' }
  for (let trial = 0; trial < 5; trial++) {
    const before = h.dispatches.length
    api.setContinuationsHeld(true)
    h.emit(arm)
    assert.deepEqual(indicator(h), arm)
    assert.equal(api.getHeldContinuationCount(), 0)
    for (const fields of [{ selecting: true }, { selecting: false }, { targetId: 'task-b', selecting: false }]) h.emit({ ...arm, ...fields })
    h.emit(dispatch)
    assert.equal(api.getHeldContinuationCount(), 4)
    assert.equal(api.getHeldDispatchCount(), 0, 'The existing dispatch-only barrier is independent')
    assert.deepEqual(indicator(h), arm)
    assert.equal(h.dispatches.length, before)
    h.focus(h.document.activeElement === h.editorElement ? h.previewElement : h.editorElement)
    assert.equal(h.cancellations.at(-1), 'context-changed')
    api.setContinuationsHeld(false)
    h.flush()
    assert.equal(api.getHeldContinuationCount(), 0)
    assert.equal(h.dispatches.length, before)
    assert.equal(h.leaderViews.at(-1), null)

    api.setContinuationsHeld(true)
    h.emit(arm)
    h.emit({ ...arm, selecting: true })
    h.emit({ kind: 'cancel', active: false, tabId: 'tab-a', generation, reason: 'escape' })
    assert.equal(indicator(h), null, 'Cancellation passes through immediately')
    assert.equal(api.getHeldContinuationCount(), 1)
    api.setContinuationsHeld(false)
    h.flush()
    assert.equal(indicator(h), null)

    api.setContinuationsHeld(true)
    h.emit(arm)
    h.emit({ ...arm, selecting: true })
    h.emit({ ...arm, targetId: 'task-b', selecting: false })
    h.emit(dispatch)
    api.setContinuationsHeld(false)
    assert.equal(h.dispatches.length, before + 1, 'An owned release drains synchronously through the original reader')
    assert.deepEqual(h.dispatches.at(-1), ['tab-a', 'queue', 'task-b', 'shortcut'])
    api.setContinuationsHeld(false)
    assert.equal(h.dispatches.length, before + 1, 'An empty second release cannot replay')
    h.flush()
  }
  assert.equal(h.traces.filter(({ data }) => data.reason === 'stale-owner-state').length, 20)
  assert.equal(h.traces.filter(({ data }) => data.reason === 'stale-owner-dispatch').length, 5)
})

test('PIFB-26: unmount discards held continuations and production has no continuation controls', t => {
  const h = harness(t)
  const bridge = h.mount('PromptInputShortcuts', bridgeProps())
  const api = h.window.__onwardPromptInputShortcutsDebug
  const generation = h.contexts.at(-1).generation
  api.setContinuationsHeld(true)
  h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation })
  h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation, selecting: false })
  h.emit({ kind: 'dispatch', active: false, tabId: 'tab-a', generation, actionId: 'queue' })
  assert.equal(api.getHeldContinuationCount(), 2)
  bridge.close()
  assert.equal(h.window.__onwardPromptInputShortcutsDebug, undefined)
  assert.equal(api.getHeldContinuationCount(), 0)
  api.setContinuationsHeld(false)
  api.setContinuationsHeld(true)
  assert.equal(api.getHeldContinuationCount(), 0)
  assert.equal(h.dispatches.length, 0)
  assert.equal(h.leaderViews.at(-1), null)

  const production = harness(t, false)
  production.mount('PromptInputShortcuts', bridgeProps())
  const current = production.contexts.at(-1).generation
  assert.equal(production.window.__onwardPromptInputShortcutsDebug, undefined)
  production.emit({ kind: 'state', active: true, tabId: 'tab-a', generation: current })
  production.emit({ kind: 'state', active: true, tabId: 'tab-a', generation: current, selecting: true })
  assert.equal(production.leaderViews.at(-1).event.selecting, true)
  production.emit({ kind: 'dispatch', active: false, tabId: 'tab-a', generation: current, actionId: 'queue' })
  assert.equal(production.dispatches.length, 1)
})

test('PIFB-22: visible Leader snapshots follow accepted events, layout identity and cancellation without stale revival', t => {
  const h = harness(t)
  const bridge = h.mount('PromptInputShortcuts', bridgeProps())
  for (let trial = 0; trial < 5; trial++) {
    const generation = h.contexts.at(-1).generation
    h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation })
    assert.equal(h.leaderViews.at(-1).targets.length, 2)
    h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation, selecting: true })
    assert.equal(h.leaderViews.at(-1).event.selecting, true)
    h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation, selecting: false, targetId: 'task-b' })
    assert.equal(h.leaderViews.at(-1).event.targetId, 'task-b')
    bridge.update({ terminals: [...bridgeProps().terminals].reverse() })
    assert.equal(h.leaderViews.at(-1).targets[0].id, 'task-b')
    bridge.update({ blocked: true })
    assert.equal(h.leaderViews.at(-1), null)
    bridge.update({ ...bridgeProps(), tabId: 'tab-b' })
    bridge.update({ tabId: 'tab-a' })
    h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation, selecting: true })
    assert.equal(h.leaderViews.at(-1), null)
  }
  bridge.close()
  assert.equal(h.leaderViews.at(-1), null)
})

test('PIFB-23: local preview owns selector release and retains the target without sending live input', async t => {
  const h = harness(t)
  const settings = { ...h.load(resolve(ROOT, 'src/utils/prompt-input.ts')).createDefaultPromptInputSettings(), leader: 'Control+X' }
  const preview = h.mount('PromptShortcutPreview', { settings, disabled: false, onMatch: noop })
  preview.tree.props.onFocus()
  await Promise.resolve()
  h.flush()
  for (let trial = 0; trial < 5; trial++) {
    h.previewKey('x', { code: 'KeyX', ctrlKey: true })
    h.previewKey('Alt', { altKey: true })
    assert.equal(preview.tree.props['data-selecting'], true)
    h.previewKey('3', { code: 'Digit3', altKey: true })
    h.previewKey('Alt', { type: 'keyup', altKey: true })
    assert.equal(preview.tree.props['data-selecting'], false)
    assert.equal(preview.tree.props['data-target-id'], '3')
    h.previewKey('q', { code: 'KeyQ' })
    assert.equal(preview.tree.props['data-action-id'], 'queue')
    assert.equal(h.timers.size, 0)
  }
  assert.deepEqual(h.dispatches, [])
})

test('PIFB-19: every repeated shortcut-error occurrence can be shown and dismissed independently', t => {
  const h = harness(t)
  const bridge = h.mount('PromptInputShortcuts', bridgeProps())
  for (let trial = 0; trial < 5; trial++) {
    h.emit({ kind: 'cancel', active: false, tabId: 'tab-a', generation: h.contexts.at(-1).generation, reason: 'target-conflict' })
    assert.equal(bridge.tree.props.role, 'alert')
    assert(findNode(bridge.tree, node => node.type === 'span').children.includes('promptInput.runtime.conflict'))
    findNode(bridge.tree, node => node.type === 'button').props.onClick()
    h.flush()
    assert.equal(bridge.tree, null)
  }
})

test('PIFB-20: the real preview cancels native-invalid input, isolates capture and cleans its ownership', async t => {
  const h = harness(t)
  const settings = { ...h.load(resolve(ROOT, 'src/utils/prompt-input.ts')).createDefaultPromptInputSettings(), leader: 'Control+X' }
  const matches = []
  const preview = h.mount('PromptShortcutPreview', { settings, disabled: false, onMatch: id => matches.push(id) })
  preview.tree.props.onFocus()
  await Promise.resolve()
  h.flush()
  assert.equal(preview.tree.props['data-phase'], 'ready')
  for (const [key, fields] of [
    ['Dead', {}], ['Process', {}], ['Unidentified', {}], ['AltGraph', {}], ['CapsLock', {}],
    ['q', { isComposing: true }], ['q', { keyCode: 229 }], ['q', { getModifierState: name => name === 'AltGraph' }]
  ]) {
    h.previewKey('x', { code: 'KeyX', ctrlKey: true })
    assert.equal(preview.tree.props['data-result'], 'state')
    h.previewKey(key, fields)
    assert.equal(preview.tree.props['data-result'], 'cancel', `${key} retires the pending sequence`)
    h.previewKey('q', { code: 'KeyQ' })
    assert.equal(preview.tree.props['data-action-id'], undefined)
    assert.equal(h.timers.size, 0)
  }
  for (let trial = 0; trial < 5; trial++) {
    h.previewKey('x', { code: 'KeyX', ctrlKey: true })
    h.previewKey('Shift')
    h.previewKey('q', { code: 'KeyQ' })
    assert.equal(preview.tree.props['data-action-id'], 'queue')
    assert.equal(matches.at(-1), 'queue')
  }
  const traversal = h.previewKey('Tab')
  assert.equal(traversal.stopped, true)
  assert.equal(traversal.defaultPrevented, undefined, 'Unarmed Tab still leaves the preview')
  assert.equal(h.previewKey('s', { ctrlKey: true }).stopped, true, 'Unmatched keys cannot reach the editor')
  assert.equal(h.previewKey('s', { ctrlKey: true, target: h.editorElement }).stopped, undefined, 'Other focused surfaces are untouched')
  assert.equal(h.previewKey('s', { type: 'keyup' }).stopped, true)
  h.previewKey('x', { code: 'KeyX', ctrlKey: true })
  preview.update({ settings: { ...settings, leader: 'F6' } })
  assert.equal(h.timers.size, 0, 'Draft replacement cancels the old timer')
  preview.tree.props.onBlur()
  h.flush()
  assert.equal(preview.tree.props['data-phase'], 'idle')
  assert.deepEqual(h.suspensions, [true, false])
  preview.close()
  assert.equal(h.window.listeners.get('keydown').size, 0)
  assert.equal(h.window.listeners.get('keyup').size, 0)
  assert.equal(h.window.listeners.get('keypress').size, 0)
  assert.deepEqual(h.dispatches, [])
})

test('PIFB-21: direct unmount releases ready and pending preview ownership without a blur event', async t => {
  for (const pending of [false, true]) {
    const h = harness(t)
    let acknowledge
    if (pending) h.setSuspensionHook(suspended => suspended ? new Promise(resolve => { acknowledge = resolve }) : Promise.resolve())
    const settings = { ...h.load(resolve(ROOT, 'src/utils/prompt-input.ts')).createDefaultPromptInputSettings(), leader: 'Control+X' }
    const preview = h.mount('PromptShortcutPreview', { settings, disabled: false, onMatch: () => {} })
    preview.tree.props.onFocus()
    await Promise.resolve()
    h.flush()
    assert.equal(preview.tree.props['data-phase'], pending ? 'preparing' : 'ready')
    if (!pending) {
      h.previewKey('x', { code: 'KeyX', ctrlKey: true })
      assert.equal(h.timers.size, 1)
    }
    const readyBefore = h.traces.filter(event => event.data?.reason === 'ready').length
    preview.close()
    assert.equal(h.timers.size, 0)
    assert.deepEqual(h.suspensions, [true, false], 'Unmount requests resume even before suspension ACK')
    acknowledge?.()
    await Promise.resolve()
    h.flush()
    assert.equal(h.traces.filter(event => event.data?.reason === 'ready').length, readyBefore, 'Late ACK never reactivates a disposed preview')
    if (pending) assert(h.traces.some(event => event.data?.reason === 'enter-stale'))
    for (const name of ['keydown', 'keyup', 'keypress']) assert.equal(h.window.listeners.get(name).size, 0)
  }
})

test('PIFB-01: real reader rejects stale/missing generations for state, dispatch and cancel after A-B-A', t => {
  const h = harness(t)
  const bridge = h.mount('PromptInputShortcuts', bridgeProps())
  for (let trial = 0; trial < 5; trial++) {
    const oldGeneration = h.contexts.at(-1).generation
    bridge.update({ tabId: 'tab-b' })
    bridge.update({ tabId: 'tab-a' })
    const generation = h.contexts.at(-1).generation
    assert.equal(generation, oldGeneration + 2)
    const staleEvents = [oldGeneration, undefined].flatMap(stale => [
      { kind: 'state', active: true, tabId: 'tab-a', generation: stale },
      { kind: 'dispatch', active: false, tabId: 'tab-a', generation: stale, actionId: 'queue' },
      { kind: 'cancel', active: false, tabId: 'tab-a', generation: stale, reason: 'target-unavailable' }
    ])
    const before = h.dispatches.length
    for (const event of staleEvents) h.emit(event)
    assert.equal(indicator(h), null)
    assert.equal(h.dispatches.length, before)
    assert.equal(findNode(bridge.tree, node => node.props?.className === 'prompt-input-global-notice'), null)
    h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation })
    assert(indicator(h))
    assert.equal(bridge.tree, null, 'Armed Leader state occupies no permanent UI row')
    for (const event of staleEvents) { h.emit(event); assert(indicator(h), 'Old cancellation cannot erase the current owner') }
    assert.equal(h.dispatches.length, before)
    h.emit({ kind: 'dispatch', active: false, tabId: 'tab-a', generation, actionId: 'queue' })
    assert.deepEqual(h.dispatches.at(-1), ['tab-a', 'queue', undefined, 'shortcut'])
    assert.equal(h.dispatches.length, before + 1)
    assert.equal(indicator(h), null)
  }
  const rejected = h.traces.filter(({ data }) => data.reason === 'stale-generation')
  assert.equal(rejected.length, 60)
  assert(rejected.every(({ name }) => name === 'renderer:prompt-shortcut.state-changed'))
})

test('PIFB-02: layout, active Task, draft/UI state and blocking do not advance tab generation', t => {
  const h = harness(t)
  const props = bridgeProps()
  const bridge = h.mount('PromptInputShortcuts', props)
  const generation = h.contexts.at(-1).generation
  for (let trial = 0; trial < 5; trial++) {
    bridge.update({ terminals: [...props.terminals].reverse(), activeTerminalId: 'task-b' })
    bridge.update({ visibleCount: 1 })
    bridge.update({ promptHidden: true, blocked: true })
    h.setInputState({ selectedIds: ['task-b'], busy: true, notice: { text: 'Complete', error: false } })
    bridge.update(props)
    assert(h.contexts.every(context => context.generation === generation))
    assert.equal(h.shortcutListeners.size, 1)
  }
  bridge.close()
  assert.equal(h.shortcutListeners.size, 0)
})

function mountNotebook(h, props = {}) {
  const notebook = h.mount('PromptNotebook', {
    tabId: 'tab-a', activeTab: true, terminals: [], taskLayout: { kind: 'preset', count: 1 },
    prompts: [], globalPromptIds: [], promptCleanup: { autoEnabled: false }, scheduleMap: new Map(), scheduleNotifications: [],
    editorDraft: null, promptEditorHeight: 180, hidden: false, width: 320,
    onEditorDraftChange: noop, onAddPrompt: noop, onUpdatePrompt: noop, ...props
  })
  const child = findNode(notebook.tree, node => node.type?.name === 'PromptEditorWithAppend')
  assert(child)
  const editor = h.mount('PromptEditorWithAppend', child.props)
  return { notebook, editor }
}

test('PIFB-03: held parent sync stays stale while real editor callbacks advance live content/title/revision', t => {
  const h = harness(t)
  const { editor } = mountNotebook(h)
  h.debounce()
  for (let trial = 0; trial < 5; trial++) {
    h.window.__onwardPromptNotebookDebug.setEditorContent(`old-${trial}`)
    h.flush()
    h.debounce()
    const api = h.window.__onwardPromptNotebookDebug
    const before = api.getLiveDraftSnapshot()
    api.setEditorContent(`pending-${trial}`)
    h.flush()
    assert.equal(h.timers.size, 1)
    const parent = api.getEditorContent()
    api.setDraftSyncHeld(true)
    assert(api.isDraftSyncHeld())
    assert.equal(h.timers.size, 0, 'Hold cancels an already scheduled parent notification')
    for (let edit = 0; edit < 20; edit++) {
      api.setEditorContent(`live-${trial}-${edit}`)
      api.setEditorTitle(`title-${trial}-${edit}`)
      h.flush()
      assert.equal(api.getEditorContent(), parent)
      assert.equal(h.timers.size, 0)
    }
    h.editorElement.innerText = `native-${trial}\nline-two`
    findNode(editor.tree, node => node.props?.className === 'prompt-editor-content').props.onInput()
    h.flush()
    const live = api.getLiveDraftSnapshot()
    assert.equal(live.content, `native-${trial}\nline-two`)
    assert.equal(live.title, `title-${trial}-19`)
    assert(live.revision > before.revision)
    assert.equal(api.getEditorContent(), parent)
    assert.equal(h.timers.size, 0)
    api.setDraftSyncHeld(false)
    assert.equal(api.isDraftSyncHeld(), false)
    h.debounce()
    assert.equal(api.getEditorContent(), live.content)
  }
})

test('PIFB-04: deactivation releases the hold and unmount cancels timers and stale controls', t => {
  const h = harness(t)
  const { editor } = mountNotebook(h)
  h.debounce()
  const api = h.window.__onwardPromptNotebookDebug
  api.setDraftSyncHeld(true)
  api.setEditorContent('held-until-deactivation')
  h.flush()
  const oldControl = h.window.__onwardPromptEditorContentControl
  editor.update({ activeTab: false })
  assert.equal(oldControl.isDraftSyncHeld(), false)
  h.debounce()
  assert.equal(api.getEditorContent(), 'held-until-deactivation')
  editor.update({ activeTab: true })
  api.setDraftSyncHeld(true)
  api.setEditorContent('held-until-unmount')
  h.flush()
  const control = h.window.__onwardPromptEditorContentControl
  editor.close()
  assert.equal(control.isDraftSyncHeld(), false)
  control.setDraftSyncHeld(false)
  control.setDraftSyncHeld(true)
  assert.equal(control.isDraftSyncHeld(), false)
  assert.equal(h.timers.size, 0)
  assert.equal(h.controllers.size, 0)
  assert.equal(h.window.__onwardPromptEditorContentControl, undefined)
})

test('PIFB-05: production exposes no hold API and retains its single 300ms parent debounce', t => {
  const h = harness(t, false)
  const { editor } = mountNotebook(h)
  assert.equal(h.window.__onwardPromptNotebookDebug, undefined)
  assert.equal(h.window.__onwardPromptEditorContentControl, undefined)
  h.editorElement.innerText = 'normal-input'
  findNode(editor.tree, node => node.props?.className === 'prompt-editor-content').props.onInput()
  h.flush()
  h.debounce()
  assert.equal(h.controllers.get('tab-a').snapshot().content, 'normal-input')
  h.editorElement.innerText = 'pending-at-unmount'
  findNode(editor.tree, node => node.props?.className === 'prompt-editor-content').props.onInput()
  assert.equal(h.timers.size, 1)
  editor.close()
  assert.equal(h.timers.size, 0)
})

test('PIFB-06: holding the actual shortcut callback defers only dispatch and drains synchronously', t => {
  const h = harness(t)
  const bridge = h.mount('PromptInputShortcuts', bridgeProps())
  const api = h.window.__onwardPromptInputShortcutsDebug
  assert(api)
  const generation = h.contexts.at(-1).generation
  for (let trial = 0; trial < 5; trial++) {
    const before = h.dispatches.length
    api.setDispatchHeld(true)
    h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation })
    assert(indicator(h), 'State events continue while held')
    h.emit({ kind: 'dispatch', active: false, tabId: 'tab-a', generation, actionId: 'queue', targetId: 'task-b' })
    assert.equal(api.getHeldDispatchCount(), 1)
    assert.equal(h.dispatches.length, before)
    assert(indicator(h), 'The held callback has not reset the owner')
    h.emit({ kind: 'cancel', active: false, tabId: 'tab-a', generation, reason: 'escape' })
    assert.equal(indicator(h), null, 'Cancel events continue while held')
    assert.equal(api.getHeldDispatchCount(), 1)
    h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation })
    api.setDispatchHeld(false)
    assert.equal(api.getHeldDispatchCount(), 0)
    assert.equal(h.dispatches.length, before + 1, 'Release drains before returning, without a timer or render')
    assert.deepEqual(h.dispatches.at(-1), ['tab-a', 'queue', 'task-b', 'shortcut'])
    h.flush()
    assert.equal(indicator(h), null)
    api.setDispatchHeld(false)
    assert.equal(h.dispatches.length, before + 1, 'An empty release cannot replay delivery')
  }
})

test('PIFB-07: held old-generation dispatch survives A-B-A then rejects without clearing a fresh owner', t => {
  const h = harness(t)
  const bridge = h.mount('PromptInputShortcuts', bridgeProps())
  const api = h.window.__onwardPromptInputShortcutsDebug
  for (let trial = 0; trial < 5; trial++) {
    const oldGeneration = h.contexts.at(-1).generation
    const before = h.dispatches.length
    api.setDispatchHeld(true)
    h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation: oldGeneration })
    h.emit({ kind: 'dispatch', active: false, tabId: 'tab-a', generation: oldGeneration, actionId: 'queue' })
    bridge.update({ tabId: 'tab-b' })
    assert.equal(api.getHeldDispatchCount(), 1)
    bridge.update({ tabId: 'tab-a' })
    assert.strictEqual(h.window.__onwardPromptInputShortcutsDebug, api)
    assert.equal(api.getHeldDispatchCount(), 1)
    const generation = h.contexts.at(-1).generation
    h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation })
    assert(indicator(h))
    api.setDispatchHeld(false)
    assert.equal(api.getHeldDispatchCount(), 0)
    assert.equal(h.dispatches.length, before)
    h.flush()
    assert(indicator(h), 'A stale release must preserve the new sequence owner')
    h.emit({ kind: 'dispatch', active: false, tabId: 'tab-a', generation, actionId: 'execute' })
    assert.equal(h.dispatches.length, before + 1)
  }
  assert.equal(h.traces.filter(({ data }) => data.reason === 'stale-generation').length, 5)
})

test('PIFB-08: release checks current blocking and layout context, while preserving the captured target ID', t => {
  const h = harness(t)
  const props = bridgeProps()
  const bridge = h.mount('PromptInputShortcuts', props)
  const api = h.window.__onwardPromptInputShortcutsDebug
  const generation = h.contexts.at(-1).generation
  api.setDispatchHeld(true)
  h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation })
  h.emit({ kind: 'dispatch', active: false, tabId: 'tab-a', generation, actionId: 'queue', targetId: 'task-b' })
  bridge.update({ visibleCount: 1 })
  assert.equal(api.getHeldDispatchCount(), 1)
  assert.deepEqual(h.contexts.at(-1).visibleTerminalIds, ['task-a'])
  api.setDispatchHeld(false)
  assert.deepEqual(h.dispatches[0], ['tab-a', 'queue', 'task-b', 'shortcut'], 'The dispatcher receives the original ID for live availability validation')
  h.flush()
  api.setDispatchHeld(true)
  h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation })
  h.emit({ kind: 'dispatch', active: false, tabId: 'tab-a', generation, actionId: 'execute' })
  bridge.update({ blocked: true })
  api.setDispatchHeld(false)
  assert.equal(h.dispatches.length, 1)
  assert(h.traces.some(({ data }) => data.phase === 'rejected' && data.reason === 'context-changed'))
})

test('PIFB-09: dispatch barrier is absent in production and unmount discards queued events and stale APIs', t => {
  const h = harness(t)
  const bridge = h.mount('PromptInputShortcuts', bridgeProps())
  const api = h.window.__onwardPromptInputShortcutsDebug
  api.setDispatchHeld(true)
  for (let index = 0; index < 20; index++) {
    h.emit({ kind: 'dispatch', active: false, tabId: 'tab-a', generation: -1, actionId: 'queue' })
  }
  assert.equal(api.getHeldDispatchCount(), 20, 'Holding occurs before even the generation guard')
  assert.equal(h.traces.filter(({ data }) => data.reason === 'stale-generation').length, 0)
  bridge.close()
  assert.equal(h.window.__onwardPromptInputShortcutsDebug, undefined)
  assert.equal(api.getHeldDispatchCount(), 0)
  api.setDispatchHeld(false)
  assert.equal(h.dispatches.length, 0)
  const production = harness(t, false)
  production.mount('PromptInputShortcuts', bridgeProps())
  assert.equal(production.window.__onwardPromptInputShortcutsDebug, undefined)
  const generation = production.contexts.at(-1).generation
  production.emit({ kind: 'state', active: true, tabId: 'tab-a', generation })
  production.emit({ kind: 'dispatch', active: false, tabId: 'tab-a', generation, actionId: 'queue' })
  assert.equal(production.dispatches.length, 1)
})

test('PIFB-10: actual App debug adapter validates preset counts and patches layout without replacing parked terminals', t => {
  const h = harness(t)
  const filename = resolve(ROOT, 'src/App.tsx')
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const effects = []
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' &&
      node.arguments[0]?.getText(source).includes('debugWindow.__onwardAppDebug = api')) effects.push(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(effects.length, 1)
  // Execute the existing effect verbatim; only its surrounding App providers
  // are substituted, so validation, patch shape and debug gating remain real.
  const output = ts.transpileModule(`exports.install = ${effects[0].getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const terminals = Object.freeze(Array.from({ length: 8 }, (_, index) => Object.freeze({ id: `task-${index}` })))
  const state = { activeTabId: 'tab-a', tabs: [{ id: 'tab-a', terminals, layoutMode: { kind: 'preset', count: 4 } }] }
  const patches = []
  const { isPresetCount } = h.load(resolve(ROOT, 'src/utils/layout-mode.ts'))
  const install = (autotest) => {
    const window = { electronAPI: { debug: { autotest } } }
    const exports = {}
    new Function('exports', 'window', 'state', 'handleShortcutAction', 'createTab', 'switchTab', 'updateActiveTab', 'isPresetCount', output)(
      exports, window, state, noop, noop, noop, patch => {
        patches.push(patch)
        state.tabs[0] = { ...state.tabs[0], ...patch }
      }, isPresetCount
    )
    return { window, cleanup: exports.install() }
  }
  const production = install(false)
  assert.equal(production.window.__onwardAppDebug, undefined)
  assert.equal(production.cleanup, undefined)
  const debug = install(true)
  t.after(() => debug.cleanup())
  const api = debug.window.__onwardAppDebug
  for (const count of [2, 4, 1, 6, 8]) {
    assert.equal(api.setLayoutCountForAutotest(count), true)
    assert.deepEqual(patches.at(-1), { layoutMode: { kind: 'preset', count } })
    assert.strictEqual(state.tabs[0].terminals, terminals)
    assert.equal(state.tabs[0].terminals.length, 8)
  }
  for (const invalid of [0, 3, 5, 7, 9, -1, 2.5, NaN, Infinity, '2', null, undefined]) {
    assert.equal(api.setLayoutCountForAutotest(invalid), false)
  }
  assert.equal(patches.length, 5)
  debug.cleanup()
  assert.equal(debug.window.__onwardAppDebug, undefined)
})

function mountSendingNotebook(h) {
  const usage = []
  const sends = []
  const history = []
  h.window.electronAPI.telemetry = { track: (name, properties) => usage.push({ name, properties }) }
  h.window.electronAPI.promptInput.send = async (id, payload) => {
    sends.push({ id, payload })
    return { ok: true, phase: 'complete', contentDelivered: payload.includePrompt }
  }
  const view = mountNotebook(h, {
    terminals: [{ id: 'task-a', title: 'A', isActive: true }, { id: 'task-b', title: 'B' }],
    onAddPrompt: (prompt, tabId) => history.push({ prompt, tabId })
  })
  const select = ids => {
    findNode(view.notebook.tree, node => typeof node.props?.onSelectionChange === 'function').props.onSelectionChange(ids)
    h.flush()
  }
  select(['task-a', 'task-b'])
  return { ...view, usage, sends, history, select, dispatch: (...args) => h.dispatchers.get('tab-a')(...args) }
}

test('PIFB-11: real Notebook dispatcher emits exactly one existing usage action for a two-target invocation', async t => {
  const h = harness(t)
  const view = mountSendingNotebook(h)
  for (const [actionId, expected] of [
    ['send', 'send'], ['execute', 'execute'], ['sendAndExecute', 'sendAndExecute'],
    ['queue', 'sendAndExecute'], ['sendAllAndExecute', 'sendAndExecute']
  ]) {
    h.window.__onwardPromptNotebookDebug.setEditorContent(`private-draft-${actionId}`)
    h.flush()
    const before = view.usage.length
    const beforeSends = view.sends.length
    assert.equal(await view.dispatch(actionId), true)
    h.flush()
    assert.equal(view.usage.length, before + 1)
    assert.deepEqual(view.usage.at(-1), { name: 'prompt/use', properties: { action: expected } })
    assert.deepEqual(view.sends.slice(beforeSends).map(send => send.id), ['task-a', 'task-b'])
  }
  assert.equal(view.usage.length, 5)
  assert.equal(view.sends.length, 10)
})

test('PIFB-12: suffix and key-only partial failures do not duplicate accepted usage events', async t => {
  const h = harness(t)
  const view = mountSendingNotebook(h)
  h.window.electronAPI.promptInput.send = async (id, payload) => {
    view.sends.push({ id, payload })
    return id === 'task-a' ? { ok: true, phase: 'complete', contentDelivered: payload.includePrompt }
      : { ok: false, phase: 'key', contentDelivered: payload.includePrompt, reason: 'write-failed' }
  }
  h.window.__onwardPromptNotebookDebug.setEditorContent('retained-private-draft')
  h.flush()
  assert.equal(await view.dispatch('queue'), false)
  h.flush()
  assert.equal(view.sends.length, 2)
  assert.equal(view.history.length, 1)
  assert.deepEqual(view.usage, [{ name: 'prompt/use', properties: { action: 'sendAndExecute' } }])
  assert.equal(h.window.__onwardPromptNotebookDebug.getLiveDraftSnapshot().content, 'retained-private-draft')
  assert.equal(await view.dispatch('execute'), false)
  h.flush()
  assert.equal(view.sends.length, 4)
  assert.equal(view.history.length, 1)
  assert.deepEqual(view.usage, [
    { name: 'prompt/use', properties: { action: 'sendAndExecute' } },
    { name: 'prompt/use', properties: { action: 'execute' } }
  ])
})

test('PIFB-13: empty, unavailable, unknown-action and busy rejections emit no accepted usage', async t => {
  const h = harness(t)
  const view = mountSendingNotebook(h)
  assert.equal(await view.dispatch('send'), false)
  assert.equal(await view.dispatch('unknown-action'), false)
  h.window.__onwardPromptNotebookDebug.setEditorContent('fresh-private-draft')
  view.select(['parked-task'])
  assert.equal(await view.dispatch('queue'), false)
  assert.equal(view.usage.length, 0)
  assert.equal(view.sends.length, 0)
  view.select(['task-a', 'task-b'])
  const replies = []
  h.window.electronAPI.promptInput.send = (_id, payload) => new Promise(resolveReply => {
    replies.push(() => resolveReply({ ok: true, phase: 'complete', contentDelivered: payload.includePrompt }))
  })
  const accepted = view.dispatch('queue')
  assert.equal(replies.length, 2)
  assert.equal(view.usage.length, 1)
  assert.equal(await view.dispatch('execute'), false)
  assert.equal(view.usage.length, 1)
  for (const reply of replies) reply()
  assert.equal(await accepted, true)
  assert.deepEqual(view.usage, [{ name: 'prompt/use', properties: { action: 'sendAndExecute' } }])
})

test('PIFB-14: a telemetry exception never aborts terminal delivery or history settlement', async t => {
  const h = harness(t)
  const view = mountSendingNotebook(h)
  let attempts = 0
  h.window.electronAPI.telemetry.track = () => { attempts += 1; throw new Error('Telemetry IPC unavailable') }
  h.window.__onwardPromptNotebookDebug.setEditorContent('private-content')
  h.flush()
  assert.equal(await view.dispatch('queue'), true)
  assert.equal(attempts, 1)
  assert.equal(view.sends.length, 2)
  assert.equal(view.history.length, 1)
  const failures = h.traces.filter(({ data }) => data.phase === 'usage-track-failed')
  assert.equal(failures.length, 1)
  assert.equal(failures[0].name, 'renderer:prompt-input.dispatch-action')
  assert.equal(JSON.stringify(failures).includes('private-content'), false)
})

function invokeInput(h, view, bridge, actionId, origin) {
  if (origin === 'button') {
    return findNode(view.notebook.tree, node => typeof node.props?.onAction === 'function').props.onAction(actionId)
  }
  const generation = h.contexts.at(-1).generation
  h.emit({ kind: 'state', active: true, tabId: 'tab-a', generation })
  assert(indicator(h))
  h.emit({ kind: 'dispatch', active: false, tabId: 'tab-a', generation, actionId })
  return h.dispatchResults.at(-1)
}

const actionTraceEvents = h => h.legacyTraces.filter(event => ['ui.prompt.action', 'ui.prompt.action.done'].includes(event.name))

test('PIFB-15: buttons and shortcut callbacks retain one legacy flow and duration through every recipient ACK', async t => {
  const h = harness(t, true, true)
  const view = mountSendingNotebook(h)
  const bridge = h.mount('PromptInputShortcuts', bridgeProps())
  const { performanceTrace } = h.load(resolve(ROOT, 'src/utils/performance-trace.ts'))
  const flowIds = new Set()
  for (let trial = 0; trial < 5; trial++) {
    for (const origin of ['button', 'shortcut']) {
      for (const [actionId, action] of [
        ['send', 'send'], ['execute', 'execute'], ['sendAndExecute', 'sendAndExecute'],
        ['queue', 'sendAndExecute'], ['sendAllAndExecute', 'sendAndExecute']
      ]) {
        const content = `private-trace-draft-${trial}-${origin}-${actionId}`
        h.window.__onwardPromptNotebookDebug.setEditorContent(content)
        h.window.__onwardPromptNotebookDebug.setEditorTitle('private-trace-title')
        h.flush()
        const before = actionTraceEvents(h).length
        const snapshot = h.controllers.get('tab-a').snapshot()
        const historyCount = view.history.length
        const replies = []
        h.window.electronAPI.promptInput.send = (id, payload) => new Promise(resolveReply => {
          replies.push({ id, payload, flowId: performanceTrace.getActiveTerminalFlow(id), resolveReply })
        })
        const pending = invokeInput(h, view, bridge, actionId, origin)
        try {
          const startEvents = actionTraceEvents(h).slice(before)
          assert.equal(startEvents.length, 1, 'An accepted invocation begins exactly one flow before awaiting delivery')
          const [start] = startEvents
          assert.equal(start.ph, 's')
          assert.equal(start.name, 'ui.prompt.action')
          assert.equal(start.cat, 'prompt')
          assert.equal(start.args.action, action)
          assert.equal(start.args.origin, origin)
          assert.deepEqual(start.args.terminalIds, ['task-a', 'task-b'])
          assert(start.id && !flowIds.has(start.id), 'Each invocation owns a fresh correlation identity')
          flowIds.add(start.id)
          assert.deepEqual(replies.map(reply => reply.id), ['task-a', 'task-b'])
          assert(replies.every(reply => reply.flowId === start.id), 'Both recipient render paths are correlated before input is sent')
          assert.equal(performanceTrace.getActiveTerminalFlow('unselected-task'), null)
          assert(replies.every(reply => reply.payload.content === (actionId === 'execute' ? '' : content)))
          h.advanceTraceTime(7)
          replies[0].resolveReply({ ok: true, phase: 'complete', contentDelivered: actionId !== 'execute' })
          for (let tick = 0; tick < 5; tick++) await Promise.resolve()
          assert.equal(actionTraceEvents(h).length, before + 1, 'The first ACK cannot close a multi-recipient span')
          h.advanceTraceTime(13)
          replies[1].resolveReply({ ok: true, phase: 'complete', contentDelivered: actionId !== 'execute' })
          assert.equal(await pending, true)
          h.flush()
          const events = actionTraceEvents(h).slice(before)
          assert.equal(events.length, 3)
          const end = events.find(event => event.ph === 'f')
          const span = events.find(event => event.ph === 'X')
          assert.equal(end.name, 'ui.prompt.action.done')
          assert.equal(end.id, start.id)
          assert.equal(end.args.action, action)
          assert.deepEqual([end.args.successCount, end.args.sentOnlyCount, end.args.failedCount], [2, 0, 0])
          assert.equal(span.name, 'ui.prompt.action')
          assert.equal(span.cat, 'prompt')
          assert.equal(span.ts, start.ts)
          assert.equal(span.dur, 20000, 'The real timeAsync wrapper measures the complete delivery interval in microseconds')
          assert.equal(span.args.action, action)
          assert.equal(span.args.flowId, start.id)
          assert.equal(span.args.result, 'success')
          assert.equal(span.args.origin, origin)
          if (actionId === 'execute') {
            assert.deepEqual(h.controllers.get('tab-a').snapshot(), snapshot)
            assert.equal(view.history.length, historyCount)
          }
          assert.equal(JSON.stringify(h.legacyTraces).includes('private-trace-'), false, 'Legacy action instrumentation never captures draft/title text')
        } finally {
          for (const reply of replies) reply.resolveReply({ ok: true, phase: 'complete', contentDelivered: reply.payload.includePrompt })
          await pending
        }
      }
    }
  }
  assert.equal(flowIds.size, 50)
})

test('PIFB-16: legacy flow completion preserves partial, suffix-only and unavailable recipient outcomes', async t => {
  const h = harness(t, true, true)
  const view = mountSendingNotebook(h)
  for (const scenario of [
    { action: 'queue', suffixOnly: true, expected: [1, 1, 0] },
    { action: 'execute', suffixOnly: false, expected: [1, 0, 1] },
    { action: 'send', throwAll: true, expected: [0, 0, 2] }
  ]) {
    h.window.__onwardPromptNotebookDebug.setEditorContent('private-retained-trace-content')
    h.flush()
    const before = actionTraceEvents(h).length
    const snapshot = h.controllers.get('tab-a').snapshot()
    h.window.electronAPI.promptInput.send = async (id, payload) => {
      if (scenario.throwAll) throw new Error('Recipient IPC unavailable')
      return id === 'task-a' ? { ok: true, phase: 'complete', contentDelivered: payload.includePrompt }
        : { ok: false, phase: 'key', contentDelivered: scenario.suffixOnly, reason: 'write-failed' }
    }
    assert.equal(await view.dispatch(scenario.action), false)
    h.flush()
    const events = actionTraceEvents(h).slice(before)
    assert.equal(events.length, 3)
    const start = events.find(event => event.ph === 's')
    const end = events.find(event => event.ph === 'f')
    const span = events.find(event => event.ph === 'X')
    assert.equal(end.id, start.id)
    assert.equal(span.args.flowId, start.id)
    assert.deepEqual([end.args.successCount, end.args.sentOnlyCount, end.args.failedCount], scenario.expected)
    assert.deepEqual(h.controllers.get('tab-a').snapshot(), snapshot)
    assert.equal(JSON.stringify(events).includes('private-retained-trace-content'), false)
  }
})

test('PIFB-17: rejected and busy invocations cannot create or replace an accepted legacy action flow', async t => {
  const h = harness(t, true, true)
  const view = mountSendingNotebook(h)
  const { performanceTrace } = h.load(resolve(ROOT, 'src/utils/performance-trace.ts'))
  assert.equal(await view.dispatch('send'), false)
  assert.equal(await view.dispatch('unknown-action'), false)
  h.window.__onwardPromptNotebookDebug.setEditorContent('private-trace-pending')
  view.select(['parked-task'])
  assert.equal(await view.dispatch('queue'), false)
  assert.equal(actionTraceEvents(h).length, 0)
  assert.equal(performanceTrace.getActiveTerminalFlow('task-a'), null)
  view.select(['task-a', 'task-b'])
  const replies = []
  h.window.electronAPI.promptInput.send = (_id, payload) => new Promise(resolveReply => {
    replies.push(() => resolveReply({ ok: true, phase: 'complete', contentDelivered: payload.includePrompt }))
  })
  const accepted = view.dispatch('queue')
  try {
    assert.equal(actionTraceEvents(h).length, 1)
    const flowId = actionTraceEvents(h)[0].id
    assert.equal(await view.dispatch('execute', undefined, 'shortcut'), false)
    assert.equal(actionTraceEvents(h).length, 1)
    assert.equal(performanceTrace.getActiveTerminalFlow('task-a'), flowId)
    assert.equal(performanceTrace.getActiveTerminalFlow('task-b'), flowId)
  } finally {
    for (const reply of replies) reply()
    await accepted
  }
  assert.equal(actionTraceEvents(h).length, 3)
})

test('PIFB-18: disabled legacy tracing allocates no flow or terminal correlation while delivery still completes', async t => {
  const h = harness(t)
  const view = mountSendingNotebook(h)
  const { performanceTrace } = h.load(resolve(ROOT, 'src/utils/performance-trace.ts'))
  assert.equal(performanceTrace.enabled, false)
  for (const method of ['createFlowId', 'setActiveTerminalFlow', 'recordFlowStart', 'recordFlowEnd']) {
    performanceTrace[method] = () => { assert.fail(`Disabled tracing called ${method}`) }
  }
  h.window.__onwardPromptNotebookDebug.setEditorContent('private-disabled-trace')
  assert.equal(await view.dispatch('queue'), true)
  assert.equal(view.sends.length, 2)
  assert.equal(view.history.length, 1)
  assert.deepEqual(h.legacyTraces, [])
})
