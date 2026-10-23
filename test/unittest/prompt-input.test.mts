/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDefaultPromptInputSettings, normalizePromptInputSettings, normalizePromptShortcut,
  promptShortcutFromKey, reducePromptLeader, resolvePromptTargets, shouldClearPromptDraft,
  terminalKeyToSequence, validatePromptInputSettings, normalizePromptActionColor, reorderPromptActions, promptShortcutCancellation, promptTargetModifierHeld, promptTargetSlot,
  type PromptInputSettings, type PromptLeaderState, type PromptShortcutContext
} from '../../src/utils/prompt-input.ts'

function configured(): PromptInputSettings {
  return { ...createDefaultPromptInputSettings(), leader: 'Control+X', targetModifier: null }
}
const context: PromptShortcutContext = {
  tabId: 'tab-a', visibleTerminalIds: ['task-a', 'task-b', 'task-c'], activeTerminalId: 'task-b', blocked: false
}
const armed = (targetId?: string): PromptLeaderState => ({ tabId: 'tab-a', deadline: 2500, ...(targetId ? { targetId } : {}) })

test('PI-U22: selector migration preserves direct digits and validates conflicts without dropping bindings', () => {
  assert.equal(createDefaultPromptInputSettings().targetModifier, 'Alt')
  const legacy = configured()
  delete legacy.targetModifier
  assert.equal(normalizePromptInputSettings(legacy).targetModifier, null)
  for (const modifier of [null, 'Alt', 'Control', 'Shift'] as const) {
    const settings = { ...configured(), targetModifier: modifier }
    assert.deepEqual(normalizePromptInputSettings(settings), settings)
    assert.deepEqual(normalizePromptInputSettings(normalizePromptInputSettings(settings)), settings)
    for (const platform of ['darwin', 'win32', 'linux']) {
      assert.equal(validatePromptInputSettings(settings, [], platform), null)
      if (!modifier) continue
      assert.equal(validatePromptInputSettings({ ...settings, leader: `${modifier}+3` }, [], platform), 'selector-conflict')
      assert.equal(validatePromptInputSettings(settings, [], platform, [`${modifier}+3`]), 'selector-conflict')
      const conflict = { ...settings, actions: [{ ...settings.actions[0], shortcut: `${modifier}+3` }] }
      assert.equal(validatePromptInputSettings(conflict, [], platform), 'selector-conflict')
      assert.equal(normalizePromptInputSettings(conflict).actions[0].shortcut, `${modifier}+3`)
    }
  }
  for (const value of ['Meta', 'a', 'Control+Alt', 3, {}]) {
    const settings = { ...configured(), targetModifier: value } as PromptInputSettings
    assert.equal(normalizePromptInputSettings(settings).targetModifier, null)
    assert.equal(validatePromptInputSettings(settings), 'invalid-selector')
  }
})

test('PI-U23: exact selector masks, physical digits and release flags are platform-neutral', () => {
  for (const modifier of ['Alt', 'Control', 'Shift'] as const) {
    const flag = modifier === 'Control' ? 'control' : modifier.toLowerCase()
    const input = { key: '#', code: 'Digit3', [flag]: true }
    for (const platform of ['darwin', 'win32', 'linux']) assert.equal(promptTargetSlot(promptShortcutFromKey(input, platform), modifier), 2)
    assert(promptTargetModifierHeld(input, modifier))
    assert(!promptTargetModifierHeld({ ...input, meta: true }, modifier))
    assert(!promptTargetModifierHeld({ ...input, isComposing: true }, modifier))
    assert(!promptTargetModifierHeld({ ...input, modifiers: ['altgr'] }, modifier))
    assert(promptTargetModifierHeld({ key: modifier }, modifier))
    assert(!promptTargetModifierHeld({ key: modifier, [flag]: true, type: 'keyUp' }, modifier))
    assert(!promptTargetModifierHeld({ key: modifier, [flag]: true, type: 'keyup' }, modifier))
    assert.equal(promptTargetSlot('3', modifier), null)
    assert.equal(promptTargetSlot(`${modifier}+0`, modifier), null)
    assert.equal(promptTargetSlot(`${modifier}+9`, modifier), null)
    assert.equal(promptTargetSlot(`${modifier}+Shift+3`, modifier), null)
  }
  assert.equal(promptTargetSlot(promptShortcutFromKey({ key: '3', code: 'Numpad3', alt: true }), 'Alt'), 2)
  assert.equal(promptTargetSlot(promptShortcutFromKey({ key: 'PageDown', code: 'Numpad3', alt: true }), 'Alt'), null)
  assert(!promptTargetModifierHeld({ key: '3', control: true, alt: true }, 'Alt'))
})

test('PI-U24: held selection updates the cue without extending timeout and retains one-shot identity on release', () => {
  const settings: PromptInputSettings = { ...configured(), targetModifier: 'Alt' }
  for (let cycle = 0; cycle < 500; cycle++) {
    let transition = reducePromptLeader(null, 'Control+X', 1000, settings, context)
    transition = reducePromptLeader(transition.state, null, 1100, settings, context, { selecting: true })
    assert.equal(transition.event?.selecting, true)
    assert.equal(transition.state?.deadline, 2500)
    transition = reducePromptLeader(transition.state, 'Alt+3', 1200, settings, context, { selecting: true })
    assert.equal(transition.state?.targetId, 'task-c')
    assert.equal(transition.state?.deadline, 2700)
    assert.equal(transition.event?.selecting, false)
    const repeated = reducePromptLeader(transition.state, 'Alt+1', 1300, settings, context, { repeat: true, selecting: true })
    assert.equal(repeated.state, transition.state)
    transition = reducePromptLeader(transition.state, null, 1400, settings, context, { selecting: false })
    assert.equal(transition.event, undefined)
    assert.equal(transition.state?.selecting, false)
    assert.equal(reducePromptLeader(transition.state, null, 1450, settings, context, { selecting: true }).state?.selecting, false)
    assert.equal(transition.state?.deadline, 2700)
    const result = reducePromptLeader(transition.state, 'Q', 1500, settings, context)
    assert.equal(result.event?.targetId, 'task-c')
    assert.equal(result.state, null)
  }
  assert.equal(reducePromptLeader(armed(), '3', 1100, settings, context).event?.reason, 'unmatched')
  assert.equal(reducePromptLeader(armed(), null, 2500, settings, context, { selecting: true }).event?.reason, 'timeout')
  assert.equal(Boolean(reducePromptLeader(null, 'Control+X', 1000, { ...settings, targetModifier: 'Control' }, context, { selecting: true }).event?.selecting), false)
})

test('PI-U25: a held-selector action requires its exact binding and keeps its captured recipient', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const modifier of ['Alt', 'Control', 'Shift'] as const) {
      const plain: PromptInputSettings = { ...configured(), targetModifier: modifier }
      const modified = { ...plain, actions: plain.actions.map(action => action.id === 'queue'
        ? { ...action, shortcut: `${modifier}+Q` } : action) }
      assert.equal(validatePromptInputSettings(modified, [], platform), null)
      const picked = reducePromptLeader(armed(), `${modifier}+3`, 1100, plain, context, { platform }).state
      const reordered = { ...context, visibleTerminalIds: ['task-c', 'task-a', 'task-b'] }
      for (const [settings, key, accepted] of [
        [modified, `${modifier}+Q`, true],
        [plain, `${modifier}+Q`, false],
        [modified, 'Q', false],
        [modified, `Meta+${modifier}+Q`, false]
      ] as const) {
        const result = reducePromptLeader(picked, normalizePromptShortcut(key, platform), 1200, settings, reordered, { platform })
        assert.equal(result.state, null)
        assert.equal(result.consume, true)
        assert.equal(result.event?.kind, accepted ? 'dispatch' : 'cancel')
        assert.equal(result.event?.actionId, accepted ? 'queue' : undefined)
        assert.equal(result.event?.targetId, accepted ? 'task-c' : undefined)
        assert.equal(result.event?.reason, accepted ? undefined : 'unmatched')
        assert.equal(reducePromptLeader(result.state, 'Q', 1300, settings, reordered, { platform }).consume, false)
      }
      assert.equal(terminalKeyToSequence(modified.actions.find(action => action.id === 'queue')!.terminalKey), '\t',
        'The invocation modifier never changes the terminal suffix')
    }
  }
})

test('PI-U21: optional emoji round-trip, copy and reorder preserve full sequences and v10 defaults', () => {
  const original = configured()
  assert.deepEqual(normalizePromptInputSettings(original), original)
  for (const emoji of ['🚀', '🤖', '👩🏽‍💻', '👍🏿', '🛠️']) {
    const settings = configured()
    settings.actions[0].emoji = emoji
    settings.actions.push({ ...settings.actions[0], id: 'duplicate', shortcut: null })
    assert.equal(validatePromptInputSettings(settings), null)
    const restored = normalizePromptInputSettings(JSON.parse(JSON.stringify(settings)))
    assert.equal(restored.actions[0].emoji, emoji)
    assert.equal(restored.actions.at(-1)?.emoji, emoji)
    assert.deepEqual(normalizePromptInputSettings(restored), restored)
    assert.equal(reorderPromptActions(restored.actions, 'duplicate', 'execute', false)[1].emoji, emoji)
  }
  for (const emoji of ['', '🚀🔥', 'not an emoji', null, 5, {}]) {
    const settings = { ...original, actions: [{ ...original.actions[0], emoji }] }
    assert.equal(normalizePromptInputSettings(settings).actions[0].emoji, undefined)
    assert.equal(validatePromptInputSettings(settings as PromptInputSettings), 'invalid-action')
  }
})

test('PI-U20: native and DOM inputs share IME and AltGraph cancellation without conflating physical Control+Alt', () => {
  for (const event of [{ key: 'Process' }, { key: 'Dead' }, { key: 'Unidentified' }, { key: 'q', isComposing: true }, { key: 'q', keyCode: 229 }]) {
    assert.equal(promptShortcutCancellation(event), 'ime')
    assert.equal(promptShortcutFromKey(event), null)
  }
  for (const event of [{ key: 'AltGraph' }, { key: 'q', modifiers: ['altgr'] }, { key: 'q', getModifierState: (key: string) => key === 'AltGraph' }]) {
    assert.equal(promptShortcutCancellation(event), 'altgr')
    assert.equal(promptShortcutFromKey(event), null)
  }
  assert.equal(promptShortcutCancellation({ key: 'q', ctrlKey: true, altKey: true }), null)
  assert.equal(promptShortcutFromKey({ key: 'q', ctrlKey: true, altKey: true }), 'Control+Alt+Q')
})

test('PI-U17: optional colors survive normalization; malformed and old colors use theme defaults', () => {
  const original = configured()
  assert.deepEqual(normalizePromptInputSettings(original), original)
  for (const value of ['#A0B1C2', '#000000', '#ffffff']) {
    const settings = configured()
    settings.actions[0].color = value
    assert.equal(validatePromptInputSettings(settings), null)
    const restored = normalizePromptInputSettings(JSON.parse(JSON.stringify(settings)))
    assert.equal(restored.actions[0].color, value.toLowerCase())
    assert.deepEqual(normalizePromptInputSettings(restored), restored)
  }
  for (const value of ['', '#fff', '#12345678', 'red', 'var(--accent)', '#12345g', ' #123456', null, 17, {}]) {
    assert.equal(normalizePromptActionColor(value), undefined)
    const settings = { ...original, actions: [{ ...original.actions[0], color: value }] }
    assert.equal(normalizePromptInputSettings(settings).actions[0].color, undefined)
    assert.equal(validatePromptInputSettings(settings as PromptInputSettings), 'invalid-action')
  }
})

test('PI-U18: horizontal stable-ID reorder retains hidden actions and rejects stale anchors without mutation', () => {
  const actions = configured().actions
  actions[1].visible = false
  actions[3].color = '#abcdef'
  const snapshot = structuredClone(actions)
  const next = reorderPromptActions(actions, 'queue', 'send', false)
  assert.deepEqual(next.map(action => action.id), ['sendAndExecute', 'execute', 'queue', 'send', 'sendAllAndExecute'])
  assert.deepEqual(actions, snapshot)
  for (const item of next) assert.equal(item, actions.find(action => action.id === item.id))
  assert.deepEqual(reorderPromptActions(next, 'queue', 'sendAllAndExecute', true), actions)
  for (const [source, target] of [['absent', 'send'], ['send', 'absent'], ['send', 'send']]) {
    assert.equal(reorderPromptActions(actions, source, target, true), actions)
  }
  assert.equal(reorderPromptActions(actions, 'execute', 'sendAndExecute', true), actions)
})

test('PI-U19: unsaved preview shares Leader semantics without changing saved settings', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const saved = configured()
    const before = structuredClone(saved)
    const draft = structuredClone(saved)
    draft.leader = 'CommandOrControl+J'
    Object.assign(draft.actions[4], { shortcut: 'Control+K', visible: false, color: '#123456' })
    const leader = platform === 'darwin' ? 'Meta+J' : 'Control+J'
    const initial = reducePromptLeader(null, leader, 0, draft, context, { platform })
    const target = reducePromptLeader(initial.state, '2', 1, draft, context, { platform })
    const hit = reducePromptLeader(target.state, 'Control+K', 2, draft, context, { platform })
    assert.equal(hit.event?.actionId, 'queue')
    assert.equal(hit.event?.targetId, 'task-b')
    assert.equal(hit.state, null)
    assert.deepEqual(saved, before)
  }
})

test('PI-U01: five independent presets retain text-only Send and native Tab Queue', () => {
  const settings = createDefaultPromptInputSettings()
  assert.equal(settings.leader, null)
  assert.deepEqual(settings.actions.map(({ id, includePrompt, terminalKey, target, shortcut }) =>
    [id, includePrompt, terminalKey, target, shortcut]), [
    ['sendAndExecute', true, 'Enter', 'default', 'Enter'],
    ['execute', false, 'Enter', 'default', 'E'],
    ['send', true, 'None', 'default', 'S'],
    ['sendAllAndExecute', true, 'Enter', 'all', 'A'],
    ['queue', true, 'Tab', 'default', 'Q']
  ])
  settings.actions[0].name = 'Changed'
  assert.equal(createDefaultPromptInputSettings().actions[0].name, '')
  const queue = settings.actions[4]
  queue.shortcut = 'Z'
  assert.equal(queue.terminalKey, 'Tab')
  queue.terminalKey = 'Control+C'
  assert.equal(queue.shortcut, 'Z')
})

test('PI-U02: keyboard aliases and CommandOrControl resolve for all three hosts', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const command = platform === 'darwin' ? 'Meta' : 'Control'
    for (const [input, expected] of [
      ['Ctrl+x', 'Control+X'], ['control+X', 'Control+X'],
      ['Shift+Alt+CTRL+q', 'Control+Alt+Shift+Q'], ['Command+X', 'Meta+X'], ['Win+X', 'Meta+X'],
      ['CmdOrCtrl+Return', `${command}+Enter`], ['CommandOrControl+x', `${command}+X`],
      ['Option+ArrowUp', 'Alt+Up'], ['esc', 'Escape'], ['space', 'Space'],
      ['Control++', 'Control+Plus'], ['+', 'Plus'], ['Control+=', 'Control+='],
      ['F24', 'F24'], [';', ';'], ['Shift+/', 'Shift+/']
    ]) assert.equal(normalizePromptShortcut(input, platform), expected, `${platform}: ${input}`)
    for (const invalid of ['', 'Ctrl', 'Alt+Shift', 'Ctrl+Q+E', 'NoSuchKey', 'F25', 'Control+', '__proto__', 'constructor', 'toString', 'a'.repeat(97)]) {
      assert.equal(normalizePromptShortcut(invalid, platform), null, invalid)
    }
  }
  assert.equal(normalizePromptShortcut('CommandOrControl+X', 'portable'), 'CommandOrControl+X')
})

test('PI-U03: physical Latin keys and numpad retain identity; dead/IME keys cannot arm', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(promptShortcutFromKey({ key: 'z', code: 'KeyY', ctrlKey: true }, platform), 'Control+Y')
    assert.equal(promptShortcutFromKey({ key: 'Q', code: 'KeyQ' }, platform), 'Q')
    assert.equal(promptShortcutFromKey({ key: '!', code: 'Digit1', shift: true }, platform), 'Shift+1')
    assert.equal(promptShortcutFromKey({ key: '1', code: 'Numpad1' }, platform), '1')
    assert.equal(promptShortcutFromKey({ key: 'End', code: 'Numpad1' }, platform), 'End')
    assert.equal(promptShortcutFromKey({ key: '+', code: 'NumpadAdd' }, platform), 'Plus')
    assert.equal(promptShortcutFromKey({ key: ' ', code: 'Space' }, platform), 'Space')
    assert.equal(promptShortcutFromKey({ key: 'Tab', shiftKey: true }, platform), 'Shift+Tab')
    for (const key of ['Process', 'Dead', 'Unidentified']) assert.equal(promptShortcutFromKey({ key, code: 'KeyX', ctrlKey: true }, platform), null)
    assert.equal(promptShortcutFromKey({ key: 'x', code: 'KeyX', ctrlKey: true, keyCode: 229 }, platform), null)
    assert.equal(promptShortcutFromKey({ key: 'x', code: 'KeyX', ctrlKey: true, isComposing: true }, platform), null)
    assert.equal(promptShortcutFromKey({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true, getModifierState: key => key === 'AltGraph' }, platform), null)
  }
})

test('PI-U04: terminal encodings are explicit bytes, independent from the action trigger', () => {
  const cases = [
    ['None', []], ['Enter', [13]], ['Tab', [9]], ['Shift+Tab', [27, 91, 90]],
    ['Escape', [27]], ['Backspace', [127]], ['Delete', [27, 91, 51, 126]],
    ['Up', [27, 91, 65]], ['Down', [27, 91, 66]], ['Right', [27, 91, 67]], ['Left', [27, 91, 68]],
    ['Home', [27, 91, 72]], ['End', [27, 91, 70]], ['PageUp', [27, 91, 53, 126]], ['PageDown', [27, 91, 54, 126]]
  ] as const
  for (const [name, bytes] of cases) assert.deepEqual([...Buffer.from(terminalKeyToSequence(name)!)], [...bytes], name)
  for (let byte = 1; byte <= 26; byte++) assert.deepEqual([...Buffer.from(terminalKeyToSequence(`Control+${String.fromCharCode(64 + byte)}`)!)], [byte])
  for (const key of ['Q', 'Ctrl+C', 'Command+Q', '\r', '\x1b[201~', 'Shift+Enter', 'constructor', '__proto__']) assert.equal(terminalKeyToSequence(key), null, key)
})

test('PI-U05: migration is idempotent and preserves intentional removals, false and null', () => {
  assert.deepEqual(normalizePromptInputSettings(undefined), createDefaultPromptInputSettings())
  assert.deepEqual(normalizePromptInputSettings(null), createDefaultPromptInputSettings())
  const raw = configured()
  raw.actions = [raw.actions[4], raw.actions[1]]
  raw.actions[0] = { ...raw.actions[0], id: 'custom', name: 'Unicode \u63d0\u793a \ud83e\uddea', preset: undefined, visible: false, shortcut: null, target: 'all' }
  raw.leader = 'CommandOrControl+X'
  const copy = structuredClone(raw)
  const migrated = normalizePromptInputSettings(JSON.parse(JSON.stringify(raw)))
  assert.equal(migrated.leader, 'CommandOrControl+X')
  assert.deepEqual(migrated.actions.map(action => action.id), ['custom', 'execute'])
  assert.equal(migrated.actions[0].visible, false)
  assert.equal(migrated.actions[0].shortcut, null)
  assert.equal(migrated.actions[1].includePrompt, false)
  assert.deepEqual(normalizePromptInputSettings(migrated), migrated)
  assert.deepEqual(raw, copy)
  assert.deepEqual(normalizePromptInputSettings({ ...raw, actions: [] }).actions, [])
})

test('PI-U06: malformed settings cannot introduce duplicate identities or reserved bindings', () => {
  const defaults = configured()
  const settings = normalizePromptInputSettings({
    leader: 'x', timeoutMs: Infinity,
    actions: [null, false, {}, defaults.actions[0], { ...defaults.actions[0], name: 'duplicate id' },
      { ...defaults.actions[1], shortcut: 'Enter' }, { ...defaults.actions[2], shortcut: '3' },
      { ...defaults.actions[3], shortcut: 'Escape' }, { ...defaults.actions[4], terminalKey: 'arbitrary escape bytes' }]
  })
  assert.equal(settings.leader, null)
  assert.equal(settings.timeoutMs, 1500)
  assert.deepEqual(settings.actions.map(action => action.shortcut), ['Enter', null, null, null, 'Q'])
  assert.equal(settings.actions[4].terminalKey, 'None')
  assert.deepEqual(normalizePromptInputSettings({ actions: [
    { ...defaults.actions[0], id: 'unnamed', preset: undefined },
    { ...defaults.actions[1], id: 'noop', terminalKey: 'None' },
    { ...defaults.actions[1], id: 'bad-key', terminalKey: 'bad' }
  ] }).actions, [])
  assert.equal(normalizePromptInputSettings({ timeoutMs: -1 }).timeoutMs, 500)
  assert.equal(normalizePromptInputSettings({ timeoutMs: 10001 }).timeoutMs, 10000)
  const colliding = configured()
  colliding.actions[0].shortcut = 'Ctrl+X'
  assert.equal(normalizePromptInputSettings(colliding).actions[0].shortcut, null)
  colliding.actions[0].shortcut = 'CommandOrControl+Q'
  colliding.actions[1].shortcut = 'Control+Q'
  assert.equal(normalizePromptInputSettings(colliding).actions[1].shortcut, 'Control+Q')
  assert.equal(validatePromptInputSettings(colliding, [], 'darwin'), null)
  assert.equal(validatePromptInputSettings(colliding, [], 'win32'), 'duplicate-shortcut')
  assert.equal(normalizePromptInputSettings({ ...configured(), leader: 'Q' }).actions[4].shortcut, 'Q')
})

test('PI-U07: validation detects host-equivalent conflicts and permits trigger/output independence', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(validatePromptInputSettings(configured(), [], platform), null)
    const next = configured()
    next.leader = 'CommandOrControl+X'
    assert.equal(validatePromptInputSettings(next, [platform === 'darwin' ? 'Cmd+X' : 'Ctrl+X'], platform), 'shortcut-conflict')
    next.leader = 'Control+X'
    next.actions[0].shortcut = 'ctrl+q'
    next.actions[1].shortcut = 'CONTROL+Q'
    assert.equal(validatePromptInputSettings(next, [], platform), 'duplicate-shortcut')
    for (const reserved of ['1', '8', 'Esc', 'ctrl+x']) {
      next.actions[0].shortcut = reserved
      assert.equal(validatePromptInputSettings(next, [], platform), 'invalid-shortcut')
    }
  }
  const custom = configured()
  custom.actions.push({ id: 'custom', name: 'Custom', visible: false, includePrompt: false, terminalKey: 'Control+C', shortcut: 'Z', target: 'default' })
  assert.equal(validatePromptInputSettings(custom), null)
  custom.actions.at(-1)!.terminalKey = 'None'
  assert.equal(validatePromptInputSettings(custom), 'invalid-action')
  custom.actions.at(-1)!.includePrompt = true
  custom.actions.at(-1)!.name = ' '
  assert.equal(validatePromptInputSettings(custom), 'invalid-action')
  const invalidPreset = { ...configured(), actions: [{ ...configured().actions[0], preset: 'missing' }] }
  assert.equal(validatePromptInputSettings(invalidPreset as PromptInputSettings), 'invalid-action')
  custom.leader = 'Q'
  assert.equal(validatePromptInputSettings(custom), 'invalid-leader')
})

test('PI-U08: leader owns only pending sequences; plain keys and modifiers remain native', () => {
  const settings = configured()
  for (const key of ['Q', '1', 'Escape', 'Enter', null]) assert.equal(reducePromptLeader(null, key, 1000, settings, context).consume, false)
  const first = reducePromptLeader(null, 'Control+X', 1000, settings, context)
  assert.equal(first.consume, true)
  assert.deepEqual(first.state, armed())
  assert.equal(first.event?.kind, 'state')
  assert.equal(reducePromptLeader(first.state, null, 1200, settings, context).state?.deadline, 2500)
  const queue = reducePromptLeader(first.state, 'Q', 1200, settings, context)
  assert.equal(queue.consume, true)
  assert.equal(queue.state, null)
  assert.equal(queue.event?.actionId, 'queue')
  assert.equal(queue.event?.tabId, 'tab-a')
  assert.equal(queue.event?.targetId, undefined)
  assert.equal(reducePromptLeader(queue.state, 'Q', 1201, settings, context).consume, false)
  assert.equal(reducePromptLeader(null, 'Control+X', 1000, createDefaultPromptInputSettings(), context).consume, false)
})

test('PI-U16: action continuations can override window shortcuts but cannot collide with OS-global Wake/Hide', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const settings = configured()
    settings.actions[0].shortcut = 'Control+Alt+G'
    assert.equal(validatePromptInputSettings(settings, ['Ctrl+Alt+G'], platform), null)
    assert.equal(validatePromptInputSettings(settings, ['Ctrl+Alt+G'], platform, ['Ctrl+Alt+G']), 'shortcut-conflict')
    assert.equal(validatePromptInputSettings(settings, [], platform, [null]), null)
    settings.actions[0].shortcut = 'CommandOrControl+J'
    assert.equal(validatePromptInputSettings(settings, [], platform, [platform === 'darwin' ? 'Meta+J' : 'Control+J']), 'shortcut-conflict')
  }
})

test('PI-U09: numeric choice locks identity across reorder and never silently retargets', () => {
  const settings = configured()
  const picked = reducePromptLeader(armed(), '3', 1400, settings, context)
  assert.deepEqual(picked.state, { tabId: 'tab-a', deadline: 2900, targetId: 'task-c', selecting: false })
  const reordered = { ...context, visibleTerminalIds: ['task-c', 'task-b', 'task-a'] }
  assert.equal(reducePromptLeader(picked.state, 'Q', 1500, settings, reordered).event?.targetId, 'task-c')
  const removed = { ...context, visibleTerminalIds: ['task-a', 'task-b', 'task-new'] }
  const rejected = reducePromptLeader(picked.state, 'Q', 1500, settings, removed)
  assert.equal(rejected.state, null)
  assert.equal(rejected.consume, true)
  assert.equal(rejected.event?.reason, 'target-unavailable')
  assert.equal(reducePromptLeader(armed(), '8', 1500, settings, context).event?.reason, 'target-unavailable')
  assert.equal(reducePromptLeader(picked.state, 'A', 1500, settings, context).event?.reason, 'target-conflict')
  assert.equal(reducePromptLeader(picked.state, '1', 1600, settings, context).state?.targetId, 'task-a')
})

test('PI-U10: cancellation, timeout, composition and tab changes clear one-shot state', () => {
  const settings = configured()
  for (const [key, reason] of [['Escape', 'escape'], ['Z', 'unmatched']]) {
    const next = reducePromptLeader(armed('task-c'), key, 2000, settings, context)
    assert.equal(next.state, null)
    assert.equal(next.consume, true)
    assert.equal(next.event?.reason, reason)
  }
  for (const now of [2500, 9999]) {
    const expired = reducePromptLeader(armed('task-c'), 'Q', now, settings, context)
    assert.equal(expired.consume, false)
    assert.equal(expired.state, null)
    assert.equal(expired.event?.reason, 'timeout')
  }
  const swapped = reducePromptLeader(armed('task-c'), 'Q', 2000, settings, { ...context, tabId: 'tab-b' })
  assert.equal(swapped.consume, false)
  assert.equal(swapped.event?.reason, 'tab-changed')
  for (const options of [{ composing: true }, {}]) {
    const ctx = options.composing ? context : { ...context, blocked: true }
    const next = reducePromptLeader(armed('task-c'), 'Enter', 2000, settings, ctx, options)
    assert.equal(next.state, null)
    assert.equal(next.consume, false)
    assert.equal(next.event?.kind, 'cancel')
  }
})

test('PI-U11: held keys cannot extend/re-arm/dispatch; double leader passes one physical key', () => {
  const settings = configured()
  for (const key of ['Control+X', '3', 'Q', 'Escape']) {
    const held = reducePromptLeader(armed(), key, 1500, settings, context, { repeat: true })
    assert.deepEqual(held.state, armed())
    assert.equal(held.consume, true)
    assert.equal(held.event, undefined)
  }
  const repeatedLeader = reducePromptLeader(null, 'Control+X', 1000, settings, context, { repeat: true })
  assert.equal(repeatedLeader.state, null)
  assert.equal(repeatedLeader.consume, true)
  const second = reducePromptLeader(armed(), 'Control+X', 1500, settings, context)
  assert.equal(second.consume, false)
  assert.equal(second.state, null)
  assert.equal(second.event?.kind, 'passthrough')
  const expiredHold = reducePromptLeader(armed(), 'Q', 2500, settings, context, { repeat: true })
  assert.equal(expiredHold.state, null)
  assert.equal(expiredHold.event?.reason, 'timeout')
})

test('PI-U12: hidden buttons remain shortcut-accessible and aliases work on each platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const settings = configured()
    settings.leader = 'CommandOrControl+X'
    settings.actions[4].visible = false
    settings.actions[4].shortcut = 'CommandOrControl+Q'
    const modifier = platform === 'darwin' ? 'Meta' : 'Control'
    const first = reducePromptLeader(null, `${modifier}+X`, 1000, settings, context, { platform })
    const next = reducePromptLeader(first.state, `${modifier}+Q`, 1100, settings, context, { platform })
    assert.equal(next.event?.actionId, 'queue')
  }
})

test('PI-U13: target precedence includes exclusion and empty-layout rejection', () => {
  const ids = ['task-a', 'task-b', 'task-c']
  const normal = { target: 'default' } as const
  const all = { target: 'all' } as const
  assert.deepEqual(resolvePromptTargets(normal, ids, 'task-b', []), { ids: ['task-b'] })
  assert.deepEqual(resolvePromptTargets(normal, ids, 'task-b', ['task-a', 'task-c']), { ids: ['task-a', 'task-c'] })
  assert.deepEqual(resolvePromptTargets(normal, ids, 'task-b', ['task-a'], 'task-c'), { ids: ['task-c'] })
  assert.deepEqual(resolvePromptTargets(normal, ids, 'task-b', ['other-tab']), { ids: [], reason: 'target-unavailable' })
  assert.deepEqual(resolvePromptTargets(normal, ids, 'other-tab', []), { ids: [], reason: 'target-unavailable' })
  assert.deepEqual(resolvePromptTargets(normal, ids, 'task-b', ['task-a'], 'parked'), { ids: [], reason: 'target-unavailable' })
  assert.deepEqual(resolvePromptTargets(all, ids, 'task-b', ['task-a']), { ids })
  assert.deepEqual(resolvePromptTargets(all, ids, 'task-b', [], 'task-c'), { ids: [], reason: 'target-conflict' })
  assert.deepEqual(resolvePromptTargets(all, [], null, []), { ids: [], reason: 'target-unavailable' })
  assert.deepEqual(resolvePromptTargets(all, ['task-a', 'task-a'], null, []), { ids: ['task-a'] })
  assert.deepEqual(ids, ['task-a', 'task-b', 'task-c'])
})

test('PI-U14: completion never erases key-only, partially sent, failed or newer/ABA drafts', () => {
  for (const includePrompt of [false, true]) {
    for (const succeeded of [false, true]) {
      for (const currentRevision of [4, 5, 6, 100]) {
        assert.equal(shouldClearPromptDraft(includePrompt, succeeded, 4, currentRevision), includePrompt && succeeded && currentRevision === 4)
      }
    }
  }
})

test('PI-U15: 500 deliberate sequences have exact counts with no retained targeting', () => {
  const settings = configured()
  let state: PromptLeaderState | null = null
  const dispatched: string[] = []
  for (let trial = 0; trial < 500; trial++) {
    const now = 10000 + trial * 100
    state = reducePromptLeader(state, 'Control+X', now, settings, context).state
    if (trial % 2 === 0) state = reducePromptLeader(state, '3', now + 1, settings, context).state
    const next = reducePromptLeader(state, 'Q', now + 2, settings, context)
    assert.equal(next.event?.kind, 'dispatch')
    assert.equal(next.event?.targetId, trial % 2 === 0 ? 'task-c' : undefined)
    dispatched.push(next.event!.actionId!)
    state = next.state
    assert.equal(state, null)
  }
  assert.equal(dispatched.length, 500)
  assert(dispatched.every(id => id === 'queue'))
})
