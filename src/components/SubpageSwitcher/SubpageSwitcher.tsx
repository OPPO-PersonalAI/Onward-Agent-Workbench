/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SubpageId } from '../../types/subpage'
import { useI18n } from '../../i18n/useI18n'
import { SubpagePanelButton } from './SubpagePanelButton'
import './SubpageSwitcher.css'

interface SubpageSwitcherProps {
  current: SubpageId
  onSelect: (target: SubpageId) => void
  className?: string
}

const SUBPAGE_ORDER: SubpageId[] = ['diff', 'editor', 'history']

export function SubpageSwitcher({ current, onSelect, className }: SubpageSwitcherProps) {
  const { t } = useI18n()
  const containerClassName = className
    ? `subpage-switcher ${className}`
    : 'subpage-switcher'

  return (
    <div
      className={containerClassName}
      data-subpage-switcher="true"
      data-subpage-current={current}
      role="tablist"
      aria-label={t('subpageSwitcher.label')}
    >
      {SUBPAGE_ORDER.map((target) => {
        const isActive = target === current
        return (
          <SubpagePanelButton
            key={target}
            className={`subpage-switcher-button ${isActive ? 'active' : ''}`}
            isCurrent={isActive}
            onClick={() => onSelect(target)}
            disabled={isActive}
            role="tab"
            data-subpage-button={target}
            data-subpage-active={isActive ? 'true' : 'false'}
          >
            {t(`subpageSwitcher.${target}`)}
          </SubpagePanelButton>
        )
      })}
    </div>
  )
}
