/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mermaid pan/zoom enhancer autotest.
 *
 * Verifies that every rendered Mermaid diagram in the Markdown preview gets
 * the interactive pan/zoom viewport attached, and that the toolbar actions
 * (zoom in/out, fit, reset, fullscreen) mutate the transform as expected.
 */

import type { AutotestContext, TestResult } from './types'

const FIXTURES = [
  'test/fixtures/mermaid-panzoom/tiny.md',
  'test/fixtures/mermaid-panzoom/medium.md',
  'test/fixtures/mermaid-panzoom/wide.md',
  'test/fixtures/mermaid-panzoom/tall.md',
  'test/fixtures/mermaid-panzoom/huge.md',
  'test/fixtures/mermaid-panzoom/mixed-types.md'
] as const

const EXPECTED_DIAGRAMS_PER_FIXTURE: Record<string, number> = {
  'test/fixtures/mermaid-panzoom/tiny.md': 1,
  'test/fixtures/mermaid-panzoom/medium.md': 3,
  'test/fixtures/mermaid-panzoom/wide.md': 1,
  'test/fixtures/mermaid-panzoom/tall.md': 1,
  'test/fixtures/mermaid-panzoom/huge.md': 1,
  'test/fixtures/mermaid-panzoom/mixed-types.md': 10
}

export async function testMermaidPanZoom(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, openFileInEditor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug

  // ------------------------------------------------------------------
  // MPZ-01: API surface present
  // ------------------------------------------------------------------
  const api = getApi()
  if (!api) {
    record('MPZ-01-api-available', false, { error: 'debug api not found' })
    return results
  }

  const requiredMethods = [
    'getMermaidPreviewState',
    'getMermaidPanZoomState',
    'triggerMermaidPanZoomAction',
    'simulateMermaidPan',
    'isMermaidFullscreenActive'
  ] as const
  const missing = requiredMethods.filter(
    (m) => typeof (api as unknown as Record<string, unknown>)[m] !== 'function'
  )
  record('MPZ-01-api-available', missing.length === 0, {
    missing,
    available: requiredMethods.length - missing.length
  })
  if (missing.length > 0) return results
  if (cancelled()) return results

  const editorReady = await waitFor(
    'mpz:editor-ready',
    () => {
      const latest = getApi()
      return Boolean(latest?.isOpen?.() && latest?.getRootPath?.())
    },
    15000,
    120
  )
  record('MPZ-02-editor-ready', editorReady, {
    isOpen: getApi()?.isOpen?.(),
    rootPath: getApi()?.getRootPath?.()
  })
  if (!editorReady) return results

  const waitForMermaidSettled = async (label: string, expectedCount: number) => {
    return await waitFor(
      `mermaid-settled:${label}`,
      () => {
        const state = getApi()?.getMermaidPreviewState?.()
        if (!state) return false
        if (state.inFlight) return false
        if (state.pending > 0) return false
        if (state.total !== expectedCount) return false
        return state.rendered + state.error === expectedCount
      },
      30000,
      120
    )
  }

  const waitForEnhancerSettled = async (label: string, expectedCount: number) => {
    return await waitFor(
      `mermaid-enhanced:${label}`,
      () => {
        const state = getApi()?.getMermaidPreviewState?.()
        if (!state) return false
        const list = getApi()?.getMermaidPanZoomState?.() ?? []
        if (list.length !== expectedCount) return false
        const enhanced = list.filter((d) => d.enhanced).length
        return enhanced === state.rendered
      },
      15000,
      80
    )
  }

  for (const fixture of FIXTURES) {
    if (cancelled()) return results
    const expectedCount = EXPECTED_DIAGRAMS_PER_FIXTURE[fixture] ?? 1
    const suite = fixture.split('/').pop()?.replace('.md', '') ?? fixture
    const prefix = `MPZ-${suite}`

    log('mpz:open-fixture', { fixture, expectedCount })

    await openFileInEditor(fixture)

    const opened = await waitFor(
      `mpz-open:${suite}`,
      () => getApi()?.getActiveFilePath?.() === fixture,
      20000
    )
    record(`${prefix}-open`, opened, {
      expected: fixture,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!opened) continue

    const mermaidReady = await waitForMermaidSettled(suite, expectedCount)
    const mstate = getApi()?.getMermaidPreviewState?.()
    record(`${prefix}-render`, mermaidReady, { state: mstate })
    if (!mermaidReady) continue

    const enhanced = await waitForEnhancerSettled(suite, expectedCount)
    const list = getApi()?.getMermaidPanZoomState?.() ?? []
    record(`${prefix}-enhance`, enhanced, {
      expectedCount,
      actualCount: list.length,
      enhancedCount: list.filter((d) => d.enhanced).length
    })
    if (!enhanced) continue

    // Give the rAF/resize-observer-scheduled initial fit time to apply the
    // transform. We poll for any non-identity transform up to the budget, but
    // don't fail the suite if some diagrams take longer — the subsequent
    // interaction tests will exercise the enhancer directly.
    await waitFor(
      `mermaid-fit-applied:${suite}`,
      () => {
        const current = getApi()?.getMermaidPanZoomState?.() ?? []
        if (current.length !== expectedCount) return false
        return current.filter(
          (d) => d.enhanced && (d.scale !== 1 || d.x !== 0 || d.y !== 0)
        ).length > 0
      },
      3000,
      80
    )
    await sleep(200)

    // Verify each enhanced diagram has a viewport, content, and toolbar.
    const previewDiagrams = Array.from(
      document.querySelectorAll(
        '.project-editor-preview-body .mermaid-diagram.mermaid-rendered:not(.mermaid-error)'
      )
    )
    let viewportsOk = true
    let toolbarsOk = true
    let transformsOk = true
    for (const diagram of previewDiagrams) {
      const vp = diagram.querySelector('.mermaid-pz-viewport')
      const content = diagram.querySelector('.mermaid-pz-content')
      const svg = diagram.querySelector('.mermaid-pz-content > svg')
      const tb = diagram.querySelector('.mermaid-toolbar')
      const btns = diagram.querySelectorAll('.mermaid-toolbar-btn')
      if (!vp || !content || !svg) viewportsOk = false
      if (!tb || btns.length < 5) toolbarsOk = false
      const transform = window.getComputedStyle(content as Element).transform
      if (!transform || transform === 'none') transformsOk = false
    }
    record(`${prefix}-structure`, viewportsOk && toolbarsOk, {
      viewportsOk,
      toolbarsOk,
      diagramCount: previewDiagrams.length
    })
    record(`${prefix}-transform-applied`, transformsOk, { transformsOk })

    if (list.length === 0) continue

    const firstId = list.find((d) => d.enhanced)?.id
    if (!firstId) {
      record(`${prefix}-first-id`, false, { reason: 'no enhanced diagram found' })
      continue
    }

    const readState = () =>
      (getApi()?.getMermaidPanZoomState?.() ?? []).find((d) => d.id === firstId)

    const initial = readState()
    record(`${prefix}-initial-state`, !!initial && initial.enhanced, { initial })
    if (!initial) continue

    // Reset to a known state before zoom tests. Reset sets scale=1, x=0, y=0.
    getApi()?.triggerMermaidPanZoomAction?.(firstId, 'reset')
    await sleep(150)
    const afterReset = readState()
    record(`${prefix}-reset-to-identity`, !!afterReset && Math.abs(afterReset.scale - 1) < 0.01, {
      state: afterReset
    })

    // Zoom in from identity — scale must strictly increase.
    const zoomInOk = getApi()?.triggerMermaidPanZoomAction?.(firstId, 'zoomIn') ?? false
    await sleep(200)
    const afterZoomIn = readState()
    const zoomInIncreased =
      !!afterZoomIn && afterReset != null && afterZoomIn.scale > afterReset.scale + 0.01
    record(`${prefix}-zoom-in-increases-scale`, zoomInOk && zoomInIncreased, {
      zoomInOk,
      before: afterReset?.scale,
      after: afterZoomIn?.scale
    })

    // Zoom out from current — scale must strictly decrease (unless clamped).
    const zoomOutStart = readState()
    const zoomOutOk = getApi()?.triggerMermaidPanZoomAction?.(firstId, 'zoomOut') ?? false
    await sleep(200)
    const afterZoomOut = readState()
    const atMin = (zoomOutStart?.scale ?? 1) <= 0.101
    const zoomOutChanged = atMin
      ? !!afterZoomOut && afterZoomOut.scale <= (zoomOutStart?.scale ?? 1) + 0.01
      : !!afterZoomOut &&
        !!zoomOutStart &&
        afterZoomOut.scale < zoomOutStart.scale - 0.01
    record(`${prefix}-zoom-out-decreases-scale`, zoomOutOk && zoomOutChanged, {
      zoomOutOk,
      atMin,
      before: zoomOutStart?.scale,
      after: afterZoomOut?.scale
    })

    // Pan — moveTo deltas should apply exactly.
    const beforePan = readState()
    const panOk = getApi()?.simulateMermaidPan?.(firstId, 50, 30) ?? false
    await sleep(150)
    const afterPan = readState()
    const dx = (afterPan?.x ?? 0) - (beforePan?.x ?? 0)
    const dy = (afterPan?.y ?? 0) - (beforePan?.y ?? 0)
    record(`${prefix}-pan-applies-delta`, panOk && Math.abs(dx - 50) < 2 && Math.abs(dy - 30) < 2, {
      panOk,
      dx,
      dy
    })

    // Fit — should produce a valid non-identity transform (assuming the
    // diagram is non-trivial relative to the viewport).
    const fitOk = getApi()?.triggerMermaidPanZoomAction?.(firstId, 'fit') ?? false
    await sleep(200)
    const afterFit = readState()
    record(`${prefix}-fit-applies-valid-transform`, fitOk && !!afterFit && Number.isFinite(afterFit.scale) && afterFit.scale > 0, {
      state: afterFit
    })

    // Fullscreen: verify closed initially.
    record(`${prefix}-fullscreen-closed-initially`, getApi()?.isMermaidFullscreenActive?.() === false, {})

    // Open fullscreen.
    const fsOpenOk = getApi()?.triggerMermaidPanZoomAction?.(firstId, 'fullscreen') ?? false
    await sleep(250)
    const fsOverlay = document.querySelector('.mermaid-fullscreen-overlay')
    const fsSvg = fsOverlay?.querySelector('.mermaid-pz-content > svg')
    record(`${prefix}-fullscreen-opens`, fsOpenOk && !!fsOverlay && !!fsSvg, {
      hasOverlay: !!fsOverlay,
      hasClonedSvg: !!fsSvg
    })

    // ESC closes fullscreen without closing the underlying project editor.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(250)
    const fsStillClosed = getApi()?.isMermaidFullscreenActive?.() === false
    const editorStillOpen = getApi()?.isOpen?.() === true
    record(`${prefix}-fullscreen-escape-closes`, fsStillClosed && editorStillOpen, {
      fsStillClosed,
      editorStillOpen
    })

    // Reopen and close via toolbar toggle.
    getApi()?.triggerMermaidPanZoomAction?.(firstId, 'fullscreen')
    await sleep(250)
    const reopened = getApi()?.isMermaidFullscreenActive?.() === true
    getApi()?.triggerMermaidPanZoomAction?.(firstId, 'fullscreen')
    await sleep(250)
    const closedAgain = getApi()?.isMermaidFullscreenActive?.() === false
    record(`${prefix}-fullscreen-toggle`, reopened && closedAgain, {
      reopened,
      closedAgain
    })

    // Reset before moving to the next fixture.
    getApi()?.triggerMermaidPanZoomAction?.(firstId, 'reset')
    await sleep(100)
  }

  record('MPZ-final-no-orphan-fullscreen', !document.querySelector('.mermaid-fullscreen-overlay'), {
    overlays: document.querySelectorAll('.mermaid-fullscreen-overlay').length
  })

  return results
}
