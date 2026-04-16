#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Closed-loop check for project file-tree Seti icons:
 * - Distinct themed colors for representative extensions
 * - Minimum relative luminance on dark UI (icons must not collapse to black)
 *
 * Keep palette logic in sync with src/components/ProjectEditor/setiFileIconTheme.ts
 * (buildSetiThemeFromAppColors).
 */

import { themeIcons } from 'seti-icons'

/** @param {Record<string, string>} colors ThemeColors-like object */
function buildSetiThemeFromAppColors(colors) {
  return {
    blue: colors['--accent'],
    grey: colors['--text-2'],
    'grey-light': colors['--text-2'],
    green: '#4ade80',
    orange: '#fb923c',
    pink: '#f472b6',
    purple: '#c084fc',
    red: '#f87171',
    white: colors['--text-1'],
    yellow: '#facc15',
    ignore: colors['--text-3']
  }
}

const GRAPHITE = {
  '--bg-0': '#101012',
  '--bg-1': '#161618',
  '--bg-2': '#1c1c1f',
  '--panel': '#212124',
  '--border': '#2c2c30',
  '--border-strong': '#38383d',
  '--text-1': '#e8e8ec',
  '--text-2': '#b4b4bc',
  '--text-3': '#8a8a94',
  '--accent': '#8b8f98',
  '--accent-strong': '#7a7e86',
  '--shadow-1': '0 6px 18px rgba(0, 0, 0, 0.4)'
}

const STARLIGHT = {
  '--bg-0': '#0f1115',
  '--bg-1': '#141821',
  '--bg-2': '#1b202b',
  '--panel': '#1f2430',
  '--border': '#2a303c',
  '--border-strong': '#343b48',
  '--text-1': '#e6e9ef',
  '--text-2': '#b8c0cc',
  '--text-3': '#8a93a3',
  '--accent': '#3b82f6',
  '--accent-strong': '#2563eb',
  '--shadow-1': '0 6px 18px rgba(0, 0, 0, 0.35)'
}

function parseHex(s) {
  const m = /^#?([\da-f]{6})$/i.exec(String(s).trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function relLuminance(hex) {
  const p = parseHex(hex)
  if (!p) return 0
  const lin = [p.r, p.g, p.b].map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

function runForPreset(name, themeColors) {
  const pick = themeIcons(buildSetiThemeFromAppColors(themeColors))
  const js = pick('sample.js').color
  const rs = pick('sample.rs').color
  const css = pick('sample.css').color
  const uniq = new Set([js, rs, css])
  if (uniq.size < 3) {
    console.error(`[seti-file-tree-icon-verify] ${name}: expected 3 distinct colors for .js / .rs / .css, got`, {
      js,
      rs,
      css
    })
    process.exit(1)
  }
  const minLum = 0.14
  for (const [label, hex] of [
    ['js', js],
    ['rs', rs],
    ['css', css]
  ]) {
    const L = relLuminance(hex)
    if (L < minLum) {
      console.error(`[seti-file-tree-icon-verify] ${name}: color too dark for ${label} (${hex}), L=${L.toFixed(3)} < ${minLum}`)
      process.exit(1)
    }
  }
  console.log(`[seti-file-tree-icon-verify] ${name}: ok (js=${js}, rs=${rs}, css=${css})`)
}

runForPreset('graphite', GRAPHITE)
runForPreset('starlight', STARLIGHT)
console.log('[seti-file-tree-icon-verify] all checks passed')
