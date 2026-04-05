/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { extname } from 'path'

export const MAX_IMAGE_FILE_SIZE = 10 * 1024 * 1024

export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.apng',
  '.jpg',
  '.jpeg',
  '.jfif',
  '.pjpeg',
  '.pjp',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.ico',
  '.cur',
  '.tif',
  '.tiff',
  '.svg'
])

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.pjpeg': 'image/jpeg',
  '.pjp': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.cur': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml'
}

export function getNormalizedImageExtension(filename: string): string {
  return extname(filename).toLowerCase()
}

export function isSupportedImageFile(filename: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.has(getNormalizedImageExtension(filename))
}

export function getImageMimeType(filename: string): string {
  return IMAGE_MIME_TYPES[getNormalizedImageExtension(filename)] || 'application/octet-stream'
}

export function bufferToImageDataUrl(buffer: Buffer, filename: string): string {
  return `data:${getImageMimeType(filename)};base64,${buffer.toString('base64')}`
}
