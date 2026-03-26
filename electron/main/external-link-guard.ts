/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow, dialog, shell } from 'electron'
import { tMain } from './localization'

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

export interface OpenExternalResult {
  success: boolean
  canceled?: boolean
  blocked?: boolean
  error?: string
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl)
  } catch {
    return null
  }
}

export function isHttpOrHttpsUrl(rawUrl: string): boolean {
  const parsed = parseUrl(rawUrl)
  if (!parsed) return false
  return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)
}

export function isSameAppNavigation(currentUrl: string, nextUrl: string): boolean {
  const current = parseUrl(currentUrl)
  const next = parseUrl(nextUrl)
  if (!current || !next) return false
  return (
    current.protocol === next.protocol &&
    current.host === next.host &&
    current.pathname === next.pathname
  )
}

export async function openExternalUrlWithConfirm(
  parentWindow: BrowserWindow | null,
  rawUrl: string
): Promise<OpenExternalResult> {
  if (!isHttpOrHttpsUrl(rawUrl)) {
    return {
      success: false,
      blocked: true,
      error: 'Only http/https links are allowed'
    }
  }

  try {
    const { response } = await dialog.showMessageBox(parentWindow ?? undefined, {
      type: 'question',
      buttons: [tMain('dialog.externalLink.open'), tMain('dialog.externalLink.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: tMain('dialog.externalLink.title'),
      message: tMain('dialog.externalLink.message'),
      detail: rawUrl
    })

    if (response !== 0) {
      return {
        success: false,
        canceled: true,
        error: 'Open external link canceled by user'
      }
    }

    await shell.openExternal(rawUrl)
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
