import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { X } from 'lucide-react'
import { noteLinkMarkerCss, noteLinkPageAtPoint } from '../lib/noteLink'
import type { NoteTextField } from '../lib/noteTextField'
import { readUsedSheetZoom } from '../lib/paperView'

type FieldLayout = {
  id: string
  left: number
  top: number
  width: number
  pageWidth: number
}

type GeometryPatch = { page?: number; x?: number; y?: number; width?: number }

type NoteTextFieldLayerProps = {
  fields: readonly NoteTextField[]
  placing: boolean
  pdf: boolean
  focusId?: string | null
  onPlace: (point: { page: number; x: number; y: number }) => void
  onText: (id: string, text: string) => void
  onGeometry: (id: string, patch: GeometryPatch, commit: boolean) => void
  onRemove: (id: string) => void
  onFocusHandled?: () => void
}

type Gesture =
  | { kind: 'move'; id: string; dx: number; dy: number }
  | { kind: 'resize'; id: string; startX: number; startWidth: number; pageWidth: number }

const fitTextArea = (node: HTMLTextAreaElement) => {
  node.style.height = '0px'
  node.style.height = `${Math.max(38, node.scrollHeight)}px`
}

export function NoteTextFieldLayer({
  fields,
  placing,
  pdf,
  focusId,
  onPlace,
  onText,
  onGeometry,
  onRemove,
  onFocusHandled,
}: NoteTextFieldLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const [layout, setLayout] = useState<FieldLayout[]>([])

  const measure = useCallback(() => {
    const layer = layerRef.current
    if (!layer) return
    const layerRect = layer.getBoundingClientRect()
    const paper = layer.closest('.unified-paper') as HTMLElement | null
    const host = paper ?? layer
    const layoutWidth = host.offsetWidth
    const layoutHeight = host.offsetHeight
    const zoom = readUsedSheetZoom(host)
    const paperBox = {
      layoutWidth,
      layoutHeight,
      visualWidth: layoutWidth * zoom,
      visualHeight: layoutHeight * zoom,
    }
    setLayout(fields.map((field) => {
      const page = pdf
        ? paper?.querySelector<HTMLElement>(`[data-pdf-page="${field.page}"]`)
        : null
      const pageRect = page?.getBoundingClientRect()
      const css = noteLinkMarkerCss(
        field,
        paperBox,
        pageRect
          ? { left: pageRect.left, top: pageRect.top, width: pageRect.width, height: pageRect.height }
          : null,
        { left: layerRect.left, top: layerRect.top },
      )
      const pageWidth = pageRect ? pageRect.width / zoom : layoutWidth
      return {
        id: field.id,
        left: css.left,
        top: css.top,
        width: Math.max(96, field.width * pageWidth),
        pageWidth: Math.max(1, pageWidth),
      }
    }))
  }, [fields, pdf])

  useLayoutEffect(() => {
    measure()
    const layer = layerRef.current
    const paper = layer?.closest('.unified-paper')
    if (!paper || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(paper)
    paper.querySelectorAll('[data-pdf-page]').forEach((page) => observer.observe(page))
    const scroller = paper.closest('.unified-note-view')
    scroller?.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      scroller?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  useLayoutEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    layer.querySelectorAll<HTMLTextAreaElement>('[data-note-text-field]').forEach(fitTextArea)
  }, [fields, layout])

  useLayoutEffect(() => {
    if (!focusId) return
    const node = layerRef.current?.querySelector<HTMLTextAreaElement>(`[data-note-text-field="${CSS.escape(focusId)}"]`)
    node?.focus()
    onFocusHandled?.()
  }, [focusId, fields, onFocusHandled])

  const handlePlace = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!placing || event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('.note-text-field')) return
    event.preventDefault()
    event.stopPropagation()
    const layer = layerRef.current
    if (!layer) return
    onPlace(noteLinkPageAtPoint(event.clientX, event.clientY, layer))
  }

  const pointFromEvent = (event: ReactPointerEvent<HTMLElement>) => {
    const layer = layerRef.current
    if (!layer) return null
    return noteLinkPageAtPoint(event.clientX, event.clientY, layer)
  }

  const beginMove = (field: NoteTextField, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    const point = pointFromEvent(event)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    gestureRef.current = { kind: 'move', id: field.id, dx: point.x - field.x, dy: point.y - field.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const beginResize = (field: NoteTextField, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    const box = layout.find((item) => item.id === field.id)
    event.preventDefault()
    event.stopPropagation()
    gestureRef.current = {
      kind: 'resize',
      id: field.id,
      startX: event.clientX,
      startWidth: field.width,
      pageWidth: box?.pageWidth ?? 1,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveGesture = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current
    if (!gesture) return
    if (gesture.kind === 'move') {
      const point = pointFromEvent(event)
      if (!point) return
      onGeometry(gesture.id, {
        page: point.page,
        x: point.x - gesture.dx,
        y: point.y - gesture.dy,
      }, false)
      return
    }
    const host = layerRef.current?.closest('.unified-paper') as HTMLElement | null
    const zoom = host ? readUsedSheetZoom(host) : 1
    const delta = (event.clientX - gesture.startX) / Math.max(zoom, 0.01) / gesture.pageWidth
    onGeometry(gesture.id, { width: gesture.startWidth + delta }, false)
  }

  const endGesture = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current
    gestureRef.current = null
    if (!gesture) return
    if (gesture.kind === 'move') {
      const point = pointFromEvent(event)
      if (!point) return
      onGeometry(gesture.id, {
        page: point.page,
        x: point.x - gesture.dx,
        y: point.y - gesture.dy,
      }, true)
      return
    }
    const host = layerRef.current?.closest('.unified-paper') as HTMLElement | null
    const zoom = host ? readUsedSheetZoom(host) : 1
    const delta = (event.clientX - gesture.startX) / Math.max(zoom, 0.01) / gesture.pageWidth
    onGeometry(gesture.id, { width: gesture.startWidth + delta }, true)
  }

  return (
    <div
      ref={layerRef}
      className={`note-text-layer ${placing ? 'is-placing' : ''}`}
      onPointerDown={placing ? handlePlace : undefined}
    >
      {fields.map((field) => {
        const position = layout.find((item) => item.id === field.id)
        return (
          <div
            key={field.id}
            className="note-text-field"
            style={{ left: position?.left ?? 0, top: position?.top ?? 0, width: position?.width ?? 180 }}
          >
            <button
              type="button"
              className="note-text-field-move"
              aria-label="Textfeld verschieben"
              title="Textfeld verschieben"
              onPointerDown={(event) => beginMove(field, event)}
              onPointerMove={moveGesture}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
            />
            <textarea
              data-note-text-field={field.id}
              value={field.text}
              placeholder="Text eingeben …"
              spellCheck
              style={{ fontSize: `${field.fontSize}px` }}
              onChange={(event) => {
                fitTextArea(event.currentTarget)
                onText(field.id, event.target.value)
              }}
              onPointerDown={(event) => event.stopPropagation()}
            />
            <button
              type="button"
              className="note-text-field-resize"
              aria-label="Textfeldbreite ändern"
              title="Textfeldbreite ändern"
              onPointerDown={(event) => beginResize(field, event)}
              onPointerMove={moveGesture}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
            />
            <button
              type="button"
              className="note-text-field-remove"
              aria-label="Textfeld entfernen"
              title="Textfeld entfernen"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onRemove(field.id)
              }}
            >
              <X size={11} aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
