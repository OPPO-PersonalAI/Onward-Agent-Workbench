/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'

const MODIFIERS = new Map([
  ['Control', 'control'], ['Shift', 'shift'], ['Alt', 'alt'], ['Meta', 'meta']
])
const NAMED_KEYS = new Map([
  ['Control', 'Control'], ['Shift', 'Shift'], ['Alt', 'Alt'], ['Meta', 'Super'],
  ['Escape', 'Escape'], ['Enter', 'Enter'], ['Tab', 'Tab'], ['Space', 'Space']
])

function describe(code, shifted) {
  if (/^Key[A-Z]$/.test(code)) {
    const lower = code.slice(3).toLowerCase()
    return { keyCode: lower, text: shifted ? lower.toUpperCase() : lower }
  }
  if (/^Digit\d$/.test(code)) {
    const digit = code.slice(5)
    return { keyCode: digit, text: shifted ? ')!@#$%^&*('[Number(digit)] : digit }
  }
  assert(NAMED_KEYS.has(code), `Unsupported native shortcut key: ${code}`)
  return { keyCode: NAMED_KEYS.get(code), text: code === 'Space' ? ' ' : '' }
}

// CDP's nativeVirtualKeyCode is a platform virtual key, not a universal VK or
// a Windows scan code. Linux uses XKB (evdev + 8); macOS uses Apple virtual keys.
// References: Chromium's input/native_input_event_builder_* and
// ui/events/keycodes/dom/{dom_code_data.inc,keycode_converter.cc}.
export function physicalShortcutKey(code, key, platform = process.platform) {
  const nativeCodes = {
    darwin: { KeyQ: 0x0c, Digit3: 0x14 },
    win32: { KeyQ: 0x51, Digit3: 0x33 },
    linux: { KeyQ: 0x18, Digit3: 0x0c }
  }
  assert(Object.hasOwn(nativeCodes, platform), `Unsupported native key platform: ${platform}`)
  assert(Object.hasOwn(nativeCodes[platform], code), `Unsupported physical shortcut key: ${code}`)
  return {
    code, key, modifiers: 0,
    windowsVirtualKeyCode: code === 'KeyQ' ? 0x51 : 0x33,
    nativeVirtualKeyCode: nativeCodes[platform][code]
  }
}

// Electron 43 SendInputEvent converts keyDown to raw keydown before forwarding.
// Unlike default CDP keyboard events, it passes through before-input-event.
// Keep printable chars immediately after their raw keydown: Chromium, rather
// than this helper or a shortcut oracle, suppresses chars for consumed strokes.
// https://github.com/electron/electron/blob/v43.0.0/shell/browser/api/electron_api_web_contents.cc
// https://github.com/chromium/chromium/blob/main/content/browser/renderer_host/render_widget_host_impl.cc
export class NativeShortcutKeyboard {
  constructor(page, contentsId) {
    this.page = page
    this.contentsId = contentsId
    this.held = new Set()
  }

  async send(input) {
    const accepted = await this.page.evaluate(({ input, contentsId }) =>
      window.electronAPI.debug.sendInputEvent(input, contentsId), { input, contentsId: this.contentsId })
    assert.equal(accepted, true, `Native ingress rejected ${input.type}/${input.keyCode}; the owned surface must really be focused`)
  }

  modifiers(repeat = false, released) {
    const modifiers = [...this.held].filter(code => code !== released && MODIFIERS.has(code)).map(code => MODIFIERS.get(code))
    if (repeat) modifiers.push('isautorepeat')
    return modifiers
  }

  async down(code) {
    const key = describe(code, this.held.has('Shift'))
    const repeat = this.held.has(code)
    this.held.add(code)
    const modifiers = this.modifiers(repeat)
    await this.send({ type: 'keyDown', keyCode: key.keyCode, modifiers })
    if (key.text && !['control', 'alt', 'meta'].some(modifier => modifiers.includes(modifier))) {
      await this.send({ type: 'char', keyCode: key.text, modifiers })
    }
  }

  async up(code) {
    const key = describe(code, this.held.has('Shift'))
    assert(this.held.has(code), `Native key was not held: ${code}`)
    await this.send({ type: 'keyUp', keyCode: key.keyCode, modifiers: this.modifiers(false, code) })
    this.held.delete(code)
  }

  async press(stroke) {
    const codes = stroke.split('+')
    for (const code of codes) describe(code, false)
    assert(codes.slice(0, -1).every(code => MODIFIERS.has(code)), `Only modifiers can prefix a stroke: ${stroke}`)
    assert.equal(new Set(codes).size, codes.length, `Duplicate key in stroke: ${stroke}`)
    const owned = codes.filter(code => !this.held.has(code))
    const errors = []
    try {
      for (const code of codes.slice(0, -1)) if (!this.held.has(code)) await this.down(code)
      await this.down(codes.at(-1))
    } catch (error) { errors.push(error) }
    for (const code of owned.reverse()) {
      if (!this.held.has(code)) continue
      try { await this.up(code) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw errors[0]
  }

  async releaseAll() {
    const errors = []
    for (const code of [...this.held].reverse()) {
      try { await this.up(code) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Native key cleanup failed')
  }
}
