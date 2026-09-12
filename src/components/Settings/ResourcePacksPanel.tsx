/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react'
import { useSettings } from '../../contexts/SettingsContext'
import { useI18n } from '../../i18n/useI18n'
import type { SettingsState } from '../../types/settings'

interface PackSummary {
  id: string
  version: string
  kind: 'theme' | 'locale'
  displayName: string
  themes?: Array<{ id: string; label: string; kind: 'light' | 'dark' }>
  locale?: 'en' | 'zh-CN'
}

interface Inspection {
  ok: boolean
  token?: string
  summary?: PackSummary
  error?: { code?: string; detail?: string }
}

export function ResourcePacksPanel() {
  const { settings, updateAppearance, updateLocalePacks, replaceSettingsFromMain } = useSettings()
  const { locale, t } = useI18n()
  const [packs, setPacks] = useState<PackSummary[]>([])
  const [pending, setPending] = useState<Inspection | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<{ pack: PackSummary; action: 'disable' | 'uninstall' } | null>(null)

  const refresh = useCallback(async () => {
    const result = await window.electronAPI.resourcePacks.list()
    setPacks(Array.isArray(result) ? result as PackSummary[] : [])
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const handleChanged = () => { void refresh() }
    window.addEventListener('onward-resource-packs-changed', handleChanged)
    return () => window.removeEventListener('onward-resource-packs-changed', handleChanged)
  }, [refresh])

  const importPack = useCallback(async () => {
    const result = await window.electronAPI.resourcePacks.pickAndInspect('native') as Inspection & { cancelled?: boolean }
    if (result.ok) setPending(result)
    else if (!result.cancelled) setStatus(result.error?.code ?? result.error?.detail ?? 'PACK_INVALID_MANIFEST')
  }, [])

  const importVsCode = useCallback(async () => {
    const result = await window.electronAPI.resourcePacks.pickAndInspect('vscode-theme') as Inspection & { cancelled?: boolean }
    if (result.ok) setPending(result)
    else if (!result.cancelled) setStatus(result.error?.code ?? result.error?.detail ?? 'PACK_INVALID_MANIFEST')
  }, [])

  const confirm = useCallback(async () => {
    if (!pending?.token) return
    const result = await window.electronAPI.resourcePacks.confirmInstall(pending.token) as { ok: boolean; error?: { code?: string } }
    if (!result.ok) {
      setStatus(result.error?.code ?? 'PACK_STORAGE_FAILED')
      return
    }
    setPending(null)
    setStatus('installed')
    await refresh()
  }, [pending, refresh])

  const usePack = useCallback((pack: PackSummary) => {
    if (!settings) return
    if (pack.kind === 'locale' && pack.locale === locale) {
      updateLocalePacks({ schemaVersion: 1, activePackByLocale: { ...settings.localePacks.activePackByLocale, [locale]: pack.id } })
      setStatus('active')
      return
    }
    const theme = pack.themes?.[0]
    if (!theme) return
    updateAppearance({
      ...settings.appearance,
      ...(theme.kind === 'light'
        ? { lightTheme: { source: 'pack', packId: pack.id, themeId: theme.id } as const, colorMode: 'light' as const }
        : { darkTheme: { source: 'pack', packId: pack.id, themeId: theme.id } as const, colorMode: 'dark' as const })
    })
    setStatus('active')
  }, [locale, settings, updateAppearance, updateLocalePacks])

  const applyPackAction = useCallback(async () => {
    if (!pendingAction) return
    const result = pendingAction.action === 'uninstall'
      ? await window.electronAPI.resourcePacks.uninstall(pendingAction.pack.id)
      : await window.electronAPI.resourcePacks.deactivate(pendingAction.pack.id)
    const typedResult = result as { ok?: boolean; settings?: SettingsState; error?: { code?: string } }
    if (!typedResult.ok || !typedResult.settings) {
      setStatus(typedResult.error?.code ?? 'PACK_STORAGE_FAILED')
      return
    }
    replaceSettingsFromMain(typedResult.settings)
    setPendingAction(null)
    setStatus(pendingAction.action === 'uninstall' ? 'uninstalled' : 'disabled')
    await refresh()
  }, [pendingAction, refresh, replaceSettingsFromMain])

  return (
    <div className="settings-group" data-testid="resource-packs-panel">
      <div className="settings-group-title">{t('settings.resourcePacks.title')}</div>
      <div className="settings-row-input settings-resource-pack-actions">
        <button type="button" className="settings-button" data-testid="resource-pack-import-native" onClick={importPack}>{t('settings.resourcePacks.importPack')}</button>
        <button type="button" className="settings-button" data-testid="resource-pack-import-vscode" onClick={importVsCode}>{t('settings.resourcePacks.importVsCode')}</button>
      </div>
      {pending?.summary && (
        <div className="settings-resource-pack-review" data-testid="resource-pack-review">
          <strong>{t('settings.resourcePacks.review')}</strong>
          <span>{pending.summary.displayName} · {pending.summary.version}</span>
          <div>
            <button type="button" className="settings-button" onClick={confirm}>{t('settings.resourcePacks.install')}</button>
            <button type="button" className="settings-button" onClick={() => setPending(null)}>{t('settings.resourcePacks.cancel')}</button>
          </div>
        </div>
      )}
      {pendingAction && (
        <div className="settings-resource-pack-review" data-testid="resource-pack-action-confirmation">
          <strong>{pendingAction.action === 'uninstall' ? t('settings.resourcePacks.confirmUninstall') : t('settings.resourcePacks.confirmDisable')}</strong>
          <span>{pendingAction.pack.displayName} · {pendingAction.pack.version}</span>
          <div>
            <button type="button" className="settings-button" onClick={applyPackAction}>{t('settings.resourcePacks.confirm')}</button>
            <button type="button" className="settings-button" onClick={() => setPendingAction(null)}>{t('settings.resourcePacks.cancel')}</button>
          </div>
        </div>
      )}
      {packs.length === 0 ? <p className="settings-group-description">{t('settings.resourcePacks.noPacks')}</p> : packs.map(pack => (
        <div className="settings-row" key={pack.id}>
          <span className="settings-row-label">{pack.displayName} · {pack.version}</span>
          <div className="settings-resource-pack-actions">
            <button type="button" className="settings-button" data-testid={`resource-pack-use-${pack.id}`} onClick={() => usePack(pack)}>{t('settings.resourcePacks.use')}</button>
            <button type="button" className="settings-button" data-testid={`resource-pack-disable-${pack.id}`} onClick={() => setPendingAction({ pack, action: 'disable' })}>{t('settings.resourcePacks.disable')}</button>
            <button type="button" className="settings-button" data-testid={`resource-pack-uninstall-${pack.id}`} onClick={() => setPendingAction({ pack, action: 'uninstall' })}>{t('settings.resourcePacks.uninstall')}</button>
          </div>
        </div>
      ))}
      {status && <p className="settings-group-description">{t('settings.resourcePacks.status', { status })}</p>}
    </div>
  )
}
