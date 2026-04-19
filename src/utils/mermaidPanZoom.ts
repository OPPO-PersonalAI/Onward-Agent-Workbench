/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import createPanZoom, { type PanZoom } from 'panzoom'

export interface MermaidPanZoomSignal {
  cancelled: boolean
}

export interface MermaidPanZoomStrings {
  zoomIn: string
  zoomOut: string
  resetZoom: string
  fitToScreen: string
  fullscreen: string
  exitFullscreen: string
  dragHint: string
}

interface Instance {
  pz: PanZoom
  diagramEl: HTMLElement
  viewport: HTMLElement
  content: HTMLElement
  svg: SVGElement
  zoomLabel: HTMLElement
  fit: () => void
  reset: () => void
  toggleFullscreen: () => void
  teardown: () => void
}

interface FullscreenHandle {
  overlay: HTMLElement
  pz: PanZoom
  teardown: () => void
}

const INSTANCE_KEY = '__onwardMermaidPanZoomInstance'
const CONTAINER_REGISTRY = new WeakMap<HTMLElement, Set<Instance>>()

const MIN_ZOOM = 0.1
const MAX_ZOOM = 12
const ZOOM_STEP = 1.3

function iconButton(svgInner: string, title: string, className: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = className
  btn.title = title
  btn.setAttribute('aria-label', title)
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${svgInner}</svg>`
  return btn
}

function formatZoomLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`
}

function getSvgIntrinsicSize(svg: SVGElement): { width: number; height: number } {
  let width = 0
  let height = 0
  const viewBoxAttr = svg.getAttribute('viewBox')
  if (viewBoxAttr) {
    const parts = viewBoxAttr.split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      width = parts[2]
      height = parts[3]
    }
  }
  if ((!width || !height) && (svg as unknown as SVGGraphicsElement).getBBox) {
    try {
      const box = (svg as unknown as SVGGraphicsElement).getBBox()
      if (box.width > 0) width = box.width
      if (box.height > 0) height = box.height
    } catch {
      /* ignore */
    }
  }
  if (!width || !height) {
    const rect = svg.getBoundingClientRect()
    width = rect.width
    height = rect.height
  }
  return { width: width || 1, height: height || 1 }
}

function computeFitTransform(
  viewport: HTMLElement,
  svg: SVGElement,
  padding = 16
): { scale: number; x: number; y: number } | null {
  let vw = viewport.clientWidth
  let vh = viewport.clientHeight
  if (vw <= 0 || vh <= 0) {
    const rect = viewport.getBoundingClientRect()
    if (vw <= 0) vw = rect.width
    if (vh <= 0) vh = rect.height
  }
  const { width: sw, height: sh } = getSvgIntrinsicSize(svg)
  if (vw <= 0 || vh <= 0 || sw <= 0 || sh <= 0) {
    return null
  }
  const maxScaleX = (vw - padding * 2) / sw
  const maxScaleY = (vh - padding * 2) / sh
  const scale = Math.min(maxScaleX, maxScaleY)
  const clampedScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale))
  const x = Math.round((vw - sw * clampedScale) / 2)
  const y = Math.round((vh - sh * clampedScale) / 2)
  return { scale: clampedScale, x, y }
}

function applyFit(
  pz: PanZoom,
  viewport: HTMLElement,
  svg: SVGElement,
  content: HTMLElement
): boolean {
  const result = computeFitTransform(viewport, svg)
  if (!result) return false
  const { scale, x, y } = result
  pz.zoomAbs(0, 0, scale)
  pz.moveTo(x, y)
  // Ensure the DOM transform reflects the computed fit immediately, not on the
  // next animation frame. Panzoom batches via requestAnimationFrame which can
  // race with subsequent test reads.
  content.style.transformOrigin = '0 0 0'
  content.style.transform = `matrix(${scale}, 0, 0, ${scale}, ${x}, ${y})`
  return true
}

function prepareSvgForTransform(svg: SVGElement): void {
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  const style = svg.style
  style.maxWidth = 'none'
  style.maxHeight = 'none'
  style.display = 'block'
  style.margin = '0'
  const { width, height } = getSvgIntrinsicSize(svg)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
}

const ICONS = {
  zoomOut: '<path d="M4 8 h8"/>',
  zoomIn: '<path d="M4 8 h8 M8 4 v8"/>',
  fit:
    '<path d="M2.5 6 V2.5 H6 M10 2.5 H13.5 V6 M13.5 10 V13.5 H10 M6 13.5 H2.5 V10"/>',
  reset:
    '<path d="M3 8 a5 5 0 1 0 1.4 -3.5"/><path d="M2.5 3 V6.2 H5.6"/>',
  fullscreen: '<path d="M2 6 V2 H6 M10 2 H14 V6 M14 10 V14 H10 M6 14 H2 V10"/>',
  exitFullscreen: '<path d="M6 2 V6 H2 M10 6 V2 M14 10 H10 V14 M6 14 V10 H2 M10 14 V10 H14"/>'
}

function createToolbar(strings: MermaidPanZoomStrings): {
  toolbar: HTMLElement
  btnZoomOut: HTMLButtonElement
  btnZoomIn: HTMLButtonElement
  btnFit: HTMLButtonElement
  btnReset: HTMLButtonElement
  btnFullscreen: HTMLButtonElement
  zoomLabel: HTMLElement
} {
  const toolbar = document.createElement('div')
  toolbar.className = 'mermaid-toolbar'
  toolbar.setAttribute('role', 'toolbar')
  toolbar.addEventListener('pointerdown', (e) => {
    e.stopPropagation()
  })

  const btnZoomOut = iconButton(ICONS.zoomOut, strings.zoomOut, 'mermaid-toolbar-btn')
  const zoomLabel = document.createElement('span')
  zoomLabel.className = 'mermaid-toolbar-level'
  zoomLabel.textContent = '100%'
  const btnZoomIn = iconButton(ICONS.zoomIn, strings.zoomIn, 'mermaid-toolbar-btn')

  const sep1 = document.createElement('span')
  sep1.className = 'mermaid-toolbar-separator'

  const btnFit = iconButton(ICONS.fit, strings.fitToScreen, 'mermaid-toolbar-btn')
  const btnReset = iconButton(ICONS.reset, strings.resetZoom, 'mermaid-toolbar-btn')

  const sep2 = document.createElement('span')
  sep2.className = 'mermaid-toolbar-separator'

  const btnFullscreen = iconButton(
    ICONS.fullscreen,
    strings.fullscreen,
    'mermaid-toolbar-btn'
  )

  toolbar.append(btnZoomOut, zoomLabel, btnZoomIn, sep1, btnFit, btnReset, sep2, btnFullscreen)

  return { toolbar, btnZoomOut, btnZoomIn, btnFit, btnReset, btnFullscreen, zoomLabel }
}

function createHint(message: string): HTMLElement {
  const hint = document.createElement('div')
  hint.className = 'mermaid-hint'
  hint.textContent = message
  return hint
}

function buildViewport(svg: SVGElement): { viewport: HTMLElement; content: HTMLElement } {
  const viewport = document.createElement('div')
  viewport.className = 'mermaid-pz-viewport'
  viewport.tabIndex = 0

  const content = document.createElement('div')
  content.className = 'mermaid-pz-content'
  content.appendChild(svg)

  viewport.appendChild(content)
  return { viewport, content }
}

function getDiagramInstance(el: HTMLElement): Instance | null {
  return (el as unknown as Record<string, Instance | undefined>)[INSTANCE_KEY] ?? null
}

function setDiagramInstance(el: HTMLElement, inst: Instance | null): void {
  ;(el as unknown as Record<string, Instance | null>)[INSTANCE_KEY] = inst
}

function createInstance(
  diagram: HTMLElement,
  svg: SVGElement,
  strings: MermaidPanZoomStrings
): Instance | null {
  prepareSvgForTransform(svg)

  const { viewport, content } = buildViewport(svg)
  const { toolbar, btnZoomOut, btnZoomIn, btnFit, btnReset, btnFullscreen, zoomLabel } =
    createToolbar(strings)
  const hint = createHint(strings.dragHint)

  diagram.innerHTML = ''
  diagram.appendChild(viewport)
  diagram.appendChild(toolbar)
  diagram.appendChild(hint)
  diagram.classList.add('mermaid-panzoom-enabled')

  const pz = createPanZoom(content, {
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    smoothScroll: false,
    bounds: false,
    zoomDoubleClickSpeed: 1, // 1 = disable default double-click zoom
    beforeWheel: () => false,
    beforeMouseDown: () => false
  })

  const updateZoomLabel = () => {
    const t = pz.getTransform()
    zoomLabel.textContent = formatZoomLabel(t.scale)
  }
  pz.on<unknown>('transform', updateZoomLabel)

  const fit = () => applyFit(pz, viewport, svg, content)
  const reset = () => {
    pz.zoomAbs(0, 0, 1)
    pz.moveTo(0, 0)
  }

  const zoomAtCenter = (factor: number) => {
    const rect = viewport.getBoundingClientRect()
    pz.smoothZoom(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
  }

  btnZoomIn.addEventListener('click', (e) => {
    e.preventDefault()
    zoomAtCenter(ZOOM_STEP)
  })
  btnZoomOut.addEventListener('click', (e) => {
    e.preventDefault()
    zoomAtCenter(1 / ZOOM_STEP)
  })
  btnFit.addEventListener('click', (e) => {
    e.preventDefault()
    fit()
  })
  btnReset.addEventListener('click', (e) => {
    e.preventDefault()
    reset()
  })

  let fullscreen: FullscreenHandle | null = null
  const toggleFullscreen = () => {
    if (fullscreen) {
      fullscreen.teardown()
      fullscreen = null
      btnFullscreen.title = strings.fullscreen
      btnFullscreen.setAttribute('aria-label', strings.fullscreen)
      btnFullscreen.innerHTML = iconButton(
        ICONS.fullscreen,
        strings.fullscreen,
        ''
      ).innerHTML
    } else {
      fullscreen = openFullscreen(svg, strings, () => {
        fullscreen = null
        btnFullscreen.title = strings.fullscreen
        btnFullscreen.setAttribute('aria-label', strings.fullscreen)
        btnFullscreen.innerHTML = iconButton(
          ICONS.fullscreen,
          strings.fullscreen,
          ''
        ).innerHTML
      })
      btnFullscreen.title = strings.exitFullscreen
      btnFullscreen.setAttribute('aria-label', strings.exitFullscreen)
      btnFullscreen.innerHTML = iconButton(
        ICONS.exitFullscreen,
        strings.exitFullscreen,
        ''
      ).innerHTML
    }
  }
  btnFullscreen.addEventListener('click', (e) => {
    e.preventDefault()
    toggleFullscreen()
  })

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    if (document.activeElement !== viewport) return
    switch (e.key) {
      case '+':
      case '=':
        e.preventDefault()
        zoomAtCenter(ZOOM_STEP)
        break
      case '-':
      case '_':
        e.preventDefault()
        zoomAtCenter(1 / ZOOM_STEP)
        break
      case '0':
        e.preventDefault()
        reset()
        break
      case 'f':
      case 'F':
        e.preventDefault()
        fit()
        break
    }
  }
  viewport.addEventListener('keydown', onKeyDown)

  const onDoubleClick = (e: MouseEvent) => {
    const target = e.target as Element | null
    if (target?.closest('.mermaid-toolbar')) return
    e.preventDefault()
    fit()
  }
  viewport.addEventListener('dblclick', onDoubleClick)

  const onPointerDown = () => {
    viewport.classList.add('is-dragging')
    viewport.focus({ preventScroll: true })
  }
  const onPointerUp = () => {
    viewport.classList.remove('is-dragging')
  }
  viewport.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)

  // Apply initial fit as soon as the viewport has a measurable size.
  // Using ResizeObserver handles cases where layout happens after enhancement
  // (e.g. the diagram was inserted while its ancestor chain was still sizing).
  let initialFitApplied = false
  let initialFitFallbackTimer: number | null = null
  const forceInitialFit = () => {
    if (initialFitApplied) return
    if (!diagram.isConnected) return
    const ok = fit()
    if (!ok) return // dimensions still not ready; retry via observer/timer
    initialFitApplied = true
    updateZoomLabel()
    initialFitObserver?.disconnect()
    if (initialFitFallbackTimer !== null) {
      window.clearTimeout(initialFitFallbackTimer)
      initialFitFallbackTimer = null
    }
  }
  const applyInitialFitIfReady = () => {
    if (initialFitApplied) return
    if (!diagram.isConnected) return
    forceInitialFit()
  }
  const initialFitObserver: ResizeObserver | null = new ResizeObserver(() => {
    applyInitialFitIfReady()
  })
  initialFitObserver.observe(viewport)
  requestAnimationFrame(() => {
    applyInitialFitIfReady()
  })
  // Safety fallback: if layout hasn't settled within 400ms, force fit anyway.
  initialFitFallbackTimer = window.setTimeout(() => {
    forceInitialFit()
  }, 400)

  const teardown = () => {
    try {
      pz.dispose()
    } catch {
      /* ignore */
    }
    if (fullscreen) {
      fullscreen.teardown()
      fullscreen = null
    }
    viewport.removeEventListener('keydown', onKeyDown)
    viewport.removeEventListener('dblclick', onDoubleClick)
    viewport.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
    initialFitObserver?.disconnect()
    if (initialFitFallbackTimer !== null) {
      window.clearTimeout(initialFitFallbackTimer)
      initialFitFallbackTimer = null
    }
    setDiagramInstance(diagram, null)
  }

  const instance: Instance = {
    pz,
    diagramEl: diagram,
    viewport,
    content,
    svg,
    zoomLabel,
    fit,
    reset,
    toggleFullscreen,
    teardown
  }
  setDiagramInstance(diagram, instance)
  return instance
}

function openFullscreen(
  originalSvg: SVGElement,
  strings: MermaidPanZoomStrings,
  onClose: () => void
): FullscreenHandle {
  const overlay = document.createElement('div')
  overlay.className = 'mermaid-fullscreen-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')

  const modal = document.createElement('div')
  modal.className = 'mermaid-fullscreen-modal'

  const { viewport, content } = buildViewport(originalSvg.cloneNode(true) as SVGElement)
  viewport.classList.add('mermaid-fullscreen-viewport')
  prepareSvgForTransform(content.querySelector('svg') as SVGElement)

  const { toolbar, btnZoomOut, btnZoomIn, btnFit, btnReset, btnFullscreen, zoomLabel } =
    createToolbar({
      ...strings,
      fullscreen: strings.exitFullscreen
    })
  toolbar.classList.add('mermaid-fullscreen-toolbar')
  btnFullscreen.innerHTML = iconButton(
    ICONS.exitFullscreen,
    strings.exitFullscreen,
    ''
  ).innerHTML
  btnFullscreen.title = strings.exitFullscreen
  btnFullscreen.setAttribute('aria-label', strings.exitFullscreen)

  modal.appendChild(viewport)
  modal.appendChild(toolbar)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  const svg = content.querySelector('svg') as SVGElement

  const pz = createPanZoom(content, {
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    smoothScroll: false,
    bounds: false,
    zoomDoubleClickSpeed: 1
  })

  const updateZoom = () => {
    zoomLabel.textContent = formatZoomLabel(pz.getTransform().scale)
  }
  pz.on<unknown>('transform', updateZoom)

  const fit = () => applyFit(pz, viewport, svg, content)
  const zoomAtCenter = (factor: number) => {
    const rect = viewport.getBoundingClientRect()
    pz.smoothZoom(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
  }

  btnZoomIn.addEventListener('click', (e) => {
    e.preventDefault()
    zoomAtCenter(ZOOM_STEP)
  })
  btnZoomOut.addEventListener('click', (e) => {
    e.preventDefault()
    zoomAtCenter(1 / ZOOM_STEP)
  })
  btnFit.addEventListener('click', (e) => {
    e.preventDefault()
    fit()
  })
  btnReset.addEventListener('click', (e) => {
    e.preventDefault()
    pz.zoomAbs(0, 0, 1)
    pz.moveTo(0, 0)
  })
  btnFullscreen.addEventListener('click', (e) => {
    e.preventDefault()
    teardown()
  })

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      teardown()
      return
    }
    switch (e.key) {
      case '+':
      case '=':
        e.preventDefault()
        e.stopImmediatePropagation()
        zoomAtCenter(ZOOM_STEP)
        break
      case '-':
      case '_':
        e.preventDefault()
        e.stopImmediatePropagation()
        zoomAtCenter(1 / ZOOM_STEP)
        break
      case '0':
        e.preventDefault()
        e.stopImmediatePropagation()
        pz.zoomAbs(0, 0, 1)
        pz.moveTo(0, 0)
        break
      case 'f':
      case 'F':
        e.preventDefault()
        e.stopImmediatePropagation()
        fit()
        break
    }
  }
  // Attach at window level in capture phase so we run before document-level
  // subpage-escape handlers on the project editor.
  window.addEventListener('keydown', onKeyDown, { capture: true })

  const onOverlayClick = (e: MouseEvent) => {
    if (e.target === overlay) teardown()
  }
  overlay.addEventListener('click', onOverlayClick)

  const onDoubleClick = (e: MouseEvent) => {
    const target = e.target as Element | null
    if (target?.closest('.mermaid-toolbar')) return
    e.preventDefault()
    fit()
  }
  viewport.addEventListener('dblclick', onDoubleClick)

  const onPointerDown = () => viewport.classList.add('is-dragging')
  const onPointerUp = () => viewport.classList.remove('is-dragging')
  viewport.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)

  requestAnimationFrame(() => {
    if (!overlay.isConnected) return
    fit()
    viewport.focus({ preventScroll: true })
  })

  let tornDown = false
  const teardown = () => {
    if (tornDown) return
    tornDown = true
    try {
      pz.dispose()
    } catch {
      /* ignore */
    }
    window.removeEventListener('keydown', onKeyDown, { capture: true } as unknown as EventListenerOptions)
    overlay.removeEventListener('click', onOverlayClick)
    viewport.removeEventListener('dblclick', onDoubleClick)
    viewport.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
    overlay.remove()
    onClose()
  }

  return { overlay, pz, teardown }
}

export function enhanceMermaidDiagrams(
  container: HTMLElement,
  signal: MermaidPanZoomSignal,
  strings: MermaidPanZoomStrings
): void {
  if (signal.cancelled) return

  let registry = CONTAINER_REGISTRY.get(container)
  if (!registry) {
    registry = new Set<Instance>()
    CONTAINER_REGISTRY.set(container, registry)
  }

  for (const inst of Array.from(registry)) {
    if (!container.contains(inst.diagramEl)) {
      inst.teardown()
      registry.delete(inst)
    }
  }

  const diagrams = container.querySelectorAll<HTMLElement>(
    '.mermaid-diagram.mermaid-rendered:not(.mermaid-error)'
  )
  for (const diagram of Array.from(diagrams)) {
    if (signal.cancelled) return
    if (getDiagramInstance(diagram)) continue
    const svg = diagram.querySelector<SVGElement>(':scope > svg')
    if (!svg) continue
    const inst = createInstance(diagram, svg, strings)
    if (inst) registry.add(inst)
  }
}

export function disposeMermaidPanZoom(container: HTMLElement): void {
  const registry = CONTAINER_REGISTRY.get(container)
  if (!registry) return
  for (const inst of Array.from(registry)) {
    inst.teardown()
  }
  registry.clear()
  CONTAINER_REGISTRY.delete(container)
}

export function getMermaidPanZoomState(
  container: HTMLElement
): Array<{
  id: string | null
  scale: number
  x: number
  y: number
  fullscreen: boolean
  enhanced: boolean
}> {
  const result: Array<{
    id: string | null
    scale: number
    x: number
    y: number
    fullscreen: boolean
    enhanced: boolean
  }> = []
  const fsOpen = !!document.querySelector('.mermaid-fullscreen-overlay')
  const diagrams = container.querySelectorAll<HTMLElement>('.mermaid-diagram')
  for (const el of Array.from(diagrams)) {
    const id = el.getAttribute('data-mermaid-id')
    const inst = getDiagramInstance(el)
    if (inst) {
      // Use panzoom's internal transform state — the synchronous source of
      // truth. The DOM style is updated asynchronously via rAF and can race
      // with test reads that happen immediately after trigger calls.
      const t = inst.pz.getTransform()
      result.push({
        id,
        scale: t.scale,
        x: t.x,
        y: t.y,
        fullscreen: fsOpen,
        enhanced: true
      })
    } else {
      result.push({
        id,
        scale: 1,
        x: 0,
        y: 0,
        fullscreen: false,
        enhanced: false
      })
    }
  }
  return result
}

export function triggerMermaidPanZoomAction(
  container: HTMLElement,
  diagramId: string,
  action: 'zoomIn' | 'zoomOut' | 'fit' | 'reset' | 'fullscreen'
): boolean {
  const diagram = container.querySelector<HTMLElement>(
    `.mermaid-diagram[data-mermaid-id="${CSS.escape(diagramId)}"]`
  )
  if (!diagram) return false
  const inst = getDiagramInstance(diagram)
  if (!inst) return false
  const rect = inst.viewport.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const currentScale = inst.pz.getTransform().scale
  switch (action) {
    case 'zoomIn': {
      const next = Math.min(MAX_ZOOM, currentScale * ZOOM_STEP)
      inst.pz.zoomAbs(cx, cy, next)
      return true
    }
    case 'zoomOut': {
      const next = Math.max(MIN_ZOOM, currentScale / ZOOM_STEP)
      inst.pz.zoomAbs(cx, cy, next)
      return true
    }
    case 'fit':
      inst.fit()
      return true
    case 'reset':
      inst.reset()
      return true
    case 'fullscreen':
      inst.toggleFullscreen()
      return true
  }
  return false
}

export function simulateMermaidPan(
  container: HTMLElement,
  diagramId: string,
  dx: number,
  dy: number
): boolean {
  const diagram = container.querySelector<HTMLElement>(
    `.mermaid-diagram[data-mermaid-id="${CSS.escape(diagramId)}"]`
  )
  if (!diagram) return false
  const inst = getDiagramInstance(diagram)
  if (!inst) return false
  const t = inst.pz.getTransform()
  inst.pz.moveTo(t.x + dx, t.y + dy)
  return true
}

export function isFullscreenActive(): boolean {
  return !!document.querySelector('.mermaid-fullscreen-overlay')
}
