export const PAPER_VIEW_SCROLLER_SELECTOR = '.paper-view, .unified-note-view'
export const EDITOR_LAYER_SCROLLER_SELECTOR = '.cm-scroller, .cm-editor, .markdown-editor, .editor-pane'

export const resolvePaperCaretScroller = (
  from: { closest: (selector: string) => HTMLElement | null } | null,
) => (
  from?.closest('.paper-view')
  ?? from?.closest('.unified-note-view')
  ?? null
)

export const isIndependentEditorLayer = (element: HTMLElement | null) => {
  if (!element) return false
  if (element.classList.contains('paper-view') || element.classList.contains('unified-note-view')) return false
  return Boolean(
    element.classList.contains('cm-scroller')
    || element.classList.contains('cm-editor')
    || element.classList.contains('markdown-editor')
    || element.classList.contains('editor-pane')
    || element.closest(EDITOR_LAYER_SCROLLER_SELECTOR),
  )
}

export const lockPaperEditorLayerScroll = (editorRoot: HTMLElement | null) => {
  if (!editorRoot) return [] as HTMLElement[]
  const layers = [
    editorRoot,
    ...[...editorRoot.querySelectorAll<HTMLElement>(EDITOR_LAYER_SCROLLER_SELECTOR)],
  ]
  layers.forEach((layer) => {
    if (layer.classList.contains('paper-view') || layer.classList.contains('unified-note-view')) return
    layer.scrollTop = 0
    layer.scrollLeft = 0
  })
  return layers.filter((layer) => !layer.classList.contains('paper-view') && !layer.classList.contains('unified-note-view'))
}

export const keepCaretVisibleInPaperScroller = (
  scroller: HTMLElement,
  caret: { top: number; bottom: number; left: number; right: number },
) => {
  const bounds = scroller.getBoundingClientRect()
  let dy = 0
  let dx = 0
  if (caret.bottom > bounds.bottom - 8) dy = caret.bottom - (bounds.bottom - 8)
  else if (caret.top < bounds.top + 8) dy = caret.top - (bounds.top + 8)
  if (caret.right > bounds.right - 8) dx = caret.right - (bounds.right - 8)
  else if (caret.left < bounds.left + 8) dx = caret.left - (bounds.left + 8)
  if (dy) scroller.scrollTop += dy
  if (dx) scroller.scrollLeft += dx
  return { dx, dy }
}

export const applyPaperArrowNavigation = (
  editorRoot: HTMLElement,
  caret: { top: number; bottom: number; left: number; right: number } | null,
) => {
  const locked = lockPaperEditorLayerScroll(editorRoot)
  const paper = resolvePaperCaretScroller(editorRoot)
  if (paper && caret) keepCaretVisibleInPaperScroller(paper, caret)
  return {
    paperScroller: paper,
    lockedLayers: locked,
    editorScrollTop: editorRoot.scrollTop,
    editorScrollLeft: editorRoot.scrollLeft,
  }
}
