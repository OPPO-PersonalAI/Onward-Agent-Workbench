/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SUPPORTED_LOCALES, auditOfficialTranslations } from '../../src/i18n/core.ts'

describe('official translation audit', () => {
  it('keeps every bundled locale complete and interpolation-compatible', () => {
    for (const { value: locale } of SUPPORTED_LOCALES) {
      const audit = auditOfficialTranslations(locale)
      assert.deepEqual(audit.missingKeys, [], `${locale} has missing keys`)
      assert.deepEqual(audit.extraKeys, [], `${locale} has unsupported keys`)
      assert.deepEqual(audit.placeholderMismatches, [], `${locale} has placeholder mismatches`)
      assert.deepEqual(audit.emptyValues, [], `${locale} has empty values`)
      assert.deepEqual(audit.unreviewedEnglishValues, [], `${locale} has unreviewed English values`)
    }
  })
})
