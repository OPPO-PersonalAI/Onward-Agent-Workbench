/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ThemeColors } from '../types/theme'

/**
 * HEX to HSL
 */
export function hexToHSL(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  if (max === min) {
    return { h: 0, s: 0, l }
  }

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6

  return { h: h * 360, s, l }
}

/**
 * HSL to HEX
 */
export function hslToHex(h: number, s: number, l: number): string {
  const hNorm = h / 360

  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }

  let r: number, g: number, b: number
  if (s === 0) {
    r = g = b = l
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, hNorm + 1 / 3)
    g = hue2rgb(p, q, hNorm)
    b = hue2rgb(p, q, hNorm - 1 / 3)
  }

  const toHex = (v: number) => {
    const hex = Math.round(v * 255).toString(16)
    return hex.length === 1 ? '0' + hex : hex
  }

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * Automatically generate complete ThemeColors based on user-selected accent colors
 *
 * Generate strategy:
 * - Background color: same hue, low saturation (3-9%), low lightness (7-14%)
 * - Border color: weak homogeneous tone
 * - Text color: weak homogeneous tone
 * - accent-strong: Reduce brightness by 10% + Increase saturation by 10%
 */
export function generateCustomTheme(accentHex: string): ThemeColors {
  const { h, s, l } = hexToHSL(accentHex)

  // accent-strong: deeper and more saturated
  const strongL = Math.max(0, l - 0.10)
  const strongS = Math.min(1, s + 0.10)

  return {
    '--bg-0': hslToHex(h, s * 0.06, 0.065),
    '--bg-1': hslToHex(h, s * 0.09, 0.09),
    '--bg-2': hslToHex(h, s * 0.10, 0.12),
    '--panel': hslToHex(h, s * 0.10, 0.14),
    '--border': hslToHex(h, s * 0.08, 0.19),
    '--border-strong': hslToHex(h, s * 0.08, 0.24),
    '--text-1': hslToHex(h, s * 0.08, 0.92),
    '--text-2': hslToHex(h, s * 0.08, 0.74),
    '--text-3': hslToHex(h, s * 0.06, 0.56),
    '--accent': accentHex,
    '--accent-strong': hslToHex(h, strongS, strongL),
    '--shadow-1': '0 6px 18px rgba(0, 0, 0, 0.38)'
  }
}
