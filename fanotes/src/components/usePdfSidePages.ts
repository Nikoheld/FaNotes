import { useCallback, useEffect, useRef, useState } from 'react'
import type { DrawingLibraryDocument } from '../types'
import type { DrawingSavePayload, DrawingSaveResult } from './DrawingBoard'
import { inkJsonForRewrite } from '../lib/packedInk'
import {
  mergePdfSideInk,
  parsePdfSidePages,
  serializePdfSidePages,
  splitPdfSideInk,
  type MergedSideInk,
  type PdfSideLayout,
  type PdfSidePagesStore,
} from '../lib/pdfSidePages'

/** What PdfNoteView reports while side pages are laid out. `epoch` changes with any re-layout the ink must follow. */
export type PdfSideLayoutHandle = { path: string; epoch: string; measure: () => PdfSideLayout | null }

export type PdfSideBoard = { key: number; document: DrawingLibraryDocument | null }

const MEMORY_KEY = 'fanotes.pdfSidePages.v1'
/** Side boards get keys of their own, far from the app's drawing-session counter. */
let sideBoardKey = 1_000_000_000

const readMemory = (): Record<string, true> => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MEMORY_KEY) ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value === true)) as Record<string, true>
  } catch {
    return {}
  }
}

const writeMemory = (memory: Record<string, true>) => {
  try {
    window.localStorage.setItem(MEMORY_KEY, JSON.stringify(memory))
  } catch {
    // Without storage the toggle lasts for this window only.
  }
}

/** Side pages need the desktop bridge (the companion lives in the vault's `.fanotes/`). */
export const pdfSidePagesAvailable = () => (
  typeof window !== 'undefined'
  && window.fanotes?.platform !== 'web'
  && typeof window.fanotes?.readPdfSidePages === 'function'
  && typeof window.fanotes?.writePdfSidePages === 'function'
)

type Source = {
  path: string
  pdfDocument: DrawingLibraryDocument | null
  pdfDrawing: Record<string, unknown> | null
  store: PdfSidePagesStore | null
  fileExists: boolean
}

type Context = {
  path: string
  source: Source
  epoch: string
  merged: MergedSideInk
  layout: PdfSideLayout
  pdfDocument: DrawingLibraryDocument | null
  lastPdfFingerprint: string
  lastSideFingerprint: string
  fileExists: boolean
}

const parseDrawing = (document: DrawingLibraryDocument | null): Record<string, unknown> | null => {
  if (!document) return null
  try {
    const parsed = JSON.parse(inkJsonForRewrite(document)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * Side pages beside a PDF note: the per-note toggle, and while it is on the
 * one ink board that covers the PDF pages and the side pages. The board opens
 * a merged document (`mergePdfSideInk`) and every save is split back into the
 * PDF's own ink and the side companion (`splitPdfSideInk`).
 */
export function usePdfSidePages(options: {
  activePath: string | null
  isPdfActive: boolean
  /** The drawing session's key for the active note; a new key means the note's ink was read again. */
  sessionKey: number
  title: string
  readPdfInk: (path: string) => Promise<DrawingLibraryDocument | null>
  flushBoard: () => Promise<void>
  reloadNoteInk: (path: string) => void
  saveDrawing: (payload: DrawingSavePayload, notePath?: string | null) => Promise<DrawingSaveResult>
  onError: (message: string) => void
}) {
  const { activePath, isPdfActive, sessionKey } = options
  const available = pdfSidePagesAvailable()
  const [memory, setMemory] = useState<Record<string, true>>(() => (available ? readMemory() : {}))
  const shown = Boolean(available && isPdfActive && activePath && memory[activePath])
  const [source, setSource] = useState<Source | null>(null)
  const [layoutHandle, setLayoutHandle] = useState<PdfSideLayoutHandle | null>(null)
  const [board, setBoard] = useState<PdfSideBoard | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const contextRef = useRef<Context | null>(null)
  const layoutRef = useRef<PdfSideLayoutHandle | null>(null)
  layoutRef.current = layoutHandle
  const loadTokenRef = useRef(0)
  const boardMountedRef = useRef(false)
  boardMountedRef.current = board !== null

  /** Saves the open board, takes it down and reads the PDF ink and the side companion again. */
  const reload = useCallback(async (path: string) => {
    const token = ++loadTokenRef.current
    if (boardMountedRef.current) {
      try { await optionsRef.current.flushBoard() } catch { /* the board reports its own save errors */ }
    }
    if (token !== loadTokenRef.current) return
    contextRef.current = null
    setBoard(null)
    setSource(null)
    try {
      const [pdfDocument, text] = await Promise.all([
        optionsRef.current.readPdfInk(path),
        window.fanotes.readPdfSidePages!(path),
      ])
      if (token !== loadTokenRef.current) return
      setSource({ path, pdfDocument, pdfDrawing: parseDrawing(pdfDocument), store: parsePdfSidePages(text), fileExists: text !== null })
    } catch (error) {
      if (token !== loadTokenRef.current) return
      optionsRef.current.onError(error instanceof Error ? error.message : 'Die leeren Seiten konnten nicht geladen werden.')
    }
  }, [])

  useEffect(() => {
    if (!shown || !activePath) {
      loadTokenRef.current += 1
      contextRef.current = null
      setBoard(null)
      setSource(null)
      return
    }
    void reload(activePath)
  }, [activePath, reload, sessionKey, shown])

  // Merge once the companion is read and PdfNoteView laid the pairs out.
  useEffect(() => {
    if (!shown || !source || !layoutHandle || source.path !== activePath || layoutHandle.path !== activePath) return
    const current = contextRef.current
    if (current?.source === source) {
      // Already open: a new layout (rotation, page sizes) saves and reads again first.
      if (current.epoch !== layoutHandle.epoch) void reload(source.path)
      return
    }
    const layout = layoutHandle.measure()
    if (!layout) return
    const merged = mergePdfSideInk(source.pdfDrawing, source.store, layout, { title: `Handschrift · ${optionsRef.current.title}` })
    contextRef.current = {
      path: source.path,
      source,
      epoch: layoutHandle.epoch,
      merged,
      layout,
      pdfDocument: source.pdfDocument,
      lastPdfFingerprint: merged.pdfFingerprint,
      lastSideFingerprint: merged.sideFingerprint,
      fileExists: source.fileExists,
    }
    sideBoardKey += 1
    setBoard({
      key: sideBoardKey,
      document: {
        id: source.pdfDocument?.id ?? '',
        title: source.pdfDocument?.title ?? String(merged.drawing.title ?? ''),
        updatedAt: source.pdfDocument?.updatedAt ?? new Date().toISOString(),
        imageRelativePath: source.pdfDocument?.imageRelativePath ?? '',
        dataRelativePath: source.pdfDocument?.dataRelativePath ?? '',
        drawingJson: JSON.stringify(merged.drawing),
        packedInk: null,
      },
    })
  }, [activePath, layoutHandle, reload, shown, source])

  const onSaveDrawing = useCallback(async (payload: DrawingSavePayload, notePathOverride?: string | null): Promise<DrawingSaveResult> => {
    const context = contextRef.current
    const notePath = notePathOverride ?? optionsRef.current.activePath
    if (!context || notePath !== context.path) return optionsRef.current.saveDrawing(payload, notePathOverride)
    const drawing = JSON.parse(payload.drawingJson) as Record<string, unknown>
    const live = layoutRef.current?.path === context.path ? layoutRef.current.measure() : null
    const split = splitPdfSideInk(drawing, live ?? context.layout, context.merged, context.path)
    if (split.sideFingerprint !== context.lastSideFingerprint) {
      // No file until a side page has ink; once written, an emptied page set is written too.
      if (split.store.ink.length || context.fileExists) {
        await window.fanotes.writePdfSidePages!(context.path, serializePdfSidePages(split.store))
        context.fileExists = true
      }
      context.lastSideFingerprint = split.sideFingerprint
    }
    if (split.pdfFingerprint === context.lastPdfFingerprint) {
      return { id: context.pdfDocument?.id || payload.id || '', title: payload.title, updatedAt: new Date().toISOString(), imageRelativePath: '', dataRelativePath: '', markdown: '' }
    }
    const result = await optionsRef.current.saveDrawing({ ...payload, drawingJson: JSON.stringify(split.pdfDrawing) }, notePathOverride)
    context.lastPdfFingerprint = split.pdfFingerprint
    return result
  }, [])

  const toggle = useCallback(async () => {
    const path = optionsRef.current.activePath
    if (!available || !path || !optionsRef.current.isPdfActive) return
    try { await optionsRef.current.flushBoard() } catch { /* reported by the board */ }
    const turningOff = Boolean(memory[path])
    loadTokenRef.current += 1
    contextRef.current = null
    setBoard(null)
    setSource(null)
    setMemory((current) => {
      const next = { ...current }
      if (turningOff) delete next[path]
      else next[path] = true
      writeMemory(next)
      return next
    })
    // The plain board opens the PDF ink as the side board last saved it.
    if (turningOff) optionsRef.current.reloadNoteInk(path)
  }, [available, memory])

  const onSideLayout = useCallback((handle: PdfSideLayoutHandle | null) => {
    setLayoutHandle((current) => (current?.epoch === handle?.epoch && current?.path === handle?.path ? current : handle))
  }, [])

  /** Rotation re-lays the pages out: save and take the board down first, then read again. */
  const beforeSideRelayout = useCallback(async () => {
    const path = optionsRef.current.activePath
    if (!path) return
    await reload(path)
  }, [reload])

  return {
    available,
    shown,
    /** Null: the normal board. `key: 0`: no board until the side pages are merged. */
    board: shown ? (board ?? { key: 0, document: null }) : null,
    onSaveDrawing,
    toggle,
    onSideLayout,
    beforeSideRelayout,
  }
}
