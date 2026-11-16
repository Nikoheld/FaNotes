import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Bold, Minus, Plus, Trash2 } from 'lucide-react'
import { noteLinkMarkerCss } from '../lib/noteLink'
import {
  NOTE_TEXT_FIELD_COLORS,
  NOTE_TEXT_FIELD_REFERENCE_PAGE_WIDTH,
  noteTextFieldPointFromRects,
  stepNoteTextFieldFontSize,
  type NoteTextField,
  type NoteTextFieldPageRect,
} from '../lib/noteTextField'
import { readUsedSheetZoom } from '../lib/paperView'
import { toggleNoteTextTask } from '../lib/noteTextMarkdown'
import { NoteTextFieldMarkdown } from './NoteTextFieldMarkdown'

type FieldLayout = {
  id: string
  left: number
  top: number
  width: number
  pageWidth: number
  /** Multiplier from the stored font size to layout px (PDF pages scale with the window). */
  scale: number
  /** 1 / sheet zoom, so the chrome around a box keeps a constant on-screen size. */
  inverse: number
}

type GeometryPatch = { page?: number; x?: number; y?: number; width?: number }
type StylePatch = { fontSize?: number; color?: string | undefined; bold?: boolean | undefined }

type NoteTextFieldLayerProps = {
  fields: readonly NoteTextField[]
  placing: boolean
  pdf: boolean
  focusId?: string | null
  onPlace: (point: { page: number; x: number; y: number }) => void
  onText: (id: string, text: string) => void
  onGeometry: (id: string, patch: GeometryPatch, commit: boolean) => void
  onStyle: (id: string, patch: StylePatch) => void
  onFinish?: () => void
  onRemove: (id: string) => void
  onFocusHandled?: () => void
  onSelectedChange?: (id: string | null) => void
}

type Gesture =
  | { kind: 'move'; id: string; dx: number; dy: number; width: number; moved: boolean }
  | { kind: 'resize'; id: string; startX: number; startWidth: number; pageWidth: number }

const MIN_BOX_HEIGHT = 1.9 // em

const fitTextArea = (node: HTMLTextAreaElement) => {
  node.style.height = '0px'
  node.style.height = `${Math.max(node.scrollHeight, 0)}px`
}

/** Size, bold and colour controls of the selected text box; shown in the top toolbar. */
export function NoteTextFieldToolbar({ field, onStyle, onRemove }: {
  field: NoteTextField
  onStyle: (id: string, patch: StylePatch) => void
  onRemove: (id: string) => void
}) {
  return (
    <div
      className="note-text-field-toolbar"
      role="toolbar"
      aria-label="Textfeld-Werkzeuge"
      onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" aria-label="Schrift kleiner" title="Schrift kleiner" onClick={() => onStyle(field.id, { fontSize: stepNoteTextFieldFontSize(field.fontSize, -1) })}><Minus size={13} aria-hidden="true" /></button>
        <span className="note-text-field-size" title="Schriftgröße">{field.fontSize}</span>
        <button type="button" aria-label="Schrift größer" title="Schrift größer" onClick={() => onStyle(field.id, { fontSize: stepNoteTextFieldFontSize(field.fontSize, 1) })}><Plus size={13} aria-hidden="true" /></button>
        <i className="note-text-field-sep" aria-hidden="true" />
        <button type="button" className={field.bold ? 'is-on' : ''} aria-pressed={Boolean(field.bold)} aria-label="Fett" title="Fett (Strg+B)" onClick={() => onStyle(field.id, { bold: field.bold ? undefined : true })}><Bold size={13} aria-hidden="true" /></button>
        <i className="note-text-field-sep" aria-hidden="true" />
        {NOTE_TEXT_FIELD_COLORS.map((color) => (
          <button
            key={color.label}
            type="button"
            className={`note-text-field-swatch ${(field.color ?? undefined) === color.value ? 'is-on' : ''}`}
            style={{ '--swatch': color.css } as CSSProperties}
            aria-label={color.label}
            title={color.label}
            aria-pressed={(field.color ?? undefined) === color.value}
            onClick={() => onStyle(field.id, { color: color.value })}
          />
        ))}
        <i className="note-text-field-sep" aria-hidden="true" />
        <button type="button" className="is-danger" aria-label="Textfeld entfernen" title="Textfeld entfernen" onClick={() => onRemove(field.id)}><Trash2 size={13} aria-hidden="true" /></button>
    </div>
  )
}

export function NoteTextFieldLayer({
  fields,
  placing,
  pdf,
  focusId,
  onPlace,
  onText,
  onGeometry,
  onStyle,
  onFinish,
  onRemove,
  onFocusHandled,
  onSelectedChange,
}: NoteTextFieldLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const fieldsRef = useRef(fields)
  fieldsRef.current = fields
  const [layout, setLayout] = useState<FieldLayout[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  useEffect(() => { onSelectedChange?.(selectedId) }, [selectedId, onSelectedChange])
  useEffect(() => () => onSelectedChange?.(null), [onSelectedChange])
  const previousSelectedRef = useRef<string | null>(null)
  const composingRef = useRef(false)
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  const onFinishRef = useRef(onFinish)
  onFinishRef.current = onFinish

  // The rendered Markdown is memoised on its text, so these read the current props.
  const toggleTask = useCallback((id: string, line: number) => {
    const field = fieldsRef.current.find((item) => item.id === id)
    if (!field) return
    const next = toggleNoteTextTask(field.text, line)
    if (next === field.text) return
    onTextRef.current(id, next)
    onFinishRef.current?.()
  }, [])

  const openLink = useCallback((href: string) => {
    void window.fanotes.openExternal(href).catch(() => {})
  }, [])

  // A click on the rendered text opens the box for typing, caret at the end.
  const startEditing = useCallback((id: string) => {
    const node = layerRef.current?.querySelector<HTMLTextAreaElement>(`[data-note-text-field="${CSS.escape(id)}"]`)
    setSelectedId(id)
    if (!node) return
    node.focus({ preventScroll: true })
    const end = node.value.length
    node.setSelectionRange(end, end)
  }, [])

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
    const next = fields.map((field) => {
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
      const pageWidth = Math.max(1, pageRect ? pageRect.width / zoom : layoutWidth)
      return {
        id: field.id,
        left: css.left,
        top: css.top,
        width: Math.max(96, field.width * pageWidth),
        pageWidth,
        scale: pdf && pageRect ? pageWidth / NOTE_TEXT_FIELD_REFERENCE_PAGE_WIDTH : 1,
        inverse: 1 / Math.max(zoom, 0.05),
      }
    })
    setLayout((current) => (
      current.length === next.length
      && current.every((item, index) => (
        item.id === next[index].id
        && item.left === next[index].left
        && item.top === next[index].top
        && item.width === next[index].width
        && item.scale === next[index].scale
        && item.inverse === next[index].inverse
      ))
        ? current
        : next
    ))
  }, [fields, pdf])

  useLayoutEffect(() => {
    measure()
    const layer = layerRef.current
    const paper = layer?.closest('.unified-paper')
    if (!paper || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(paper)
    paper.querySelectorAll('[data-pdf-page]').forEach((page) => observer.observe(page))
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  useLayoutEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    layer.querySelectorAll<HTMLTextAreaElement>('[data-note-text-field]').forEach(fitTextArea)
  }, [fields, layout])

  // A freshly placed box takes the keyboard at once, without scrolling the sheet.
  useLayoutEffect(() => {
    if (!focusId) return
    const node = layerRef.current?.querySelector<HTMLTextAreaElement>(`[data-note-text-field="${CSS.escape(focusId)}"]`)
    if (!node) return
    node.focus({ preventScroll: true })
    setSelectedId(focusId)
    onFocusHandled?.()
  }, [focusId, fields, onFocusHandled])

  // Leaving a box that stayed empty removes it again.
  useEffect(() => {
    const previous = previousSelectedRef.current
    previousSelectedRef.current = selectedId
    if (!previous || previous === selectedId) return
    const field = fieldsRef.current.find((item) => item.id === previous)
    if (field && field.text.trim() === '') onRemove(previous)
    else if (field) onFinish?.()
  }, [selectedId, onRemove, onFinish])

  // A press anywhere outside a box (page, ink, toolbar) finishes the edit.
  useEffect(() => {
    if (!selectedId) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.note-text-field, .note-text-field-toolbar')) return
      setSelectedId(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [selectedId])

  useEffect(() => {
    if (selectedId && !fields.some((field) => field.id === selectedId)) setSelectedId(null)
  }, [fields, selectedId])

  const pointAt = (clientX: number, clientY: number) => {
    const layer = layerRef.current
    if (!layer) return null
    const paper = layer.closest('.unified-paper') as HTMLElement | null
    const rects: NoteTextFieldPageRect[] = []
    const pages = pdf ? paper?.querySelectorAll<HTMLElement>('[data-pdf-page]') : null
    if (pages && pages.length) {
      pages.forEach((node) => {
        const rect = node.getBoundingClientRect()
        const page = Number(node.dataset.pdfPage)
        rects.push({ page: Number.isSafeInteger(page) && page >= 1 ? page : 1, left: rect.left, top: rect.top, width: rect.width, height: rect.height })
      })
    } else {
      const rect = (paper ?? layer).getBoundingClientRect()
      rects.push({ page: 1, left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    }
    return noteTextFieldPointFromRects(rects, clientX, clientY)
  }

  const handlePlace = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!placing || event.button > 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('.note-text-field')) return
    event.preventDefault()
    event.stopPropagation()
    const point = pointAt(event.clientX, event.clientY)
    if (point) onPlace(point)
  }

  const clampMove = (field: NoteTextField | undefined, gesture: Extract<Gesture, { kind: 'move' }>, clientX: number, clientY: number) => {
    const point = pointAt(clientX, clientY)
    if (!point) return null
    return {
      page: point.page,
      x: Math.max(0, Math.min(1 - gesture.width, point.x - gesture.dx)),
      y: Math.max(0, Math.min(0.97, point.y - gesture.dy)),
    }
  }

  const beginMove = (field: NoteTextField, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button > 0) return
    const point = pointAt(event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedId(field.id)
    gestureRef.current = { kind: 'move', id: field.id, dx: point.x - field.x, dy: point.y - field.y, width: field.width, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const beginResize = (field: NoteTextField, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button > 0) return
    const box = layout.find((item) => item.id === field.id)
    event.preventDefault()
    event.stopPropagation()
    setSelectedId(field.id)
    gestureRef.current = {
      kind: 'resize',
      id: field.id,
      startX: event.clientX,
      startWidth: field.width,
      pageWidth: box?.pageWidth ?? 1,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const applyGesture = (event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const gesture = gestureRef.current
    if (!gesture) return
    const field = fieldsRef.current.find((item) => item.id === gesture.id)
    if (!field) return
    if (gesture.kind === 'move') {
      const next = clampMove(field, gesture, event.clientX, event.clientY)
      if (!next) return
      if (next.page !== field.page || Math.abs(next.x - field.x) > 1e-4 || Math.abs(next.y - field.y) > 1e-4) {
        gesture.moved = true
        onGeometry(gesture.id, next, commit)
      } else if (commit && gesture.moved) {
        onGeometry(gesture.id, next, true)
      }
      return
    }
    const host = layerRef.current?.closest('.unified-paper') as HTMLElement | null
    const zoom = host ? readUsedSheetZoom(host) : 1
    const delta = (event.clientX - gesture.startX) / Math.max(zoom, 0.01) / gesture.pageWidth
    onGeometry(gesture.id, { width: Math.min(gesture.startWidth + delta, 0.98 - field.x) }, commit)
  }

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    applyGesture(event, true)
    const gesture = gestureRef.current
    gestureRef.current = null
    if (!gesture) return
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    layerRef.current
      ?.querySelector<HTMLTextAreaElement>(`[data-note-text-field="${CSS.escape(gesture.id)}"]`)
      ?.focus({ preventScroll: true })
  }

  const finish = (textarea: HTMLTextAreaElement) => {
    textarea.blur()
    setSelectedId(null)
  }

  const onKeyDown = (field: NoteTextField, event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const mod = event.ctrlKey || event.metaKey
    if (event.key === 'Escape' || (mod && event.key === 'Enter')) {
      event.preventDefault()
      event.stopPropagation()
      finish(event.currentTarget)
      return
    }
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
      event.preventDefault()
      event.stopPropagation()
      onStyle(field.id, { bold: field.bold ? undefined : true })
      return
    }
    // Typing must never reach tool keys, delete or undo handlers of the sheet.
    if (!mod || ['z', 'y', 'a', 'c', 'v', 'x'].includes(event.key.toLowerCase())) event.stopPropagation()
  }

  return (
    <div
      ref={layerRef}
      className={`note-text-layer ${placing ? 'is-placing' : ''}`}
      onPointerDown={placing ? handlePlace : undefined}
    >
      {fields.map((field) => {
        const position = layout.find((item) => item.id === field.id)
        const selected = selectedId === field.id
        const scale = position?.scale ?? 1
        const inverse = position?.inverse ?? 1
        const empty = field.text.trim() === ''
        const rendered = !selected && !empty
        const style = {
          left: position?.left ?? 0,
          top: position?.top ?? 0,
          width: position?.width ?? 180,
          opacity: position ? 1 : 0,
          '--tf-inv': inverse,
          '--tf-ink': field.color ?? '#20222b',
        } as CSSProperties
        return (
          <div
            key={field.id}
            className={`note-text-field ${selected ? 'is-selected' : ''} ${empty ? 'is-empty' : ''} ${rendered ? 'is-rendered' : ''}`}
            style={style}
            onFocus={(event) => {
              // Tabbing to a link or checkbox of the rendered text does not start an edit.
              if (event.target instanceof Element && event.target.closest('.note-text-field-render')) return
              setSelectedId(field.id)
            }}
            onBlur={(event) => {
              const next = event.relatedTarget
              if (next instanceof Node && !event.currentTarget.contains(next) && !composingRef.current) setSelectedId((current) => current === field.id ? null : current)
            }}
          >
            <button
              type="button"
              tabIndex={-1}
              className="note-text-field-move"
              aria-label="Textfeld verschieben"
              title="Textfeld verschieben"
              onMouseDown={(event) => event.preventDefault()}
              onPointerDown={(event) => beginMove(field, event)}
              onPointerMove={(event) => applyGesture(event, false)}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
            >
              <span aria-hidden="true" />
            </button>
            <textarea
              data-note-text-field={field.id}
              data-snapshot={empty ? undefined : 'hide'}
              value={field.text}
              rows={1}
              placeholder="Text eingeben …"
              spellCheck
              style={{
                fontSize: `${field.fontSize * scale}px`,
                minHeight: `${MIN_BOX_HEIGHT}em`,
                fontWeight: field.bold ? 700 : 400,
              }}
              onChange={(event) => {
                fitTextArea(event.currentTarget)
                onText(field.id, event.target.value)
              }}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => { composingRef.current = false }}
              onKeyDown={(event) => onKeyDown(field, event)}
              onPointerDown={(event) => event.stopPropagation()}
            />
            {!empty && (
              <div
                className="note-text-field-render"
                data-snapshot="show"
                data-i18n-ignore
                style={{
                  fontSize: `${field.fontSize * scale}px`,
                  minHeight: `${MIN_BOX_HEIGHT}em`,
                  fontWeight: field.bold ? 700 : 400,
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => startEditing(field.id)}
              >
                <NoteTextFieldMarkdown
                  text={field.text}
                  onToggleTask={(line) => toggleTask(field.id, line)}
                  onOpenLink={openLink}
                />
              </div>
            )}
            <button
              type="button"
              tabIndex={-1}
              className="note-text-field-resize"
              aria-label="Textfeldbreite ändern"
              title="Textfeldbreite ändern"
              onMouseDown={(event) => event.preventDefault()}
              onPointerDown={(event) => beginResize(field, event)}
              onPointerMove={(event) => applyGesture(event, false)}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
            >
              <span aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
