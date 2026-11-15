import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { Camera, ClipboardPaste, FileImage, Lock, LockOpen, Redo2, Trash2, Undo2, X, Columns2 } from 'lucide-react'
import { clipboardImageFile } from '../lib/clipboardImage'
import { noteLinkPageAtPoint } from '../lib/noteLink'
import { readUsedSheetZoom } from '../lib/paperView'
import {
  STAMPS,
  createAnnotationHistory,
  formatMeasure,
  legendRows,
  measureValue,
  newAnnotationId,
  nextCalloutNumber,
  parseAnnotations,
  pushAnnotationHistory,
  redoAnnotations,
  renumberCallouts,
  stampById,
  termsFromText,
  undoAnnotations,
  type CalloutAnnotation,
  type ImageAnnotation,
  type LegendAnnotation,
  type MeasureAnnotation,
  type NoteAnnotation,
  type StampAnnotation,
  type StrokeAnnotation,
} from '../../electron/noteAnnotation.mjs'

type Tool = 'select' | 'callout' | 'stamp' | 'legend' | 'highlight' | 'angle' | 'angle2' | 'distance' | 'crop'
type Tab = 'label' | 'marks' | 'images' | 'measure'
type Frame = { left: number; top: number; w: number; h: number }
type Pending = { page: number; pts: Array<[number, number]>; cursor: [number, number] | null }
type CropBox = { page: number; x0: number; y0: number; x1: number; y1: number }

export type StudyAnnotationLayerProps = {
  path: string | null
  pdf: boolean
  open: boolean
  onClose: () => void
}

const LABEL_COLORS = ['#1d4ed8', '#dc2626', '#16a34a', '#111827']
const HIGHLIGHT_COLORS = ['#facc15', '#f97316', '#22c55e', '#38bdf8', '#e879f9']
const A4_WIDTH_CM = 21
const SAVE_DELAY_MS = 500

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = () => reject(new Error('Das Bild konnte nicht gelesen werden.'))
  image.src = src
})

/** Downscale to a data URL that fits in the note file. */
const encodeImage = (source: CanvasImageSource, width: number, height: number, png: boolean) => {
  let max = png ? 1400 : 1600
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const scale = Math.min(1, max / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Das Bild konnte nicht verarbeitet werden.')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    const url = png && attempt === 0 ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85 - attempt * 0.1)
    if (url.length <= 1_500_000) return { url, aspect: canvas.width / canvas.height }
    max *= 0.7
  }
  throw new Error('Das Bild ist zu groß.')
}

export function StudyAnnotationLayer({ path, pdf, open, onClose }: StudyAnnotationLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<NoteAnnotation[]>([])
  const itemsRef = useRef<NoteAnnotation[]>([])
  const historyRef = useRef(createAnnotationHistory())
  const [historyTick, setHistoryTick] = useState(0)
  const [frames, setFrames] = useState<Map<number, Frame>>(new Map())
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [tool, setTool] = useState<Tool>('select')
  const [tab, setTab] = useState<Tab>('label')
  const [numbered, setNumbered] = useState(false)
  const [labelColor, setLabelColor] = useState(LABEL_COLORS[0])
  const [stampId, setStampId] = useState('gain')
  const [hlColor, setHlColor] = useState(HIGHLIGHT_COLORS[0])
  const [hlWidth, setHlWidth] = useState(18)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [armedTerm, setArmedTerm] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [live, setLive] = useState<{ kind: 'stroke'; page: number; pts: Array<[number, number]> } | { kind: 'callout'; page: number; a: [number, number]; b: [number, number] } | null>(null)
  const [cropBox, setCropBox] = useState<CropBox | null>(null)
  const [compareId, setCompareId] = useState<string | null>(null)
  const [termDraft, setTermDraft] = useState('')
  const [status, setStatus] = useState('')
  const [ghost, setGhost] = useState<{ text: string; x: number; y: number } | null>(null)
  const loadedPathRef = useRef<string | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const dirtyRef = useRef(false)
  const pathRef = useRef<string | null>(null)

  // ---- persistence ---------------------------------------------------------
  const flush = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const target = loadedPathRef.current
    if (!target || !dirtyRef.current) return
    dirtyRef.current = false
    try {
      await window.fanotes.writeNoteAnnotations?.(target, itemsRef.current)
    } catch {
      dirtyRef.current = true
      setStatus('Speichern fehlgeschlagen.')
    }
  }, [])

  const queueSave = useCallback(() => {
    dirtyRef.current = true
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => { saveTimerRef.current = null; void flush() }, SAVE_DELAY_MS)
  }, [flush])

  const replace = useCallback((next: NoteAnnotation[]) => {
    itemsRef.current = next
    setItems(next)
  }, [])

  /** Commit a change: one undo step, then save. `before` is the list the step starts from. */
  const commit = useCallback((next: NoteAnnotation[], before: NoteAnnotation[] = itemsRef.current) => {
    if (next === before) return
    historyRef.current = pushAnnotationHistory(historyRef.current, before)
    setHistoryTick((tick) => tick + 1)
    replace(next)
    queueSave()
  }, [queueSave, replace])

  const undo = useCallback(() => {
    const result = undoAnnotations(historyRef.current, itemsRef.current)
    if (!result) return false
    historyRef.current = result.history
    setHistoryTick((tick) => tick + 1)
    replace(result.list)
    queueSave()
    return true
  }, [queueSave, replace])

  const redo = useCallback(() => {
    const result = redoAnnotations(historyRef.current, itemsRef.current)
    if (!result) return false
    historyRef.current = result.history
    setHistoryTick((tick) => tick + 1)
    replace(result.list)
    queueSave()
    return true
  }, [queueSave, replace])

  useEffect(() => {
    pathRef.current = path
    void flush()
    loadedPathRef.current = null
    historyRef.current = createAnnotationHistory()
    replace([])
    setSelectedId(null)
    setCompareId(null)
    setPending(null)
    setTool('select')
    if (!path || typeof window.fanotes.readNoteCompanion !== 'function') return
    let cancelled = false
    void window.fanotes.readNoteCompanion(path).then((companion) => {
      if (cancelled || pathRef.current !== path) return
      loadedPathRef.current = path
      replace(parseAnnotations(companion?.annotations))
    }).catch(() => { if (!cancelled) loadedPathRef.current = path })
    return () => { cancelled = true }
  }, [flush, path, replace])

  useEffect(() => {
    const onHide = () => { void flush() }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      void flush()
    }
  }, [flush])

  // ---- geometry ------------------------------------------------------------
  const measure = useCallback(() => {
    const layer = layerRef.current
    if (!layer) return
    const paper = layer.closest('.unified-paper') as HTMLElement | null
    const host = paper ?? layer
    const zoom = readUsedSheetZoom(host)
    const layerRect = layer.getBoundingClientRect()
    const next = new Map<number, Frame>()
    if (pdf && paper) {
      paper.querySelectorAll<HTMLElement>('[data-pdf-page]').forEach((node) => {
        const number = Number(node.dataset.pdfPage)
        if (!Number.isSafeInteger(number)) return
        const rect = node.getBoundingClientRect()
        next.set(number, { left: (rect.left - layerRect.left) / zoom, top: (rect.top - layerRect.top) / zoom, w: rect.width / zoom, h: rect.height / zoom })
      })
    } else {
      next.set(1, { left: 0, top: 0, w: host.offsetWidth, h: host.offsetHeight })
    }
    setSize({ w: host.offsetWidth, h: host.offsetHeight })
    setFrames((current) => {
      if (current.size === next.size && [...next].every(([key, value]) => {
        const old = current.get(key)
        return old && Math.abs(old.left - value.left) < 0.25 && Math.abs(old.top - value.top) < 0.25 && Math.abs(old.w - value.w) < 0.25 && Math.abs(old.h - value.h) < 0.25
      })) return current
      return next
    })
  }, [pdf])

  useLayoutEffect(() => {
    measure()
    const layer = layerRef.current
    const paper = layer?.closest('.unified-paper')
    if (!paper || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(paper)
    paper.querySelectorAll('[data-pdf-page]').forEach((node) => observer.observe(node))
    // Pages mount lazily; re-measure shortly after the viewer settles.
    const mutation = new MutationObserver(() => measure())
    mutation.observe(paper, { childList: true, subtree: false })
    const timer = window.setTimeout(measure, 400)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      mutation.disconnect()
      window.clearTimeout(timer)
      window.removeEventListener('resize', measure)
    }
  }, [measure, path, items.length])

  const pageRect = useCallback((page: number): DOMRect | null => {
    const layer = layerRef.current
    const paper = layer?.closest('.unified-paper') as HTMLElement | null
    if (!layer) return null
    const node = pdf ? paper?.querySelector<HTMLElement>(`[data-pdf-page="${page}"]`) : (paper ?? layer)
    return node?.getBoundingClientRect() ?? null
  }, [pdf])

  const fracIn = useCallback((page: number, clientX: number, clientY: number): [number, number] | null => {
    const rect = pageRect(page)
    if (!rect || rect.width < 1 || rect.height < 1) return null
    return [clamp01((clientX - rect.left) / rect.width), clamp01((clientY - rect.top) / rect.height)]
  }, [pageRect])

  const locate = useCallback((clientX: number, clientY: number) => {
    const layer = layerRef.current
    if (!layer) return null
    return noteLinkPageAtPoint(clientX, clientY, layer)
  }, [])

  const px = useCallback((page: number, x: number, y: number) => {
    const frame = frames.get(page)
    return frame ? { x: frame.left + x * frame.w, y: frame.top + y * frame.h, frame } : null
  }, [frames])

  const pageCm = useCallback((page: number) => {
    const frame = frames.get(page)
    const ratio = frame && frame.w > 0 ? frame.h / frame.w : 1.414
    return { width: A4_WIDTH_CM, height: A4_WIDTH_CM * ratio }
  }, [frames])

  const visiblePage = useCallback(() => {
    if (!pdf) return 1
    const paper = layerRef.current?.closest('.unified-paper')
    let best = 1
    let bestVisible = -1
    paper?.querySelectorAll<HTMLElement>('[data-pdf-page]').forEach((node) => {
      const rect = node.getBoundingClientRect()
      const visible = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
      if (visible > bestVisible) { bestVisible = visible; best = Number(node.dataset.pdfPage) || 1 }
    })
    return best
  }, [pdf])

  // ---- edit helpers --------------------------------------------------------
  const patchItem = useCallback(<T extends NoteAnnotation>(id: string, patch: Partial<T>, before?: NoteAnnotation[], history = true) => {
    const base = itemsRef.current
    const next = base.map((item) => (item.id === id ? { ...item, ...patch } as NoteAnnotation : item))
    if (history) commit(next, before ?? base)
    else replace(next)
  }, [commit, replace])

  const add = useCallback((item: NoteAnnotation) => {
    const [clean] = parseAnnotations([item])
    if (!clean) return null
    commit([...itemsRef.current, clean])
    return clean
  }, [commit])

  const remove = useCallback((id: string) => {
    commit(itemsRef.current.filter((item) => item.id !== id))
    setSelectedId((current) => (current === id ? null : current))
    setCompareId((current) => (current === id ? null : current))
  }, [commit])

  /** Drag helper: live updates without history, one undo step on release. */
  const beginDrag = useCallback((event: ReactPointerEvent, page: number, apply: (point: [number, number], origin: [number, number]) => Partial<NoteAnnotation>, id: string) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const origin = fracIn(page, event.clientX, event.clientY)
    if (!origin) return
    const before = itemsRef.current
    setSelectedId(id)
    let moved = false
    const move = (e: PointerEvent) => {
      const point = fracIn(page, e.clientX, e.clientY)
      if (!point) return
      moved = true
      patchItem(id, apply(point, origin), before, false)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (moved) commit(itemsRef.current, before)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [commit, fracIn, patchItem])

  // ---- adding images -------------------------------------------------------
  const addImageFromSource = useCallback(async (source: CanvasImageSource, width: number, height: number, png: boolean, title: string, at?: { page: number; x: number; y: number; w: number }) => {
    if (itemsRef.current.filter((item) => item.kind === 'image').length >= 12) {
      setStatus('Maximal 12 Bilder pro Notiz.')
      return
    }
    const { url, aspect } = encodeImage(source, width, height, png)
    const page = at?.page ?? visiblePage()
    const created = add({ kind: 'image', id: newAnnotationId(), page, x: at?.x ?? 0.06, y: at?.y ?? 0.06, w: at?.w ?? 0.4, aspect, opacity: 1, locked: false, src: url, title } as ImageAnnotation)
    if (created) { setSelectedId(created.id); setStatus('Bild eingefügt. Zum Nachzeichnen die Deckkraft senken und sperren.') }
    else setStatus('Das Bild konnte nicht gespeichert werden.')
  }, [add, visiblePage])

  const addImageFile = useCallback(async (file: File | Blob, title = '') => {
    try {
      const url = URL.createObjectURL(file)
      try {
        const image = await loadImage(url)
        await addImageFromSource(image, image.naturalWidth, image.naturalHeight, file.type === 'image/png', title || ('name' in file ? String((file as File).name).slice(0, 60) : ''))
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Das Bild konnte nicht eingefügt werden.')
    }
  }, [addImageFromSource])

  const pasteFromClipboard = useCallback(async () => {
    try {
      const entries = await navigator.clipboard.read()
      for (const entry of entries) {
        const type = entry.types.find((t) => t.startsWith('image/'))
        if (type) { await addImageFile(await entry.getType(type), 'Zwischenablage'); return }
      }
      setStatus('In der Zwischenablage ist kein Bild.')
    } catch {
      setStatus('Zugriff auf die Zwischenablage nicht möglich. Mit Strg+V einfügen.')
    }
  }, [addImageFile])

  useEffect(() => {
    if (!open) return
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      const file = clipboardImageFile(event.clipboardData)
      if (!file) return
      event.preventDefault()
      void addImageFile(file, 'Zwischenablage')
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addImageFile, open])

  const cropPdfRegion = useCallback(async (box: CropBox) => {
    const node = layerRef.current?.closest('.unified-paper')?.querySelector<HTMLElement>(`[data-pdf-page="${box.page}"]`)
    const canvases = [...(node?.querySelectorAll<HTMLCanvasElement>('.pdf-note-canvas-host > canvas') ?? [])]
    const visible = canvases.slice(0, 2).filter((c) => c.width > 0 && getComputedStyle(c).visibility !== 'hidden' && Number(getComputedStyle(c).opacity) > 0.5)
    const canvas = visible.sort((a, b) => b.width - a.width)[0] ?? canvases.find((c) => c.width > 0)
    const x = Math.min(box.x0, box.x1); const y = Math.min(box.y0, box.y1)
    const w = Math.abs(box.x1 - box.x0); const h = Math.abs(box.y1 - box.y0)
    if (!canvas || w < 0.02 || h < 0.02) { setStatus('Ausschnitt zu klein oder Seite noch nicht geladen.'); return }
    const sx = x * canvas.width; const sy = y * canvas.height; const sw = w * canvas.width; const sh = h * canvas.height
    const part = document.createElement('canvas')
    part.width = Math.max(1, Math.round(sw)); part.height = Math.max(1, Math.round(sh))
    part.getContext('2d')?.drawImage(canvas, sx, sy, sw, sh, 0, 0, part.width, part.height)
    // Place it beside the cut-out when there is room, else on the same spot's right half.
    const targetW = Math.min(0.5, Math.max(0.2, w))
    const targetX = x + w + targetW + 0.02 <= 1 ? x + w + 0.02 : Math.max(0, 1 - targetW - 0.02)
    await addImageFromSource(part, part.width, part.height, true, `Abb. S. ${box.page}`, { page: box.page, x: targetX, y, w: targetW })
  }, [addImageFromSource])

  // ---- gestures on the page -----------------------------------------------
  const finishTool = () => { setTool('select'); setPending(null); setArmedTerm(null) }

  const onLayerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === 'select' || event.button !== 0) return
    if ((event.target as HTMLElement).closest('[data-study-object]')) return
    const where = locate(event.clientX, event.clientY)
    if (!where) return
    event.preventDefault()
    event.stopPropagation()
    const page = where.page
    const start: [number, number] = [where.x, where.y]

    if (tool === 'stamp') {
      const created = add({ kind: 'stamp', id: newAnnotationId(), page, x: start[0], y: start[1], stamp: stampId, size: 26 } as StampAnnotation)
      if (created) setSelectedId(created.id)
      return
    }
    if (tool === 'legend') {
      const old = itemsRef.current.find((item) => item.kind === 'legend' && item.page === page) as LegendAnnotation | undefined
      if (old) patchItem(old.id, { x: start[0], y: start[1] })
      else add({ kind: 'legend', id: newAnnotationId(), page, x: Math.min(start[0], 0.7), y: start[1], names: {} } as LegendAnnotation)
      finishTool()
      return
    }
    if (tool === 'angle' || tool === 'angle2' || tool === 'distance') {
      const need = tool === 'angle' ? 3 : tool === 'angle2' ? 4 : 2
      const base = pending && pending.page === page ? pending.pts : []
      const pts = [...base, start]
      if (pts.length >= need) {
        const item = { kind: 'measure', id: newAnnotationId(), page, mode: tool === 'distance' ? 'distance' : 'angle', pts, color: '#dc2626' } as MeasureAnnotation
        const created = add(item)
        if (created) setSelectedId(created.id)
        setPending(null)
      } else setPending({ page, pts, cursor: start })
      return
    }

    // drag gestures
    const target = event.currentTarget
    const ptr = event.pointerId
    try { target.setPointerCapture(ptr) } catch { /* ignore */ }
    let strokePts: Array<[number, number]> = [start]
    const move = (e: PointerEvent) => {
      const point = fracIn(page, e.clientX, e.clientY)
      if (!point) return
      if (tool === 'highlight') {
        const last = strokePts[strokePts.length - 1]
        if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.002) return
        strokePts = [...strokePts, point].slice(-600)
        setLive({ kind: 'stroke', page, pts: strokePts })
      } else if (tool === 'callout') setLive({ kind: 'callout', page, a: start, b: point })
      else if (tool === 'crop') setCropBox({ page, x0: start[0], y0: start[1], x1: point[0], y1: point[1] })
    }
    const up = (e: PointerEvent) => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      const end = fracIn(page, e.clientX, e.clientY) ?? start
      setLive(null)
      if (tool === 'highlight') {
        const finalPts = strokePts.length >= 2 ? strokePts : [start, [Math.min(1, start[0] + 0.004), start[1]] as [number, number]]
        add({ kind: 'stroke', id: newAnnotationId(), page, pts: finalPts, color: hlColor, width: hlWidth, opacity: 0.4 } as StrokeAnnotation)
      } else if (tool === 'callout') {
        const dragged = Math.hypot(end[0] - start[0], end[1] - start[1]) > 0.015
        const lx = dragged ? end[0] : clamp01(start[0] + 0.1)
        const ly = dragged ? end[1] : clamp01(start[1] - 0.05)
        const created = add({
          kind: 'callout', id: newAnnotationId(), page, ax: start[0], ay: start[1], lx, ly,
          text: armedTerm ?? '', color: labelColor,
          ...(numbered ? { num: nextCalloutNumber(itemsRef.current) } : {}),
        } as CalloutAnnotation)
        if (created) {
          setSelectedId(created.id)
          if (!armedTerm) setFocusId(created.id)
        }
        setArmedTerm(null)
      } else if (tool === 'crop') {
        const box: CropBox = { page, x0: start[0], y0: start[1], x1: end[0], y1: end[1] }
        setCropBox(null)
        finishTool()
        void cropPdfRegion(box)
      }
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  const onLayerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pending) return
    const point = fracIn(pending.page, event.clientX, event.clientY)
    if (point) setPending({ ...pending, cursor: point })
  }

  // ---- word bank -----------------------------------------------------------
  const termsItem = items.find((item) => item.kind === 'terms')
  const terms = termsItem && termsItem.kind === 'terms' ? termsItem.list : []
  const setTerms = (list: string[]) => {
    const next = itemsRef.current.filter((item) => item.kind !== 'terms')
    commit(list.length ? [...next, { kind: 'terms', id: 'terms', list }] : next)
  }
  const addTerms = (raw: string) => {
    const incoming = termsFromText(raw)
    if (!incoming.length) return
    setTerms([...new Set([...terms, ...incoming])].slice(0, 80))
  }
  const takeSelection = () => {
    const selected = window.getSelection()?.toString() ?? ''
    if (!selected.trim()) { setStatus('Markiere zuerst Wörter im PDF-Text.'); return }
    addTerms(selected)
    setStatus('')
  }

  const dragTerm = (event: ReactPointerEvent<HTMLButtonElement>, term: string) => {
    if (event.button !== 0) return
    const startX = event.clientX; const startY = event.clientY
    let dragging = false
    const move = (e: PointerEvent) => {
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return
      dragging = true
      setGhost({ text: term, x: e.clientX, y: e.clientY })
    }
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setGhost(null)
      if (!dragging) { setTool('callout'); setArmedTerm(term); setStatus(`Tippe auf die Stelle, die du mit "${term}" beschriften willst.`); return }
      const el = document.elementFromPoint(e.clientX, e.clientY)
      if (!el || el.closest('.study-panel') || !el.closest('.unified-paper')) return
      const where = locate(e.clientX, e.clientY)
      if (!where) return
      const created = add({
        kind: 'callout', id: newAnnotationId(), page: where.page, ax: where.x, ay: where.y,
        lx: clamp01(where.x + 0.1), ly: clamp01(where.y - 0.05), text: term, color: labelColor,
        ...(numbered ? { num: nextCalloutNumber(itemsRef.current) } : {}),
      } as CalloutAnnotation)
      if (created) setSelectedId(created.id)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // ---- keyboard ------------------------------------------------------------
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && !event.altKey && event.key.toLowerCase() === 'z') {
        if (event.shiftKey ? redo() : undo()) { event.preventDefault(); event.stopPropagation() }
      } else if (mod && event.key.toLowerCase() === 'y') {
        if (redo()) { event.preventDefault(); event.stopPropagation() }
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault()
        remove(selectedId)
      } else if (event.key === 'Escape' && (tool !== 'select' || pending)) {
        finishTool()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, pending, redo, remove, selectedId, tool, undo])

  useEffect(() => {
    const paper = layerRef.current?.closest('.unified-paper')
    const active = open && tool !== 'select'
    paper?.classList.toggle('is-placing-study', active)
    return () => paper?.classList.remove('is-placing-study')
  }, [open, tool])

  // ---- rendering -----------------------------------------------------------
  const rows = useMemo(() => legendRows(items), [items])
  const legendNames = (legend: LegendAnnotation) => legend.names
  const images = items.filter((item): item is ImageAnnotation => item.kind === 'image')
  const compare = images.find((image) => image.id === compareId) ?? null
  const selected = items.find((item) => item.id === selectedId) ?? null
  const canUndo = historyRef.current.past.length > 0 && historyTick >= 0
  const canRedo = historyRef.current.future.length > 0 && historyTick >= 0

  const lineEl = (key: string, a: { x: number; y: number }, b: { x: number; y: number }, color: string, width = 2, extra: Record<string, unknown> = {}) => (
    <line key={key} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={width} strokeLinecap="round" {...extra} />
  )

  const drawn = items.map((item) => {
    if (item.kind === 'callout') {
      const a = px(item.page, item.ax, item.ay); const l = px(item.page, item.lx, item.ly)
      if (!a || !l) return null
      const isSel = selectedId === item.id
      return (
        <g key={item.id} data-study-object data-study-kind="callout">
          {Math.hypot(a.x - l.x, a.y - l.y) > 14 && lineEl('l', a, l, item.color, 2)}
          <circle cx={a.x} cy={a.y} r={isSel ? 6 : 4} fill={item.color} stroke="#fff" strokeWidth={1.5} style={{ pointerEvents: 'auto', cursor: 'grab' }}
            onPointerDown={(e) => beginDrag(e, item.page, (p) => ({ ax: p[0], ay: p[1] }), item.id)} data-study-anchor={item.id} />
        </g>
      )
    }
    if (item.kind === 'stroke') {
      const frame = frames.get(item.page)
      if (!frame) return null
      const pts = item.pts.map(([x, y]) => `${frame.left + x * frame.w},${frame.top + y * frame.h}`).join(' ')
      return (
        <g key={item.id} data-study-object data-study-kind="stroke">
          <polyline points={pts} fill="none" stroke={item.color} strokeOpacity={item.opacity} strokeWidth={Math.max(2, item.width * frame.w / 1000)} strokeLinecap="round" strokeLinejoin="round"
            style={{ pointerEvents: tool === 'select' ? 'stroke' : 'none', cursor: 'pointer' }} onPointerDown={(e) => { e.stopPropagation(); setSelectedId(item.id) }} />
          {selectedId === item.id && <polyline points={pts} fill="none" stroke="#2563eb" strokeWidth={1.5} strokeDasharray="5 4" style={{ pointerEvents: 'none' }} />}
        </g>
      )
    }
    if (item.kind === 'measure') {
      const pts = item.pts.map(([x, y]) => px(item.page, x, y))
      if (pts.some((p) => !p)) return null
      const real = pts as Array<{ x: number; y: number }>
      const value = measureValue(item, pageCm(item.page))
      const centre = item.mode === 'distance'
        ? { x: (real[0].x + real[1].x) / 2, y: (real[0].y + real[1].y) / 2 }
        : real.length === 3 ? real[1] : { x: real.reduce((s, p) => s + p.x, 0) / 4, y: real.reduce((s, p) => s + p.y, 0) / 4 }
      return (
        <g key={item.id} data-study-object data-study-kind="measure">
          {item.mode === 'distance' || real.length === 4
            ? <>{lineEl('a', real[0], real[1], item.color)}{real.length === 4 && lineEl('b', real[2], real[3], item.color)}</>
            : <>{lineEl('a', real[1], real[0], item.color)}{lineEl('b', real[1], real[2], item.color)}</>}
          {real.map((p, index) => (
            <circle key={index} cx={p.x} cy={p.y} r={5} fill="#fff" stroke={item.color} strokeWidth={2} style={{ pointerEvents: 'auto', cursor: 'grab' }}
              onPointerDown={(e) => beginDrag(e, item.page, (point) => ({ pts: item.pts.map((old, i) => (i === index ? point : old)) } as Partial<MeasureAnnotation>), item.id)} />
          ))}
          <g transform={`translate(${centre.x + 10},${centre.y - 12})`} style={{ pointerEvents: 'auto', cursor: 'pointer' }} onPointerDown={(e) => { e.stopPropagation(); setSelectedId(item.id) }}>
            <rect x={-4} y={-14} rx={4} width={Math.max(40, formatMeasure(item, value).length * 8 + 8)} height={20} fill="#fff" stroke={item.color} />
            <text x={0} y={0} fontSize={13} fontWeight={700} fill={item.color} data-study-measure={item.id}>{formatMeasure(item, value)}</text>
          </g>
        </g>
      )
    }
    return null
  })

  const html = items.map((item) => {
    if (item.kind === 'image') {
      const p = px(item.page, item.x, item.y)
      if (!p) return null
      const width = p.frame.w * item.w
      return (
        <div key={item.id} data-study-object data-study-kind="image" className={`study-image ${selectedId === item.id ? 'is-selected' : ''} ${item.locked ? 'is-locked' : ''}`}
          style={{ left: p.x, top: p.y, width, height: width / item.aspect, opacity: item.opacity, pointerEvents: item.locked ? 'none' : 'auto' }}
          onPointerDown={(e) => beginDrag(e, item.page, (point, origin) => ({ x: clamp01(item.x + point[0] - origin[0]), y: clamp01(item.y + point[1] - origin[1]) }), item.id)}>
          <img src={item.src} alt={item.title || 'Referenzbild'} draggable={false} />
          {!item.locked && <span className="study-image-resize" onPointerDown={(e) => beginDrag(e, item.page, (point) => ({ w: Math.min(1, Math.max(0.05, point[0] - item.x)) }), item.id)} />}
        </div>
      )
    }
    if (item.kind === 'stamp') {
      const p = px(item.page, item.x, item.y)
      const def = stampById(item.stamp)
      if (!p || !def) return null
      const fontSize = Math.max(10, item.size * p.frame.w / 800)
      return (
        <div key={item.id} data-study-object data-study-kind="stamp" data-stamp={item.stamp} className={`study-stamp ${selectedId === item.id ? 'is-selected' : ''}`}
          style={{ left: p.x, top: p.y, color: def.color, fontSize }} title={def.label}
          onPointerDown={(e) => beginDrag(e, item.page, (point) => ({ x: point[0], y: point[1] }), item.id)}>{def.glyph}</div>
      )
    }
    if (item.kind === 'callout') {
      const l = px(item.page, item.lx, item.ly)
      if (!l) return null
      const isSel = selectedId === item.id
      return (
        <div key={item.id} data-study-object data-study-kind="callout" data-callout={item.id} className={`study-label ${isSel ? 'is-selected' : ''}`}
          style={{ left: l.x, top: l.y, borderColor: item.color, color: item.color }}
          onPointerDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') beginDrag(e, item.page, (point) => ({ lx: point[0], ly: point[1] }), item.id); else setSelectedId(item.id) }}>
          {item.num && <b className="study-label-num" style={{ background: item.color }}>{item.num}</b>}
          {(!item.num || isSel) && (
            <input
              value={item.text}
              size={Math.max(4, item.text.length + 1)}
              placeholder={item.num ? 'Bedeutung' : 'Beschriftung'}
              aria-label={item.num ? `Legende ${item.num}` : 'Beschriftung'}
              autoFocus={focusId === item.id}
              onFocus={() => { setSelectedId(item.id); setFocusId(null) }}
              onChange={(e) => patchItem(item.id, { text: e.target.value.slice(0, 120) } as Partial<CalloutAnnotation>, undefined, false)}
              onBlur={() => queueSave()}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              style={{ color: item.color }}
            />
          )}
        </div>
      )
    }
    if (item.kind === 'legend') {
      const p = px(item.page, item.x, item.y)
      if (!p) return null
      const list = legendRows(items, legendNames(item))
      return (
        <div key={item.id} data-study-object data-study-kind="legend" className={`study-legend ${selectedId === item.id ? 'is-selected' : ''}`} style={{ left: p.x, top: p.y }}
          onPointerDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') beginDrag(e, item.page, (point) => ({ x: point[0], y: point[1] }), item.id) }}>
          <strong>Legende</strong>
          {list.length === 0 && <small>Noch keine Zeichen gesetzt.</small>}
          {list.map((row) => (
            <div key={row.key} className="study-legend-row">
              <span style={{ color: row.color }}>{row.glyph}</span>
              {stampById(row.key)
                ? <input value={row.label} aria-label={`Legende ${row.glyph}`} onChange={(e) => patchItem(item.id, { names: { ...item.names, [row.key]: e.target.value.slice(0, 60) } } as Partial<LegendAnnotation>, undefined, false)} onBlur={() => queueSave()} />
                : <em>{row.label || '...'}</em>}
            </div>
          ))}
        </div>
      )
    }
    return null
  })

  // live previews
  const preview: ReactElement[] = []
  if (live?.kind === 'stroke') {
    const frame = frames.get(live.page)
    if (frame) preview.push(<polyline key="live-s" points={live.pts.map(([x, y]) => `${frame.left + x * frame.w},${frame.top + y * frame.h}`).join(' ')} fill="none" stroke={hlColor} strokeOpacity={0.4} strokeWidth={Math.max(2, hlWidth * frame.w / 1000)} strokeLinecap="round" strokeLinejoin="round" />)
  }
  if (live?.kind === 'callout') {
    const a = px(live.page, live.a[0], live.a[1]); const b = px(live.page, live.b[0], live.b[1])
    if (a && b) preview.push(lineEl('live-c', a, b, labelColor, 2, { strokeDasharray: '4 4' }))
  }
  if (pending) {
    const dots = pending.pts.map(([x, y]) => px(pending.page, x, y)).filter(Boolean) as Array<{ x: number; y: number }>
    dots.forEach((d, i) => preview.push(<circle key={`pd${i}`} cx={d.x} cy={d.y} r={5} fill="#dc2626" />))
    const cursor = pending.cursor ? px(pending.page, pending.cursor[0], pending.cursor[1]) : null
    if (cursor && dots.length) {
      const anchor = tool === 'angle' && dots.length === 2 ? dots[1] : dots[dots.length - 1]
      preview.push(lineEl('pc', anchor, cursor, '#dc2626', 1.5, { strokeDasharray: '4 4' }))
      if (dots.length >= 2 && tool === 'angle') preview.push(lineEl('pc0', dots[0], dots[1], '#dc2626', 1.5, { strokeDasharray: '4 4' }))
    }
  }
  const cropRect = cropBox ? (() => {
    const a = px(cropBox.page, Math.min(cropBox.x0, cropBox.x1), Math.min(cropBox.y0, cropBox.y1))
    const b = px(cropBox.page, Math.max(cropBox.x0, cropBox.x1), Math.max(cropBox.y0, cropBox.y1))
    return a && b ? { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y } : null
  })() : null

  const toolButton = (id: Tool, label: string, hint: string) => (
    <button type="button" className={`study-tool ${tool === id ? 'is-active' : ''}`} aria-pressed={tool === id} title={hint}
      onClick={() => { setTool(tool === id ? 'select' : id); setPending(null); setArmedTerm(null) }}>{label}</button>
  )

  const mine = (tool !== 'select')
  return (
    <>
      <div ref={layerRef} className={`study-layer ${open && mine ? 'is-placing' : ''}`} data-study-layer
        onPointerDown={open ? onLayerPointerDown : undefined} onPointerMove={open ? onLayerPointerMove : undefined}
        onPointerLeave={() => pending && setPending({ ...pending, cursor: null })}>
        <div className="study-layer-inner" style={{ width: size.w, height: size.h }}>
          {html.filter((node, index) => node && items[index].kind === 'image')}
          <svg className="study-svg" width={size.w} height={size.h} aria-hidden="true">{drawn}{preview}</svg>
          {html.filter((node, index) => node && items[index].kind !== 'image')}
          {cropRect && <div className="study-crop" style={cropRect} />}
        </div>
      </div>
      {ghost && <div className="study-ghost" style={{ left: ghost.x, top: ghost.y }}>{ghost.text}</div>}
      {open && (
        <div className="study-panel" role="dialog" aria-label="Lernwerkzeuge" onPointerDown={(e) => e.stopPropagation()}>
          <div className="study-panel-head">
            <strong>Lernwerkzeuge</strong>
            <span>
              <button type="button" aria-label="Rückgängig" title="Rückgängig (Strg+Z)" disabled={!canUndo} onClick={() => undo()}><Undo2 size={14} /></button>
              <button type="button" aria-label="Wiederholen" title="Wiederholen (Strg+Y)" disabled={!canRedo} onClick={() => redo()}><Redo2 size={14} /></button>
              <button type="button" aria-label="Schließen" title="Schließen" onClick={() => { finishTool(); onClose() }}><X size={14} /></button>
            </span>
          </div>
          <div className="study-tabs" role="tablist">
            {([['label', 'Beschriften'], ['marks', 'Zeichen'], ['images', 'Bilder'], ['measure', 'Messen']] as Array<[Tab, string]>).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => { setTab(id); setStatus('') }}>{label}</button>
            ))}
          </div>
          <div className="study-body">
            {tab === 'label' && <>
              <div className="study-row">
                {toolButton('callout', 'Beschriftung setzen', 'Tippen = Zielpunkt, ziehen = Linie zum Text')}
                <label className="study-check"><input type="checkbox" checked={numbered} onChange={(e) => setNumbered(e.target.checked)} /> Nummeriert (1, 2, 3 + Legende)</label>
              </div>
              <div className="study-row">
                {LABEL_COLORS.map((c) => <button key={c} type="button" className={`study-swatch ${labelColor === c ? 'is-active' : ''}`} style={{ background: c }} aria-label={`Farbe ${c}`} onClick={() => setLabelColor(c)} />)}
                {toolButton('legend', 'Legende platzieren', 'Zeigt Zeichen und nummerierte Beschriftungen')}
                {numbered && <button type="button" className="study-tool" onClick={() => commit(renumberCallouts(itemsRef.current))}>Neu nummerieren</button>}
              </div>
              <div className="study-terms">
                <strong>Begriffe</strong>
                <small>Antippen, dann auf die Zeichnung tippen, oder auf die Zeichnung ziehen.</small>
                <div className="study-chips">
                  {terms.map((term) => (
                    <span key={term} className={`study-chip ${armedTerm === term ? 'is-active' : ''}`}>
                      <button type="button" data-study-term={term} style={{ touchAction: 'none' }} onPointerDown={(e) => dragTerm(e, term)}>{term}</button>
                      <button type="button" aria-label={`${term} entfernen`} onClick={() => setTerms(terms.filter((t) => t !== term))}>x</button>
                    </span>
                  ))}
                </div>
                <div className="study-row">
                  <input value={termDraft} placeholder="Begriffe, mit Komma getrennt" onChange={(e) => setTermDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { addTerms(termDraft); setTermDraft('') } }} />
                  <button type="button" className="study-tool" onClick={() => { addTerms(termDraft); setTermDraft('') }}>Hinzufügen</button>
                </div>
                <button type="button" className="study-tool" onMouseDown={(e) => e.preventDefault()} onClick={takeSelection}>Aus PDF-Auswahl übernehmen</button>
              </div>
            </>}
            {tab === 'marks' && <>
              <div className="study-stamps">
                {STAMPS.map((stamp) => (
                  <button key={stamp.id} type="button" data-study-stamp={stamp.id} className={`study-stamp-pick ${tool === 'stamp' && stampId === stamp.id ? 'is-active' : ''}`} style={{ color: stamp.color }} title={stamp.label}
                    onClick={() => { setStampId(stamp.id); setTool('stamp') }}>{stamp.glyph}<small>{stamp.label}</small></button>
                ))}
              </div>
              <div className="study-row">{toolButton('legend', 'Legende platzieren', 'Legende aus den gesetzten Zeichen')}</div>
              <div className="study-row">
                {toolButton('highlight', 'Ast markieren', 'Dicker, durchscheinender Stift für Äste im Stammbaum')}
                {HIGHLIGHT_COLORS.map((c) => <button key={c} type="button" className={`study-swatch ${hlColor === c ? 'is-active' : ''}`} style={{ background: c }} aria-label={`Farbe ${c}`} onClick={() => { setHlColor(c); setTool('highlight') }} />)}
              </div>
              <label className="study-slider">Dicke <input type="range" min={6} max={40} value={hlWidth} onChange={(e) => setHlWidth(Number(e.target.value))} /></label>
            </>}
            {tab === 'images' && <>
              <div className="study-row">
                <button type="button" className="study-tool" onClick={() => fileRef.current?.click()}><FileImage size={14} /> Datei</button>
                <button type="button" className="study-tool" onClick={() => void pasteFromClipboard()}><ClipboardPaste size={14} /> Einfügen</button>
                <button type="button" className="study-tool" onClick={() => cameraRef.current?.click()}><Camera size={14} /> Kamera</button>
                {pdf && toolButton('crop', 'PDF-Ausschnitt', 'Bereich einer PDF-Seite als Bild übernehmen (z. B. Abbildung)')}
              </div>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addImageFile(f) }} />
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addImageFile(f, 'Foto') }} />
              {images.length === 0 && <small>Bilder zum Nachzeichnen oder Vergleichen. Strg+V fügt ein Bild aus der Zwischenablage ein.</small>}
              {images.map((image) => (
                <div key={image.id} className={`study-image-row ${selectedId === image.id ? 'is-selected' : ''}`} data-study-image-row={image.id}>
                  <img src={image.src} alt="" onClick={() => setSelectedId(image.id)} />
                  <div>
                    <small>{image.title || 'Bild'} (S. {image.page})</small>
                    <input type="range" min={10} max={100} value={Math.round(image.opacity * 100)} aria-label="Deckkraft"
                      onChange={(e) => patchItem(image.id, { opacity: Number(e.target.value) / 100 } as Partial<ImageAnnotation>, undefined, false)} onPointerUp={() => queueSave()} onKeyUp={() => queueSave()} />
                  </div>
                  <button type="button" aria-label={image.locked ? 'Entsperren' : 'Sperren'} title={image.locked ? 'Entsperren' : 'Sperren (nicht mehr verschiebbar)'} onClick={() => patchItem(image.id, { locked: !image.locked } as Partial<ImageAnnotation>)}>{image.locked ? <Lock size={14} /> : <LockOpen size={14} />}</button>
                  <button type="button" aria-label="Vergleichsansicht" title="Neben der Seite anzeigen" className={compareId === image.id ? 'is-active' : ''} onClick={() => setCompareId(compareId === image.id ? null : image.id)}><Columns2 size={14} /></button>
                  <button type="button" aria-label="Bild entfernen" onClick={() => remove(image.id)}><Trash2 size={14} /></button>
                </div>
              ))}
            </>}
            {tab === 'measure' && <>
              <div className="study-row">
                {toolButton('angle', 'Winkel (3 Punkte)', 'Schenkel, Scheitel, Schenkel antippen')}
                {toolButton('angle2', 'Winkel zw. 2 Linien', 'Zwei Linien mit je zwei Punkten markieren')}
                {toolButton('distance', 'Strecke', 'Zwei Punkte, Angabe in cm (A4-Seitenbreite 21 cm)')}
              </div>
              <small>{tool === 'angle' ? 'Tippe: Punkt auf dem ersten Schenkel, Scheitel, Punkt auf dem zweiten Schenkel.' : tool === 'angle2' ? 'Tippe je zwei Punkte auf Linie 1 und Linie 2.' : tool === 'distance' ? 'Tippe Anfang und Ende. Die Punkte lassen sich danach verschieben.' : 'Der Messwert bleibt als Beschriftung stehen und folgt verschobenen Punkten.'}</small>
            </>}
            {status && <p className="study-status" role="status">{status}</p>}
          </div>
          <div className="study-foot">
            <span>{selected ? `Auswahl: ${selected.kind}` : `${items.filter((i) => i.kind !== 'terms').length} Objekte`}</span>
            {selected && <button type="button" className="study-tool" onClick={() => remove(selected.id)}><Trash2 size={13} /> Löschen</button>}
            {tool !== 'select' && <button type="button" className="study-tool" onClick={finishTool}>Fertig</button>}
          </div>
        </div>
      )}
      {compare && (
        <aside className="study-compare" aria-label="Vergleich">
          <header><strong>{compare.title || 'Referenz'}</strong><button type="button" aria-label="Vergleich schließen" onClick={() => setCompareId(null)}><X size={14} /></button></header>
          <img src={compare.src} alt={compare.title || 'Referenz'} />
        </aside>
      )}
    </>
  )
}
