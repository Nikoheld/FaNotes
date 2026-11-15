import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowLeft, Bold, BookOpen, ChevronDown, ChevronRight, Columns2, Eye, FilePlus2, FileText,
  Focus, Italic, LoaderCircle, MessageSquarePlus, Minus, Plus, Redo2, Replace, Search, SlidersHorizontal, Strikethrough, Subscript, Superscript, Underline, Undo2, X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import * as commands from '../editor/commands'
import { WritingController, type EditKind } from '../editor/controller'
import { blockAt, blockLength, caret, clampPos, isCollapsed, makeDoc, ordered, updateBinder, type Pos } from '../editor/doc'
import { CanvasMeasurer, loadHyphenator, loadWritingFonts, hyphenatorFor, type Hyphenator } from '../layout/measure'
import { LayoutCache, layoutManuscript } from '../layout/paginate'
import { LANGUAGE_TYPOGRAPHY } from '../model/defaults'
import { titleKey } from '../model/flow'
import { writerId } from '../model/ids'
import { marksAt, runsText } from '../model/runs'
import type { Align, BinderNode, FontFamilyId, Marks, StoryLanguage } from '../model/types'
import { loadProject, recoverJournal, storageAdapter, storyHost, storyTitleFromPath, writeJournal } from '../storage'
import { L, formatNumber, styleName } from './i18n'
import { caretBox, hitTest, lineIndex, move, type Motion } from './navigation'
import { Inspector } from './Inspector'
import { PageView, pageRects, type Highlight, type PagePointer, type PageTheme, type ViewMode } from './PageView'
import { countBlocks, countRuns, countText, htmlToParagraphs, runsToHtml, textToParagraphs } from './text'
import './writing.css'

type Props = {
  path: string
  onClose: () => void
  /** Called after each successful save (sync and search refresh). */
  onSaved?: (paths: string[]) => void
}

const FONT_CHOICES: Array<{ id: FontFamilyId; label: string }> = [
  { id: 'literata', label: 'Literata' },
  { id: 'garamond', label: 'EB Garamond' },
  { id: 'courier', label: 'Courier Prime' },
  { id: 'atkinson', label: 'Atkinson' },
]
const SIZES = [8, 9, 10, 10.5, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40]
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const COLORS = ['#1f2937', '#7f1d1d', '#9a3412', '#166534', '#1e3a8a', '#6b21a8', '#6b7280']
const HIGHLIGHTS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa']
const LANGUAGES: Array<{ id: StoryLanguage; label: string }> = [
  { id: 'de', label: 'Deutsch' },
  { id: 'de-CH', label: 'Deutsch (Schweiz)' },
  { id: 'en-US', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
]

type FindState = { open: boolean; replace: boolean; query: string; replacement: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean; current: number }

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

export function WritingMode({ path, onClose, onSaved }: Props) {
  const host = useMemo(() => storyHost(), [])
  const [controller, setController] = useState<WritingController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fontsReady, setFontsReady] = useState(false)
  const [hyphenators, setHyphenators] = useState<Partial<Record<StoryLanguage, Hyphenator | null>>>({})
  const [zoom, setZoom] = useState(() => Number(localStorage.getItem('fanotes.writing.zoom')) || 1)
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem('fanotes.writing.view') as ViewMode) || 'page')
  const [theme, setTheme] = useState<PageTheme>(() => (localStorage.getItem('fanotes.writing.theme') as PageTheme) || 'paper')
  const [focusMode, setFocusMode] = useState(false)
  const [binderOpen, setBinderOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [find, setFind] = useState<FindState>({ open: false, replace: false, query: '', replacement: '', caseSensitive: false, wholeWord: false, regex: false, current: 0 })
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [caretOn, setCaretOn] = useState(true)
  const [focused, setFocused] = useState(false)
  const scroller = useRef<HTMLDivElement | null>(null)
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const measurer = useMemo(() => (typeof document !== 'undefined' ? new CanvasMeasurer() : null), [])
  const cache = useMemo(() => new LayoutCache(), [])
  const goalX = useRef<number | null>(null)
  const dragging = useRef<{ anchor: Pos; unit: 'char' | 'word' | 'paragraph' } | null>(null)
  const composing = useRef<{ start: Pos; length: number } | null>(null)

  // ── Load ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        if (!host) throw new Error(L('Geschichten werden in dieser Version nicht unterstützt.', 'Stories are not supported in this version.'))
        const [project] = await Promise.all([
          loadProject(host, path, { recovered: L('Gefundene Szene', 'Recovered scene') }),
          loadWritingFonts().then(() => { if (alive) { measurer && (measurer as CanvasMeasurer).reset(); setFontsReady(true) } }),
        ])
        if (!alive) return
        const recovery = recoverJournal(path, project)
        const doc = makeDoc(recovery.manifest, recovery.scenes)
        const saved = (() => { try { return JSON.parse(localStorage.getItem(`fanotes.writing.caret:${path}`) ?? 'null') as Pos | null } catch { return null } })()
        const next = new WritingController(makeDoc(project.manifest, project.scenes), writerId(), saved ? caret(saved) : undefined)
        if (recovery.recovered || project.manifestChanged || recovery.manifest !== project.manifest) next.replaceDoc(doc, false)
        setController(next)
        if (recovery.recovered) setNotice(L(`${recovery.recovered} Szene(n) mit ungesicherten Änderungen aus der letzten Sitzung wiederhergestellt.`, `Restored unsaved changes in ${recovery.recovered} scene(s) from the last session.`))
        if (project.missing.length) setNotice(L(`${project.missing.length} Szene(n) sind noch nicht auf diesem Gerät (Sync läuft?). Sie werden nicht verändert.`, `${project.missing.length} scene(s) are not on this device yet (still syncing?). They are left untouched.`))
        const languages = new Set<StoryLanguage>([project.manifest.language])
        await Promise.all([...languages].map((language) => loadHyphenator(language).catch(() => null)))
        if (alive) setHyphenators(Object.fromEntries([...languages].map((language) => [language, hyphenatorFor(language)])))
      } catch (loadError) {
        if (alive) setError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    })()
    return () => { alive = false }
  }, [host, path, measurer])

  const subscribe = useCallback((listener: () => void) => controller?.subscribe(listener) ?? (() => undefined), [controller])
  const state = useSyncExternalStore(subscribe, () => controller?.state ?? null)
  const doc = state?.doc ?? null

  // ── Layout ─────────────────────────────────────────────────────────────
  const layout = useMemo(() => {
    if (!doc || !measurer || !fontsReady) return null
    const footnotes = new Map<string, { runs: import('../model/types').Run[] }>()
    for (const scene of doc.scenes.values()) for (const [id, note] of Object.entries(scene.footnotes ?? {})) footnotes.set(id, note)
    return layoutManuscript(doc.manifest, doc.flow, cache, { measurer, hyphenators, footnoteRuns: (id) => footnotes.get(id)?.runs ?? null })
  }, [doc, measurer, fontsReady, cache, hyphenators])
  const lines = useMemo(() => (layout ? lineIndex(layout) : null), [layout])
  useEffect(() => {
    if (layout) (window as unknown as { __fanotesWriting?: unknown }).__fanotesWriting = { stats: layout.stats, pages: layout.pages.length }
  }, [layout])

  // ── Autosave and journal ───────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!controller || !host) return true
    setSaveState('saving')
    const dirty = controller.dirtyScenes().map((scene) => `${path}/scenes/${scene.id}.json`)
    const ok = await controller.save(storageAdapter(host, path))
    setSaveState(ok ? 'saved' : 'error')
    if (ok) {
      writeJournal(path, null)
      onSaved?.([...dirty, `${path}/story.json`])
    }
    return ok
  }, [controller, host, path, onSaved])
  const version = controller?.version ?? 0
  useEffect(() => {
    if (!controller || !controller.isDirty()) return
    setSaveState('saving')
    const journal = window.setTimeout(() => writeJournal(path, controller.journal()), 250)
    const timer = window.setTimeout(() => { void save() }, 700)
    return () => { window.clearTimeout(timer); window.clearTimeout(journal) }
  }, [controller, version, save, path])
  useEffect(() => {
    if (!controller) return
    const flush = () => { if (controller.isDirty()) { writeJournal(path, controller.journal()); void save() } }
    window.addEventListener('blur', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('blur', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [controller, path, save])
  const close = useCallback(async () => {
    if (controller) {
      try { localStorage.setItem(`fanotes.writing.caret:${path}`, JSON.stringify(controller.state.selection.head)) } catch { /* ignore */ }
      if (!(await save())) {
        setNotice(L('Speichern fehlgeschlagen. Die Änderungen bleiben in diesem Fenster und im Notfallspeicher.', 'Saving failed. Your changes stay in this window and in the recovery journal.'))
        return
      }
    }
    onClose()
  }, [controller, onClose, path, save])

  // ── Persisted view settings ────────────────────────────────────────────
  useEffect(() => { try { localStorage.setItem('fanotes.writing.zoom', String(zoom)); localStorage.setItem('fanotes.writing.view', view); localStorage.setItem('fanotes.writing.theme', theme) } catch { /* ignore */ } }, [zoom, view, theme])

  // ── Caret blink and visibility ─────────────────────────────────────────
  useEffect(() => {
    setCaretOn(true)
    const timer = window.setInterval(() => setCaretOn((value) => !value), 530)
    return () => window.clearInterval(timer)
  }, [state?.selection])

  const caretGeometry = useMemo(() => (layout && lines && state && measurer ? caretBox(layout, lines, state.selection.head, measurer) : null), [layout, lines, state, measurer])

  const scrollCaretIntoView = useCallback(() => {
    const element = scroller.current
    if (!element || !layout || !caretGeometry) return
    const rect = pageRects(layout, zoom, view, element.clientWidth).rects[caretGeometry.page]
    if (!rect) return
    const top = rect.top + caretGeometry.y * zoom
    const bottom = top + caretGeometry.height * zoom
    const margin = 60
    if (top < element.scrollTop + margin) element.scrollTop = Math.max(0, top - margin)
    else if (bottom > element.scrollTop + element.clientHeight - margin) element.scrollTop = bottom - element.clientHeight + margin
    // Keep the hidden input at the caret so the IME window opens next to it.
    if (input.current) {
      input.current.style.left = `${rect.left + caretGeometry.x * zoom}px`
      input.current.style.top = `${top}px`
    }
  }, [layout, caretGeometry, zoom, view])
  useEffect(() => { scrollCaretIntoView() }, [scrollCaretIntoView])

  // ── Applying commands ──────────────────────────────────────────────────
  const run = useCallback((next: commands.Result, kind: EditKind = 'other', typed?: string) => {
    if (!controller) return false
    goalX.current = null
    return controller.apply(next, kind, typed)
  }, [controller])

  const titles = () => {
    const scenes = doc ? [...doc.scenes.keys()].length : 0
    const chapters = doc ? doc.manifest.binder.filter((node) => node.kind === 'chapter').length : 0
    return { scene: L(`Szene ${scenes + 1}`, `Scene ${scenes + 1}`), chapter: L(`Kapitel ${chapters + 1}`, `Chapter ${chapters + 1}`) }
  }

  const insertTyped = useCallback((text: string) => {
    if (!controller) return
    run(commands.insertText(controller.state, text), 'typing', text)
  }, [controller, run])

  const moveCaret = (motion: Motion, extend: boolean) => {
    if (!controller || !layout || !measurer) return
    const current = controller.state.selection
    let head = current.head
    if (!extend && !isCollapsed(current) && (motion === 'left' || motion === 'right')) {
      const range = ordered(controller.state.doc, current)
      controller.select(caret(motion === 'left' ? range.from : range.to))
      return
    }
    const result = move(controller.state.doc, layout, head, motion, measurer, motion === 'up' || motion === 'down' || motion === 'pageUp' || motion === 'pageDown' ? goalX.current : null)
    head = result.pos
    goalX.current = result.goalX
    controller.select(extend ? { anchor: current.anchor, head } : caret(head))
  }

  // ── Keyboard ───────────────────────────────────────────────────────────
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!controller) return
    if (event.nativeEvent.isComposing || composing.current) return
    const mod = event.ctrlKey || event.metaKey
    const key = event.key
    const st = controller.state
    const handled = (() => {
      if (mod && !event.altKey) {
        const lower = key.toLowerCase()
        if (lower === 'z' && !event.shiftKey) return controller.undo(), true
        if ((lower === 'y') || (lower === 'z' && event.shiftKey)) return controller.redo(), true
        if (lower === 'b') return run(commands.toggleMark(st, 'b'), 'format'), true
        if (lower === 'i') return run(commands.toggleMark(st, 'i'), 'format'), true
        if (lower === 'u') return run(commands.toggleMark(st, 'u'), 'format'), true
        if (lower === 'k' && event.shiftKey) return run(commands.toggleMark(st, 'sc'), 'format'), true
        if (key === '+' || (key === '=' && event.shiftKey)) return run(commands.toggleMark(st, 'sup'), 'format'), true
        if (key === '=' || key === '#') return run(commands.toggleMark(st, 'sub'), 'format'), true
        if (key === ' ') return run(commands.clearFormatting(st), 'format'), true
        if (lower === 'l') return run(commands.setAlign(st, 'left'), 'format'), true
        if (lower === 'e') return run(commands.setAlign(st, 'center'), 'format'), true
        if (lower === 'r') return run(commands.setAlign(st, 'right'), 'format'), true
        if (lower === 'j') return run(commands.setAlign(st, 'justify'), 'format'), true
        if (lower === 'n' && event.shiftKey) return run(commands.setParagraphStyle(st, 'body'), 'format'), true
        if (lower === 'a') return run(commands.selectAll(st)), true
        if (lower === 'f') return setFind((value) => ({ ...value, open: true, replace: false })), true
        if (lower === 'h') return setFind((value) => ({ ...value, open: true, replace: true })), true
        if (lower === 's') return void save(), true
        if (key === 'Enter' && event.shiftKey) return run(commands.splitScene(st, { titles: titles() }), 'structure'), true
        if (key === 'Enter') return run(commands.insertPageBreak(st), 'structure'), true
        if (key === 'Backspace') return run(commands.deleteBackward(st, 'word'), 'delete'), true
        if (key === 'Delete') return run(commands.deleteForward(st, 'word'), 'delete'), true
        if (key === 'ArrowLeft') return moveCaret('wordLeft', event.shiftKey), true
        if (key === 'ArrowRight') return moveCaret('wordRight', event.shiftKey), true
        if (key === 'ArrowUp') return moveCaret('paragraphUp', event.shiftKey), true
        if (key === 'ArrowDown') return moveCaret('paragraphDown', event.shiftKey), true
        if (key === 'Home') return moveCaret('docStart', event.shiftKey), true
        if (key === 'End') return moveCaret('docEnd', event.shiftKey), true
        return false
      }
      if (mod && event.altKey) {
        if (key === '1') return run(commands.setParagraphStyle(st, 'chapter'), 'format'), true
        if (key === '2') return run(commands.setParagraphStyle(st, 'heading'), 'format'), true
        if (key === '3') return run(commands.setParagraphStyle(st, 'subheading'), 'format'), true
        if (key === 'Enter') return run(commands.splitScene(st, { chapter: true, titles: titles() }), 'structure'), true
        if (key.toLowerCase() === 'f') return addFootnote(), true
        if (key.toLowerCase() === 'm') return addComment(), true
        return false
      }
      switch (key) {
        case 'ArrowLeft': moveCaret('left', event.shiftKey); return true
        case 'ArrowRight': moveCaret('right', event.shiftKey); return true
        case 'ArrowUp': moveCaret('up', event.shiftKey); return true
        case 'ArrowDown': moveCaret('down', event.shiftKey); return true
        case 'Home': moveCaret('lineStart', event.shiftKey); return true
        case 'End': moveCaret('lineEnd', event.shiftKey); return true
        case 'PageUp': moveCaret('pageUp', event.shiftKey); return true
        case 'PageDown': moveCaret('pageDown', event.shiftKey); return true
        case 'Backspace': run(commands.deleteBackward(st), 'delete'); return true
        case 'Delete': run(commands.deleteForward(st), 'delete'); return true
        case 'Enter': run(event.shiftKey ? commands.insertLineBreak(st) : commands.splitParagraph(st), 'structure'); return true
        case 'Tab': return true
        case 'Escape':
          if (find.open) { setFind((value) => ({ ...value, open: false })); return true }
          if (focusMode) { setFocusMode(false); return true }
          return false
        case 'F11': setFocusMode((value) => !value); return true
        default: return false
      }
    })()
    if (handled) event.preventDefault()
  }

  const onBeforeInput = (event: InputEvent) => {
    if (!controller) return
    const type = event.inputType
    if (type === 'insertCompositionText') return
    const st = controller.state
    if (type === 'insertText' || type === 'insertReplacementText') {
      event.preventDefault()
      const data = event.data ?? event.dataTransfer?.getData('text/plain') ?? ''
      if (data) insertTyped(data)
      return
    }
    if (type === 'insertParagraph') { event.preventDefault(); run(commands.splitParagraph(st), 'structure'); return }
    if (type === 'insertLineBreak') { event.preventDefault(); run(commands.insertLineBreak(st), 'structure'); return }
    if (type === 'deleteContentBackward') { event.preventDefault(); run(commands.deleteBackward(st), 'delete'); return }
    if (type === 'deleteContentForward') { event.preventDefault(); run(commands.deleteForward(st), 'delete'); return }
    if (type === 'deleteWordBackward') { event.preventDefault(); run(commands.deleteBackward(st, 'word'), 'delete'); return }
    if (type === 'deleteWordForward') { event.preventDefault(); run(commands.deleteForward(st, 'word'), 'delete'); return }
    if (type === 'historyUndo') { event.preventDefault(); controller.undo(); return }
    if (type === 'historyRedo') { event.preventDefault(); controller.redo(); return }
    if (type === 'formatBold') { event.preventDefault(); run(commands.toggleMark(st, 'b'), 'format'); return }
    if (type === 'formatItalic') { event.preventDefault(); run(commands.toggleMark(st, 'i'), 'format'); return }
    if (type === 'formatUnderline') { event.preventDefault(); run(commands.toggleMark(st, 'u'), 'format'); return }
    if (type.startsWith('insertFrom')) return
    if (type.startsWith('delete') || type.startsWith('insert')) event.preventDefault()
  }

  useEffect(() => {
    const element = input.current
    if (!element) return
    const handler = (event: Event) => onBeforeInput(event as InputEvent)
    element.addEventListener('beforeinput', handler)
    return () => element.removeEventListener('beforeinput', handler)
  })

  // IME composition: the composed text is live in the document and replaced as it changes.
  const onCompositionStart = () => {
    if (!controller) return
    let st = controller.state
    if (!isCollapsed(st.selection)) {
      st = commands.deleteSelection(st) ?? st
      controller.apply(st, 'delete')
    }
    composing.current = { start: controller.state.selection.head, length: 0 }
  }
  const replaceComposition = (data: string, kind: EditKind) => {
    if (!controller || !composing.current) return
    const { start, length } = composing.current
    let st = { ...controller.state, selection: { anchor: start, head: { block: start.block, offset: start.offset + length } } }
    st = (length ? commands.deleteSelection(st) : st) ?? st
    const next = data ? commands.insertText(st, data) : st
    controller.apply(next, kind, data)
    composing.current = { start, length: data.length }
  }
  const onCompositionUpdate = (event: React.CompositionEvent<HTMLTextAreaElement>) => replaceComposition(event.data, 'typing')
  const onCompositionEnd = (event: React.CompositionEvent<HTMLTextAreaElement>) => {
    replaceComposition(event.data, 'typing')
    composing.current = null
    if (input.current) input.current.value = ''
  }

  // Clipboard.
  const onCopy = (event: React.ClipboardEvent, cut = false) => {
    if (!controller || isCollapsed(controller.state.selection)) return
    event.preventDefault()
    const paragraphs = commands.selectedRuns(controller.state)
    event.clipboardData.setData('text/plain', paragraphs.map((paragraph) => runsText(paragraph.runs)).join('\n'))
    event.clipboardData.setData('text/html', runsToHtml(paragraphs))
    if (cut) run(commands.deleteSelection(controller.state), 'delete')
  }
  const onPaste = (event: React.ClipboardEvent) => {
    if (!controller) return
    event.preventDefault()
    const html = event.clipboardData.getData('text/html')
    const text = event.clipboardData.getData('text/plain')
    const paragraphs = html ? htmlToParagraphs(html) : textToParagraphs(text)
    if (!paragraphs.length) return
    run(commands.insertRunsAt(controller.state, paragraphs), 'paste')
  }

  // ── Pointer ────────────────────────────────────────────────────────────
  const onPointerDown = (pointer: PagePointer) => {
    if (!controller || !layout || !measurer || pointer.button !== 0) return
    const pos = hitTest(layout, pointer.page, pointer.x, pointer.y, measurer)
    input.current?.focus({ preventScroll: true })
    if (!pos) return
    goalX.current = null
    const block = blockAt(controller.state.doc, pos.block)
    if (pointer.detail >= 3 && block) {
      controller.select({ anchor: { block: block.key, offset: 0 }, head: { block: block.key, offset: blockLength(block) } })
      dragging.current = { anchor: { block: block.key, offset: 0 }, unit: 'paragraph' }
      return
    }
    if (pointer.detail === 2 && block) {
      const [from, to] = commands.wordAt(runsText(block.runs), pos.offset)
      controller.select({ anchor: { block: block.key, offset: from }, head: { block: block.key, offset: to } })
      dragging.current = { anchor: { block: block.key, offset: from }, unit: 'word' }
      return
    }
    const anchor = pointer.shift ? controller.state.selection.anchor : pos
    controller.select({ anchor, head: pos })
    dragging.current = { anchor, unit: 'char' }
  }
  const onPointerMove = (pointer: PagePointer) => {
    if (!controller || !layout || !measurer || !dragging.current) return
    const pos = hitTest(layout, pointer.page, pointer.x, pointer.y, measurer)
    if (pos) controller.select({ anchor: dragging.current.anchor, head: pos })
  }
  const onPointerUp = () => { dragging.current = null }

  // ── Footnotes and comments ─────────────────────────────────────────────
  const addFootnote = () => {
    if (!controller) return
    const text = window.prompt(L('Text der Fussnote', 'Footnote text'), '')
    if (text === null) return
    const result = commands.insertFootnote(controller.state, text)
    if (result) run(result.state, 'structure')
  }
  const addComment = () => {
    if (!controller || isCollapsed(controller.state.selection)) {
      setNotice(L('Markiere zuerst den Text, zu dem der Kommentar gehört.', 'Select the text the comment is about first.'))
      return
    }
    const text = window.prompt(L('Kommentar', 'Comment'), '')
    if (!text) return
    const result = commands.addComment(controller.state, L('Ich', 'Me'), text)
    if (result) run(result.state, 'format')
  }

  // ── Find & replace ─────────────────────────────────────────────────────
  const matches = useMemo<Highlight[]>(() => {
    if (!doc || !find.open || !find.query) return []
    let pattern: RegExp
    try {
      const source = find.regex ? find.query : escapeRegExp(find.query)
      pattern = new RegExp(find.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source, `gu${find.caseSensitive ? '' : 'i'}`)
    } catch {
      return []
    }
    const out: Highlight[] = []
    for (const block of doc.flow) {
      if (!block.editable) continue
      const text = runsText(block.runs)
      pattern.lastIndex = 0
      for (let match = pattern.exec(text); match && out.length < 5000; match = pattern.exec(text)) {
        if (match[0].length === 0) { pattern.lastIndex += 1; continue }
        out.push({ block: block.key, from: match.index, to: match.index + match[0].length })
      }
    }
    return out
  }, [doc, find.open, find.query, find.regex, find.wholeWord, find.caseSensitive])
  const currentMatch = matches.length ? Math.min(find.current, matches.length - 1) : -1
  const highlights = useMemo(() => matches.map((match, index) => (index === currentMatch ? { ...match, current: true } : match)), [matches, currentMatch])
  const goToMatch = (index: number) => {
    if (!controller || !matches.length) return
    const wrapped = (index + matches.length) % matches.length
    const match = matches[wrapped]
    setFind((value) => ({ ...value, current: wrapped }))
    controller.select({ anchor: { block: match.block, offset: match.from }, head: { block: match.block, offset: match.to } })
  }
  const replacementFor = (match: Highlight) => {
    if (!find.regex || !doc) return find.replacement
    const block = blockAt(doc, match.block)
    const text = block ? runsText(block.runs).slice(match.from, match.to) : ''
    try {
      return text.replace(new RegExp(find.query, `u${find.caseSensitive ? '' : 'i'}`), find.replacement)
    } catch {
      return find.replacement
    }
  }
  const replaceOne = () => {
    if (!controller || currentMatch < 0) return
    const match = matches[currentMatch]
    const st = { ...controller.state, selection: { anchor: { block: match.block, offset: match.from }, head: { block: match.block, offset: match.to } } }
    run(commands.insertText(st, replacementFor(match)) ?? commands.deleteSelection(st), 'paste')
  }
  const replaceAll = () => {
    if (!controller || !matches.length) return
    let st = controller.state
    // From the end, so earlier offsets stay valid.
    for (const match of [...matches].reverse()) {
      const selected = { ...st, selection: { anchor: { block: match.block, offset: match.from }, head: { block: match.block, offset: match.to } } }
      const replacement = replacementFor(match)
      st = (replacement ? commands.insertText(selected, replacement) : commands.deleteSelection(selected)) ?? st
    }
    run(st, 'paste')
    setNotice(L(`${matches.length} Stellen ersetzt.`, `Replaced ${matches.length} occurrences.`))
  }

  // ── Derived values for the chrome ──────────────────────────────────────
  const selection = state?.selection ?? null
  const range = doc && selection && !isCollapsed(selection) ? ordered(doc, selection) : null
  const headBlock = doc && selection ? blockAt(doc, selection.head.block) : undefined
  const marks: Marks = (state?.storedMarks ?? (headBlock ? marksAt(headBlock.runs, selection!.head.offset) : undefined)) ?? {}
  const counts = useMemo(() => (doc ? countBlocks(doc.flow) : { words: 0, chars: 0, charsNoSpaces: 0, paragraphs: 0 }), [doc])
  // Words per scene for the binder; counts are cached per paragraph, so this is cheap per keystroke.
  const sceneWords = useMemo(() => {
    const out = new Map<string, number>()
    if (!doc) return out
    for (const scene of doc.scenes.values()) out.set(scene.id, scene.paragraphs.reduce((sum, paragraph) => sum + (paragraph.deleted ? 0 : countRuns(paragraph.runs).words), 0))
    return out
  }, [doc])
  const selectionCounts = useMemo(() => (state && range ? countText(commands.selectedText(state)) : null), [state, range])
  const language = doc?.manifest.language ?? 'de'
  const minutes = Math.max(1, Math.round(counts.words / LANGUAGE_TYPOGRAPHY[language].wpm))
  const pageNumber = caretGeometry && layout ? layout.pages[caretGeometry.page]?.number ?? '1' : '1'

  const setStyle = (style: string) => run(controller ? commands.setParagraphStyle(controller.state, style) : null, 'format')
  const setMarkValue = (patch: Parameters<typeof commands.setMark>[1]) => run(controller ? commands.setMark(controller.state, patch) : null, 'format')
  const setAlignment = (align: Align) => run(controller ? commands.setAlign(controller.state, align) : null, 'format')
  const refocus = () => window.requestAnimationFrame(() => input.current?.focus({ preventScroll: true }))

  const goToBlock = (key: string) => {
    if (!controller) return
    const pos = clampPos(controller.state.doc, { block: key, offset: 0 })
    controller.select(caret(pos))
    refocus()
  }
  const renameNode = (id: string, title: string) => {
    if (!controller) return
    controller.replaceDoc(updateBinder(controller.state.doc, (node) => (node.id === id ? { ...node, title } : node)))
  }
  const addChapter = () => {
    if (!controller) return
    const st = controller.state
    const end = [...st.doc.flow].reverse().find((block) => block.ref.kind === 'para')
    if (!end) return
    run(commands.splitScene({ ...st, selection: caret({ block: end.key, offset: blockLength(end) }) }, { chapter: true, titles: titles() }), 'structure')
    refocus()
  }
  const addScene = () => {
    if (!controller) return
    const st = controller.state
    const head = blockAt(st.doc, st.selection.head.block)
    const sceneId = head?.sceneId
    const last = sceneId ? [...st.doc.flow].reverse().find((block) => block.sceneId === sceneId && block.ref.kind === 'para') : undefined
    if (!last) return
    run(commands.splitScene({ ...st, selection: caret({ block: last.key, offset: blockLength(last) }) }, { titles: titles() }), 'structure')
    refocus()
  }

  if (error) {
    return (
      <div className="wm-root">
        <div className="wm-error"><p>{error}</p><button type="button" className="secondary-button" onClick={onClose}><ArrowLeft size={14} /> {L('Zurück', 'Back')}</button></div>
      </div>
    )
  }
  if (!controller || !doc || !layout || !state) {
    return <div className="wm-root"><div className="wm-loading"><LoaderCircle className="spin" size={20} /> {L('Geschichte wird geöffnet …', 'Opening story …')}</div></div>
  }

  const styleIds = Object.keys(doc.manifest.styles)
  const currentStyle = headBlock?.style ?? 'body'

  return (
    <div className={`wm-root${focusMode ? ' is-focus' : ''}`}>
      <header className="wm-toolbar" onMouseDown={(event) => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() }}>
        <button type="button" className="wm-icon" title={L('Zurück zu den Notizen', 'Back to notes')} onClick={() => void close()}><ArrowLeft size={16} /></button>
        <button type="button" className={`wm-icon${binderOpen ? ' is-on' : ''}`} title={L('Gliederung', 'Binder')} onClick={() => setBinderOpen((value) => !value)}><BookOpen size={16} /></button>
        <strong className="wm-title" data-i18n-ignore>{doc.manifest.title || storyTitleFromPath(path)}</strong>
        <span className="wm-sep" />
        <button type="button" className="wm-icon" title={L('Rückgängig (Strg+Z)', 'Undo (Ctrl+Z)')} disabled={!controller.canUndo()} onClick={() => { controller.undo(); refocus() }}><Undo2 size={16} /></button>
        <button type="button" className="wm-icon" title={L('Wiederholen (Strg+Y)', 'Redo (Ctrl+Y)')} disabled={!controller.canRedo()} onClick={() => { controller.redo(); refocus() }}><Redo2 size={16} /></button>
        <span className="wm-sep" />
        <select className="wm-select wm-style" value={currentStyle} title={L('Absatzformat', 'Paragraph style')} onChange={(event) => { setStyle(event.target.value); refocus() }}>
          {styleIds.map((id) => <option key={id} value={id}>{styleName(doc.manifest.styles[id])}</option>)}
        </select>
        <select className="wm-select" value={marks.font ?? doc.manifest.styles[currentStyle]?.font ?? 'literata'} title={L('Schrift', 'Font')} onChange={(event) => { setMarkValue({ font: event.target.value as FontFamilyId }); refocus() }}>
          {FONT_CHOICES.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}
        </select>
        <select className="wm-select wm-size" value={String(marks.size ?? doc.manifest.styles[currentStyle]?.size ?? 11)} title={L('Schriftgrösse', 'Font size')} onChange={(event) => { setMarkValue({ size: Number(event.target.value) }); refocus() }}>
          {[...new Set([...SIZES, marks.size ?? doc.manifest.styles[currentStyle]?.size ?? 11])].sort((a, b) => a - b).map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
        <span className="wm-sep" />
        {([['b', Bold, L('Fett (Strg+B)', 'Bold (Ctrl+B)')], ['i', Italic, L('Kursiv (Strg+I)', 'Italic (Ctrl+I)')], ['u', Underline, L('Unterstrichen (Strg+U)', 'Underline (Ctrl+U)')], ['s', Strikethrough, L('Durchgestrichen', 'Strikethrough')], ['sup', Superscript, L('Hochgestellt', 'Superscript')], ['sub', Subscript, L('Tiefgestellt', 'Subscript')]] as const).map(([key, Icon, label]) => (
          <button key={key} type="button" className={`wm-icon${marks[key] ? ' is-on' : ''}`} title={label} aria-pressed={Boolean(marks[key])} onClick={() => { run(commands.toggleMark(controller.state, key), 'format'); refocus() }}><Icon size={16} /></button>
        ))}
        <button type="button" className={`wm-icon wm-text-icon${marks.sc ? ' is-on' : ''}`} title={L('Kapitälchen (Strg+Umschalt+K)', 'Small caps (Ctrl+Shift+K)')} onClick={() => { run(commands.toggleMark(controller.state, 'sc'), 'format'); refocus() }}>Kᴀᴘ</button>
        <details className="wm-menu">
          <summary className="wm-icon" title={L('Farbe und Markierung', 'Colour and highlight')}><span className="wm-color-dot" style={{ background: marks.color ?? 'currentColor' }} /><ChevronDown size={12} /></summary>
          <div className="wm-popover">
            <small>{L('Schriftfarbe', 'Text colour')}</small>
            <div className="wm-swatches">{COLORS.map((color) => <button key={color} type="button" style={{ background: color }} aria-label={color} onClick={() => { setMarkValue({ color }); refocus() }} />)}<button type="button" className="wm-swatch-clear" onClick={() => { setMarkValue({ color: null }); refocus() }}><X size={12} /></button></div>
            <small>{L('Markierung', 'Highlight')}</small>
            <div className="wm-swatches">{HIGHLIGHTS.map((color) => <button key={color} type="button" style={{ background: color }} aria-label={color} onClick={() => { setMarkValue({ hl: color }); refocus() }} />)}<button type="button" className="wm-swatch-clear" onClick={() => { setMarkValue({ hl: null }); refocus() }}><X size={12} /></button></div>
          </div>
        </details>
        <span className="wm-sep" />
        {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight], ['justify', AlignJustify]] as const).map(([align, Icon]) => (
          <button key={align} type="button" className={`wm-icon${(headBlock?.align ?? doc.manifest.styles[currentStyle]?.align) === align ? ' is-on' : ''}`} title={{ left: L('Linksbündig (Strg+L)', 'Align left (Ctrl+L)'), center: L('Zentriert (Strg+E)', 'Centre (Ctrl+E)'), right: L('Rechtsbündig (Strg+R)', 'Align right (Ctrl+R)'), justify: L('Blocksatz (Strg+J)', 'Justify (Ctrl+J)') }[align]} onClick={() => { setAlignment(align); refocus() }}><Icon size={16} /></button>
        ))}
        <span className="wm-sep" />
        <details className="wm-menu">
          <summary className="wm-icon" title={L('Einfügen', 'Insert')}><Plus size={16} /><ChevronDown size={12} /></summary>
          <div className="wm-popover wm-list">
            <button type="button" onClick={() => { addFootnote(); refocus() }}>{L('Fussnote', 'Footnote')} <kbd>Strg+Alt+F</kbd></button>
            <button type="button" onClick={() => { addComment(); refocus() }}><MessageSquarePlus size={14} /> {L('Kommentar', 'Comment')} <kbd>Strg+Alt+M</kbd></button>
            <button type="button" onClick={() => { run(commands.insertPageBreak(controller.state), 'structure'); refocus() }}>{L('Seitenumbruch', 'Page break')} <kbd>Strg+Enter</kbd></button>
            <button type="button" onClick={() => { run(commands.splitScene(controller.state, { titles: titles() }), 'structure'); refocus() }}>{L('Neue Szene ab hier', 'New scene from here')} <kbd>Strg+⇧+Enter</kbd></button>
            <button type="button" onClick={() => { run(commands.splitScene(controller.state, { chapter: true, titles: titles() }), 'structure'); refocus() }}>{L('Neues Kapitel ab hier', 'New chapter from here')} <kbd>Strg+Alt+Enter</kbd></button>
          </div>
        </details>
        <button type="button" className={`wm-icon${find.open ? ' is-on' : ''}`} title={L('Suchen und Ersetzen (Strg+F / Strg+H)', 'Find and replace (Ctrl+F / Ctrl+H)')} onClick={() => setFind((value) => ({ ...value, open: !value.open }))}><Search size={16} /></button>
        <span className="wm-grow" />
        <select className="wm-select" value={language} title={L('Sprache der Geschichte', 'Story language')} onChange={(event) => {
          const next = event.target.value as StoryLanguage
          controller.replaceDoc(makeDoc({ ...doc.manifest, language: next }, doc.scenes))
          void loadHyphenator(next).then(() => setHyphenators((value) => ({ ...value, [next]: hyphenatorFor(next) })))
        }}>
          {LANGUAGES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <div className="wm-segmented" role="group" aria-label={L('Ansicht', 'View')}>
          <button type="button" className={view === 'page' ? 'is-on' : ''} title={L('Seitenansicht', 'Print layout')} onClick={() => setView('page')}><FileText size={15} /></button>
          <button type="button" className={view === 'spread' ? 'is-on' : ''} title={L('Doppelseite', 'Two-page spread')} onClick={() => setView('spread')}><Columns2 size={15} /></button>
          <button type="button" className={view === 'draft' ? 'is-on' : ''} title={L('Entwurf (fortlaufend)', 'Draft (continuous)')} onClick={() => setView('draft')}><Eye size={15} /></button>
        </div>
        <select className="wm-select wm-theme" value={theme} title={L('Papier', 'Paper')} onChange={(event) => setTheme(event.target.value as PageTheme)}>
          <option value="paper">{L('Papier', 'Paper')}</option>
          <option value="sepia">{L('Sepia', 'Sepia')}</option>
          <option value="night">{L('Nacht', 'Night')}</option>
        </select>
        <button type="button" className={`wm-icon${inspectorOpen ? ' is-on' : ''}`} title={L('Seite, Formate und Notizen', 'Page, styles and notes')} onClick={() => setInspectorOpen((value) => !value)}><SlidersHorizontal size={16} /></button>
        <button type="button" className={`wm-icon${focusMode ? ' is-on' : ''}`} title={L('Fokusmodus (F11)', 'Focus mode (F11)')} onClick={() => { setFocusMode((value) => !value); refocus() }}><Focus size={16} /></button>
        <div className="wm-zoom">
          <button type="button" className="wm-icon" title={L('Verkleinern', 'Zoom out')} onClick={() => setZoom((value) => ZOOMS.filter((step) => step < value - 0.001).at(-1) ?? value)}><Minus size={14} /></button>
          <span>{Math.round(zoom * 100)} %</span>
          <button type="button" className="wm-icon" title={L('Vergrössern', 'Zoom in')} onClick={() => setZoom((value) => ZOOMS.find((step) => step > value + 0.001) ?? value)}><Plus size={14} /></button>
        </div>
      </header>

      {find.open && (
        <div className="wm-find" role="search">
          <Search size={14} />
          <input autoFocus placeholder={L('Suchen', 'Find')} value={find.query} data-i18n-ignore onChange={(event) => setFind((value) => ({ ...value, query: event.target.value, current: 0 }))} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); goToMatch(currentMatch + (event.shiftKey ? -1 : 1)) } if (event.key === 'Escape') { setFind((value) => ({ ...value, open: false })); refocus() } }} />
          <span className="wm-find-count">{find.query ? (matches.length ? `${currentMatch + 1} / ${matches.length}` : L('Keine Treffer', 'No matches')) : ''}</span>
          <button type="button" className="wm-icon" title={L('Vorheriger Treffer (Umschalt+Enter)', 'Previous (Shift+Enter)')} onClick={() => goToMatch(currentMatch - 1)}><ChevronDown size={14} style={{ transform: 'rotate(180deg)' }} /></button>
          <button type="button" className="wm-icon" title={L('Nächster Treffer (Enter)', 'Next (Enter)')} onClick={() => goToMatch(currentMatch + 1)}><ChevronDown size={14} /></button>
          <label><input type="checkbox" checked={find.caseSensitive} onChange={(event) => setFind((value) => ({ ...value, caseSensitive: event.target.checked }))} /> Aa</label>
          <label><input type="checkbox" checked={find.wholeWord} onChange={(event) => setFind((value) => ({ ...value, wholeWord: event.target.checked }))} /> {L('Ganzes Wort', 'Whole word')}</label>
          <label><input type="checkbox" checked={find.regex} onChange={(event) => setFind((value) => ({ ...value, regex: event.target.checked }))} /> .*</label>
          <button type="button" className="wm-icon" title={L('Ersetzen', 'Replace')} onClick={() => setFind((value) => ({ ...value, replace: !value.replace }))}><Replace size={14} /></button>
          {find.replace && (
            <>
              <input placeholder={L('Ersetzen durch', 'Replace with')} value={find.replacement} data-i18n-ignore onChange={(event) => setFind((value) => ({ ...value, replacement: event.target.value }))} />
              <button type="button" className="secondary-button" onClick={replaceOne} disabled={currentMatch < 0}>{L('Ersetzen', 'Replace')}</button>
              <button type="button" className="secondary-button" onClick={replaceAll} disabled={!matches.length}>{L('Alle ersetzen', 'Replace all')}</button>
            </>
          )}
          <button type="button" className="wm-icon" title={L('Schliessen', 'Close')} onClick={() => { setFind((value) => ({ ...value, open: false })); refocus() }}><X size={14} /></button>
        </div>
      )}

      {notice && <div className="wm-notice" role="status" data-i18n-ignore>{notice}<button type="button" className="wm-icon" onClick={() => setNotice(null)} aria-label={L('Schliessen', 'Close')}><X size={13} /></button></div>}

      <div className="wm-body">
        {binderOpen && !focusMode && (
          <Binder
            nodes={doc.manifest.binder}
            currentScene={headBlock?.sceneId ?? null}
            sceneWords={(id) => sceneWords.get(id) ?? null}
            onOpen={(node) => goToBlock(node.kind === 'scene' ? doc.flow.find((block) => block.sceneId === node.id && block.ref.kind === 'para')?.key ?? '' : titleKey(node.id))}
            onRename={renameNode}
            onAddChapter={addChapter}
            onAddScene={addScene}
          />
        )}
        <div className={`wm-scroll theme-${theme}`} ref={(element) => { scroller.current = element; if (element !== scrollElement) setScrollElement(element) }} onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); input.current?.focus({ preventScroll: true }) } }}>
          <PageView
            layout={layout}
            doc={doc}
            measurer={measurer!}
            zoom={zoom}
            view={view}
            theme={theme}
            caret={range ? null : caretGeometry}
            caretVisible={caretOn && focused}
            selection={range}
            focusBlock={focusMode ? selection?.head.block ?? null : null}
            highlights={highlights}
            underlines={[]}
            scroller={scrollElement}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
          <textarea
            ref={input}
            className="wm-input"
            aria-label={L('Manuskript', 'Manuscript')}
            autoCapitalize="sentences"
            autoCorrect="off"
            spellCheck={false}
            lang={language}
            onKeyDown={onKeyDown}
            onCompositionStart={onCompositionStart}
            onCompositionUpdate={onCompositionUpdate}
            onCompositionEnd={onCompositionEnd}
            onInput={(event) => { if (!composing.current) event.currentTarget.value = '' }}
            onCopy={(event) => onCopy(event)}
            onCut={(event) => onCopy(event, true)}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            data-i18n-ignore
          />
        </div>
        {inspectorOpen && !focusMode && <Inspector controller={controller} manifest={doc.manifest} footnoteNumbers={layout.footnoteNumbers} onClose={() => setInspectorOpen(false)} />}
      </div>

      <footer className="wm-status" data-i18n-ignore>
        <span>{L('Seite', 'Page')} {pageNumber} / {layout.pages.length}</span>
        <span>{formatNumber(counts.words)} {L('Wörter', 'words')}{selectionCounts ? ` (${formatNumber(selectionCounts.words)} ${L('markiert', 'selected')})` : ''}</span>
        <span title={L(`${formatNumber(counts.chars)} Zeichen mit Leerzeichen`, `${formatNumber(counts.chars)} characters with spaces`)}>{formatNumber(counts.charsNoSpaces)} {L('Zeichen', 'characters')}</span>
        <span>{L(`${minutes} Min. Lesezeit`, `${minutes} min read`)}</span>
        <span className="wm-grow" />
        <span>{styleName(doc.manifest.styles[currentStyle] ?? doc.manifest.styles.body)}</span>
        <span className={`wm-save is-${saveState}`}>{saveState === 'saved' ? L('Gespeichert', 'Saved') : saveState === 'saving' ? L('Speichert …', 'Saving …') : L('Nicht gespeichert', 'Not saved')}{saveState === 'error' && controller.lastSaveError ? `: ${controller.lastSaveError}` : ''}</span>
      </footer>
    </div>
  )
}

function Binder({ nodes, currentScene, sceneWords, onOpen, onRename, onAddChapter, onAddScene }: {
  nodes: BinderNode[]
  currentScene: string | null
  sceneWords: (id: string) => number | null
  onOpen: (node: BinderNode) => void
  onRename: (id: string, title: string) => void
  onAddChapter: () => void
  onAddScene: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const render = (list: BinderNode[], depth: number): React.ReactNode => list.map((node) => {
    const words = node.kind === 'scene' ? sceneWords(node.id) : null
    const open = !collapsed.has(node.id)
    return (
      <li key={node.id}>
        <div className={`wm-binder-row is-${node.kind}${node.id === currentScene ? ' is-current' : ''}${node.exclude ? ' is-excluded' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
          {node.children ? (
            <button type="button" className="wm-binder-toggle" aria-label={open ? L('Zuklappen', 'Collapse') : L('Aufklappen', 'Expand')} onClick={() => setCollapsed((value) => { const next = new Set(value); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next })}>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : <span className="wm-binder-toggle" />}
          {editing === node.id ? (
            <input
              autoFocus
              defaultValue={node.title}
              data-i18n-ignore
              onBlur={(event) => { onRename(node.id, event.target.value.trim() || node.title); setEditing(null) }}
              onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); if (event.key === 'Escape') setEditing(null) }}
            />
          ) : (
            <button type="button" className="wm-binder-title" title={node.synopsis ?? node.title} onClick={() => onOpen(node)} onDoubleClick={() => setEditing(node.id)} data-i18n-ignore>
              {node.title || L('(ohne Titel)', '(untitled)')}
            </button>
          )}
          {words !== null && <small>{formatNumber(words)}</small>}
          {words === null && node.kind === 'scene' && <small title={L('Noch nicht auf diesem Gerät', 'Not on this device yet')}>…</small>}
        </div>
        {node.children && open && node.children.length > 0 && <ul>{render(node.children, depth + 1)}</ul>}
      </li>
    )
  })
  return (
    <nav className="wm-binder" aria-label={L('Gliederung', 'Binder')}>
      <div className="wm-binder-head">
        <span>{L('Gliederung', 'Binder')}</span>
        <button type="button" className="wm-icon" title={L('Neue Szene', 'New scene')} onClick={onAddScene}><FilePlus2 size={14} /></button>
        <button type="button" className="wm-icon" title={L('Neues Kapitel', 'New chapter')} onClick={onAddChapter}><Plus size={14} /></button>
      </div>
      <ul>{render(nodes, 0)}</ul>
    </nav>
  )
}

export default WritingMode
