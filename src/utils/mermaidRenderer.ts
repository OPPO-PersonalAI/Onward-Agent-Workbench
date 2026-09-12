/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */


type MermaidApi = typeof import('mermaid').default
type MermaidTheme = {
  kind: 'light' | 'dark'
  colors: {
    '--bg-0': string
    '--bg-2': string
    '--panel': string
    '--border': string
    '--text-1': string
    '--text-2': string
    '--text-3': string
    '--accent': string
  }
}

let mermaidApi: MermaidApi | null = null
let loading: Promise<MermaidApi | null> | null = null
let renderQueue: Promise<void> = Promise.resolve()

async function loadMermaid(): Promise<MermaidApi | null> {
  if (mermaidApi) return mermaidApi
  if (loading) return loading
  loading = (async () => {
    try {
      const mod = await import('mermaid')
      const api = mod.default
      mermaidApi = api
      return api
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

const DEFAULT_DARK_THEME: MermaidTheme = {
  kind: 'dark',
  colors: {
    '--bg-0': '#101012', '--bg-2': '#1c1c1f', '--panel': '#212124', '--border': '#2c2c30',
    '--text-1': '#e8e8ec', '--text-2': '#b4b4bc', '--text-3': '#8a8a94', '--accent': '#8b8f98'
  }
}

function configureMermaid(api: MermaidApi, theme: MermaidTheme): void {
  api.initialize({
    startOnLoad: false,
    theme: theme.kind === 'light' ? 'base' : 'dark',
    themeVariables: {
      background: theme.colors['--bg-2'],
      mainBkg: theme.colors['--panel'],
      nodeBorder: theme.colors['--border'],
      lineColor: theme.colors['--text-3'],
      primaryColor: theme.colors['--bg-0'],
      secondaryColor: theme.colors['--panel'],
      tertiaryColor: theme.colors['--bg-2'],
      primaryTextColor: theme.colors['--text-1'],
      secondaryTextColor: theme.colors['--text-2'],
      tertiaryTextColor: theme.colors['--text-3'],
      edgeLabelBackground: theme.colors['--bg-2'],
      clusterBkg: theme.colors['--bg-0'],
      clusterBorder: theme.colors['--border'],
      fontFamily: "'IBM Plex Mono', 'Fira Code', 'Source Code Pro', monospace"
    }
  })
}

export async function renderMermaidDiagrams(
  container: HTMLElement,
  signal: MermaidRenderSignal,
  errorMessage?: string,
  theme: MermaidTheme = DEFAULT_DARK_THEME
): Promise<void> {
  const placeholders = container.querySelectorAll<HTMLElement>(
    '.mermaid-diagram[data-mermaid-id]'
  )
  if (placeholders.length === 0) return

  const job = async () => {
    const api = await loadMermaid()
    if (!api || signal.cancelled) return
    configureMermaid(api, theme)
    for (const el of Array.from(placeholders)) {
      if (signal.cancelled) return
      const id = el.getAttribute('data-mermaid-id')
      if (!id) continue
      const sourceEl = el.querySelector<HTMLElement>('code.language-mermaid')
      if (!sourceEl) continue
      const source = sourceEl?.textContent ?? ''
      if (!source.trim()) continue
      try {
        const { svg } = await api.render(id, source)
        if (signal.cancelled) return
        // Keep the original source in the DOM. Theme changes can then render a
        // new SVG without reparsing Markdown or consulting the source file.
        el.replaceChildren(sourceEl.closest('.mermaid-source')?.cloneNode(true) ?? sourceEl.cloneNode(true))
        el.insertAdjacentHTML('afterbegin', svg)
        el.classList.remove('mermaid-error')
        el.classList.add('mermaid-rendered')
      } catch {
        el.classList.add('mermaid-error')
        if (!el.querySelector('.mermaid-error-message')) {
          const errorEl = document.createElement('div')
          errorEl.className = 'mermaid-error-message'
          errorEl.textContent = errorMessage || 'Diagram syntax error'
          el.appendChild(errorEl)
        }
      }
    }
  }
  const queued = renderQueue.then(job, job)
  renderQueue = queued.catch(() => undefined)
  await queued
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
