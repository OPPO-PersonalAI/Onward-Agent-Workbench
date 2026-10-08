/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import type { SettingsState } from '../../src/types/settings'
import type { ResolvedTheme } from '../../src/types/theme'

/** User-approved one-shot bootstrap: the handler reads only an already-loaded memory snapshot. */
export function installThemeBootstrap(): void {
  const start = performance.now()
  const trace = (reason: string, extra: Record<string, unknown> = {}) => ipcRenderer.send(IPC.DEBUG_PERF_TRACE, {
    event: PERF_TRACE_EVENT.RENDERER_THEME_BOOTSTRAP, data: { reason, ...extra }
  })
  trace('snapshot-request')
  const bootstrap = ipcRenderer.sendSync(IPC.THEMES_BOOTSTRAP) as { settings: SettingsState; resolvedTheme: ResolvedTheme } | null
  ipcRenderer.send(IPC.DEBUG_PERF_TRACE, {
    event: PERF_TRACE_EVENT.RENDERER_THEME_BOOTSTRAP,
    data: { reason: 'snapshot-received', ok: Boolean(bootstrap?.resolvedTheme), durationMs: performance.now() - start }
  })
  if (!bootstrap?.resolvedTheme) return
  contextBridge.exposeInMainWorld('onwardThemeBootstrap', bootstrap)
  const apply = () => {
    const root = document.documentElement
    if (!root) return false
    for (const [name, value] of Object.entries(bootstrap.resolvedTheme.colors)) root.style.setProperty(name, value)
    root.dataset.theme = bootstrap.resolvedTheme.id
    root.dataset.themeKind = bootstrap.resolvedTheme.kind
    root.style.colorScheme = bootstrap.resolvedTheme.kind
    trace('dom-applied', { kind: bootstrap.resolvedTheme.kind, durationMs: performance.now() - start })
    return true
  }
  if (!apply()) {
    trace('dom-deferred')
    const observer = new MutationObserver(() => { if (apply()) observer.disconnect() })
    observer.observe(document, { childList: true, subtree: true })
  }
}
