import {
  ArrowLeft, ChevronDown, ChevronRight, FilePlus2, LoaderCircle, MoreHorizontal, Plus, Replace, Search, Trash2, X,
} from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import * as commands from '../editor/commands'
import { WritingController, type EditKind } from '../editor/controller'
import { blockAt, blockLength, caret, clampPos, isCollapsed, makeDoc, ordered, updateBinder, withScene, type Pos } from '../editor/doc'
import { CanvasMeasurer, loadHyphenator, loadWritingFonts, hyphenatorFor, type Hyphenator } from '../layout/measure'
import { LayoutCache, layoutManuscript } from '../layout/paginate'
import { LANGUAGE_TYPOGRAPHY } from '../model/defaults'
import { paragraphKey, titleKey, type FlowBlock } from '../model/flow'
import { writerId } from '../model/ids'
import { marksAt, runsText } from '../model/runs'
import type { Align, BinderNode, FontFamilyId, Marks, Scene, StoryLanguage, StoryManifest } from '../model/types'
import { loadProject, recoverJournal, storageAdapter, storyHost, storyTitleFromPath, writeJournal } from '../storage'
import { L, formatNumber, styleName } from './i18n'
import { caretBox, hitTestCaret, move, type Motion } from './navigation'
import { Assistant, defaultAssistSettings, issueSignature, paragraphLanguage, type AssistSettings } from '../assist/checker'
import type { Issue } from '../assist/rules'
import { autocorrectAfterInput, spellingFix, startsSentence } from '../assist/typography'
import { AssistPopover, type PopoverTarget } from './AssistPopover'
import { defaultAutocorrectSettings, type AutocorrectSettings } from './CheckPanel'
import { Inspector, type InspectorTab } from './Inspector'
import { ZOOMS, Toolbar, type Area, type ToolbarActions } from './Toolbar'
import { StatusBar } from './StatusBar'
import { useBurstThrottled, useShallowStable, useStableActions } from './renderHooks'
import { Corkboard, Outline, LABEL_COLORS, STATUS_LABEL } from './BoardViews'
import { BibleSheets, Timeline } from './BibleViews'
import { GoalsView } from './GoalsView'
import { ReferencePane, type Reference } from './ReferencePane'
import { ScenePanel, SnapshotCompare } from './ScenePanel'
import { ExportDialog } from '../export/ExportDialog'
import { androidBridge } from '../androidHost'
import { installStoryWrittenEntry, reportEditorBusy } from '../androidLive'
import { registerStoryGate, type StoryGate } from '../liveSync'
import { paragraphForQuery, subscribeStoryReveal } from '../reveal'
import { sanitizeManifest, sanitizeScene } from '../model/sanitize'
import { mergeableManifest, mergeableScene } from '../syncMerge'
import { useStoryTools } from './storyTools'
import { canDrop, findIn, moveNode, moveToTrash, trashedIds, updateNode, TRASH_ID, type DropPosition } from '../model/binder'
import { diffScene, restoreSnapshot, type DiffRow, type Snapshot } from '../model/snapshots'
import { entryNames } from '../model/bible'
import { PageView, caretPageRect, type Highlight, type PagePointer, type PageTheme, type ViewMode, GAP as GAP_PX } from './PageView'
import { countBlocks, countRuns, countText, htmlToParagraphs, runsToHtml, textToParagraphs } from './text'
import './writing.css'

type Props = {
  path: string
  onClose: () => void
  /** Called after each successful save (sync and search refresh). */
  onSaved?: (paths: string[]) => void
}

type FindState = { open: boolean; replace: boolean; query: string; replacement: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean; current: number }

const NO_HIGHLIGHTS: Highlight[] = []
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

export function WritingMode({ path, onClose, onSaved }: Props) {
  const host = useMemo(() => storyHost(), [])
  const [controller, setController] = useState<WritingController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fontsReady, setFontsReady] = useState(false)
  /** Bumped when the assistant's story lists (dictionary, ignored, bible names) changed. */
  const [listsVersion, setListsVersion] = useState({ key: '', n: 0 })
  const [hyphenators, setHyphenators] = useState<Partial<Record<StoryLanguage, Hyphenator | null>>>({})
  const [zoom, setZoom] = useState(() => Number(localStorage.getItem('fanotes.writing.zoom')) || 1)
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem('fanotes.writing.view') as ViewMode) || 'page')
  const [theme, setTheme] = useState<PageTheme>(() => (localStorage.getItem('fanotes.writing.theme') as PageTheme) || 'paper')
  const [focusMode, setFocusMode] = useState(false)
  const [binderOpen, setBinderOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('check')
  const [area, setArea] = useState<Area>(() => (localStorage.getItem('fanotes.writing.area') as Area | null) ?? 'manuscript')
  const [reference, setReference] = useState<Reference | null>(null)
  const [typewriter, setTypewriter] = useState(() => localStorage.getItem('fanotes.writing.typewriter') === '1')
  const [compare, setCompare] = useState<{ snapshot: Snapshot; rows: DiffRow[] } | null>(null)
  const [storyFiles, setStoryFiles] = useState<string[] | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const writer = useMemo(() => writerId(), [])
  const [assistSettings, setAssistSettings] = useState<AssistSettings>(() => {
    try { return { ...defaultAssistSettings(), ...JSON.parse(localStorage.getItem('fanotes.writing.assist.v1') ?? '{}') } } catch { return defaultAssistSettings() }
  })
  const [autocorrect, setAutocorrect] = useState<AutocorrectSettings>(() => {
    try { return { ...defaultAutocorrectSettings(), ...JSON.parse(localStorage.getItem('fanotes.writing.autocorrect.v1') ?? '{}') } } catch { return defaultAutocorrectSettings() }
  })
  const [popover, setPopover] = useState<PopoverTarget | null>(null)
  const [lexiconReady, setLexiconReady] = useState(false)
  /** The spelling worker engine (Rust wasm off the main thread); null until it is ready. */
  const spellingEngine = useRef<import('../../lib/spellingEngine').SpellingEngine | null>(null)
  const [, setSuggestionTick] = useState(0)
  /** controller.version right after an autocorrect: Backspace then undoes just the correction. */
  const lastAutocorrect = useRef(-1)
  const assistant = useMemo(() => new Assistant(null), [])
  assistant.settings = assistSettings
  /** The small in-app dialog for footnote and comment text (window.prompt does not exist in Electron). */
  const [noteDialog, setNoteDialog] = useState<{ kind: 'footnote' | 'comment'; text: string; selection: commands.EditorState['selection'] } | null>(null)
  const [find, setFind] = useState<FindState>({ open: false, replace: false, query: '', replacement: '', caseSensitive: false, wholeWord: false, regex: false, current: 0 })
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [caretOn, setCaretOn] = useState(true)
  const [focused, setFocused] = useState(false)
  const scroller = useRef<HTMLDivElement | null>(null)
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  // Stable, so React does not detach and re-attach it on every render (that flipped
  // `scrollElement` to null and back and rendered the manuscript three times per keystroke).
  const scrollerRef = useCallback((element: HTMLDivElement | null) => {
    scroller.current = element
    if (element) setScrollElement(element)
  }, [])
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
        setStoryFiles(project.files)
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
  // Word counts, the binder and the inspector follow the document with a short delay while typing.
  const slowDoc = useBurstThrottled(doc)

  // ── Layout ─────────────────────────────────────────────────────────────
  // The previous layout lets pagination restart at the changed page (see paginate.ts).
  const previousLayout = useRef<ReturnType<typeof layoutManuscript> | null>(null)
  const layout = useMemo(() => {
    if (!doc || !measurer || !fontsReady) return null
    const footnotes = new Map<string, { runs: import('../model/types').Run[] }>()
    for (const scene of doc.scenes.values()) for (const [id, note] of Object.entries(scene.footnotes ?? {})) footnotes.set(id, note)
    const next = layoutManuscript(doc.manifest, doc.flow, cache, { measurer, hyphenators, footnoteRuns: (id) => footnotes.get(id)?.runs ?? null }, previousLayout.current)
    previousLayout.current = next
    return next
  }, [doc, measurer, fontsReady, cache, hyphenators])
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
  // Another device's edits arrive while the story is open: sync writes scenes and the manifest only
  // while nothing is unsaved here, and the editor merges what it wrote (see liveSync.ts).
  useEffect(() => {
    if (!controller || !host) return
    let alive = true
    const gate: StoryGate = {
      path,
      isBusy: () => controller.isDirty() || controller.isSaving(),
      changed: (relatives) => {
        void (async () => {
          const scenes: Scene[] = []
          let manifest: StoryManifest | null = null
          for (const relative of relatives) {
            const text = await host.read(`${path}/${relative}`).catch(() => null)
            if (!alive || text === null) continue
            let value: unknown = null
            try { value = JSON.parse(text) } catch { continue }
            // Checked like a loaded story, not only shaped for merging.
            if (relative === 'story.json') manifest = mergeableManifest(value) ? sanitizeManifest(value) : null
            else {
              const id = relative.slice('scenes/'.length, -'.json'.length)
              const scene = mergeableScene(value, id) ? sanitizeScene(value, id) : null
              if (scene) scenes.push(scene)
            }
          }
          if (alive && controller.absorb(scenes, manifest)) setNotice(L('Änderungen von einem anderen Gerät wurden übernommen.', 'Changes from another device were merged in.'))
        })()
      },
    }
    const off = registerStoryGate(gate)
    // Android: sync is native, so the editor pushes its state and Kotlin calls back (androidLive.ts).
    const stopReport = reportEditorBusy(controller, androidBridge())
    const stopEntry = androidBridge() ? installStoryWrittenEntry(window as unknown as Record<string, unknown>, (relatives) => gate.changed(relatives), stopReport.resend) : () => undefined
    return () => { alive = false; off(); stopReport(); stopEntry() }
  }, [controller, host, path])
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
      await tools.flush(countBlocks(controller.state.doc.flow).words)
      if (!(await save())) {
        setNotice(L('Speichern fehlgeschlagen. Die Änderungen bleiben in diesem Fenster und im Notfallspeicher.', 'Saving failed. Your changes stay in this window and in the recovery journal.'))
        return
      }
    }
    onClose()
  }, [controller, onClose, path, save])

  // A search hit opens the story at the scene and paragraph that matched.
  useEffect(() => {
    if (!controller) return
    return subscribeStoryReveal(path, (request) => {
      const scene = controller.state.doc.scenes.get(request.sceneId)
      const paragraph = scene ? paragraphForQuery(scene, request.query) : null
      setArea('manuscript')
      if (scene && paragraph) {
        const key = paragraphKey(paragraph)
        window.setTimeout(() => { controller.select(caret(clampPos(controller.state.doc, { block: key, offset: 0 }))); refocus() }, 0)
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, path])

  // The Android app asks the editor to close (back button): save first, like the arrow does.
  useEffect(() => {
    const onRequest = () => { void close() }
    window.addEventListener('fanotes-writing-close', onRequest)
    return () => window.removeEventListener('fanotes-writing-close', onRequest)
  }, [close])

  // ── Writing assistance ────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    assistant.onSuggestions = () => setSuggestionTick((tick) => tick + 1)
    void import('../../lib/spellingEngine').then(async ({ loadSpellingEngine }) => {
      const engine = await loadSpellingEngine()
      if (!alive) return
      spellingEngine.current = engine
      assistant.setSpelling({
        isMisspelled: (word) => engine.isMisspelled(word),
        suggest: () => [],
        suggestAsync: async (word, language) => (await engine.suggest(word, [language])).map((entry) => entry.word),
      })
      setLexiconReady(true)
    }).catch(() => undefined)
    return () => { alive = false; assistant.onSuggestions = null }
  }, [assistant])
  useEffect(() => { try { localStorage.setItem('fanotes.writing.assist.v1', JSON.stringify(assistSettings)) } catch { /* ignore */ } }, [assistSettings])
  useEffect(() => { try { localStorage.setItem('fanotes.writing.autocorrect.v1', JSON.stringify(autocorrect)) } catch { /* ignore */ } }, [autocorrect])
  const manifestForLists = doc?.manifest

  // ── Persisted view settings ────────────────────────────────────────────
  useEffect(() => { try { localStorage.setItem('fanotes.writing.zoom', String(zoom)); localStorage.setItem('fanotes.writing.view', view); localStorage.setItem('fanotes.writing.theme', theme); localStorage.setItem('fanotes.writing.area', area); localStorage.setItem('fanotes.writing.typewriter', typewriter ? '1' : '0') } catch { /* ignore */ } }, [zoom, view, theme, area, typewriter])

  // ── Caret blink and visibility ─────────────────────────────────────────
  useEffect(() => {
    setCaretOn(true)
    const timer = window.setInterval(() => setCaretOn((value) => !value), 530)
    return () => window.clearInterval(timer)
  }, [state?.selection])

  const caretGeometry = useMemo(() => (layout && state && measurer ? caretBox(layout, state.selection.head, measurer, state.doc.index, state.selection.upstream) : null), [layout, state, measurer])

  // The scroller's size and position, kept up to date by events. Reading them from the element
  // after every keystroke would force the browser to lay out the page synchronously.
  const scrollBox = useRef({ top: 0, width: 0, height: 0 })
  useEffect(() => {
    const element = scrollElement
    if (!element) return
    const measure = () => { scrollBox.current = { top: element.scrollTop, width: element.clientWidth, height: element.clientHeight } }
    measure()
    const onScroll = () => { scrollBox.current.top = element.scrollTop }
    element.addEventListener('scroll', onScroll, { passive: true })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(element)
    return () => { element.removeEventListener('scroll', onScroll); observer?.disconnect() }
  }, [scrollElement])
  // ── Zoom by pinching (touch, trackpad) and Ctrl + wheel ────────────────
  // The spot under the fingers or the pointer stays where it is.
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const zoomAnchor = useRef<{ x: number; y: number; contentX: number; contentY: number; from: number } | null>(null)
  const zoomAround = useCallback((next: number, clientX: number, clientY: number) => {
    const element = scroller.current
    const from = zoomRef.current
    const target = Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], Math.round(next * 100) / 100))
    if (!element || Math.abs(target - from) < 0.005) return
    const bounds = element.getBoundingClientRect()
    const x = clientX - bounds.left
    const y = clientY - bounds.top
    zoomAnchor.current = { x, y, contentX: element.scrollLeft + x, contentY: element.scrollTop + y, from }
    zoomRef.current = target
    setZoom(target)
  }, [])
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current
    const element = scroller.current
    if (!anchor || !element) return
    zoomAnchor.current = null
    const ratio = zoom / anchor.from
    element.scrollTop = Math.max(0, (anchor.contentY - GAP_PX) * ratio + GAP_PX - anchor.y)
    element.scrollLeft = Math.max(0, (anchor.contentX - GAP_PX) * ratio + GAP_PX - anchor.x)
    scrollBox.current.top = element.scrollTop
  }, [zoom])
  useEffect(() => {
    const element = scrollElement
    if (!element) return
    // Ctrl + wheel, and a trackpad pinch (the browser reports it as Ctrl + wheel).
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      zoomAround(zoomRef.current * Math.exp(-Math.max(-60, Math.min(60, delta)) * 0.006), event.clientX, event.clientY)
    }
    let pinch: { distance: number; zoom: number } | null = null
    let frame = 0
    const spread = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return
      pinch = { distance: Math.max(1, spread(event.touches)), zoom: zoomRef.current }
      touchStart.current = null
    }
    const onTouchMove = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return
      event.preventDefault()
      const touches = event.touches
      const next = pinch.zoom * (spread(touches) / pinch.distance)
      const x = (touches[0].clientX + touches[1].clientX) / 2
      const y = (touches[0].clientY + touches[1].clientY) / 2
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { frame = 0; zoomAround(next, x, y) })
    }
    const onTouchEnd = (event: TouchEvent) => { if (event.touches.length < 2) pinch = null }
    element.addEventListener('wheel', onWheel, { passive: false })
    element.addEventListener('touchstart', onTouchStart, { passive: true })
    element.addEventListener('touchmove', onTouchMove, { passive: false })
    element.addEventListener('touchend', onTouchEnd, { passive: true })
    element.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('touchstart', onTouchStart)
      element.removeEventListener('touchmove', onTouchMove)
      element.removeEventListener('touchend', onTouchEnd)
      element.removeEventListener('touchcancel', onTouchEnd)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scrollElement, zoomAround])

  const scrollCaretIntoView = useCallback(() => {
    const element = scroller.current
    if (!element || !layout || !caretGeometry) return
    const box = scrollBox.current
    if (!box.width) scrollBox.current = { top: element.scrollTop, width: element.clientWidth, height: element.clientHeight }
    const rect = caretPageRect(layout, caretGeometry.page, zoom, view, box.width)
    if (!rect) return
    const top = rect.top + caretGeometry.y * zoom
    const bottom = top + caretGeometry.height * zoom
    const margin = 60
    const scrollTo = (value: number) => { element.scrollTop = value; box.top = value }
    // Typewriter: the line being written stays at the same height (a bit above the middle).
    if (typewriter) { const target = Math.max(0, top - box.height * 0.42); if (Math.abs(target - box.top) > 0.5) scrollTo(target) }
    else if (top < box.top + margin) scrollTo(Math.max(0, top - margin))
    else if (bottom > box.top + box.height - margin) scrollTo(bottom - box.height + margin)
    // Keep the hidden input at the caret so the IME window opens next to it.
    if (input.current) {
      input.current.style.left = `${rect.left + caretGeometry.x * zoom}px`
      input.current.style.top = `${top}px`
    }
  }, [layout, caretGeometry, zoom, view, typewriter])
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
    setPopover(null)
    if (!run(commands.insertText(controller.state, text), 'typing', text) || !autocorrect.enabled) return
    const st = controller.state
    const head = st.selection.head
    const block = blockAt(st.doc, head.block)
    if (block?.ref.kind !== 'para') return
    const paragraph = runsText(block.runs)
    const language = paragraphLanguage(paragraph, block.lang, st.doc.manifest.language, assistSettings.detectLanguage)
    const spellingLanguage = language.startsWith('de') ? 'de' : 'en'
    const pending: { request: { word: string; sentenceStart: boolean; from: number; to: number } | null } = { request: null }
    const fix = autocorrectAfterInput(paragraph, head.offset, text, language, {
      ...autocorrect,
      swissSs: autocorrect.swissSs && language === 'de-CH',
      isKnown: (word) => assistant.knows(word),
      // The engine answers from the spelling worker, so the decision follows asynchronously (below).
      correctWord: (word, sentenceStart, range) => {
        if (spellingEngine.current?.isMisspelled(word)) pending.request = { word, sentenceStart, ...range }
        return null
      },
    })
    const asked = pending.request
    const engine = spellingEngine.current
    if (asked && engine) {
      const blockKey = block.key
      const capitalise = autocorrect.capitalize
      void engine.planAutocorrect(asked.word, [spellingLanguage], { language: spellingLanguage, sentenceStart: asked.sentenceStart, properName: false }).then((decision) => {
        // The text moved on while the worker answered: drop the fix.
        const now = controller.state
        const current = blockAt(now.doc, blockKey)
        if (current?.ref.kind !== 'para' || runsText(current.runs).slice(asked.from, asked.to) !== asked.word) return
        const later = decision ? spellingFix(asked.from, asked.to, decision.word, asked.sentenceStart && capitalise, language) : fix
        if (!later) return
        if (controller.apply(commands.replaceInBlockRange(now, blockKey, later.from, later.to, later.text, 'keep'), 'other')) lastAutocorrect.current = controller.version
      }, () => undefined)
      return
    }
    if (!fix) return
    if (controller.apply(commands.replaceInBlockRange(st, block.key, fix.from, fix.to, fix.text, 'keep'), 'other')) lastAutocorrect.current = controller.version
  }, [controller, run, autocorrect, assistSettings.detectLanguage, assistant])

  /** Backspace right after an autocorrect gives back what was typed. */
  const undoAutocorrect = () => {
    if (!controller || lastAutocorrect.current !== controller.version) return false
    lastAutocorrect.current = -1
    controller.undo()
    return true
  }

  /** The assistant's finding at a position, if any. */
  const issueAt = (pos: Pos): { issue: Issue; language: StoryLanguage } | null => {
    if (!doc) return null
    const block = blockAt(doc, pos.block)
    if (block?.ref.kind !== 'para') return null
    const result = assistant.check(block.runs, block.lang, doc.manifest.language)
    const issue = result.issues.find((candidate) => pos.offset >= candidate.from && pos.offset <= candidate.to && candidate.to > candidate.from) ?? null
    return issue ? { issue, language: result.language } : null
  }
  const wordAround = (pos: Pos) => {
    const block = doc ? blockAt(doc, pos.block) : undefined
    if (!block) return null
    const text = runsText(block.runs)
    const [from, to] = commands.wordAt(text, pos.offset)
    const word = text.slice(from, to)
    return /\p{L}/u.test(word) ? { from, to, text: word } : null
  }
  const openPopover = (pos: Pos, withIssue: boolean, page: number, x: number, y: number) => {
    if (!doc || !layout || !scroller.current) return
    const rect = caretPageRect(layout, page, zoom, view, scroller.current.clientWidth)
    if (!rect) return
    const found = withIssue ? issueAt(pos) : null
    const block = blockAt(doc, pos.block)
    const language = found?.language ?? (block ? paragraphLanguage(runsText(block.runs), block.lang, doc.manifest.language, assistSettings.detectLanguage) : doc.manifest.language)
const spelling = found?.issue.category === 'spelling' ? found.issue : null
    const word = spelling && block ? { from: spelling.from, to: spelling.to, text: runsText(block.runs).slice(spelling.from, spelling.to) } : wordAround(pos)
    if (!found && !word) return
    setPopover({ block: pos.block, left: rect.left + x * zoom, top: rect.top + y * zoom + 18, issue: found?.issue ?? null, word, synonyms: !spelling, language: language.startsWith('de') ? 'de' : 'en' })
  }
  // Keyed on the assistant's inputs only (not on the layout), so that pages whose lines did not change keep their underlines.
  const storyLanguage = doc?.manifest.language ?? 'de'
  const dictionaryWords = doc?.manifest.dictionary
  const ignoredIssues = doc?.manifest.ignored
  const underlinesFor = useCallback((block: FlowBlock) => {
    if (block.ref.kind !== 'para') return []
    return assistant.check(block.runs, block.lang, storyLanguage).issues
      .filter((issue) => issue.to > issue.from)
      .map((issue) => ({ block: block.key, from: issue.from, to: issue.to, kind: issue.category === 'spelling' ? 'spelling' as const : issue.category === 'style' ? 'style' as const : 'grammar' as const }))
    // The assistant's lists, settings and lexicon are part of its cache key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant, assistSettings, lexiconReady, dictionaryWords, ignoredIssues, storyLanguage, listsVersion.n])

  const moveCaret = (motion: Motion, extend: boolean) => {
    if (!controller || !layout || !measurer) return
    const current = controller.state.selection
    let head = current.head
    if (!extend && !isCollapsed(current) && (motion === 'left' || motion === 'right')) {
      const range = ordered(controller.state.doc, current)
      controller.select(caret(motion === 'left' ? range.from : range.to))
      return
    }
    const result = move(controller.state.doc, layout, head, motion, measurer, motion === 'up' || motion === 'down' || motion === 'pageUp' || motion === 'pageDown' ? goalX.current : null, current.upstream)
    head = result.pos
    goalX.current = result.goalX
    // End, and up/down into the end of a wrapped line, keep the caret at the end of that line.
    controller.select(extend ? { anchor: current.anchor, head, ...(result.upstream ? { upstream: true as const } : {}) } : caret(head, Boolean(result.upstream)))
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
        case 'Backspace': if (!undoAutocorrect()) run(commands.deleteBackward(st), 'delete'); return true
        case 'Delete': run(commands.deleteForward(st), 'delete'); return true
        case 'Enter': run(event.shiftKey ? commands.insertLineBreak(st) : commands.splitParagraph(st), 'structure'); return true
        case 'Tab': return true
        case 'F7':
          if (event.shiftKey && caretGeometry) {
            openPopover(st.selection.head, false, caretGeometry.page, caretGeometry.x, caretGeometry.y + caretGeometry.height - 14)
          } else {
            setInspectorOpen(true)
            setInspectorTab('check')
          }
          return true
        case 'Escape':
          if (popover) { setPopover(null); return true }
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
    if (type === 'deleteContentBackward') { event.preventDefault(); if (!undoAutocorrect()) run(commands.deleteBackward(st), 'delete'); return }
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
  /** A finger on a tablet scrolls; a tap (little movement) places the caret on release. */
  const touchStart = useRef<{ pointer: PagePointer; at: number } | null>(null)
  const onPointerDown = (pointer: PagePointer) => {
    if (pointer.pointerType === 'touch') { touchStart.current = { pointer, at: Date.now() }; return }
    if (!controller || !layout || !measurer || pointer.button !== 0) return
    const hit = hitTestCaret(layout, pointer.page, pointer.x, pointer.y, measurer)
    const pos = hit?.pos
    input.current?.focus({ preventScroll: true })
    if (!hit || !pos) return
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
    controller.select({ anchor, head: pos, ...(hit.upstream ? { upstream: true as const } : {}) })
    dragging.current = { anchor, unit: 'char' }
    setPopover(null)
    if (!pointer.shift && pointer.pointerType !== 'pen' && issueAt(pos)) openPopover(pos, true, pointer.page, pointer.x, pointer.y)
  }
  const onContextMenu = (pointer: PagePointer) => {
    if (!controller || !layout || !measurer) return
    const hit = hitTestCaret(layout, pointer.page, pointer.x, pointer.y, measurer)
    if (!hit) return
    const pos = hit.pos
    controller.select(caret(pos, hit.upstream))
    openPopover(pos, true, pointer.page, pointer.x, pointer.y)
  }
  const onPointerMove = (pointer: PagePointer) => {
    if (pointer.pointerType === 'touch') {
      const start = touchStart.current?.pointer
      if (start && (start.page !== pointer.page || Math.hypot(pointer.x - start.x, pointer.y - start.y) > 10 / zoom)) touchStart.current = null
      return
    }
    if (!controller || !layout || !measurer || !dragging.current) return
    const hit = hitTestCaret(layout, pointer.page, pointer.x, pointer.y, measurer)
    if (hit) controller.select({ anchor: dragging.current.anchor, head: hit.pos, ...(hit.upstream ? { upstream: true as const } : {}) })
  }
  const onPointerUp = (pointer?: PagePointer) => {
    dragging.current = null
    const tap = touchStart.current
    touchStart.current = null
    if (pointer?.pointerType !== 'touch' || !tap || Date.now() - tap.at > 600 || !controller || !layout || !measurer) return
    const hit = hitTestCaret(layout, tap.pointer.page, tap.pointer.x, tap.pointer.y, measurer)
    if (!hit) return
    const pos = hit.pos
    controller.select(caret(pos, hit.upstream))
    // Focusing on the tap itself opens the on-screen keyboard.
    input.current?.focus({ preventScroll: true })
    setPopover(null)
    if (issueAt(pos)) openPopover(pos, true, tap.pointer.page, tap.pointer.x, tap.pointer.y)
  }

  // ── Footnotes and comments ─────────────────────────────────────────────
  const addFootnote = () => {
    if (!controller) return
    setNoteDialog({ kind: 'footnote', text: '', selection: controller.state.selection })
  }
  const addComment = () => {
    if (!controller || isCollapsed(controller.state.selection)) {
      setNotice(L('Markiere zuerst den Text, zu dem der Kommentar gehört.', 'Select the text the comment is about first.'))
      return
    }
    setNoteDialog({ kind: 'comment', text: '', selection: controller.state.selection })
  }
  const confirmNote = () => {
    if (!controller || !noteDialog) return
    const st = { ...controller.state, selection: noteDialog.selection }
    if (noteDialog.kind === 'footnote') {
      const result = commands.insertFootnote(st, noteDialog.text.trim())
      if (result) run(result.state, 'structure')
    } else if (noteDialog.text.trim()) {
      const result = commands.addComment(st, L('Ich', 'Me'), noteDialog.text.trim())
      if (result) run(result.state, 'format')
    }
    setNoteDialog(null)
    refocus()
  }

  // ── Find & replace ─────────────────────────────────────────────────────
  const matches = useMemo<Highlight[]>(() => {
    if (!doc || !find.open || !find.query) return NO_HIGHLIGHTS
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
    // A version of every touched scene first, so a wrong pattern is one restore away.
    const touched = new Set(matches.map((match) => blockAt(controller.state.doc, match.block)?.sceneId).filter((id): id is string => Boolean(id)))
    for (const sceneId of touched) {
      const scene = controller.state.doc.scenes.get(sceneId)
      if (scene) void tools.takeSnapshot(scene, findIn(controller.state.doc.manifest.binder, sceneId)?.title ?? '', 'replace', L(`Vor „Alle ersetzen“: ${find.query}`, `Before “Replace all”: ${find.query}`)).catch(() => undefined)
    }
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
  const stableMarks = useShallowStable(marks)
  const counts = useMemo(() => (slowDoc ? countBlocks(slowDoc.flow) : { words: 0, chars: 0, charsNoSpaces: 0, paragraphs: 0 }), [slowDoc])
  // Words per scene for the binder; counts are cached per paragraph, so this is cheap per keystroke.
  const sceneWords = useMemo(() => {
    const out = new Map<string, number>()
    if (!slowDoc) return out
    for (const scene of slowDoc.scenes.values()) out.set(scene.id, scene.paragraphs.reduce((sum, paragraph) => sum + (paragraph.deleted ? 0 : countRuns(paragraph.runs).words), 0))
    return out
  }, [slowDoc])
  const sceneWordsOf = useCallback((id: string) => sceneWords.get(id) ?? null, [sceneWords])
  const tools = useStoryTools({
    host,
    path,
    files: storyFiles,
    writer,
    totalWords: slowDoc ? counts.words : null,
    onWritten: (paths) => onSaved?.(paths),
    onError: (message) => setNotice(message),
  })
  const characters = useMemo(() => tools.entriesOf('character'), [tools.entriesOf])
  const places = useMemo(() => tools.entriesOf('place'), [tools.entriesOf])
  const events = useMemo(() => tools.entriesOf('event'), [tools.entriesOf])
  // Names from the bible count as correctly spelled.
  useEffect(() => {
    if (!manifestForLists) return
    const names = [...characters, ...places].flatMap((entry) => entryNames(entry).flatMap((name) => name.split(/\s+/u)))
    const words = [...(manifestForLists.dictionary ?? []), ...names]
    const ignored = manifestForLists.ignored ?? []
    assistant.setProjectLists(words, ignored)
    // Pages keep their underlines until `underlinesFor` changes; the lists are set after render,
    // so a new version re-renders the pages with the new lists (bible names included).
    const key = JSON.stringify([words, ignored])
    setListsVersion((current) => (current.key === key ? current : { key, n: current.n + 1 }))
  }, [assistant, manifestForLists, characters, places])

  /** Binder edits; typing into one field of one node is a single undo step. */
  const lastPatch = useRef<{ key: string; at: number } | null>(null)
  const patchNode = (id: string, patch: Partial<BinderNode>) => {
    if (!controller) return
    const current = controller.state.doc
    const binder = updateNode(current.manifest.binder, id, (node) => {
      const next = { ...node, ...patch }
      for (const key of Object.keys(patch) as Array<keyof BinderNode>) if (next[key] === undefined) delete next[key]
      return next
    })
    if (binder === current.manifest.binder) return
    const key = `${id}:${Object.keys(patch).join(',')}`
    const now = Date.now()
    const coalesce = lastPatch.current?.key === key && now - lastPatch.current.at < 1500
    lastPatch.current = { key, at: now }
    controller.replaceDoc(makeDoc({ ...current.manifest, binder }, current.scenes), !coalesce)
  }
  const moveBinderNode = (id: string, targetId: string, position: DropPosition) => {
    if (!controller) return
    const current = controller.state.doc
    const binder = moveNode(current.manifest.binder, id, targetId, position)
    if (binder !== current.manifest.binder) controller.replaceDoc(makeDoc({ ...current.manifest, binder }, current.scenes))
  }
  const trashNode = (id: string) => {
    if (!controller) return
    const current = controller.state.doc
    controller.replaceDoc(makeDoc({ ...current.manifest, binder: moveToTrash(current.manifest.binder, id, L('Papierkorb', 'Trash')) }, current.scenes))
    setNotice(L('In den Papierkorb gelegt. Die Szene bleibt erhalten und lässt sich zurückziehen.', 'Moved to the trash. The scene is kept and can be dragged back.'))
  }
  const openScene = (sceneId: string) => {
    if (!doc) return
    setArea('manuscript')
    const node = findIn(doc.manifest.binder, sceneId)
    if (node && (node.exclude || trashedIds(doc.manifest.binder).has(sceneId))) {
      setNotice(trashedIds(doc.manifest.binder).has(sceneId)
        ? L(`„${node.title}“ liegt im Papierkorb. Ziehe die Szene in ein Kapitel, um sie wieder im Manuskript zu haben.`, `“${node.title}” is in the trash. Drag it into a chapter to bring it back into the manuscript.`)
        : L(`„${node.title}“ ist vom Manuskript ausgeschlossen. Im Tab „Szene“ kannst du sie wieder einschliessen.`, `“${node.title}” is excluded from the manuscript. Include it again in the “Scene” tab.`))
      return
    }
    const block = doc.flow.find((entry) => entry.sceneId === sceneId && entry.ref.kind === 'para')
    if (block) window.setTimeout(() => goToBlock(block.key), 0)
  }
  const openCompare = async (stamp: string) => {
    const sceneId = headBlock?.sceneId
    if (!sceneId || !controller) return
    const snapshot = await tools.openSnapshot(sceneId, stamp)
    const scene = controller.state.doc.scenes.get(sceneId)
    if (!snapshot || !scene) { setNotice(L('Diese Version konnte nicht gelesen werden.', 'This version could not be read.')); return }
    setCompare({ snapshot, rows: diffScene(snapshot.paragraphs, scene.paragraphs) })
  }
  const restoreCompare = async () => {
    if (!compare || !controller) return
    const scene = controller.state.doc.scenes.get(compare.snapshot.sceneId)
    if (!scene) return
    try {
      await tools.takeSnapshot(scene, findIn(controller.state.doc.manifest.binder, scene.id)?.title ?? '', 'restore', L('Vor dem Wiederherstellen', 'Before restoring'))
    } catch (error) {
      setNotice(L(`Der jetzige Stand konnte nicht gesichert werden; nichts wurde geändert. (${error instanceof Error ? error.message : error})`, `The current state could not be saved; nothing was changed. (${error instanceof Error ? error.message : error})`))
      return
    }
    const restored = restoreSnapshot(scene, compare.snapshot)
    const nextDoc = withScene(controller.state.doc, restored)
    const st = controller.state
    controller.apply({ ...st, doc: nextDoc, selection: caret(clampPos(nextDoc, st.selection.head)) }, 'structure')
    setCompare(null)
    refocus()
    setNotice(L('Version wiederhergestellt. Der vorherige Stand ist als Version gesichert.', 'Version restored. The previous state was saved as a version.'))
  }
  const linkedNotes = useMemo(() => {
    const out = new Set<string>()
    const walk = (nodes: BinderNode[]) => { for (const node of nodes) { for (const link of node.links ?? []) out.add(link); if (node.children) walk(node.children) } }
    if (doc) walk(doc.manifest.binder)
    return [...out]
  }, [doc?.manifest.binder])

  const selectionCounts = useMemo(() => (state && range ? countText(commands.selectedText(state)) : null), [state, range])
  const language = doc?.manifest.language ?? 'de'
  const minutes = Math.max(1, Math.round(counts.words / LANGUAGE_TYPOGRAPHY[language].wpm))
  const pageNumber = caretGeometry && layout ? layout.pages[caretGeometry.page]?.number ?? '1' : '1'

  const setStyle = (style: string) => run(controller ? commands.setParagraphStyle(controller.state, style) : null, 'format')
  const setMarkValue = (patch: Parameters<typeof commands.setMark>[1]) => run(controller ? commands.setMark(controller.state, patch) : null, 'format')
  const setAlignment = (align: Align) => run(controller ? commands.setAlign(controller.state, align) : null, 'format')
  const refocus = useCallback(() => window.requestAnimationFrame(() => input.current?.focus({ preventScroll: true })), [])

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

  const openGoals = useCallback(() => setArea('goals'), [])
  const toolbarActions = useStableActions({
    close,
    refocus,
    undo: () => { controller?.undo() },
    redo: () => { controller?.redo() },
    setStyle,
    setMarkValue,
    setAlignment,
    toggleMark: (key: 'b' | 'i' | 'u' | 's' | 'sup' | 'sub' | 'sc') => { if (controller) run(commands.toggleMark(controller.state, key), 'format') },
    insertBreak: (kind: 'page' | 'scene' | 'chapter') => {
      if (!controller) return
      run(kind === 'page' ? commands.insertPageBreak(controller.state) : commands.splitScene(controller.state, kind === 'chapter' ? { chapter: true, titles: titles() } : { titles: titles() }), 'structure')
    },
    addFootnote,
    addComment,
    changeLanguage: (next: StoryLanguage) => {
      if (!controller || !doc) return
      controller.replaceDoc(makeDoc({ ...doc.manifest, language: next }, doc.scenes))
      void loadHyphenator(next).then(() => setHyphenators((value) => ({ ...value, [next]: hyphenatorFor(next) })))
    },
    toggleReference: () => {
      if (!doc) return
      if (reference) { setReference(null); return }
      const node = headBlock?.sceneId ? findIn(doc.manifest.binder, headBlock.sceneId) : null
      const first = node?.links?.[0]
      setReference(first ? { kind: 'note', path: first } : characters[0] ? { kind: 'bible', id: characters[0].id } : { kind: 'scene', id: [...doc.scenes.keys()][0] })
    },
  } satisfies ToolbarActions)
  const binderActions = useStableActions({
    open: (node: BinderNode) => {
      if (node.kind === 'scene') { openScene(node.id); return }
      if (node.id === TRASH_ID || node.kind === 'folder') return
      setArea('manuscript')
      goToBlock(titleKey(node.id))
    },
    rename: renameNode,
    addChapter,
    addScene,
    move: moveBinderNode,
    patch: patchNode,
    trash: trashNode,
  })
  const sceneActions = useStableActions({
    patch: (sceneId: string, patch: Partial<BinderNode>) => patchNode(sceneId, patch),
    openNote: (notePath: string) => setReference({ kind: 'note', path: notePath }),
    takeSnapshot: async (sceneId: string, title: string, note: string) => {
      const scene = controller?.state.doc.scenes.get(sceneId)
      if (!scene) return
      try {
        await tools.takeSnapshot(scene, title, 'manual', note)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    compare: (stamp: string) => { void openCompare(stamp) },
    jump: (block: string, from: number, to: number) => { controller?.select({ anchor: { block, offset: from }, head: { block, offset: to } }); refocus() },
    closeInspector: () => setInspectorOpen(false),
  })
  const headSceneId = headBlock?.sceneId ?? null
  const slowLayout = useBurstThrottled(layout)
  const checkProps = useMemo(() => ({
    assistant,
    settings: assistSettings,
    onSettings: setAssistSettings,
    autocorrect,
    onAutocorrect: setAutocorrect,
    sceneId: headSceneId,
    onJump: sceneActions.jump,
  }), [assistant, assistSettings, autocorrect, headSceneId, sceneActions])
  const scenePanel = useMemo(() => {
    const node = headSceneId && slowDoc ? findIn(slowDoc.manifest.binder, headSceneId) : null
    return (
      <ScenePanel
        key={headSceneId ?? 'none'}
        node={node}
        words={headSceneId ? sceneWords.get(headSceneId) ?? 0 : 0}
        characters={characters}
        places={places}
        stamps={headSceneId ? tools.stampsFor(headSceneId) : []}
        onPatch={(patch) => { if (headSceneId) sceneActions.patch(headSceneId, patch) }}
        onOpenNote={sceneActions.openNote}
        onTakeSnapshot={(note) => sceneActions.takeSnapshot(headSceneId ?? '', node?.title ?? '', note)}
        onCompare={sceneActions.compare}
      />
    )
  }, [headSceneId, slowDoc?.manifest.binder, sceneWords, characters, places, tools.stampsFor, sceneActions])

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
      <Toolbar
        act={toolbarActions}
        title={doc.manifest.title || storyTitleFromPath(path)}
        binderOpen={binderOpen}
        setBinderOpen={setBinderOpen}
        area={area}
        setArea={setArea}
        canUndo={controller.canUndo()}
        canRedo={controller.canRedo()}
        styles={doc.manifest.styles}
        currentStyle={currentStyle}
        marks={stableMarks}
        align={headBlock?.align}
        findOpen={find.open}
        setFind={setFind}
        language={language}
        view={view}
        setView={setView}
        theme={theme}
        setTheme={setTheme}
        setExportOpen={setExportOpen}
        typewriter={typewriter}
        setTypewriter={setTypewriter}
        referenceOpen={Boolean(reference)}
        inspectorOpen={inspectorOpen}
        setInspectorOpen={setInspectorOpen}
        inspectorTab={inspectorTab}
        setInspectorTab={setInspectorTab}
        focusMode={focusMode}
        setFocusMode={setFocusMode}
        zoom={zoom}
        setZoom={setZoom}
      />

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
            nodes={slowDoc?.manifest.binder ?? doc.manifest.binder}
            currentScene={headBlock?.sceneId ?? null}
            sceneWords={sceneWordsOf}
            onOpen={binderActions.open}
            onRename={binderActions.rename}
            onAddChapter={binderActions.addChapter}
            onAddScene={binderActions.addScene}
            onMove={binderActions.move}
            onPatch={binderActions.patch}
            onTrash={binderActions.trash}
          />
        )}
        {area !== 'manuscript' && (
          <div className="wm-area">
            {area === 'board' && <Corkboard binder={doc.manifest.binder} sceneWords={sceneWordsOf} characters={characters} onPatch={patchNode} onMove={moveBinderNode} onOpen={openScene} />}
            {area === 'outline' && <Outline binder={doc.manifest.binder} sceneWords={sceneWordsOf} characters={characters} onPatch={patchNode} onMove={moveBinderNode} onOpen={openScene} />}
            {(area === 'characters' || area === 'places') && <BibleSheets key={area} kind={area === 'characters' ? 'character' : 'place'} entries={area === 'characters' ? characters : places} binder={doc.manifest.binder} scenes={doc.scenes} writer={writer} onSave={tools.saveEntry} onOpenScene={openScene} />}
            {area === 'timeline' && <Timeline events={events} characters={characters} places={places} binder={doc.manifest.binder} writer={writer} onSave={tools.saveEntry} onOpenScene={openScene} />}
            {area === 'goals' && <GoalsView goals={doc.manifest.goals ?? {}} total={counts.words} today={tools.todayWords} session={tools.sessionWords} days={tools.days} onGoals={(goals) => controller.replaceDoc(makeDoc({ ...controller.state.doc.manifest, goals }, controller.state.doc.scenes))} />}
          </div>
        )}
        <div className={`wm-scroll theme-${theme}${area !== 'manuscript' ? ' is-hidden' : ''}`} ref={scrollerRef} onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); input.current?.focus({ preventScroll: true }) } }}>
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
            underlinesFor={underlinesFor}
            onContextMenu={onContextMenu}
            scroller={scrollElement}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
          {popover && (
            <AssistPopover
              target={popover}
              onClose={() => { setPopover(null); refocus() }}
              onReplace={(from, to, text) => { run(commands.replaceInBlockRange(controller.state, popover.block, from, to, text), 'format'); setPopover(null); refocus() }}
              onIgnore={(issue) => {
                const block = blockAt(controller.state.doc, popover.block)
                if (block) controller.replaceDoc(makeDoc({ ...doc.manifest, ignored: [...new Set([...(doc.manifest.ignored ?? []), issueSignature(issue, runsText(block.runs))])] }, controller.state.doc.scenes))
                setPopover(null)
                refocus()
              }}
              onAddWord={(word) => { controller.replaceDoc(makeDoc({ ...doc.manifest, dictionary: [...new Set([...(doc.manifest.dictionary ?? []), word])] }, controller.state.doc.scenes)); setPopover(null); refocus() }}
              onDisableRule={(rule) => { setAssistSettings((value) => ({ ...value, disabledRules: [...new Set([...value.disabledRules, rule])] })); setPopover(null); refocus() }}
            />
          )}
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
        {reference && area === 'manuscript' && !focusMode && (
          <ReferencePane reference={reference} binder={doc.manifest.binder} scenes={doc.scenes} bible={[...characters, ...places, ...events]} links={linkedNotes} onChange={setReference} onClose={() => setReference(null)} />
        )}
        {inspectorOpen && !focusMode && (
          <Inspector
            controller={controller}
            manifest={doc.manifest}
            revision={slowDoc}
            footnoteNumbers={(slowLayout ?? layout).footnoteNumbers}
            onClose={sceneActions.closeInspector}
            tab={inspectorTab}
            onTab={setInspectorTab}
            check={checkProps}
            scene={scenePanel}
          />
        )}
      </div>

      {exportOpen && (
        <ExportDialog
          project={{ manifest: doc.manifest, scenes: doc.scenes }}
          currentChapter={(() => { const chapter = headBlock?.chapterId ? findIn(doc.manifest.binder, headBlock.chapterId) : null; return chapter ? { id: chapter.id, title: chapter.title } : null })()}
          measurer={measurer ?? undefined}
          hyphenators={hyphenators}
          layout={layout}
          onSave={androidBridge() ? async (result) => {
            let binary = ''
            for (let index = 0; index < result.bytes.length; index += 0x8000) binary += String.fromCharCode(...result.bytes.subarray(index, index + 0x8000))
            const raw = JSON.parse(androidBridge()!.saveExport(path, result.fileName, btoa(binary))) as { ok: boolean; value?: string; error?: string }
            if (!raw.ok) throw new Error(raw.error ?? 'Export failed')
            setNotice(L(`Gespeichert als ${raw.value}`, `Saved as ${raw.value}`))
            onSaved?.([raw.value!])
          } : undefined}
          onClose={() => { setExportOpen(false); refocus() }}
        />
      )}
      {compare && <SnapshotCompare snapshot={compare.snapshot} rows={compare.rows} onRestore={() => { void restoreCompare() }} onClose={() => { setCompare(null); refocus() }} />}

      {noteDialog && (
        <div className="wm-dialog-backdrop" onMouseDown={() => { setNoteDialog(null); refocus() }}>
          <form className="wm-dialog" role="dialog" aria-label={noteDialog.kind === 'footnote' ? L('Fussnote einfügen', 'Insert footnote') : L('Kommentar hinzufügen', 'Add comment')} onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); confirmNote() }}>
            <strong>{noteDialog.kind === 'footnote' ? L('Fussnote', 'Footnote') : L('Kommentar', 'Comment')}</strong>
            <textarea autoFocus rows={4} value={noteDialog.text} data-i18n-ignore placeholder={noteDialog.kind === 'footnote' ? L('Text der Fussnote', 'Footnote text') : L('Was ist dir hier aufgefallen?', 'What did you notice here?')} onChange={(event) => setNoteDialog((value) => (value ? { ...value, text: event.target.value } : value))} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); confirmNote() } if (event.key === 'Escape') { setNoteDialog(null); refocus() } }} />
            <div>
              <button type="button" className="secondary-button" onClick={() => { setNoteDialog(null); refocus() }}>{L('Abbrechen', 'Cancel')}</button>
              <button type="submit" className="primary-button" disabled={noteDialog.kind === 'comment' && !noteDialog.text.trim()}>{noteDialog.kind === 'footnote' ? L('Einfügen', 'Insert') : L('Hinzufügen', 'Add')}</button>
            </div>
          </form>
        </div>
      )}

      <StatusBar
        pageNumber={pageNumber}
        pageCount={layout.pages.length}
        words={counts.words}
        selectedWords={selectionCounts ? selectionCounts.words : null}
        chars={counts.chars}
        charsNoSpaces={counts.charsNoSpaces}
        minutes={minutes}
        dailyGoal={doc.manifest.goals?.daily ?? null}
        todayWords={tools.todayWords}
        styleLabel={styleName(doc.manifest.styles[currentStyle] ?? doc.manifest.styles.body)}
        saveState={saveState}
        saveError={controller.lastSaveError ?? null}
        onOpenGoals={openGoals}
      />
    </div>
  )
}

const Binder = memo(function Binder({ nodes, currentScene, sceneWords, onOpen, onRename, onAddChapter, onAddScene, onMove, onPatch, onTrash }: {
  nodes: BinderNode[]
  currentScene: string | null
  sceneWords: (id: string) => number | null
  onOpen: (node: BinderNode) => void
  onRename: (id: string, title: string) => void
  onAddChapter: () => void
  onAddScene: () => void
  onMove: (id: string, targetId: string, position: DropPosition) => void
  onPatch: (id: string, patch: Partial<BinderNode>) => void
  onTrash: (id: string) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string; position: DropPosition } | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const dropAt = (event: React.DragEvent<HTMLDivElement>, node: BinderNode) => {
    if (!drag) return
    const rect = event.currentTarget.getBoundingClientRect()
    const y = (event.clientY - rect.top) / rect.height
    const candidates: DropPosition[] = y < 0.3 ? ['before', 'inside'] : y > 0.7 ? ['after', 'inside'] : ['inside', y < 0.5 ? 'before' : 'after']
    const position = candidates.find((candidate) => canDrop(nodes, drag, node.id, candidate))
    if (!position) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (over?.id !== node.id || over.position !== position) setOver({ id: node.id, position })
  }
  const render = (list: BinderNode[], depth: number): React.ReactNode => list.map((node) => {
    const words = node.kind === 'scene' ? sceneWords(node.id) : null
    const open = !collapsed.has(node.id)
    const isTrash = node.id === TRASH_ID
    return (
      <li key={node.id}>
        <div
          className={`wm-binder-row is-${node.kind}${node.id === currentScene ? ' is-current' : ''}${node.exclude && !isTrash ? ' is-excluded' : ''}${isTrash ? ' is-trash' : ''}${drag === node.id ? ' is-dragging' : ''}${over?.id === node.id ? ` drop-${over.position}` : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable={!isTrash && editing !== node.id}
          onDragStart={(event) => { setDrag(node.id); setMenu(null); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', node.id) }}
          onDragEnd={() => { setDrag(null); setOver(null) }}
          onDragOver={(event) => dropAt(event, node)}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null) }}
          onDrop={(event) => { event.preventDefault(); if (drag && over) onMove(drag, over.id, over.position); setDrag(null); setOver(null) }}
        >
          {node.children ? (
            <button type="button" className="wm-binder-toggle" aria-label={open ? L('Zuklappen', 'Collapse') : L('Aufklappen', 'Expand')} onClick={() => setCollapsed((value) => { const next = new Set(value); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next })}>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : <span className="wm-binder-toggle" />}
          {isTrash ? <Trash2 size={12} className="wm-binder-icon" /> : node.label ? <span className="wm-label-dot" style={{ background: node.label }} /> : null}
          {editing === node.id ? (
            <input
              autoFocus
              defaultValue={node.title}
              data-i18n-ignore
              onBlur={(event) => { onRename(node.id, event.target.value.trim() || node.title); setEditing(null) }}
              onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); if (event.key === 'Escape') setEditing(null) }}
            />
          ) : (
            <button type="button" className="wm-binder-title" title={node.synopsis ?? node.title} onClick={() => onOpen(node)} onDoubleClick={() => { if (!isTrash) setEditing(node.id) }} data-i18n-ignore>
              {isTrash ? L('Papierkorb', 'Trash') : node.title || L('(ohne Titel)', '(untitled)')}
            </button>
          )}
          {node.status && node.kind === 'scene' && <span className={`wm-status-badge is-${node.status}`} title={L(...STATUS_LABEL[node.status])} />}
          {words !== null && <small>{formatNumber(words)}</small>}
          {words === null && node.kind === 'scene' && <small title={L('Noch nicht auf diesem Gerät', 'Not on this device yet')}>…</small>}
          {!isTrash && (
            <button type="button" className="wm-binder-more" aria-label={L('Mehr', 'More')} aria-expanded={menu === node.id} onClick={() => setMenu((value) => (value === node.id ? null : node.id))}><MoreHorizontal size={13} /></button>
          )}
        </div>
        {menu === node.id && (
          <div className="wm-binder-menu" role="menu" onMouseLeave={() => setMenu(null)}>
            <button type="button" role="menuitem" onClick={() => { setEditing(node.id); setMenu(null) }}>{L('Umbenennen', 'Rename')}</button>
            {node.kind === 'scene' && (
              <div className="wm-binder-menu-row" role="group" aria-label={L('Status', 'Status')}>
                {(Object.keys(STATUS_LABEL) as Array<keyof typeof STATUS_LABEL>).map((status) => (
                  <button key={status} type="button" className={node.status === status ? 'is-on' : ''} onClick={() => onPatch(node.id, { status: node.status === status ? undefined : status })}>{L(...STATUS_LABEL[status])}</button>
                ))}
              </div>
            )}
            <div className="wm-swatches" role="group" aria-label={L('Label-Farbe', 'Label colour')}>
              {LABEL_COLORS.map((color) => <button key={color} type="button" className={node.label === color ? 'is-on' : ''} style={{ background: color }} aria-label={color} onClick={() => onPatch(node.id, { label: color })} />)}
              <button type="button" className="wm-swatch-clear" aria-label={L('Keine Farbe', 'No colour')} onClick={() => onPatch(node.id, { label: undefined })}><X size={12} /></button>
            </div>
            <button type="button" role="menuitem" onClick={() => { onPatch(node.id, { exclude: node.exclude ? undefined : true }); setMenu(null) }}>
              {node.exclude ? L('Wieder ins Manuskript', 'Include in the manuscript') : L('Vom Manuskript ausschliessen', 'Exclude from the manuscript')}
            </button>
            <button type="button" role="menuitem" className="is-danger" onClick={() => { onTrash(node.id); setMenu(null) }}><Trash2 size={12} /> {L('In den Papierkorb', 'Move to trash')}</button>
          </div>
        )}
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
      <p className="wm-binder-hint">{L('Ziehen zum Umordnen', 'Drag to reorder')}</p>
    </nav>
  )
})

export default WritingMode
