/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CodingAgentConfigInput, CodingAgentHistoryEntry, CodingAgentProvider, CodingAgentType } from '../../types/electron'
import { useI18n } from '../../i18n/useI18n'
import './CodingAgentModal.css'

interface CodingAgentModalProps {
  agentType: CodingAgentType
  onLaunch: (config: CodingAgentConfigInput) => void
  onCancel: () => void
}

const PROVIDER_OPTIONS: Array<{
  value: CodingAgentProvider
  labelKey: 'codingAgent.providerCustom' | null
  fallbackLabel: string
  defaultApiUrl: string
}> = [
  { value: 'openrouter', labelKey: null, fallbackLabel: 'OpenRouter', defaultApiUrl: 'https://openrouter.ai/api' },
  { value: 'custom', labelKey: 'codingAgent.providerCustom', fallbackLabel: 'Custom', defaultApiUrl: '' }
]

const PROVIDER_DEFAULTS: Record<CodingAgentProvider, string> = {
  openrouter: PROVIDER_OPTIONS[0].defaultApiUrl,
  custom: PROVIDER_OPTIONS[1].defaultApiUrl
}

export function CodingAgentModal({ agentType, onLaunch, onCancel }: CodingAgentModalProps) {
  const { t } = useI18n()
  const needsApiConfig = agentType === 'claude-code'

  const [history, setHistory] = useState<CodingAgentHistoryEntry[]>([])
  const [lastUsedId, setLastUsedId] = useState<string | null>(null)
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null)
  const [provider, setProvider] = useState<CodingAgentProvider>('openrouter')
  const [apiUrl, setApiUrl] = useState(PROVIDER_OPTIONS[0].defaultApiUrl)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [extraArgs, setExtraArgs] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [loading, setLoading] = useState(true)
  const [installStatus, setInstallStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [installError, setInstallError] = useState('')
  const [error, setError] = useState('')
  const modalRef = useRef<HTMLDivElement>(null)

  const maskKey = useCallback((value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return t('codingAgent.keyMask')
    return `****${trimmed.slice(-4)}`
  }, [t])

  const resetToDefaults = useCallback(() => {
    setProvider('openrouter')
    setApiUrl(PROVIDER_DEFAULTS.openrouter || '')
    setApiKey('')
    setModel('')
    setExtraArgs('')
    setActiveHistoryId(null)
  }, [])

  const applyEntry = useCallback((entry: CodingAgentHistoryEntry) => {
    setProvider(entry.provider || 'openrouter')
    setApiUrl(entry.apiUrl || '')
    setApiKey(entry.apiKey || '')
    setModel(entry.model || '')
    setExtraArgs(entry.extraArgs || '')
    setActiveHistoryId(entry.id)
  }, [])

  const loadHistory = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const state = await window.electronAPI.codingAgentConfig.load(agentType)
      setHistory(state.history)
      const lid = state.lastUsedId[agentType] ?? null
      setLastUsedId(lid)
      const initial = state.history.find(item => item.id === lid) ?? state.history[0]
      if (initial) {
        applyEntry(initial)
      } else {
        resetToDefaults()
      }
    } catch (err) {
      console.error('Failed to load coding agent config:', err)
      setError(t('codingAgent.errorLoadConfig'))
      resetToDefaults()
    } finally {
      setLoading(false)
    }
  }, [agentType, applyEntry, resetToDefaults, t])

  useEffect(() => { loadHistory() }, [loadHistory])

  useEffect(() => {
    let active = true
    setInstallStatus('loading')
    setInstallError('')
    window.electronAPI.codingAgent.prepare(agentType)
      .then((result) => {
        if (!active) return
        if (result.success) {
          setInstallStatus('ready')
          setInstallError('')
        } else {
          setInstallStatus('error')
          setInstallError(result.error || t(`codingAgent.statusError.${agentType}` as const))
        }
      })
      .catch((err) => {
        if (!active) return
        console.error('Failed to prepare coding agent:', err)
        setInstallStatus('error')
        setInstallError(t(`codingAgent.statusError.${agentType}` as const))
      })
    return () => { active = false }
  }, [agentType, t])

  useEffect(() => { modalRef.current?.focus() }, [])

  const isOpenRouter = provider === 'openrouter'

  const handleOpenOpenRouterModels = useCallback(() => {
    window.electronAPI.shell.openExternal('https://openrouter.ai/models').catch(() => {
      setError(t('codingAgent.errorOpenLink'))
    })
  }, [t])

  const handleOpenInstallGuide = useCallback(() => {
    const url = agentType === 'codex'
      ? 'https://github.com/openai/codex'
      : 'https://docs.anthropic.com/en/docs/claude-code/overview'
    window.electronAPI.shell.openExternal(url).catch(() => {})
  }, [agentType])

  const handleProviderChange = (nextProvider: CodingAgentProvider) => {
    setProvider(nextProvider)
    setApiUrl(PROVIDER_DEFAULTS[nextProvider] || '')
    setActiveHistoryId(null)
  }

  const handleDelete = async (id: string) => {
    try {
      const state = await window.electronAPI.codingAgentConfig.delete(id)
      setHistory(state.history)
      setLastUsedId(state.lastUsedId[agentType] ?? null)
      if (activeHistoryId === id) {
        const fallback = state.history.find(item => item.id === state.lastUsedId[agentType]) ?? state.history[0]
        if (fallback) applyEntry(fallback)
        else resetToDefaults()
      }
    } catch (err) {
      console.error('Failed to delete coding agent config:', err)
      setError(t('codingAgent.errorDeleteConfig'))
    }
  }

  // For claude-code: apiUrl + apiKey + model required. For codex: always valid.
  const isValid = needsApiConfig
    ? Boolean(apiUrl.trim() && apiKey.trim() && model.trim())
    : true

  const handleLaunch = async () => {
    if (!isValid || installStatus !== 'ready') return
    setError('')
    const payload: CodingAgentConfigInput = {
      agentType,
      extraArgs: extraArgs.trim(),
      ...(needsApiConfig && {
        provider,
        apiUrl: apiUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim()
      })
    }

    try {
      const state = await window.electronAPI.codingAgentConfig.save(payload)
      setHistory(state.history)
      setLastUsedId(state.lastUsedId[agentType] ?? null)
      setActiveHistoryId(state.lastUsedId[agentType] ?? null)
    } catch (err) {
      console.error('Failed to save coding agent config:', err)
      setError(t('codingAgent.errorSaveConfig'))
    }

    onLaunch(payload)
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') onCancel()
    else if (event.key === 'Enter' && isValid && installStatus === 'ready') handleLaunch()
  }

  const title = t(`codingAgent.title.${agentType}` as const)
  const installStatusText = installStatus === 'ready'
    ? t(`codingAgent.statusReady.${agentType}` as const)
    : installStatus === 'error'
      ? (installError || t(`codingAgent.statusError.${agentType}` as const))
      : t(`codingAgent.statusLoading.${agentType}` as const)

  return (
    <div className="claude-code-modal-overlay" onClick={onCancel}>
      <div
        className="claude-code-modal"
        ref={modalRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="claude-code-modal-header">
          <h3 className="claude-code-modal-title">
            <span
              className={`claude-code-status-dot is-${installStatus}`}
              aria-label={installStatusText}
              title={installStatusText}
            />
            {title}
          </h3>
          <button className="claude-code-modal-close" onClick={onCancel} aria-label={t('codingAgent.close')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="claude-code-modal-body">
          <div className="claude-code-form">
            {needsApiConfig && (
              <>
                <div className="claude-code-field">
                  <label className="claude-code-label" htmlFor="ca-provider">{t('codingAgent.providerLabel')}</label>
                  <div className="onward-select-shell onward-select-shell--block">
                    <select
                      id="ca-provider"
                      className="claude-code-select onward-select onward-select--regular"
                      value={provider}
                      onChange={(e) => handleProviderChange(e.target.value as CodingAgentProvider)}
                    >
                      {PROVIDER_OPTIONS.map(item => (
                        <option key={item.value} value={item.value}>
                          {item.labelKey ? t(item.labelKey) : item.fallbackLabel}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="claude-code-field">
                  <label className="claude-code-label" htmlFor="ca-url">{t('codingAgent.apiUrlLabel')}</label>
                  <input id="ca-url" className="claude-code-input" value={apiUrl}
                    onChange={(e) => setApiUrl(e.target.value)} placeholder={t('codingAgent.apiUrlPlaceholder')} />
                </div>

                <div className="claude-code-field">
                  <label className="claude-code-label" htmlFor="ca-key">{t('codingAgent.apiKeyLabel')}</label>
                  <div className="claude-code-input-row">
                    <input id="ca-key" className="claude-code-input" type={showApiKey ? 'text' : 'password'}
                      value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={t('codingAgent.apiKeyPlaceholder')} />
                    <button type="button" className="claude-code-input-action"
                      onClick={() => setShowApiKey(p => !p)}
                      aria-label={showApiKey ? t('codingAgent.hideKey') : t('codingAgent.showKey')}>
                      {showApiKey ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                          <path d="M4 4L20 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                          <path d="M10.4 10.9a2.5 2.5 0 0 0 2.6 2.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                          <path d="M6.5 6.8C4.6 8.3 3.3 10 2.5 12c1.6 3.8 5.1 6.5 9.5 6.5 1.9 0 3.6-.4 5-1.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                          <path d="M9.9 5.1c.7-.1 1.4-.1 2.1-.1 4.4 0 7.9 2.7 9.5 6.5-.7 1.7-1.8 3.2-3.2 4.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                          <path d="M2.5 12c1.6-3.8 5.1-6.5 9.5-6.5s7.9 2.7 9.5 6.5c-1.6 3.8-5.1 6.5-9.5 6.5S4.1 15.8 2.5 12Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                          <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8"/>
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                <div className="claude-code-models">
                  <div className="claude-code-models-title">{t('codingAgent.modelConfig')}</div>
                  {isOpenRouter && (
                    <div className="claude-code-hint">
                      {t('codingAgent.modelMarketplace')}
                      <button type="button" className="claude-code-link" onClick={handleOpenOpenRouterModels}>
                        https://openrouter.ai/models
                      </button>
                    </div>
                  )}
                  <div className="claude-code-field">
                    <label className="claude-code-label" htmlFor="ca-model">{t('codingAgent.modelName')}</label>
                    <input id="ca-model" className="claude-code-input" value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder={isOpenRouter ? t('codingAgent.modelPlaceholderOpenRouter') : t('codingAgent.modelPlaceholderCustom')} />
                  </div>
                  {isOpenRouter && (
                    <div className="claude-code-hint">{t('codingAgent.modelHint')}</div>
                  )}
                </div>
              </>
            )}

            <div className="claude-code-field">
              <label className="claude-code-label" htmlFor="ca-extra-args">{t('codingAgent.extraArgs')}</label>
              <input id="ca-extra-args" className="claude-code-input" value={extraArgs}
                onChange={(e) => setExtraArgs(e.target.value)} placeholder={t('codingAgent.extraArgsPlaceholder')} />
              <div className="claude-code-hint">
                {t(`codingAgent.extraArgsHint.${agentType}` as const)}
              </div>
            </div>
          </div>

          <div className="claude-code-history">
            <div className="claude-code-history-header">
              <span>{t('codingAgent.history')}</span>
              {loading && <span className="claude-code-history-loading">{t('codingAgent.historyLoading')}</span>}
            </div>
            {history.length === 0 && !loading ? (
              <div className="claude-code-history-empty">{t('codingAgent.historyEmpty')}</div>
            ) : (
              history.map(item => (
                <div key={item.id} className={`claude-code-history-item ${item.id === activeHistoryId ? 'is-active' : ''}`}>
                  <div className="claude-code-history-main">
                    <div className="claude-code-history-title">
                      {needsApiConfig
                        ? (PROVIDER_OPTIONS.find(o => o.value === item.provider)?.fallbackLabel || item.provider || '-')
                        : t('terminalDropdown.codex')}
                      {item.id === lastUsedId && <span className="claude-code-history-badge">{t('codingAgent.historyLastUsed')}</span>}
                    </div>
                    <div className="claude-code-history-meta">
                      {needsApiConfig && (
                        <>
                          <span className="claude-code-history-meta-item">URL: {item.apiUrl || t('codingAgent.historyUrlEmpty')}</span>
                          <span className="claude-code-history-meta-item">Key: {maskKey(item.apiKey || '')}</span>
                          <span className="claude-code-history-meta-item">Model: {item.model || '-'}</span>
                        </>
                      )}
                      {item.extraArgs && <span className="claude-code-history-meta-item">Args: {item.extraArgs}</span>}
                    </div>
                  </div>
                  <div className="claude-code-history-actions">
                    <button className="claude-code-history-btn" onClick={() => applyEntry(item)}>
                      {t('codingAgent.historyUse')}
                    </button>
                    <button className="claude-code-history-btn claude-code-history-btn-danger" onClick={() => handleDelete(item.id)}>
                      {t('codingAgent.historyDelete')}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {installStatus === 'error' && (
            <div className="claude-code-error" role="status">
              {installError}
              <button type="button" className="claude-code-link" onClick={handleOpenInstallGuide}>
                {t('codingAgent.viewInstallGuide')}
              </button>
            </div>
          )}

          {error && <div className="claude-code-error" role="status">{error}</div>}
        </div>

        <div className="claude-code-modal-footer">
          <button className="claude-code-modal-btn claude-code-modal-btn-ghost" onClick={onCancel}>
            {t('codingAgent.cancel')}
          </button>
          <button className="claude-code-modal-btn claude-code-modal-btn-primary"
            onClick={handleLaunch} disabled={!isValid || installStatus !== 'ready'}>
            {t('codingAgent.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
