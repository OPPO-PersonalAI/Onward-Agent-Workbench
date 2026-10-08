/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildMermaidTheme, shouldApplyMermaidResult } from './preview-theme'
import { readPreviewPalette } from './preview-theme-dom'
import { perfTraceDiagnostic } from './perf-trace'
import { PERF_TRACE_EVENT } from './perf-trace-names'

type MermaidApi = typeof import('mermaid').default

let mermaidApi: MermaidApi | null = null
let loading: Promise<MermaidApi | null> | null = null
// Mermaid has a singleton configuration. Serialize configure+render, not UI commits.
let renderTail: Promise<unknown> = Promise.resolve()
let renderSequence = 0
const generations = new WeakMap<HTMLElement, number>()

async function loadMermaid(): Promise<MermaidApi | null> {
  if (mermaidApi) return mermaidApi
  if (loading) return loading
  loading = (async () => {
    try {
      const mod = await import('mermaid')
      mermaidApi = mod.default
      return mermaidApi
    } catch {
      loading = null
      return null
    }
  })()
  return loading
}

export interface MermaidRenderSignal {
  cancelled: boolean
}

function updateSvgInPlace(target: SVGElement, next: SVGElement): void {
  // Panzoom holds the SVG and its wrapper by identity. Keep both, including the
  // explicit dimensions assigned by prepareSvgForTransform and the user's zoom.
  const retained = new Map(['width', 'height'].map(name => [name, target.getAttribute(name)]))
  const layoutStyles = ['max-width', 'max-height', 'display', 'margin'].map(name => ({
    name, value: target.style.getPropertyValue(name), priority: target.style.getPropertyPriority(name)
  }))
  for (const attribute of Array.from(target.attributes)) target.removeAttribute(attribute.name)
  for (const attribute of Array.from(next.attributes)) target.setAttribute(attribute.name, attribute.value)
  for (const [name, value] of retained) {
    if (value !== null) target.setAttribute(name, value)
  }
  // Mermaid also emits theme-owned inline styles (notably background). Preserve
  // only the layout properties written by prepareSvgForTransform, not old colors.
  for (const { name, value, priority } of layoutStyles) {
    if (value) target.style.setProperty(name, value, priority)
  }
  target.replaceChildren(...Array.from(next.cloneNode(true).childNodes))
}

export async function renderMermaidDiagrams(
  container: HTMLElement,
  signal: MermaidRenderSignal,
  errorMessage?: string
): Promise<void> {
  const start = performance.now()
  const generation = (generations.get(container) ?? 0) + 1
  generations.set(container, generation)
  const palette = readPreviewPalette()
  const revision = document.documentElement.dataset.themeRevision?.slice(0, 128) ?? ''
  const config = buildMermaidTheme(palette)
  const signature = JSON.stringify(config)
  let applied = 0
  let skipped = 0
  let missingSource = 0
  let failed = 0
  let inlineUpdated = 0
  let inserted = 0
  let fullscreenUpdated = 0
  let reason = 'complete'
  const isCanceled = () => signal.cancelled || generations.get(container) !== generation
  try {
    const placeholders = container.querySelectorAll<HTMLElement>('.mermaid-diagram[data-mermaid-id]')
    if (placeholders.length === 0) { reason = 'no-diagrams'; return }

    const api = await loadMermaid()
    if (!api) { reason = 'module-unavailable'; return }
    if (isCanceled()) { reason = 'canceled'; return }

    for (const el of Array.from(placeholders)) {
      if (isCanceled()) { reason = 'canceled'; return }

      const source = el.dataset.mermaidSource ?? el.querySelector<HTMLElement>('code.language-mermaid')?.textContent ?? ''
      if (!source.trim()) { missingSource++; continue }
      // The wrapper survives SVG enhancement and serialized retained-view snapshots.
      el.dataset.mermaidSource = source
      if (el.dataset.mermaidTheme === signature && el.classList.contains('mermaid-rendered')) { skipped++; continue }

      try {
        const task = renderTail.then(async () => {
          if (!shouldApplyMermaidResult({
            canceled: isCanceled(), connected: el.isConnected,
            generation, currentGeneration: generations.get(container) ?? 0,
            source, currentSource: el.dataset.mermaidSource ?? ''
          })) return null
          api.initialize(config)
          // Rendering with an existing SVG id lets Mermaid remove the visible SVG.
          return api.render(`onward-mermaid-${++renderSequence}`, source)
        })
        renderTail = task.then(() => undefined, () => undefined)
        const result = await task
        if (!result || !shouldApplyMermaidResult({
          canceled: isCanceled(), connected: el.isConnected,
          generation, currentGeneration: generations.get(container) ?? 0,
          source, currentSource: el.dataset.mermaidSource ?? ''
        })) { reason = 'canceled'; return }
        const template = document.createElement('template')
        template.innerHTML = result.svg
        const next = template.content.querySelector<SVGElement>('svg')
        if (!next) { failed++; continue }
        const current = el.querySelector<SVGElement>('svg')
        next.dataset.onwardMermaidId = el.dataset.mermaidId
        if (current && el.classList.contains('mermaid-rendered')) {
          // Fullscreen uses a clone; mutate it too without replacing its panzoom owner.
          for (const clone of Array.from(document.querySelectorAll<SVGElement>('.mermaid-fullscreen-overlay svg[data-onward-mermaid-id]'))) {
            if (clone.id === current.id) {
              updateSvgInPlace(clone, next)
              fullscreenUpdated = Math.min(65535, fullscreenUpdated + 1)
            }
          }
          updateSvgInPlace(current, next)
          inlineUpdated = Math.min(65535, inlineUpdated + 1)
        } else {
          el.replaceChildren(next)
          inserted = Math.min(65535, inserted + 1)
        }
        el.dataset.mermaidTheme = signature
        el.classList.remove('mermaid-error')
        el.querySelector('.mermaid-error-message')?.remove()
        el.classList.add('mermaid-rendered')
        applied++
      } catch {
        if (isCanceled()) { reason = 'canceled'; return }
        failed++
        // Preserve an already-readable diagram if a later recolor fails.
        if (!el.classList.contains('mermaid-rendered')) el.classList.add('mermaid-error')
        if (errorMessage && !el.querySelector('.mermaid-error-message')) {
          const errorEl = document.createElement('div')
          errorEl.className = 'mermaid-error-message'
          errorEl.textContent = errorMessage
          el.appendChild(errorEl)
        }
      }
      // Give input/paint a turn between actual diagram redraws.
      await new Promise<void>(resolve => window.setTimeout(resolve, 0))
    }
  } finally {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_MERMAID_APPLY, {
      surface: 'mermaid', kind: palette.kind, revision, applied, skipped, missingSource, failed,
      inlineUpdated, inserted, fullscreenUpdated,
      reason: isCanceled() ? 'canceled' : failed ? 'render-fallback' : reason,
      durationMs: performance.now() - start
    })
  }
}

const MERMAID_LANGS = new Set(['mermaid', 'mmd'])

export function buildMermaidPlaceholder(text: string, id: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return `<div class="mermaid-diagram" data-mermaid-id="${id}"><pre class="mermaid-source"><code class="language-mermaid">${escaped}</code></pre></div>\n`
}

export function isMermaidLang(lang: string | undefined): boolean {
  return Boolean(lang && MERMAID_LANGS.has(lang.toLowerCase()))
}
