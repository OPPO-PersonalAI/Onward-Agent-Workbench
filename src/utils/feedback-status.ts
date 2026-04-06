/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FEEDBACK_LABEL_ACCEPTED,
  FEEDBACK_LABEL_IN_PROGRESS,
  type FeedbackSyncStatus
} from '../types/feedback'

export function resolveFeedbackSyncStatus(
  labels: string[],
  issueState: 'open' | 'closed' | null,
  issueStateReason: string | null
): FeedbackSyncStatus {
  if (issueState === 'closed') {
    if (issueStateReason === 'completed') {
      return 'completed'
    }
    if (issueStateReason === 'not_planned') {
      return 'not_planned'
    }
    if (issueStateReason === 'duplicate') {
      return 'duplicate'
    }
    return 'submitted'
  }

  if (labels.includes(FEEDBACK_LABEL_IN_PROGRESS)) {
    return 'in_progress'
  }
  if (labels.includes(FEEDBACK_LABEL_ACCEPTED)) {
    return 'accepted'
  }
  return 'submitted'
}
