/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ButtonHTMLAttributes } from 'react'

interface SubpagePanelButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  isCurrent?: boolean
}

export function SubpagePanelButton({
  className,
  isCurrent = false,
  type = 'button',
  ...props
}: SubpagePanelButtonProps) {
  const combinedClassName = [
    'subpage-panel-control-button',
    isCurrent ? 'is-current' : '',
    className || ''
  ].filter(Boolean).join(' ')

  return (
    <button
      type={type}
      className={combinedClassName}
      aria-selected={isCurrent ? 'true' : props['aria-selected']}
      {...props}
    />
  )
}
