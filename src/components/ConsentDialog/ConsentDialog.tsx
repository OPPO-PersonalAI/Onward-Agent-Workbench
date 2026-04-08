/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState } from 'react'
import { useI18n } from '../../i18n/useI18n'
import './ConsentDialog.css'

interface ConsentDialogProps {
  onConsent: (consent: boolean) => void
}

export function ConsentDialog({ onConsent }: ConsentDialogProps) {
  const { t } = useI18n()
  const [submitting, setSubmitting] = useState(false)

  const handleAccept = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    await window.electronAPI.telemetry.setConsent(true)
    onConsent(true)
  }, [onConsent, submitting])

  const handleDecline = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    await window.electronAPI.telemetry.setConsent(false)
    onConsent(false)
  }, [onConsent, submitting])

  return (
    <div className="consent-dialog-overlay">
      <div className="consent-dialog">
        <h2 className="consent-dialog-title">
          {t('telemetry.consent.title')}
        </h2>
        <p className="consent-dialog-description">
          {t('telemetry.consent.description')}
        </p>
        <ul className="consent-dialog-list">
          <li>{t('telemetry.consent.collect.features')}</li>
          <li>{t('telemetry.consent.collect.performance')}</li>
          <li>{t('telemetry.consent.collect.crashes')}</li>
        </ul>
        <p className="consent-dialog-never">
          {t('telemetry.consent.neverCollect')}
        </p>
        <ul className="consent-dialog-list consent-dialog-list-never">
          <li>{t('telemetry.consent.never.files')}</li>
          <li>{t('telemetry.consent.never.commands')}</li>
          <li>{t('telemetry.consent.never.personal')}</li>
        </ul>
        <p className="consent-dialog-settings-hint">
          {t('telemetry.consent.settingsHint')}
        </p>
        <div className="consent-dialog-actions">
          <button
            className="consent-dialog-btn consent-dialog-btn-decline"
            onClick={handleDecline}
            disabled={submitting}
          >
            {t('telemetry.consent.decline')}
          </button>
          <button
            className="consent-dialog-btn consent-dialog-btn-accept"
            onClick={handleAccept}
            disabled={submitting}
          >
            {t('telemetry.consent.accept')}
          </button>
        </div>
      </div>
    </div>
  )
}
