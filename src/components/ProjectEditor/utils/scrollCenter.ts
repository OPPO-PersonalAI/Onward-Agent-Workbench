/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AlignElementCenterOptions {
  behavior?: ScrollBehavior
  // Fraction of viewport height that counts as the "dead zone" — if the target
  // is fully inside this middle band, no scroll happens. 0.6 = middle 60%.
  deadZoneRatio?: number
}

// Re-align `target` into the middle band of `container`'s viewport when it
// leaves that band. No-op when the target is already comfortably visible.
export function alignElementCenter(
  container: HTMLElement,
  target: HTMLElement,
  options: AlignElementCenterOptions = {}
): void {
  const behavior = options.behavior ?? 'smooth'
  const band = Math.min(Math.max(options.deadZoneRatio ?? 0.6, 0), 1)
  const containerRect = container.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const bandHeight = containerRect.height * band
  const topBand = containerRect.top + (containerRect.height - bandHeight) / 2
  const bottomBand = topBand + bandHeight
  if (targetRect.top >= topBand && targetRect.bottom <= bottomBand) return
  const targetCenterInContainer =
    targetRect.top - containerRect.top + targetRect.height / 2
  const delta = targetCenterInContainer - containerRect.height / 2
  const nextTop = Math.max(
    0,
    Math.min(
      container.scrollHeight - container.clientHeight,
      container.scrollTop + delta
    )
  )
  container.scrollTo({ top: nextTop, behavior })
}
