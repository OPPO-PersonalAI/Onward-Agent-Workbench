/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ScheduleNotification as NotificationType } from '../../hooks/useScheduleEngine'
import { useI18n } from '../../i18n/useI18n'

interface ScheduleNotificationBarProps {
  notifications: NotificationType[]
  onDismiss: (promptId: string, type: NotificationType['type']) => void
  onRetry: (promptId: string) => void
}

export function ScheduleNotificationBar({
  notifications,
  onDismiss,
  onRetry
}: ScheduleNotificationBarProps) {
  const { t } = useI18n()
  if (notifications.length === 0) return null

  return (
    <div className="schedule-notification-bar">
      {notifications.map(notification => (
        <div key={`${notification.promptId}-${notification.type}`} className="schedule-notification-item">
          <span className="schedule-notification-icon">
            {notification.type === 'terminal-missing' ? '⚠️' : '⏰'}
          </span>
          <span className="schedule-notification-text">
            <strong>{notification.promptTitle}</strong>: {notification.message}
          </span>
          <div className="schedule-notification-actions">
            {notification.type === 'missed-execution' && (
              <button
                className="schedule-notification-btn retry"
                onClick={() => onRetry(notification.promptId)}
              >
                {t('scheduleNotification.catchUp')}
              </button>
            )}
            <button
              className="schedule-notification-btn dismiss"
              onClick={() => onDismiss(notification.promptId, notification.type)}
            >
              {notification.type === 'missed-execution' ? t('scheduleNotification.skip') : t('scheduleNotification.confirm')}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
