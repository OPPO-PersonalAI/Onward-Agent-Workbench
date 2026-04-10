/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */


type MermaidApi = typeof import('mermaid').default

let mermaidApi: MermaidApi | null = null
let loading: Promise<MermaidApi | null> | null = null

async function loadMermaid(): Promise<MermaidApi | null> {
  if (mermaidApi) return mermaidApi
  if (loading) return loading
  loading = (async () => {
    try {
      const mod = await import('mermaid')
      const api = mod.default
      api.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
          background: '#1c1c1f',
          mainBkg: '#212124',
          nodeBorder: '#2c2c30',
          lineColor: '#8a8a94',
          primaryTextColor: '#e8e8ec',
          secondaryTextColor: '#b4b4bc',
          tertiaryTextColor: '#8a8a94',
          edgeLabelBackground: '#1c1c1f',
        },
        fontFamily: "'IBM Plex Mono', 'Fira Code', 'Source Code Pro', monospace",
      })
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

export async function renderMermaidDiagrams(
  container: HTMLElement,
  signal: MermaidRenderSignal,
  errorMessage?: string
): Promise<void> {
  const placeholders = container.querySelectorAll<HTMLElement>(
    '.mermaid-diagram[data-mermaid-id]'
  )
  if (placeholders.length === 0) return

  const api = await loadMermaid()
  if (!api || signal.cancelled) return

  for (const el of Array.from(placeholders)) {
    if (signal.cancelled) return

    const id = el.getAttribute('data-mermaid-id')
    if (!id) continue

    const sourceEl = el.querySelector<HTMLElement>('code.language-mermaid')
    const source = sourceEl?.textContent ?? ''
    if (!source.trim()) continue

    try {
      const { svg } = await api.render(id, source)
      if (signal.cancelled) return
      el.innerHTML = svg
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
