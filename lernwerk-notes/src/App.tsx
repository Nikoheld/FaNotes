import {
  ArrowLeft,
  Bot,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Command,
  Database,
  Download,
  FilePlus2,
  Files,
  FileUp,
  FolderOpen,
  FolderPlus,
  Info,
  LoaderCircle,
  LayoutGrid,
  Maximize2,
  MoreHorizontal,
  Network,
  NotebookTabs,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Plus,
  Save,
  ScanLine,
  Search,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react'
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PaletteAction } from './components/CommandPalette'
import type { DrawingBoardHandle, DrawingSavePayload } from './components/DrawingBoard'
import { FileTree } from './components/FileTree'
import { FormattingToolbar } from './components/FormattingToolbar'
import type { GlyphenWerkView } from './components/GlyphenWerkWorkspace'
import type { MarkdownEditorHandle, MarkdownFormatAction } from './components/MarkdownEditor'
import type { WorksheetLayerHandle } from './components/WorksheetLayer'
import { DEFAULT_SETTINGS } from './defaults'
import { applyRendererResourceLimits } from './lib/resourceLimits'
import { setUiLanguage, translateUiText } from './i18n'
import { bestContrastText, ensureReadableColor } from './lib/colorContrast'
import type { AppSettings, BootstrapData, DetectedTextLanguage, DrawingLibraryDocument, NoteTab, OneNoteImportResult, SearchHit, UpdateState, VaultEntry, WorksheetDocument } from './types'

const DrawingBoard = lazy(() => import('./components/DrawingBoard').then((module) => ({ default: module.DrawingBoard })))
const FirstRunOnboarding = lazy(() => import('./components/FirstRunOnboarding').then((module) => ({ default: module.FirstRunOnboarding })))
const GlyphenWerkWorkspace = lazy(() => import('./components/GlyphenWerkWorkspace').then((module) => ({ default: module.GlyphenWerkWorkspace })))
const CommandPalette = lazy(() => import('./components/CommandPalette').then((module) => ({ default: module.CommandPalette })))
const AiPanel = lazy(() => import('./components/AiPanel').then((module) => ({ default: module.AiPanel })))
type MarkdownEditorModule = { default: typeof import('./components/MarkdownEditor')['MarkdownEditor'] }
let markdownEditorModulePromise: Promise<MarkdownEditorModule> | null = null
const loadMarkdownEditor = () => {
  markdownEditorModulePromise ??= import('./components/MarkdownEditor')
    .then((module) => ({ default: module.MarkdownEditor }))
  return markdownEditorModulePromise
}
const MarkdownEditor = lazy(loadMarkdownEditor)
const RightInspector = lazy(() => import('./components/RightInspector').then((module) => ({ default: module.RightInspector })))
const SearchPanel = lazy(() => import('./components/SearchPanel').then((module) => ({ default: module.SearchPanel })))
const SettingsModal = lazy(() => import('./components/SettingsModal').then((module) => ({ default: module.SettingsModal })))
const VaultOverview = lazy(() => import('./components/VaultOverview').then((module) => ({ default: module.VaultOverview })))
const WorksheetLayer = lazy(() => import('./components/WorksheetLayer').then((module) => ({ default: module.WorksheetLayer })))
const StableWorksheetLayer = memo(WorksheetLayer)
const STARTUP_TREE_REFRESH_DELAY_MS = 18_000
const STARTUP_DOCUMENT_LAYER_DELAY_MS = 900
type AppProps = { startupBootstrap?: Promise<BootstrapData> }

type SaveState = 'saved' | 'saving' | 'error'
type Toast = { id: number; kind: 'success' | 'error' | 'info'; message: string }
type DrawingSession = { key: number; document: DrawingLibraryDocument | null }
type WorksheetSession = { key: number; documents: WorksheetDocument[] }
type NoteTabButtonProps = {
  active: boolean
  dirty: boolean
  path: string
  title: string
  onOpen: (path: string) => void | Promise<void>
  onClose: (path: string) => void | Promise<void>
}

const NoteTabButton = memo(function NoteTabButton({ active, dirty, path, title, onOpen, onClose }: NoteTabButtonProps) {
  const tabRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active) tabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  return (
    <div ref={tabRef} className={`note-tab ${active ? 'active' : ''}`} title={path}>
      <button
        type="button"
        className="note-tab-main"
        role="tab"
        aria-selected={active}
        aria-label={`${title}${dirty ? ', nicht gespeicherte Änderungen' : ''}`}
        onClick={() => { void onOpen(path) }}
        onAuxClick={(event) => { if (event.button === 1) void onClose(path) }}
      >
        <Files aria-hidden="true" size={13} />
        <span>{title}</span>
        {dirty && <i className="dirty-dot" title="Noch nicht gespeichert" />}
      </button>
      <button className="tab-close" type="button" aria-label={`${title} schließen`} title="Tab schließen (Strg+W)" onClick={() => { void onClose(path) }}><X aria-hidden="true" size={12} /></button>
    </div>
  )
})

const INITIAL_UPDATE_STATE: UpdateState = {
  status: 'idle',
  supported: false,
  currentVersion: '2026.7.4-beta.4',
  latestVersion: null,
  publishedAt: null,
  releaseNotes: [],
  downloadedBytes: 0,
  totalBytes: 0,
  progress: 0,
  error: null,
  checkedAt: null,
  installationKind: 'managed-appimage',
  autoCheckUpdates: true,
  autoDownloadUpdates: true,
  installUpdatesOnQuit: true,
  updateChannel: 'stable',
}

const stripExtension = (name: string) => name.replace(/\.md$/i, '')
const fileName = (path: string) => path.split('/').pop() ?? path
const parentPath = (path: string) => path.split('/').slice(0, -1).join('/')
const NOTE_INK_MARKER = /<!--\s*fanotes-ink:([a-zA-Z0-9_-]{1,96})\s*-->/u
const NOTE_WORKSHEET_MARKER = /<!--\s*fanotes-worksheet:([a-zA-Z0-9_-]{1,96})\s*-->/gu
const GLYPHENWERK_VIEW_LABELS: Record<GlyphenWerkView, string> = {
  capture: 'Training',
  test: 'Erkennung testen',
  collection: 'Sammlung',
  export: 'Exportieren',
}

const noteInkId = (content: string) => NOTE_INK_MARKER.exec(content)?.[1] ?? null

const attachNoteInk = (content: string, id: string) => {
  if (noteInkId(content)) return content
  const separator = content && !content.endsWith('\n') ? '\n\n' : content ? '\n' : ''
  return `${content}${separator}<!-- fanotes-ink:${id} -->\n`
}

const replaceNoteInk = (content: string, id: string) => noteInkId(content)
  ? content.replace(NOTE_INK_MARKER, `<!-- fanotes-ink:${id} -->`)
  : attachNoteInk(content, id)

const noteWorksheetIds = (content: string) => [...content.matchAll(NOTE_WORKSHEET_MARKER)].map((match) => match[1])

const attachWorksheet = (content: string, id: string) => {
  if (noteWorksheetIds(content).includes(id)) return content
  const separator = content && !content.endsWith('\n') ? '\n\n' : content ? '\n' : ''
  return `${content}${separator}<!-- fanotes-worksheet:${id} -->\n`
}

const stripNoteMetadata = (content: string) => content.replace(NOTE_INK_MARKER, '').replace(NOTE_WORKSHEET_MARKER, '')
const visibleNoteContent = (content: string) => stripNoteMetadata(content).trim()

const normalizePath = (value: string) => {
  const parts: string[] = []
  value.replace(/\\/g, '/').split('/').forEach((part) => {
    if (!part || part === '.') return
    if (part === '..') parts.pop()
    else parts.push(part)
  })
  return parts.join('/')
}

const relativeVaultPath = (fromFile: string, target: string) => {
  const from = parentPath(fromFile).split('/').filter(Boolean)
  const to = normalizePath(target).split('/').filter(Boolean)
  let shared = 0
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1
  return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/') || fileName(target)
}

const countEntries = (entries: VaultEntry[]): { files: number; folders: number } => entries.reduce((total, entry) => {
  if (entry.kind === 'file') total.files += 1
  else {
    total.folders += 1
    const children = countEntries(entry.children ?? [])
    total.files += children.files
    total.folders += children.folders
  }
  return total
}, { files: 0, folders: 0 })

const firstMarkdown = (entries: VaultEntry[]): string | undefined => {
  const welcome = entries.find((entry) => entry.kind === 'file' && entry.name.toLocaleLowerCase('de') === 'willkommen.md')
  if (welcome) return welcome.relativePath
  for (const entry of entries) {
    if (entry.kind === 'file' && (entry.extension === 'md' || entry.extension === '.md')) return entry.relativePath
    if (entry.kind === 'folder') {
      const nested = firstMarkdown(entry.children ?? [])
      if (nested) return nested
    }
  }
  return undefined
}

const folderPaths = (entries: VaultEntry[]): Set<string> => {
  const paths = new Set<string>()
  const visit = (items: VaultEntry[]) => items.forEach((entry) => {
    if (entry.kind === 'folder') {
      paths.add(entry.relativePath)
      visit(entry.children ?? [])
    }
  })
  visit(entries)
  return paths
}

const filePaths = (entries: VaultEntry[]): Set<string> => {
  const paths = new Set<string>()
  const visit = (items: VaultEntry[]) => items.forEach((entry) => {
    if (entry.kind === 'file') paths.add(entry.relativePath)
    else visit(entry.children ?? [])
  })
  visit(entries)
  return paths
}

const formatDate = (pattern: string, date = new Date()) => pattern
  .replaceAll('YYYY', String(date.getFullYear()))
  .replaceAll('YY', String(date.getFullYear()).slice(-2))
  .replaceAll('MM', String(date.getMonth() + 1).padStart(2, '0'))
  .replaceAll('DD', String(date.getDate()).padStart(2, '0'))

const hexRgb = (hex: string) => {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((part) => part + part).join('') : value
  const parsed = Number.parseInt(full, 16)
  if (!Number.isFinite(parsed)) return '139, 124, 255'
  return `${(parsed >> 16) & 255}, ${(parsed >> 8) & 255}, ${parsed & 255}`
}

const effectiveTheme = (settings: AppSettings, systemDark: boolean) => settings.theme === 'system'
  ? (systemDark ? 'dark' : 'light')
  : settings.theme

const THEME_CONTRAST_SURFACES: Record<string, string[]> = {
  dark: ['#0e0f14', '#14151d', '#171821', '#1d1e28'],
  light: ['#f4f3f7', '#eeedf2', '#faf9fc', '#ffffff'],
  midnight: ['#080d1b', '#0d1424', '#10182a', '#162139'],
  forest: ['#0c1411', '#111c17', '#15211b', '#1a2a22'],
  aurora: ['#100d1b', '#171226', '#1b152c', '#241b38'],
  sepia: ['#f2eadc', '#eae0cf', '#f8f0e3', '#fffaf0'],
}

const useSystemDark = () => {
  const [dark, setDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return dark
}

export default function App({ startupBootstrap }: AppProps) {
  const isWeb = window.lernwerk?.platform === 'web'
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null)
  const [tree, setTree] = useState<VaultEntry[]>([])
  const [tabs, setTabs] = useState<NoteTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [detectedTextLanguage, setDetectedTextLanguage] = useState<DetectedTextLanguage>('unknown')
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [inspectorVisible, setInspectorVisible] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [drawingOpen, setDrawingOpen] = useState(false)
  const [drawingSession, setDrawingSession] = useState<DrawingSession>({ key: 0, document: null })
  const [worksheetSession, setWorksheetSession] = useState<WorksheetSession>({ key: 0, documents: [] })
  const [worksheetImportOpen, setWorksheetImportOpen] = useState(false)
  const [worksheetImportBusy, setWorksheetImportBusy] = useState(false)
  const [oneNoteImportBusy, setOneNoteImportBusy] = useState(false)
  const [mutatingEntryPaths, setMutatingEntryPaths] = useState<string[]>([])
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [editorMenuOpen, setEditorMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [lmStudioOpen, setLmStudioOpen] = useState(false)
  const [glyphenWerkOpen, setGlyphenWerkOpen] = useState(false)
  const [glyphenWerkView, setGlyphenWerkView] = useState<GlyphenWerkView>('capture')
  const [glyphenWerkSampleCount, setGlyphenWerkSampleCount] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [focusToken, setFocusToken] = useState(0)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [updateState, setUpdateState] = useState<UpdateState>(INITIAL_UPDATE_STATE)
  const tabsRef = useRef(tabs)
  const activePathRef = useRef(activePath)
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const drawingBoardRef = useRef<DrawingBoardHandle>(null)
  const worksheetLayerRefs = useRef(new Map<string, WorksheetLayerHandle>())
  const worksheetLayerRefCallbacks = useRef(new Map<string, (handle: WorksheetLayerHandle | null) => void>())
  const worksheetDirtyCallbacks = useRef(new Map<string, (dirty: boolean) => void>())
  const focusRestoreRef = useRef({ sidebar: true, inspector: true })
  const treeRef = useRef(tree)
  const saveTimers = useRef(new Map<string, number>())
  const pendingWrites = useRef(new Map<string, string>())
  const settingsTimer = useRef<number | null>(null)
  const settingsRef = useRef(settings)
  const settingsRevisionRef = useRef(0)
  const settingsPersistedRevisionRef = useRef(0)
  const drawingOpenRef = useRef(drawingOpen)
  const drawingDirtyRef = useRef(false)
  const drawingLoadRequestRef = useRef(0)
  const worksheetLoadRequestRef = useRef(0)
  const initialDrawingLoadRef = useRef(true)
  const initialWorksheetLoadRef = useRef(true)
  const worksheetDirtyIdsRef = useRef(new Set<string>())
  const closeInProgressRef = useRef(false)
  const mutatingEntryPathsRef = useRef(new Set<string>())
  const vaultSessionGenerationRef = useRef(0)
  const vaultStructureRevisionRef = useRef(0)
  const vaultSwitchInProgressRef = useRef(false)
  const searchRequestRef = useRef(0)
  const openingNotesRef = useRef(new Set<string>())
  const toastCounter = useRef(0)
  const updateStatusRef = useRef<UpdateState['status']>('idle')
  const secureSettingsLoadRef = useRef<Promise<void> | null>(null)
  const systemDark = useSystemDark()

  useEffect(() => {
    const root = document.documentElement
    const synchronize = () => root.classList.toggle('fanotes-energy-idle', document.hidden || !document.hasFocus())
    synchronize()
    document.addEventListener('visibilitychange', synchronize)
    window.addEventListener('focus', synchronize)
    window.addEventListener('blur', synchronize)
    return () => {
      root.classList.remove('fanotes-energy-idle')
      document.removeEventListener('visibilitychange', synchronize)
      window.removeEventListener('focus', synchronize)
      window.removeEventListener('blur', synchronize)
    }
  }, [])

  useEffect(() => { tabsRef.current = tabs }, [tabs])
  useEffect(() => { activePathRef.current = activePath }, [activePath])
  useEffect(() => { setDetectedTextLanguage('unknown') }, [activePath])
  useEffect(() => { treeRef.current = tree }, [tree])
  useEffect(() => { settingsRef.current = settings }, [settings])
  useEffect(() => {
    applyRendererResourceLimits(settings)
  }, [settings.desktopOcrModel, settings.ocrModelKeepAliveSeconds, settings.ocrThreadLimit])
  useEffect(() => {
    if (bootstrap) void setUiLanguage(settings.uiLanguage)
  }, [bootstrap, settings.uiLanguage])
  useEffect(() => { drawingOpenRef.current = drawingOpen }, [drawingOpen])
  useEffect(() => {
    if (!editorMenuOpen) return
    const close = () => setEditorMenuOpen(false)
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [editorMenuOpen])
  const activeTab = useMemo(() => tabs.find((tab) => tab.path === activePath) ?? null, [activePath, tabs])
  const activeEntryMutating = useMemo(() => Boolean(activePath && mutatingEntryPaths.some(
    (path) => activePath === path || activePath.startsWith(`${path}/`),
  )), [activePath, mutatingEntryPaths])
  const counts = useMemo(() => countEntries(tree), [tree])
  const vaultNoteReferences = useMemo(() => lmStudioOpen ? [...filePaths(tree)]
    .filter((path) => path !== activePath)
    .map((path) => ({ title: stripExtension(fileName(path)), relativePath: path })) : [], [activePath, lmStudioOpen, tree])
  const lmStudioNote = useMemo(() => lmStudioOpen && activeTab ? {
    title: activeTab.title,
    relativePath: activeTab.path,
    markdown: visibleNoteContent(pendingWrites.current.get(activeTab.path) ?? activeTab.content),
  } : null, [activeTab, lmStudioOpen])
  const activeWordCount = useMemo(() => {
    if (!settings.showWordCount || !activeTab) return 0
    const visible = visibleNoteContent(activeTab.content)
    return visible ? visible.split(/\s+/u).length : 0
  }, [activeTab, settings.showWordCount])

  useEffect(() => {
    const requestId = ++drawingLoadRequestRef.current
    drawingDirtyRef.current = false
    drawingOpenRef.current = false
    setDrawingOpen(false)
    setDrawingSession({ key: 0, document: null })
    const path = activeTab?.path
    const id = activeTab ? noteInkId(activeTab.content) : null
    const initialNoteLoad = Boolean(path && initialDrawingLoadRef.current)
    if (path) initialDrawingLoadRef.current = false
    if (!path || !id) return

    let idleId: number | null = null
    let startTimer: number | null = null
    const load = () => {
      void window.lernwerk.readDrawing(id)
        .then((document) => {
          if (requestId !== drawingLoadRequestRef.current || activePathRef.current !== path) return
          setDrawingSession({ key: requestId, document })
        })
        .catch(() => {
          // A stale or manually removed ink sidecar must never block the note.
        })
    }
    const schedule = () => {
      startTimer = null
      idleId = window.requestIdleCallback(load, { timeout: 1_500 })
    }
    if (initialNoteLoad) startTimer = window.setTimeout(schedule, STARTUP_DOCUMENT_LAYER_DELAY_MS)
    else schedule()
    return () => {
      if (startTimer !== null) window.clearTimeout(startTimer)
      if (idleId !== null) window.cancelIdleCallback(idleId)
    }
  }, [activeTab?.path])

  useEffect(() => {
    const requestId = ++worksheetLoadRequestRef.current
    worksheetDirtyIdsRef.current.clear()
    setWorksheetSession({ key: requestId, documents: [] })
    const path = activeTab?.path
    const ids = activeTab ? noteWorksheetIds(activeTab.content) : []
    const initialNoteLoad = Boolean(path && initialWorksheetLoadRef.current)
    if (path) initialWorksheetLoadRef.current = false
    if (!path || !ids.length) return
    let idleId: number | null = null
    let startTimer: number | null = null
    const load = () => {
      void Promise.allSettled(ids.map((id) => window.lernwerk.readWorksheet(id))).then((results) => {
        if (requestId !== worksheetLoadRequestRef.current || activePathRef.current !== path) return
        const documents = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
        setWorksheetSession({ key: requestId, documents })
      })
    }
    const schedule = () => {
      startTimer = null
      idleId = window.requestIdleCallback(load, { timeout: 1_500 })
    }
    if (initialNoteLoad) startTimer = window.setTimeout(schedule, STARTUP_DOCUMENT_LAYER_DELAY_MS)
    else schedule()
    return () => {
      if (startTimer !== null) window.clearTimeout(startTimer)
      if (idleId !== null) window.cancelIdleCallback(idleId)
    }
  }, [activeTab?.path])

  useEffect(() => {
    const activeIds = new Set(worksheetSession.documents.map((document) => document.id))
    for (const id of worksheetLayerRefCallbacks.current.keys()) {
      if (!activeIds.has(id)) worksheetLayerRefCallbacks.current.delete(id)
    }
    for (const id of worksheetDirtyCallbacks.current.keys()) {
      if (!activeIds.has(id)) worksheetDirtyCallbacks.current.delete(id)
    }
  }, [worksheetSession.documents])

  const toast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastCounter.current
    setToasts((current) => [...current.slice(-3), { id, kind, message }])
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), kind === 'error' ? 6500 : 4000)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id))
  }, [])

  useEffect(() => {
    let alive = true
    let idleId: number | null = null
    const applyUpdateState = (next: UpdateState) => {
      if (!alive) return
      const previous = updateStatusRef.current
      updateStatusRef.current = next.status
      setUpdateState(next)
      if (next.status === 'downloaded' && previous !== 'downloaded') {
        toast(`FaNotes ${next.latestVersion} ist geprüft und wird beim Beenden installiert.`, 'success')
      }
    }
    const unsubscribe = window.lernwerk?.onUpdateState(applyUpdateState) ?? (() => undefined)
    const loadInitialState = () => {
      idleId = null
      void window.lernwerk?.getUpdateState().then(applyUpdateState).catch(() => {})
    }
    idleId = window.requestIdleCallback(loadInitialState, { timeout: 5_000 })
    return () => {
      alive = false
      unsubscribe()
      if (idleId !== null) window.cancelIdleCallback(idleId)
    }
  }, [toast])

  const flushDrawing = useCallback(async () => {
    if (!drawingDirtyRef.current) return true
    try {
      await drawingBoardRef.current?.flush()
      drawingDirtyRef.current = false
      return true
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Handschrift konnte nicht gespeichert werden.', 'error')
      return false
    }
  }, [toast])

  const flushWorksheets = useCallback(async () => {
    if (!worksheetDirtyIdsRef.current.size) return true
    try {
      const dirtyIds = [...worksheetDirtyIdsRef.current]
      await Promise.all(dirtyIds.map((id) => {
        const layer = worksheetLayerRefs.current.get(id)
        if (!layer) throw new Error('Ein bearbeitetes Arbeitsblatt ist noch nicht vollständig geladen.')
        return layer.flush()
      }))
      dirtyIds.forEach((id) => worksheetDirtyIdsRef.current.delete(id))
      return true
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Arbeitsblatt-Antworten konnten nicht gespeichert werden.', 'error')
      return false
    }
  }, [toast])

  const flushDocumentLayers = useCallback(async () => {
    const [drawingSaved, worksheetsSaved] = await Promise.all([flushDrawing(), flushWorksheets()])
    return drawingSaved && worksheetsSaved
  }, [flushDrawing, flushWorksheets])

  const refreshTree = useCallback(async () => {
    const session = vaultSessionGenerationRef.current
    const nextTree = await window.lernwerk.getTree()
    if (session !== vaultSessionGenerationRef.current) return treeRef.current
    treeRef.current = nextTree
    setTree(nextTree)
    return nextTree
  }, [])

  const openNote = useCallback(async (path: string) => {
    if (activePathRef.current && activePathRef.current !== path && !await flushDocumentLayers()) return
    const session = vaultSessionGenerationRef.current
    const structureRevision = vaultStructureRevisionRef.current
    setOverviewOpen(false)
    setGlyphenWerkOpen(false)
    const existing = tabsRef.current.find((tab) => tab.path === path)
    if (existing) {
      setActivePath(path)
      setFocusToken((value) => value + 1)
      return
    }
    const requestKey = `${session}:${structureRevision}:${path}`
    if (openingNotesRef.current.has(requestKey)) return
    openingNotesRef.current.add(requestKey)
    try {
      const content = await window.lernwerk.readFile(path)
      if (
        session !== vaultSessionGenerationRef.current ||
        structureRevision !== vaultStructureRevisionRef.current
      ) return
      const tab: NoteTab = { path, title: stripExtension(fileName(path)), content, savedContent: content }
      setTabs((current) => current.some((item) => item.path === path) ? current : [...current, tab])
      setActivePath(path)
      setFocusToken((value) => value + 1)
    } catch (error) {
      if (
        session === vaultSessionGenerationRef.current &&
        structureRevision === vaultStructureRevisionRef.current
      ) {
        toast(error instanceof Error ? error.message : 'Notiz konnte nicht geöffnet werden.', 'error')
      }
    } finally {
      openingNotesRef.current.delete(requestKey)
    }
  }, [flushDocumentLayers, toast])

  useEffect(() => {
    if (!window.lernwerk) {
      setFatalError('Die sichere Desktop-Schnittstelle fehlt. Bitte FaNotes als Desktop-App und nicht als normale Webseite starten.')
      return
    }
    let alive = true
    let freshTreeTimer: number | null = null
    let freshTreeIdle: number | null = null
    let editorWarmupFrame: number | null = null
    void (async () => {
      try {
        // Desktop starts this tiny config IPC while the English catalog is
        // loading. That overlaps independent I/O without moving any heavy
        // editor, recognition, updater, or vault work into the start phase.
        const data = await (startupBootstrap ?? window.lernwerk.bootstrap())
        if (!alive) return
        setBootstrap(data)
        setSettings({ ...DEFAULT_SETTINGS, ...data.settings })
        if (data.onboardingRequired) return
        // Let the shell paint first, then parse the editor chunk in parallel
        // with local tree-cache/NAS work. The shared promise also prevents the
        // later React.lazy render from scheduling a duplicate module request.
        editorWarmupFrame = window.requestAnimationFrame(() => { void loadMarkdownEditor() })
        try {
          const loadFreshTree = async () => {
            let nextTree = await window.lernwerk.getTree()
            if (!alive) return
            let nextNote = firstMarkdown(nextTree)
            if (!nextNote) {
              // Only a verified live scan may decide that the vault is empty.
              // A stale empty cache must never create a surprise note.
              const created = await window.lernwerk.createNote(undefined, translateUiText('Erste Notiz'))
              if (!alive) return
              nextTree = await window.lernwerk.getTree()
              nextNote = created.relativePath
            }
            treeRef.current = nextTree
            setTree(nextTree)
            if (nextNote && !activePathRef.current) await openNote(nextNote)
          }

          const cachedTree = await window.lernwerk.getCachedTree().catch(() => null)
          if (!alive) return
          const startupTree = cachedTree ?? await window.lernwerk.getFastTree()
          if (!alive) return
          if (startupTree.length) {
            treeRef.current = startupTree
            setTree(startupTree)
            const startupNote = firstMarkdown(startupTree)
            if (startupNote) await openNote(startupNote)

            // Cached starts and the first optimized Dirent scan both receive
            // full timestamps/sizes only after the note is already editable.
            freshTreeTimer = window.setTimeout(() => {
              freshTreeIdle = window.requestIdleCallback(() => {
                void loadFreshTree().catch((error) => {
                  if (alive) toast(error instanceof Error ? error.message : 'Der Vault konnte nicht aktualisiert werden.', 'error')
                })
              }, { timeout: 30_000 })
            }, STARTUP_TREE_REFRESH_DELAY_MS)
          } else {
            await loadFreshTree()
          }
        } catch (error) {
          if (alive) toast(
            `${error instanceof Error ? error.message : 'Der Vault ist nicht erreichbar.'} Du kannst in den Einstellungen einen anderen Vault wählen.`,
            'error',
          )
        }
      } catch (error) {
        if (alive) setFatalError(error instanceof Error ? error.message : 'FaNotes konnte nicht gestartet werden.')
      }
    })()
    return () => {
      alive = false
      if (freshTreeTimer !== null) window.clearTimeout(freshTreeTimer)
      if (freshTreeIdle !== null) window.cancelIdleCallback(freshTreeIdle)
      if (editorWarmupFrame !== null) window.cancelAnimationFrame(editorWarmupFrame)
    }
  }, [openNote, startupBootstrap, toast])

  useEffect(() => {
    if (!bootstrap) return
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => window.lernwerk.reportRendererReady())
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [bootstrap?.vaultPath, bootstrap?.onboardingRequired])

  const completeOnboarding = useCallback(async (subjects: string[]) => {
    const data = await window.lernwerk.completeOnboarding(subjects)
    setBootstrap(data)
    setSettings({ ...DEFAULT_SETTINGS, ...data.settings })
    let initialTree = await window.lernwerk.getTree()
    let initialNote = firstMarkdown(initialTree)
    if (!initialNote) {
      const created = await window.lernwerk.createNote(undefined, translateUiText('Erste Notiz'))
      initialTree = await window.lernwerk.getTree()
      initialNote = created.relativePath
    }
    treeRef.current = initialTree
    setTree(initialTree)
    if (initialNote) await openNote(initialNote)
  }, [openNote])

  const saveContent = useCallback(async (path: string, content: string): Promise<boolean> => {
    const timer = saveTimers.current.get(path)
    if (timer) window.clearTimeout(timer)
    saveTimers.current.delete(path)
    setSaveState('saving')
    try {
      await window.lernwerk.writeFile(path, content)
      if (pendingWrites.current.get(path) === content) pendingWrites.current.delete(path)
      setTabs((current) => current.map((tab) => tab.path === path ? { ...tab, savedContent: content } : tab))
      setSaveState(pendingWrites.current.size ? 'saving' : 'saved')
      return true
    } catch (error) {
      setSaveState('error')
      toast(error instanceof Error ? error.message : 'Speichern fehlgeschlagen.', 'error')
      return false
    }
  }, [toast])

  const flushPendingWrites = useCallback(async (): Promise<boolean> => {
    editorRef.current?.flushChanges()
    saveTimers.current.forEach((timer) => window.clearTimeout(timer))
    saveTimers.current.clear()

    // A new edit can arrive while an earlier IPC write is in flight. Repeat
    // with the latest snapshots instead of silently dropping that newer edit.
    for (let pass = 0; pass < 8; pass += 1) {
      const pending = [...pendingWrites.current.entries()]
      if (!pending.length) return true
      const results = await Promise.all(pending.map(([path, content]) => saveContent(path, content)))
      if (results.some((saved) => !saved)) return false
    }
    return pendingWrites.current.size === 0
  }, [saveContent])

  const saveCurrentWork = useCallback(async (announce = false): Promise<boolean> => {
    if (!activePathRef.current) {
      if (announce) toast('Öffne zuerst eine Notiz, die gespeichert werden kann.', 'info')
      return false
    }
    const documentLayersSaved = await flushDocumentLayers()
    const notesSaved = documentLayersSaved && await flushPendingWrites()
    if (notesSaved) {
      setSaveState('saved')
      if (announce) toast('Alles sicher gespeichert.', 'success')
      return true
    }
    if (documentLayersSaved) toast('Die Notiz konnte nicht vollständig gespeichert werden.', 'error')
    return false
  }, [flushDocumentLayers, flushPendingWrites, toast])

  const flushPendingEntry = useCallback(async (entryPath: string): Promise<boolean> => {
    const belongsToEntry = (candidate: string) => candidate === entryPath || candidate.startsWith(`${entryPath}/`)
    if (activePathRef.current && belongsToEntry(activePathRef.current)) editorRef.current?.flushChanges()
    ;[...saveTimers.current.entries()].forEach(([path, timer]) => {
      if (!belongsToEntry(path)) return
      window.clearTimeout(timer)
      saveTimers.current.delete(path)
    })
    for (let pass = 0; pass < 8; pass += 1) {
      const pending = [...pendingWrites.current.entries()].filter(([path]) => belongsToEntry(path))
      if (!pending.length) return true
      const results = await Promise.all(pending.map(([path, content]) => saveContent(path, content)))
      if (results.some((saved) => !saved)) return false
    }
    return ![...pendingWrites.current.keys()].some(belongsToEntry)
  }, [saveContent])

  const flushSettings = useCallback(async (): Promise<boolean> => {
    for (let pass = 0; pass < 8; pass += 1) {
      if (settingsTimer.current) window.clearTimeout(settingsTimer.current)
      settingsTimer.current = null
      const revision = settingsRevisionRef.current
      const snapshot = settingsRef.current
      try {
        const persisted = await window.lernwerk.saveSettings(snapshot)
        settingsPersistedRevisionRef.current = Math.max(settingsPersistedRevisionRef.current, revision)
        if (settingsRevisionRef.current === revision) {
          settingsRef.current = persisted
          return true
        }
        // A newer setting arrived while the IPC was in flight. Loop and save
        // that generation before allowing a Vault switch or process close.
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Einstellungen konnten nicht gespeichert werden.', 'error')
        return false
      }
    }
    return settingsPersistedRevisionRef.current >= settingsRevisionRef.current
  }, [toast])

  const resetAppData = useCallback(async () => {
    if (settingsTimer.current) window.clearTimeout(settingsTimer.current)
    settingsTimer.current = null
    const layersSaved = await flushDocumentLayers()
    const notesSaved = layersSaved && await flushPendingWrites()
    if (!notesSaved) throw new Error('Offene Änderungen konnten nicht gespeichert werden. Der Reset wurde abgebrochen.')
    await window.lernwerk.resetAppData()
  }, [flushDocumentLayers, flushPendingWrites])

  const updateContent = useCallback((content: string) => {
    if (!activePath) return
    if ([...mutatingEntryPathsRef.current].some((path) => activePath === path || activePath.startsWith(`${path}/`))) return
    setTabs((current) => current.map((tab) => tab.path === activePath ? { ...tab, content } : tab))
    pendingWrites.current.set(activePath, content)
    setSaveState('saving')
    const existing = saveTimers.current.get(activePath)
    if (existing) window.clearTimeout(existing)
    const timer = window.setTimeout(() => { void saveContent(activePath, content) }, settings.autosaveDelay)
    saveTimers.current.set(activePath, timer)
  }, [activePath, saveContent, settings.autosaveDelay])

  const closeTab = useCallback(async (path: string) => {
    if (activePathRef.current === path) editorRef.current?.flushChanges()
    if (activePathRef.current === path && !await flushDocumentLayers()) return
    const currentTabs = tabsRef.current
    const closing = currentTabs.find((tab) => tab.path === path)
    const latestContent = pendingWrites.current.get(path) ?? closing?.content
    if (closing && latestContent !== undefined && latestContent !== closing.savedContent) {
      // pendingWrites is updated synchronously by CodeMirror and can be newer
      // than tabsRef until React's passive effect runs. Never overwrite it
      // with the stale tab snapshot during a rapid type-and-close gesture.
      pendingWrites.current.set(closing.path, latestContent)
      const saved = await saveContent(closing.path, latestContent)
      // Keep the tab open after an I/O failure or if the user produced a newer
      // edit while this save was in flight.
      if (!saved || pendingWrites.current.has(closing.path)) return
    }
    setTabs((current) => current.filter((tab) => tab.path !== path))
    setActivePath((currentActive) => {
      if (currentActive !== path) return currentActive
      const latestTabs = tabsRef.current
      const latestIndex = latestTabs.findIndex((tab) => tab.path === path)
      const remaining = latestTabs.filter((tab) => tab.path !== path)
      return remaining[Math.min(Math.max(latestIndex, 0), remaining.length - 1)]?.path ?? null
    })
  }, [flushDocumentLayers, saveContent])

  const cycleTabs = useCallback((direction: 1 | -1) => {
    const currentTabs = tabsRef.current
    if (currentTabs.length < 2) return
    const currentIndex = Math.max(0, currentTabs.findIndex((tab) => tab.path === activePathRef.current))
    const nextIndex = (currentIndex + direction + currentTabs.length) % currentTabs.length
    void openNote(currentTabs[nextIndex].path)
  }, [openNote])

  const createNote = useCallback(async (parent?: string) => {
    const session = vaultSessionGenerationRef.current
    vaultStructureRevisionRef.current += 1
    try {
      const result = await window.lernwerk.createNote(parent ?? (settings.defaultFolder || undefined))
      if (session !== vaultSessionGenerationRef.current) return
      vaultStructureRevisionRef.current += 1
      await refreshTree()
      if (session !== vaultSessionGenerationRef.current) return
      await openNote(result.relativePath)
      toast('Neue Markdown-Notiz erstellt.', 'success')
    } catch (error) {
      if (session !== vaultSessionGenerationRef.current) return
      // If a configured default folder does not exist, create at root instead.
      try {
        const result = await window.lernwerk.createNote(parent)
        if (session !== vaultSessionGenerationRef.current) return
        vaultStructureRevisionRef.current += 1
        await refreshTree()
        if (session !== vaultSessionGenerationRef.current) return
        await openNote(result.relativePath)
        toast('Neue Markdown-Notiz erstellt.', 'success')
      } catch {
        if (session === vaultSessionGenerationRef.current) {
          toast(error instanceof Error ? error.message : 'Notiz konnte nicht erstellt werden.', 'error')
        }
      }
    }
  }, [openNote, refreshTree, settings.defaultFolder, toast])

  const createFolder = useCallback(async (parent?: string) => {
    const session = vaultSessionGenerationRef.current
    vaultStructureRevisionRef.current += 1
    try {
      await window.lernwerk.createFolder(parent)
      if (session !== vaultSessionGenerationRef.current) return
      vaultStructureRevisionRef.current += 1
      await refreshTree()
      toast('Neuer Ordner erstellt.', 'success')
    } catch (error) {
      if (session === vaultSessionGenerationRef.current) toast(error instanceof Error ? error.message : 'Ordner konnte nicht erstellt werden.', 'error')
    }
  }, [refreshTree, toast])

  const setFolderColor = useCallback(async (path: string, color: string | null) => {
    const session = vaultSessionGenerationRef.current
    try {
      await window.lernwerk.setFolderColor(path, color)
      if (session !== vaultSessionGenerationRef.current) return
      await refreshTree()
      if (session !== vaultSessionGenerationRef.current) return
      toast(color ? 'Ordnerfarbe gespeichert.' : 'Ordnerfarbe auf Standard zurückgesetzt.', 'success')
    } catch (error) {
      if (session === vaultSessionGenerationRef.current) {
        toast(error instanceof Error ? error.message : 'Ordnerfarbe konnte nicht gespeichert werden.', 'error')
      }
    }
  }, [refreshTree, toast])

  const createDailyNote = useCallback(async () => {
    const session = vaultSessionGenerationRef.current
    vaultStructureRevisionRef.current += 1
    try {
      const segments = normalizePath(settings.dailyNotesFolder || translateUiText('Tagesnotizen')).split('/').filter(Boolean)
      const known = folderPaths(tree)
      let folder = ''
      for (const segment of segments) {
        const candidate = folder ? `${folder}/${segment}` : segment
        if (!known.has(candidate)) {
          const created = await window.lernwerk.createFolder(folder, segment)
          if (session !== vaultSessionGenerationRef.current) return
          vaultStructureRevisionRef.current += 1
          folder = created.relativePath
          known.add(folder)
        } else folder = candidate
      }
      const title = formatDate(settings.dateFormat || 'YYYY-MM-DD')
      const expectedPath = folder ? `${folder}/${title}.md` : `${title}.md`
      if (filePaths(tree).has(expectedPath)) {
        await openNote(expectedPath)
        if (session !== vaultSessionGenerationRef.current) return
        toast(`Tagesnotiz ${title} geöffnet.`, 'info')
        return
      }
      const result = await window.lernwerk.createNote(folder, title)
      if (session !== vaultSessionGenerationRef.current) return
      vaultStructureRevisionRef.current += 1
      await refreshTree()
      if (session !== vaultSessionGenerationRef.current) return
      await openNote(result.relativePath)
      toast(`Tagesnotiz ${title} ist bereit.`, 'success')
    } catch (error) {
      if (session === vaultSessionGenerationRef.current) toast(error instanceof Error ? error.message : 'Tagesnotiz konnte nicht erstellt werden.', 'error')
    }
  }, [openNote, refreshTree, settings.dailyNotesFolder, settings.dateFormat, toast, tree])

  const renameEntry = useCallback(async (path: string, nextName: string) => {
    const session = vaultSessionGenerationRef.current
    vaultStructureRevisionRef.current += 1
    const nextPath = await window.lernwerk.renameEntry(path, nextName)
    if (session !== vaultSessionGenerationRef.current) return
    vaultStructureRevisionRef.current += 1
    ;[...saveTimers.current.entries()].forEach(([timerPath, timer]) => {
      if (timerPath === path || timerPath.startsWith(`${path}/`)) {
        window.clearTimeout(timer)
        saveTimers.current.delete(timerPath)
      }
    })
    setTabs((current) => current.map((tab) => {
      if (tab.path !== path && !tab.path.startsWith(`${path}/`)) return tab
      const renamedPath = tab.path === path ? nextPath : `${nextPath}${tab.path.slice(path.length)}`
      return { ...tab, path: renamedPath, title: stripExtension(fileName(renamedPath)) }
    }))
    const pending = [...pendingWrites.current.entries()]
    const renamedPending: [string, string][] = []
    pending.forEach(([pendingPath, content]) => {
      if (pendingPath !== path && !pendingPath.startsWith(`${path}/`)) return
      pendingWrites.current.delete(pendingPath)
      const renamedPath = pendingPath === path ? nextPath : `${nextPath}${pendingPath.slice(path.length)}`
      pendingWrites.current.set(renamedPath, content)
      renamedPending.push([renamedPath, content])
    })
    setActivePath((current) => current && (current === path || current.startsWith(`${path}/`))
      ? `${nextPath}${current.slice(path.length)}`
      : current)
    await refreshTree()
    await Promise.all(renamedPending.map(([renamedPath, content]) => saveContent(renamedPath, content)))
  }, [refreshTree, saveContent])

  const trashEntry = useCallback(async (path: string) => {
    const session = vaultSessionGenerationRef.current
    vaultStructureRevisionRef.current += 1
    let mutationMarked = false
    try {
      const saved = await flushPendingEntry(path)
      if (session !== vaultSessionGenerationRef.current) return
      if (!saved) {
        toast('Verschieben abgebrochen: Die letzten Änderungen konnten nicht sicher gespeichert werden.', 'error')
        return
      }
      mutatingEntryPathsRef.current.add(path)
      setMutatingEntryPaths((current) => current.includes(path) ? current : [...current, path])
      mutationMarked = true
      await window.lernwerk.trashEntry(path)
      if (session !== vaultSessionGenerationRef.current) return
      vaultStructureRevisionRef.current += 1
      ;[...saveTimers.current.entries()].forEach(([timerPath, timer]) => {
        if (timerPath === path || timerPath.startsWith(`${path}/`)) {
          window.clearTimeout(timer)
          saveTimers.current.delete(timerPath)
        }
      })
      ;[...pendingWrites.current.keys()].forEach((pendingPath) => {
        if (pendingPath === path || pendingPath.startsWith(`${path}/`)) pendingWrites.current.delete(pendingPath)
      })
      setTabs((current) => current.filter((tab) => tab.path !== path && !tab.path.startsWith(`${path}/`)))
      setActivePath((current) => current && (current === path || current.startsWith(`${path}/`)) ? null : current)
      await refreshTree()
      toast('In den Papierkorb verschoben.', 'success')
    } catch (error) {
      if (session === vaultSessionGenerationRef.current) {
        toast(error instanceof Error ? error.message : 'Der Eintrag konnte nicht in den Papierkorb verschoben werden.', 'error')
      }
    } finally {
      if (mutationMarked) {
        mutatingEntryPathsRef.current.delete(path)
        setMutatingEntryPaths((current) => current.filter((entryPath) => entryPath !== path))
      }
    }
  }, [flushPendingEntry, refreshTree, toast])

  const applySettings = useCallback((next: AppSettings) => {
    const revision = settingsRevisionRef.current + 1
    settingsRevisionRef.current = revision
    settingsRef.current = next
    setSettings(next)
    if (settingsTimer.current) window.clearTimeout(settingsTimer.current)
    const timer = window.setTimeout(() => {
      if (settingsTimer.current === timer) settingsTimer.current = null
      void window.lernwerk.saveSettings(next)
        .then(() => {
          settingsPersistedRevisionRef.current = Math.max(settingsPersistedRevisionRef.current, revision)
        })
        .catch(() => toast('Einstellungen konnten nicht gespeichert werden.', 'error'))
    }, 180)
    settingsTimer.current = timer
  }, [toast])

  const resetSettings = useCallback(() => {
    if (settingsTimer.current) window.clearTimeout(settingsTimer.current)
    settingsTimer.current = null
    const revision = settingsRevisionRef.current + 1
    settingsRevisionRef.current = revision
    settingsRef.current = { ...DEFAULT_SETTINGS }
    setSettings({ ...DEFAULT_SETTINGS })
    void window.lernwerk.saveSettings(DEFAULT_SETTINGS, { clearProtectedSecrets: true })
      .then((persisted) => {
        settingsPersistedRevisionRef.current = Math.max(settingsPersistedRevisionRef.current, revision)
        if (settingsRevisionRef.current !== revision) return
        secureSettingsLoadRef.current = null
        settingsRef.current = persisted
        setSettings(persisted)
        toast('Standardeinstellungen wiederhergestellt.', 'success')
      })
      .catch(() => toast('Die Standardeinstellungen konnten nicht gespeichert werden.', 'error'))
  }, [toast])

  const handleDrawingSettingsChange = useCallback((changes: Partial<AppSettings>) => {
    applySettings({ ...settingsRef.current, ...changes })
  }, [applySettings])

  const loadSecureSettings = useCallback(() => {
    if (!window.lernwerk.loadSecureSettings) return Promise.resolve()
    secureSettingsLoadRef.current ??= window.lernwerk.loadSecureSettings()
      .then((secrets) => {
        settingsRef.current = { ...settingsRef.current, ...secrets }
        setSettings((current) => ({ ...current, ...secrets }))
      })
      .catch((error) => {
        secureSettingsLoadRef.current = null
        throw error
      })
    return secureSettingsLoadRef.current
  }, [])

  const openLmStudio = useCallback(() => {
    setPaletteOpen(false)
    setSearchOpen(false)
    setGlyphenWerkOpen(false)
    void loadSecureSettings()
      .then(() => setLmStudioOpen(true))
      .catch((error) => toast(error instanceof Error ? error.message : 'Geschützte AI-Einstellungen konnten nicht geladen werden.', 'error'))
  }, [loadSecureSettings, toast])

  const applyLmStudioResult = useCallback((markdown: string, relativePath: string) => {
    if (!activeTab || activeTab.path !== relativePath) {
      toast('Die bearbeitete Notiz ist nicht mehr aktiv. Das KI-Ergebnis wurde nicht übernommen.', 'error')
      return
    }
    if (activeEntryMutating) {
      toast('Diese Notiz ist während der Dateiaktion schreibgeschützt.', 'error')
      return
    }
    const currentContent = pendingWrites.current.get(activeTab.path) ?? activeTab.content
    let nextContent = stripNoteMetadata(markdown.endsWith('\n') ? markdown : `${markdown}\n`)
    const inkId = noteInkId(currentContent)
    if (inkId) nextContent = attachNoteInk(nextContent, inkId)
    noteWorksheetIds(currentContent).forEach((id) => { nextContent = attachWorksheet(nextContent, id) })
    updateContent(nextContent)
    setFocusToken((value) => value + 1)
    toast('AI-Ergebnis übernommen und zum Speichern vorgemerkt.', 'success')
  }, [activeEntryMutating, activeTab, toast, updateContent])

  const selectVault = useCallback(async () => {
    if (vaultSwitchInProgressRef.current) return
    vaultSwitchInProgressRef.current = true
    try {
      const documentLayersSaved = await flushDocumentLayers()
      const [notesSaved, settingsSaved] = documentLayersSaved
        ? await Promise.all([flushPendingWrites(), flushSettings()])
        : [false, false]
      if (!notesSaved || !settingsSaved || !documentLayersSaved) {
        toast('Vault-Wechsel abgebrochen: Nicht alle Änderungen konnten sicher gespeichert werden.', 'error')
        return
      }
      const selected = await window.lernwerk.selectVault()
      if (!selected) return
      vaultSessionGenerationRef.current += 1
      searchRequestRef.current += 1
      treeRef.current = []
      setTree([])
      setSearchLoading(false)
      drawingDirtyRef.current = false
      drawingOpenRef.current = false
      drawingLoadRequestRef.current += 1
      worksheetLoadRequestRef.current += 1
      worksheetDirtyIdsRef.current.clear()
      setDrawingOpen(false)
      setDrawingSession((current) => ({ key: current.key + 1, document: null }))
      setWorksheetSession((current) => ({ key: current.key + 1, documents: [] }))
      setBootstrap(selected)
      const selectedSettings = { ...DEFAULT_SETTINGS, ...selected.settings }
      const selectedSettingsRevision = settingsRevisionRef.current + 1
      settingsRevisionRef.current = selectedSettingsRevision
      settingsPersistedRevisionRef.current = selectedSettingsRevision
      settingsRef.current = selectedSettings
      setSettings(selectedSettings)
      setTabs([])
      setActivePath(null)
      setSearchQuery('')
      setSearchHits([])
      const nextTree = await refreshTree()
      const first = firstMarkdown(nextTree)
      if (first) await openNote(first)
      toast(`Vault „${selected.vaultName}“ geöffnet.`, 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Der Vault konnte nicht sicher gewechselt werden.', 'error')
    } finally {
      vaultSwitchInProgressRef.current = false
    }
  }, [flushDocumentLayers, flushPendingWrites, flushSettings, openNote, refreshTree, toast])

  const checkForUpdates = useCallback(async () => {
    try {
      const next = await window.lernwerk.checkForUpdates()
      setUpdateState(next)
      if (next.status === 'up-to-date') toast(`FaNotes ${next.currentVersion} ist aktuell.`, 'success')
      else if (next.status === 'available') toast(`FaNotes ${next.latestVersion} ist verfügbar.`, 'info')
      else if (next.status === 'error' && next.error) toast(next.error, 'error')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Die Updateprüfung ist fehlgeschlagen.', 'error')
    }
  }, [toast])

  const downloadUpdate = useCallback(async () => {
    try {
      setUpdateState(await window.lernwerk.downloadUpdate())
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das Update konnte nicht heruntergeladen werden.', 'error')
    }
  }, [toast])

  const installUpdate = useCallback(async () => {
    try {
      const documentLayersSaved = await flushDocumentLayers()
      const [notesSaved, settingsSaved] = documentLayersSaved
        ? await Promise.all([flushPendingWrites(), flushSettings()])
        : [false, false]
      if (!notesSaved || !settingsSaved || !documentLayersSaved) {
        toast('Update abgebrochen: Nicht alle Änderungen konnten sicher gespeichert werden.', 'error')
        return
      }
      setUpdateState(await window.lernwerk.installUpdate())
      toast('FaNotes startet gleich mit der neuen Version neu.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das Update konnte nicht installiert werden.', 'error')
    }
  }, [flushDocumentLayers, flushPendingWrites, flushSettings, toast])

  useEffect(() => {
    const query = searchQuery.trim()
    const session = vaultSessionGenerationRef.current
    const requestId = ++searchRequestRef.current
    if (query.length < 2) { setSearchHits([]); setSearchLoading(false); return }
    setSearchLoading(true)
    const timer = window.setTimeout(() => {
      void window.lernwerk.search(query)
        .then((hits) => {
          if (session === vaultSessionGenerationRef.current && requestId === searchRequestRef.current) setSearchHits(hits)
        })
        .catch(() => {
          if (session === vaultSessionGenerationRef.current && requestId === searchRequestRef.current) setSearchHits([])
        })
        .finally(() => {
          if (session === vaultSessionGenerationRef.current && requestId === searchRequestRef.current) setSearchLoading(false)
        })
    }, 240)
    return () => window.clearTimeout(timer)
  }, [searchQuery])

  const toggleFocusMode = useCallback(() => {
    if (focusMode) {
      setSidebarVisible(focusRestoreRef.current.sidebar)
      setInspectorVisible(focusRestoreRef.current.inspector)
      setFocusMode(false)
      return
    }
    focusRestoreRef.current = { sidebar: sidebarVisible, inspector: inspectorVisible }
    setSidebarVisible(false)
    setInspectorVisible(false)
    setFocusMode(true)
  }, [focusMode, inspectorVisible, sidebarVisible])

  const formatMarkdown = useCallback((action: MarkdownFormatAction) => {
    if (!activePathRef.current || drawingOpen || overviewOpen) {
      toast('Öffne eine Notiz im Editor, um sie zu formatieren.', 'info')
      return
    }
    if (activeEntryMutating) {
      toast('Diese Notiz ist während der Dateiaktion schreibgeschützt.', 'error')
      return
    }
    if (!editorRef.current?.format(action)) toast('Die Formatierung konnte nicht angewandt werden.', 'error')
  }, [activeEntryMutating, drawingOpen, overviewOpen, toast])

  const handleDrawingDirtyChange = useCallback((dirty: boolean) => {
    drawingDirtyRef.current = dirty
  }, [])

  const closeDrawing = useCallback(() => {
    drawingOpenRef.current = false
    setDrawingOpen(false)
    return true
  }, [])

  useEffect(() => window.lernwerk?.onBeforeClose(() => {
    if (closeInProgressRef.current) return
    // Stop Main's watchdog while a deliberate renderer confirmation dialog is
    // open; after confirmation requestClose below arms it again for the flush.
    window.lernwerk.cancelClose()
    closeInProgressRef.current = true
    window.lernwerk.requestClose()
    void flushDocumentLayers()
      .then(async (documentLayersSaved) => {
        const [notesSaved, settingsSaved] = documentLayersSaved
          ? await Promise.all([flushPendingWrites(), flushSettings()])
          : [false, false]
        if (notesSaved && settingsSaved && documentLayersSaved) {
          drawingDirtyRef.current = false
          window.lernwerk.confirmClose()
          return
        }
        closeInProgressRef.current = false
        window.lernwerk.cancelClose()
        toast('Beenden abgebrochen: Deine Änderungen bleiben geöffnet und können erneut gespeichert werden.', 'error')
      })
      .catch((error) => {
        closeInProgressRef.current = false
        window.lernwerk.cancelClose()
        toast(error instanceof Error ? error.message : 'Beenden wurde wegen eines Speicherfehlers abgebrochen.', 'error')
      })
  }), [flushDocumentLayers, flushPendingWrites, flushSettings, toast])

  const openDrawing = useCallback(() => {
    if (!activeTab) {
      toast('Öffne zuerst eine Notiz, um darauf handschriftlich zu schreiben.', 'info')
      return
    }
    drawingOpenRef.current = true
    setOverviewOpen(false)
    setSearchOpen(false)
    setDrawingOpen(true)
    if (drawingSession.key > 0) return
    const id = noteInkId(activeTab.content)
    if (!id) {
      setDrawingSession({ key: 1, document: null })
      return
    }
    const requestId = ++drawingLoadRequestRef.current
    void window.lernwerk.readDrawing(id)
      .then((document) => {
        if (requestId !== drawingLoadRequestRef.current || activePathRef.current !== activeTab.path) return
        setDrawingSession({ key: requestId, document })
      })
      .catch(() => {
        if (requestId === drawingLoadRequestRef.current && activePathRef.current === activeTab.path) {
          setDrawingSession({ key: requestId, document: null })
        }
      })
  }, [activeTab, drawingSession.key, toast])

  const toggleDrawing = useCallback(() => {
    if (drawingOpenRef.current) closeDrawing()
    else {
      setGlyphenWerkOpen(false)
      openDrawing()
    }
  }, [closeDrawing, openDrawing])

  const openSearchHit = useCallback(async (hit: SearchHit) => {
    setSearchOpen(false)
    if (hit.kind !== 'drawing' || !hit.drawingId) {
      await openNote(hit.relativePath)
      return
    }

    if (!activeTab) {
      toast('Öffne eine Notiz, um die gefundene Handschrift darauf anzuzeigen.', 'info')
      return
    }
    try {
      const document = await window.lernwerk.readDrawing(hit.drawingId)
      if (activePathRef.current !== activeTab.path) return
      const currentContent = pendingWrites.current.get(activeTab.path) ?? activeTab.content
      const nextContent = replaceNoteInk(currentContent, document.id)
      if (nextContent !== currentContent) updateContent(nextContent)
      setDrawingSession((current) => ({ key: current.key + 1, document }))
      openDrawing()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Handschrift-Seite konnte nicht geöffnet werden.', 'error')
    }
  }, [activeTab, openDrawing, openNote, toast, updateContent])

  const showFiles = useCallback(() => {
    if (!closeDrawing()) return
    setSearchOpen(false)
    setOverviewOpen(false)
    setGlyphenWerkOpen(false)
    setSidebarVisible(true)
  }, [closeDrawing])

  const openOverview = useCallback(() => {
    if (!closeDrawing()) return
    setGlyphenWerkOpen(false)
    setOverviewOpen(true)
  }, [closeDrawing])

  const openGlyphenWerk = useCallback(() => {
    if (!closeDrawing()) return
    setPaletteOpen(false)
    setSearchOpen(false)
    setOverviewOpen(false)
    setLmStudioOpen(false)
    setSidebarVisible(true)
    setGlyphenWerkOpen(true)
  }, [closeDrawing])

  const openGlyphenWerkView = useCallback((view: GlyphenWerkView) => {
    setGlyphenWerkView(view)
    openGlyphenWerk()
  }, [openGlyphenWerk])

  const handleTrainingChanged = useCallback((sampleCount: number) => {
    if (sampleCount > 0) toast(`${sampleCount} persönliche Trainingsbeispiele sind aktiv.`, 'success')
  }, [toast])

  const handleGlyphenWerkTrainingChanged = useCallback(async (sampleCount: number) => {
    setGlyphenWerkSampleCount(sampleCount)
    if (drawingBoardRef.current) await drawingBoardRef.current.refreshTraining()
  }, [])

  const importTrainingFromSettings = useCallback(async (file: File) => {
    try {
      const { importGlyphenWerkZip, loadRecognitionResources } = await import('./lib/handwritingDb')
      const result = await importGlyphenWerkZip(file)
      const loaded = await loadRecognitionResources(true)
      if (drawingBoardRef.current) await drawingBoardRef.current.refreshTraining()
      const importedCount = result.importedSamples + result.importedLayoutExamples + result.importedLabels
      const warning = result.warnings[0] ? ` ${result.warnings[0]}` : ''
      toast(importedCount > 0
        ? `${result.importedSamples} Zeichen und ${result.importedLayoutExamples} Layout-Beispiele importiert. ${loaded.sampleCount} Beispiele sind jetzt aktiv.${warning}`
        : `Keine neuen Trainingsbeispiele gespeichert; Duplikate wurden ausgelassen.${warning}`,
      importedCount > 0 ? 'success' : 'info')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Training konnte nicht importiert werden.', 'error')
      throw error
    }
  }, [toast])

  const insertIntoNote = useCallback((value: string) => {
    const notePath = activePathRef.current
    const tab = notePath ? tabsRef.current.find((candidate) => candidate.path === notePath) : null
    if (!notePath || !tab) {
      toast('Öffne zuerst eine Notiz.', 'error')
      return false
    }
    if ([...mutatingEntryPathsRef.current].some((path) => notePath === path || notePath.startsWith(`${path}/`))) {
      toast('Diese Notiz wird gerade in den Papierkorb verschoben.', 'error')
      return false
    }
    const currentContent = pendingWrites.current.get(notePath) ?? tab.content
    const separator = currentContent && !currentContent.endsWith('\n') ? '\n\n' : ''
    updateContent(`${currentContent}${separator}${value}\n`)
    setFocusToken((current) => current + 1)
    toast('Handschrift wurde schön formatiert eingefügt.', 'success')
    return true
  }, [toast, updateContent])

  const saveDrawingAsset = useCallback(async (payload: DrawingSavePayload) => {
    const session = vaultSessionGenerationRef.current
    const notePath = activePath
    const asset = await window.lernwerk.saveDrawing(payload)
    let updatedAt = asset.updatedAt ?? new Date().toISOString()
    try {
      const drawingData = JSON.parse(payload.drawingJson) as { updatedAt?: unknown }
      if (!asset.updatedAt && typeof drawingData.updatedAt === 'string') updatedAt = drawingData.updatedAt
    } catch {
      // Main validates the JSON; this fallback only keeps the immediate UI resilient.
    }
    const document: DrawingLibraryDocument = {
      id: asset.id,
      title: asset.title ?? payload.title,
      updatedAt,
      imageRelativePath: asset.imageRelativePath,
      dataRelativePath: asset.dataRelativePath,
      drawingJson: payload.drawingJson,
    }
    const imagePath = activePath ? relativeVaultPath(activePath, asset.imageRelativePath) : asset.imageRelativePath
    const safeTitle = payload.title.replace(/[\[\]]/g, '') || 'Handschrift'
    const result = { ...asset, markdown: `![${safeTitle}](${imagePath})` }
    if (session !== vaultSessionGenerationRef.current) return result
    if (notePath) {
      const tab = tabsRef.current.find((candidate) => candidate.path === notePath)
      const currentContent = pendingWrites.current.get(notePath) ?? tab?.content ?? ''
      const nextContent = attachNoteInk(currentContent, asset.id)
      if (nextContent !== currentContent) {
        setTabs((current) => current.map((candidate) => candidate.path === notePath ? { ...candidate, content: nextContent } : candidate))
        pendingWrites.current.set(notePath, nextContent)
        const existingTimer = saveTimers.current.get(notePath)
        if (existingTimer) window.clearTimeout(existingTimer)
        const timer = window.setTimeout(() => { void saveContent(notePath, nextContent) }, settingsRef.current.autosaveDelay)
        saveTimers.current.set(notePath, timer)
      }
    }
    if (activePathRef.current !== notePath) return result
    setDrawingSession((current) => ({ ...current, document }))
    return result
  }, [activePath, saveContent])

  const saveWorksheetDocument = useCallback(async (document: WorksheetDocument) => {
    const session = vaultSessionGenerationRef.current
    const saved = await window.lernwerk.saveWorksheet(document)
    if (session === vaultSessionGenerationRef.current) {
      setWorksheetSession((current) => ({ ...current, documents: current.documents.map((item) => item.id === saved.id ? saved : item) }))
    }
    return saved
  }, [])

  const handleWorksheetDirtyChange = useCallback((id: string, dirty: boolean) => {
    if (dirty) worksheetDirtyIdsRef.current.add(id)
    else worksheetDirtyIdsRef.current.delete(id)
  }, [])

  const worksheetLayerRefFor = useCallback((id: string) => {
    let callback = worksheetLayerRefCallbacks.current.get(id)
    if (!callback) {
      callback = (handle) => {
        if (handle) worksheetLayerRefs.current.set(id, handle)
        else worksheetLayerRefs.current.delete(id)
      }
      worksheetLayerRefCallbacks.current.set(id, callback)
    }
    return callback
  }, [])

  const worksheetDirtyCallbackFor = useCallback((id: string) => {
    let callback = worksheetDirtyCallbacks.current.get(id)
    if (!callback) {
      callback = (dirty) => handleWorksheetDirtyChange(id, dirty)
      worksheetDirtyCallbacks.current.set(id, callback)
    }
    return callback
  }, [handleWorksheetDirtyChange])

  const openWorksheetImport = useCallback(() => {
    setSearchOpen(false)
    setOverviewOpen(false)
    setWorksheetImportOpen(true)
  }, [])

  const importWorksheet = useCallback(async (target: 'current' | 'new') => {
    if (worksheetImportBusy) return
    if (target === 'current' && !activeTab) {
      toast('Öffne zuerst eine Notiz oder wähle „Neue Notiz“.', 'info')
      return
    }
    const targetPath = target === 'current' ? activeTab!.path : null
    setWorksheetImportBusy(true)
    setWorksheetImportOpen(false)
    try {
      const document = await window.lernwerk.importWorksheet()
      if (!document) return
      if (target === 'new') {
        vaultStructureRevisionRef.current += 1
        const created = await window.lernwerk.createNote(settings.defaultFolder || undefined, document.title)
        const initialContent = await window.lernwerk.readFile(created.relativePath)
        const nextContent = attachWorksheet(initialContent, document.id)
        await window.lernwerk.writeFile(created.relativePath, nextContent)
        await refreshTree()
        await openNote(created.relativePath)
        setWorksheetSession((current) => ({ key: current.key + 1, documents: [document] }))
        toast(`Arbeitsblatt „${document.title}“ wurde als neue Notiz angelegt.`, 'success')
        return
      }
      if (!targetPath) return
      if (activePathRef.current === targetPath) {
        const tab = tabsRef.current.find((item) => item.path === targetPath)
        const currentContent = pendingWrites.current.get(targetPath) ?? tab?.content ?? ''
        const nextContent = attachWorksheet(currentContent, document.id)
        updateContent(nextContent)
        setWorksheetSession((current) => current.documents.some((item) => item.id === document.id)
          ? current
          : { key: current.key + 1, documents: [...current.documents, document] })
      } else {
        const currentContent = await window.lernwerk.readFile(targetPath)
        await window.lernwerk.writeFile(targetPath, attachWorksheet(currentContent, document.id))
      }
      toast(`Arbeitsblatt „${document.title}“ wurde in die Notiz eingefügt.`, 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das Arbeitsblatt konnte nicht importiert werden.', 'error')
    } finally {
      setWorksheetImportBusy(false)
    }
  }, [activeTab, openNote, refreshTree, settings.defaultFolder, toast, updateContent, worksheetImportBusy])

  const importOneNote = useCallback(async (): Promise<OneNoteImportResult | null> => {
    if (oneNoteImportBusy) return null
    if (isWeb) throw new Error('Binäre OneNote-Notizbücher werden sicher in der Linux- oder Windows-App importiert.')
    setOneNoteImportBusy(true)
    setWorksheetImportOpen(false)
    try {
      const result = await window.lernwerk.importOneNote()
      if (!result) return null
      vaultStructureRevisionRef.current += 1
      await refreshTree()
      if (result.importedNotes[0]) await openNote(result.importedNotes[0])
      toast(`${result.pageCount} ${result.pageCount === 1 ? 'OneNote-Seite' : 'OneNote-Seiten'} layoutgetreu importiert.`, 'success')
      return result
    } finally {
      setOneNoteImportBusy(false)
    }
  }, [isWeb, oneNoteImportBusy, openNote, refreshTree, toast])

  const paletteActions = useMemo<PaletteAction[]>(() => [
    { id: 'new-note', label: 'Neue Notiz', detail: 'Markdown-Datei im Standardordner', shortcut: 'Ctrl N', group: 'Dateien', icon: <FilePlus2 size={15} />, run: () => void createNote() },
    { id: 'new-folder', label: 'Neuer Ordner', detail: 'Fach oder Unterordner anlegen', group: 'Dateien', icon: <FolderPlus size={15} />, run: () => void createFolder() },
    { id: 'save', label: 'Aktuelle Notiz speichern', detail: 'Text, Handschrift und Arbeitsblätter sichern', shortcut: 'Ctrl S', group: 'Dateien', icon: <Save size={15} />, run: () => { void saveCurrentWork(true) } },
    { id: 'search', label: 'Im Vault suchen', shortcut: 'Ctrl ⇧ F', group: 'Navigation', icon: <Search size={15} />, run: () => setSearchOpen(true) },
    { id: 'drawing', label: drawingOpen ? 'Zur Tastatur wechseln' : 'Mit Stift schreiben', detail: 'Eingabeart auf derselben Notizseite wechseln', shortcut: 'Ctrl D', group: 'Werkzeuge', keywords: 'tablet stift erkennen mathe', icon: <PenLine size={15} />, run: toggleDrawing },
    { id: 'worksheet', label: 'Bild oder PDF als Arbeitsblatt', detail: 'In die aktuelle oder eine neue Notiz importieren und ausfüllen', shortcut: 'Ctrl ⇧ I', group: 'Werkzeuge', keywords: 'pdf bild import arbeitsblatt ausfüllen', icon: <FileUp size={15} />, run: openWorksheetImport },
    { id: 'onenote-import', label: 'Microsoft OneNote importieren', detail: 'Notizbuch, Abschnitte, Layout, Ink und Anlagen sicher übernehmen', group: 'Dateien', keywords: 'one onetoc2 onepkg onedrive migration', icon: <NotebookTabs size={15} />, run: () => { void importOneNote().catch((error) => toast(error instanceof Error ? error.message : 'OneNote-Import fehlgeschlagen.', 'error')) } },
    { id: 'ai-assistant', label: 'AI-Assistent', detail: 'LM Studio, Ollama, OpenAI, Gemini, Anthropic oder OpenCode nutzen', shortcut: 'Ctrl ⇧ A', group: 'Werkzeuge', keywords: 'ki ai lm studio ollama openai gemini anthropic opencode rechtschreibung fakten', icon: <Bot size={15} />, run: openLmStudio },
    { id: 'glyphenwerk', label: 'GlyphenWerk öffnen', detail: 'Handschrift trainieren, live testen, korrigieren und verwalten', shortcut: 'Ctrl ⇧ G', group: 'Werkzeuge', keywords: 'training erkennung symbole test datensatz', icon: <Database size={15} />, run: openGlyphenWerk },
    { id: 'overview', label: 'Vault-Übersicht & Wissensgraph', detail: 'Fächer und offene Notizen überblicken', group: 'Navigation', icon: <Network size={15} />, run: openOverview },
    { id: 'daily', label: 'Heutige Tagesnotiz', detail: settings.dailyNotesFolder, group: 'Dateien', icon: <CalendarDays size={15} />, run: () => void createDailyNote() },
    { id: 'focus', label: focusMode ? 'Fokusmodus verlassen' : 'Fokusmodus starten', detail: 'Blendet Seitenleisten für ungestörtes Schreiben aus', shortcut: 'Ctrl ⇧ E', group: 'Ansicht', icon: <Maximize2 size={15} />, run: toggleFocusMode },
    { id: 'sidebar', label: 'Dateileiste umschalten', group: 'Ansicht', icon: <PanelLeftClose size={15} />, run: () => setSidebarVisible((value) => !value) },
    { id: 'inspector', label: 'Gliederung umschalten', group: 'Ansicht', icon: <PanelRightClose size={15} />, run: () => setInspectorVisible((value) => !value) },
    { id: 'settings', label: 'Einstellungen öffnen', shortcut: 'Ctrl ,', group: 'FaNotes', icon: <Settings size={15} />, run: () => setSettingsOpen(true) },
    { id: 'quit', label: isWeb ? 'Zur FaNotes-Website' : 'FaNotes beenden', shortcut: 'Ctrl Q', group: 'FaNotes', icon: <X size={15} />, run: () => window.lernwerk.requestClose() },
  ], [createDailyNote, createFolder, createNote, drawingOpen, focusMode, importOneNote, isWeb, openGlyphenWerk, openLmStudio, openOverview, openWorksheetImport, saveCurrentWork, settings.dailyNotesFolder, toast, toggleDrawing, toggleFocusMode])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key === 'Tab') { event.preventDefault(); cycleTabs(event.shiftKey ? -1 : 1); return }
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        if (activePathRef.current) void closeTab(activePathRef.current)
        return
      }
      if (mod && !event.shiftKey && event.key.toLowerCase() === 's' && !event.defaultPrevented) {
        event.preventDefault()
        void saveCurrentWork()
        return
      }
      if (mod && event.key.toLowerCase() === 'p') { event.preventDefault(); setPaletteOpen(true) }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true) }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'a') { event.preventDefault(); openLmStudio() }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'g') { event.preventDefault(); openGlyphenWerk() }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'i') { event.preventDefault(); openWorksheetImport() }
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); void createNote() }
      if (mod && event.key === ',') { event.preventDefault(); setSettingsOpen(true) }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'e') { event.preventDefault(); toggleFocusMode() }
      if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); toggleDrawing() }
      if (mod && event.key.toLowerCase() === 'q') { event.preventDefault(); window.lernwerk.requestClose() }
      if (event.key === 'Escape') {
        if (worksheetImportOpen) setWorksheetImportOpen(false)
        else if (paletteOpen) setPaletteOpen(false)
        else if (searchOpen) setSearchOpen(false)
        else if (settingsOpen) setSettingsOpen(false)
        else if (lmStudioOpen) setLmStudioOpen(false)
        else if (overviewOpen) setOverviewOpen(false)
        else if (glyphenWerkOpen) setGlyphenWerkOpen(false)
        else if (drawingOpenRef.current) closeDrawing()
        else if (focusMode) toggleFocusMode()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [closeDrawing, closeTab, createNote, cycleTabs, focusMode, glyphenWerkOpen, lmStudioOpen, openGlyphenWerk, openLmStudio, openWorksheetImport, overviewOpen, paletteOpen, saveCurrentWork, searchOpen, settingsOpen, toggleDrawing, toggleFocusMode, worksheetImportOpen])

  const theme = effectiveTheme(settings, systemDark)
  const cssVars = useMemo(() => {
    const contrastSurface = THEME_CONTRAST_SURFACES[theme] ?? THEME_CONTRAST_SURFACES.dark
    return {
      '--accent': settings.accent,
      '--accent-rgb': hexRgb(settings.accent),
      '--accent-secondary': settings.accentSecondary,
      '--accent-readable': ensureReadableColor(settings.accent, contrastSurface),
      '--accent-secondary-readable': ensureReadableColor(settings.accentSecondary, contrastSurface),
      '--paper-accent-readable': ensureReadableColor(settings.accent, ['#ffffff', '#f7f7fa']),
      '--paper-accent-secondary-readable': ensureReadableColor(settings.accentSecondary, ['#ffffff', '#f7f7fa']),
      '--on-accent': bestContrastText(settings.accent),
      '--sidebar-width': sidebarVisible ? `${settings.sidebarWidth}px` : '0px',
      '--right-panel-width': `${settings.rightPanelWidth}px`,
      '--content-width': settings.readableLineLength ? `${settings.contentWidth}px` : '100%',
      '--editor-size': `${settings.editorFontSize}px`,
      '--preview-size': `${settings.previewFontSize}px`,
      '--line-height': String(settings.lineHeight),
      '--ui-font': settings.uiFont,
      '--editor-font': settings.editorFont,
    } as React.CSSProperties
  }, [settings, sidebarVisible, theme])

  if (fatalError) return <div className="fatal-screen"><section className="fatal-card" role="alert"><div className="startup-mark is-error"><CircleAlert size={22} /></div><h1>FaNotes konnte nicht starten</h1><p>Deine Daten wurden nicht verändert. Prüfe den Vault und versuche es erneut.</p><code>{fatalError}</code><button className="primary-button" type="button" onClick={() => window.location.reload()}>Erneut versuchen</button></section></div>
  if (!bootstrap) return <div className="fatal-screen startup-screen"><section className="fatal-card startup-card" aria-live="polite"><div className="startup-mark"><PenLine size={22} /></div><h1>FaNotes öffnet deinen Schreibtisch</h1><p>Deine letzte Notiz erscheint gleich. Handschrift und weitere Werkzeuge werden danach im Hintergrund bereitgestellt.</p><div className="startup-progress" aria-hidden="true"><span /></div><small><LoaderCircle className="spin" size={12} /> Lokal und privat</small></section></div>
  if (bootstrap.onboardingRequired) return (
    <div className={`app-shell first-run-shell theme-${theme} background-${settings.workspaceBackground} ${settings.reduceMotion ? 'no-motion' : ''}`} style={cssVars}>
      {settings.customCss && <style>{settings.customCss}</style>}
      <Suspense fallback={<div className="fatal-screen"><section className="fatal-card"><LoaderCircle className="spin" color="var(--accent)" /><h1>Fächerauswahl wird geladen …</h1></section></div>}>
        <FirstRunOnboarding subjects={bootstrap.starterSubjects} onComplete={completeOnboarding} />
      </Suspense>
    </div>
  )

  return (
    <div className={`app-shell theme-${theme} background-${settings.workspaceBackground} ${focusMode ? 'focus-mode' : ''} ${settings.compactMode ? 'compact' : ''} ${settings.reduceMotion ? 'no-motion' : ''} ${settings.glassEffects ? 'with-glass' : 'no-glass'}`} style={cssVars}>
      {settings.customCss && <style>{settings.customCss}</style>}
      <nav className="ribbon" aria-label="Hauptnavigation">
        <button type="button" className={!searchOpen && !overviewOpen && !lmStudioOpen && !glyphenWerkOpen ? 'active' : ''} title="Dateien" data-tooltip="Dateien" aria-label="Dateien" onClick={showFiles}><Files size={19} /></button>
        <button type="button" className={searchOpen ? 'active' : ''} title="Im Vault suchen (Strg+Umschalt+F)" data-tooltip="Suchen · Strg ⇧ F" aria-label="Im gesamten Vault suchen" onClick={() => { setSearchOpen(true); setSidebarVisible(true) }}><Search size={19} /></button>
        <button type="button" className={drawingOpen ? 'active' : ''} title={drawingOpen ? 'Zur Tastatureingabe wechseln' : 'Auf derselben Seite mit Stift schreiben'} data-tooltip={drawingOpen ? 'Zur Tastatur · Strg D' : 'Mit Stift schreiben · Strg D'} aria-pressed={drawingOpen} onClick={toggleDrawing}><PenLine size={19} /></button>
        <button type="button" className={worksheetImportOpen ? 'active' : ''} title="Bild oder PDF als Arbeitsblatt importieren" data-tooltip="Arbeitsblatt importieren" aria-label="Bild oder PDF als Arbeitsblatt importieren" onClick={openWorksheetImport}><FileUp size={19} /></button>
        <button type="button" className={lmStudioOpen ? 'active' : ''} title="AI" data-tooltip="AI · Strg ⇧ A" aria-label="AI-Assistent öffnen" onClick={openLmStudio}><Bot size={19} /></button>
        <button type="button" className={glyphenWerkOpen ? 'active' : ''} title="GlyphenWerk" data-tooltip="GlyphenWerk · Strg ⇧ G" aria-label="GlyphenWerk öffnen" onClick={openGlyphenWerk}><Database size={19} /></button>
        <button type="button" title="Heutige Tagesnotiz" data-tooltip="Tagesnotiz" aria-label="Heutige Tagesnotiz öffnen" onClick={() => void createDailyNote()}><CalendarDays size={18} /></button>
        <div className="ribbon-divider" />
        <button type="button" className={overviewOpen ? 'active' : ''} title="Vault-Übersicht" data-tooltip="Übersicht & Wissensgraph" aria-label="Vault-Übersicht und Wissensgraph öffnen" onClick={openOverview}><Network size={18} /></button>
        <button type="button" title="Befehlspalette (Strg+P)" data-tooltip="Befehle · Strg P" aria-label="Befehlspalette öffnen" onClick={() => setPaletteOpen(true)}><Command size={18} /></button>
        <div className="ribbon-spacer" />
        <button type="button" title="Einstellungen (Strg+,)" data-tooltip="Einstellungen · Strg ," aria-label="Einstellungen öffnen" onClick={() => setSettingsOpen(true)}><Settings size={19} /></button>
      </nav>

      <div className="app-body" style={{ gridTemplateColumns: `${sidebarVisible ? 'var(--sidebar-width)' : '0px'} minmax(420px, 1fr) auto` }}>
        <aside className={`sidebar ${sidebarVisible ? '' : 'is-hidden'} ${glyphenWerkOpen ? 'is-glyphenwerk' : ''}`}>
          {glyphenWerkOpen ? <>
            <div className="sidebar-header glyphenwerk-sidebar-header">
              <button type="button" className="glyphenwerk-sidebar-brand" onClick={() => openGlyphenWerkView('capture')}>
                <span aria-hidden="true">∫</span><div><small>In FaNotes integriert</small><strong>GlyphenWerk</strong></div>
              </button>
              <div className="sidebar-actions"><button className="icon-button sidebar-collapse-button" type="button" title="Seitenleiste einklappen" aria-label="GlyphenWerk-Seitenleiste einklappen" onClick={() => setSidebarVisible(false)}><PanelLeftClose size={16} /></button></div>
            </div>
            <div className="glyphenwerk-sidebar-intro"><Database size={16} /><span><strong>Sofort bereit</strong><small>Standardmodell nutzen und optional personalisieren</small></span></div>
            <nav className="glyphenwerk-sidebar-nav" aria-label="GlyphenWerk Bereiche">
              <span>Training &amp; Modell</span>
              <button type="button" className={glyphenWerkView === 'capture' ? 'active' : ''} aria-current={glyphenWerkView === 'capture' ? 'page' : undefined} onClick={() => openGlyphenWerkView('capture')}><PenLine size={16} /><span><strong>Training</strong><small>Zeichen &amp; Varianten erfassen</small></span></button>
              <button type="button" className={glyphenWerkView === 'test' ? 'active' : ''} aria-current={glyphenWerkView === 'test' ? 'page' : undefined} onClick={() => openGlyphenWerkView('test')}><ScanLine size={16} /><span><strong>Erkennung testen</strong><small>Text &amp; Mathematik live prüfen</small></span></button>
              <button type="button" className={glyphenWerkView === 'collection' ? 'active' : ''} aria-current={glyphenWerkView === 'collection' ? 'page' : undefined} onClick={() => openGlyphenWerkView('collection')}><LayoutGrid size={16} /><span><strong>Sammlung</strong><small>Trainingsbeispiele verwalten</small></span>{glyphenWerkSampleCount !== null && <em>{glyphenWerkSampleCount}</em>}</button>
              <button type="button" className={glyphenWerkView === 'export' ? 'active' : ''} aria-current={glyphenWerkView === 'export' ? 'page' : undefined} onClick={() => openGlyphenWerkView('export')}><Download size={16} /><span><strong>Exportieren</strong><small>Datensatz als ZIP sichern</small></span></button>
            </nav>
            <section className="glyphenwerk-sidebar-stats" aria-label="GlyphenWerk Modellstatus">
              <div><span>Lokales Modell</span><ShieldCheck size={14} /></div>
              <strong>{glyphenWerkSampleCount ?? '…'}</strong><small>persönliche Beispiele · Standardmodell aktiv</small>
              <i><span style={{ width: `${Math.min(100, ((glyphenWerkSampleCount ?? 0) / 250) * 100)}%` }} /></i>
              <p>{glyphenWerkSampleCount === null
                ? 'Modellstatus wird geladen …'
                : glyphenWerkSampleCount === 0
                  ? 'Text & Mathematik funktionieren bereits ohne Training'
                  : glyphenWerkSampleCount < 250
                    ? `${250 - glyphenWerkSampleCount} bis zum ersten Personalisierungs-Meilenstein`
                    : 'Erster Personalisierungs-Meilenstein erreicht'}</p>
            </section>
            <div className="glyphenwerk-sidebar-spacer" />
            <button type="button" className="glyphenwerk-sidebar-back" onClick={showFiles}><ArrowLeft size={14} /> Zurück zu Fächern &amp; Notizen</button>
            <div className="sidebar-footer glyphenwerk-sidebar-footer"><span><ShieldCheck size={11} /> Nur lokal gespeichert</span><button type="button" onClick={() => openGlyphenWerkView('test')}><ScanLine size={12} /> Test</button></div>
          </> : <>
            <div className="sidebar-header">
              <button type="button" className="sidebar-vault" onClick={() => setSettingsOpen(true)} title={bootstrap.vaultPath}><small>Lokaler Vault</small><strong>{bootstrap.vaultName} <ChevronDown size={11} /></strong></button>
              <div className="sidebar-actions"><button className="icon-button" type="button" title="Neue Notiz" onClick={() => void createNote()}><FilePlus2 size={16} /></button><button className="icon-button" type="button" title="Neuer Ordner" onClick={() => void createFolder()}><FolderPlus size={16} /></button><button className="icon-button sidebar-collapse-button" type="button" title="Ordner-Seitenleiste einklappen" aria-label="Ordner-Seitenleiste einklappen" onClick={() => setSidebarVisible(false)}><PanelLeftClose size={16} /></button></div>
            </div>
            <div className="sidebar-search" role="search" title="Text, Dateinamen und unsichtbare Handschrift durchsuchen"><Search aria-hidden="true" size={14} /><input value={searchQuery} placeholder="Notizen & Handschrift suchen …" aria-label="Im gesamten Vault suchen" onChange={(event) => { setSearchQuery(event.target.value); setSearchOpen(true) }} onFocus={() => setSearchOpen(true)} />{searchQuery ? <button className="search-clear" type="button" aria-label="Suchbegriff löschen" title="Suche leeren" onMouseDown={(event) => event.preventDefault()} onClick={() => { setSearchQuery(''); setSearchHits([]) }}><X size={13} /></button> : <kbd aria-label="Strg Umschalt F">⌃⇧F</kbd>}</div>
            <div className="file-tree-wrap"><FileTree entries={tree} activePath={activePath} rootLabel="Fächer & Notizen" onOpen={openNote} onCreateNote={createNote} onCreateFolder={createFolder} onSetFolderColor={setFolderColor} onRename={renameEntry} onTrash={trashEntry} /></div>
            <div className="sidebar-footer"><span>{counts.files} Notizen · {counts.folders} Ordner</span><button type="button" title="Vault jetzt aktualisieren" onClick={() => void refreshTree()}><ShieldCheck size={12} /> {isWeb ? 'Browser' : 'Lokal'}</button></div>
          </>}
        </aside>

        <main className="workspace">
          <div className="tabs-bar">
            <div className="tabs-scroll" role="tablist" aria-label="Offene Notizen">{tabs.map((tab) => <NoteTabButton key={tab.path} active={tab.path === activePath} dirty={tab.content !== tab.savedContent} path={tab.path} title={tab.title} onOpen={openNote} onClose={closeTab} />)}</div>
            <button type="button" className="tabs-menu" title="Neue Notiz (Strg+N)" aria-label="Neue Notiz" onClick={() => void createNote()}><Plus size={15} /></button>
          </div>
          <div className="editor-toolbar">
            <div className="breadcrumb" title={activeTab?.path ?? bootstrap.vaultPath}><span>{glyphenWerkOpen ? `GlyphenWerk · ${GLYPHENWERK_VIEW_LABELS[glyphenWerkView]}` : activeTab?.path ?? bootstrap.vaultName}</span></div>
            <FormattingToolbar disabled={!activeTab || drawingOpen || overviewOpen || glyphenWerkOpen || activeEntryMutating} onFormat={formatMarkdown} />
            <div className="toolbar-group">
              <button type="button" className="toolbar-button ai" title="Mit einem AI-Anbieter bearbeiten" aria-label="AI-Assistent öffnen" onClick={openLmStudio}><Bot size={14} /> AI</button>
              <button type="button" className="toolbar-button" title="Bild oder PDF als Arbeitsblatt importieren" aria-label="Arbeitsblatt importieren" onClick={openWorksheetImport}><FileUp size={14} /> Arbeitsblatt</button>
              <button type="button" className={`toolbar-button convert ${drawingOpen ? 'active' : ''}`} title={drawingOpen ? 'Zur Tastatureingabe wechseln (Strg+D)' : 'Mit Stift schreiben (Strg+D)'} aria-pressed={drawingOpen} onClick={toggleDrawing}><PenLine size={14} /> {drawingOpen ? 'Tastatur' : 'Stift'}</button>
              <div className="editor-more">
                <button type="button" className={`toolbar-button menu-trigger ${editorMenuOpen ? 'active' : ''}`} title="Weitere Notizaktionen" aria-label="Weitere Notizaktionen" aria-haspopup="menu" aria-expanded={editorMenuOpen} onClick={(event) => { event.stopPropagation(); setEditorMenuOpen((open) => !open) }}><MoreHorizontal size={16} /></button>
                {editorMenuOpen && <div className="editor-more-menu" role="menu" aria-label="Weitere Notizaktionen" onPointerDown={(event) => event.stopPropagation()}>
                  <header><span><MoreHorizontal size={15} /></span><div><strong>Notizmenü</strong><small>Ansicht und Datei</small></div></header>
                  <span className="editor-menu-label">Ansicht</span>
                  <button type="button" role="menuitemcheckbox" aria-checked={focusMode} onClick={() => { setEditorMenuOpen(false); toggleFocusMode() }}><span><Maximize2 size={15} /></span><span><strong>{focusMode ? 'Fokusmodus verlassen' : 'Fokusmodus'}</strong><small>Seitenleisten ausblenden</small></span><kbd>⌃⇧E</kbd></button>
                  <button type="button" role="menuitemcheckbox" aria-checked={inspectorVisible} onClick={() => { setEditorMenuOpen(false); setInspectorVisible((value) => !value) }}><span>{inspectorVisible ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}</span><span><strong>{inspectorVisible ? 'Gliederung ausblenden' : 'Gliederung anzeigen'}</strong><small>Überschriften und Dokumentinfo</small></span><i className={inspectorVisible ? 'is-on' : ''} /></button>
                  <span className="editor-menu-separator" role="separator" />
                  <span className="editor-menu-label">Datei</span>
                  <button type="button" role="menuitem" disabled={!activePath} onClick={() => { setEditorMenuOpen(false); if (activePath) void window.lernwerk.revealInFolder(activePath) }}><span>{isWeb ? <Download size={15} /> : <FolderOpen size={15} />}</span><span><strong>{isWeb ? 'Markdown herunterladen' : 'Im Dateimanager zeigen'}</strong><small>{isWeb ? 'Aktuelle Notiz exportieren' : 'Speicherort der Notiz öffnen'}</small></span></button>
                </div>}
              </div>
            </div>
          </div>
          <div className="editor-stage">
            <Suspense fallback={<div className="editor-module-loading"><LoaderCircle className="spin" size={20} /><span>Ansicht wird geladen …</span></div>}>
              {glyphenWerkOpen ? (
              <GlyphenWerkWorkspace appearance={{ theme, reduceMotion: settings.reduceMotion }} activeView={glyphenWerkView} onViewChange={setGlyphenWerkView} onClose={() => setGlyphenWerkOpen(false)} onTrainingChanged={handleGlyphenWerkTrainingChanged} onImportTraining={importTrainingFromSettings} />
            ) : overviewOpen ? (
              <VaultOverview entries={tree} openTabs={tabs} onOpen={(path) => { setOverviewOpen(false); return openNote(path) }} onCreateNote={() => createNote()} onClose={() => setOverviewOpen(false)} />
            ) : activeTab ? (
              <div className={`unified-note-view paper-${settings.paperStyle} ${drawingOpen ? 'is-inking' : ''}`}>
                <article className={`unified-paper ${worksheetSession.documents.length ? 'has-worksheet' : ''}`} aria-label={`${activeTab.title} · gemeinsame Tastatur- und Handschriftseite`}>
                  <div className="editor-pane"><MarkdownEditor ref={editorRef} key={activeTab.path} content={activeTab.content} onChange={updateContent} onSave={async (content) => { await saveContent(activeTab.path, content) }} settings={settings} focusToken={focusToken} readOnly={activeEntryMutating || drawingOpen} paperMode onLanguageDetected={setDetectedTextLanguage} /></div>
                  {worksheetSession.documents.map((document) => <Suspense key={document.id} fallback={<div className="worksheet-loading"><LoaderCircle className="spin" size={20} /> Arbeitsblatt wird geladen …</div>}>
                    <StableWorksheetLayer
                      ref={worksheetLayerRefFor(document.id)}
                      document={document}
                      inputDisabled={drawingOpen || activeEntryMutating}
                      onSave={saveWorksheetDocument}
                      onDirtyChange={worksheetDirtyCallbackFor(document.id)}
                    />
                  </Suspense>)}
                  {drawingSession.key > 0 && <Suspense fallback={drawingOpen ? <div className="inline-ink-loading"><LoaderCircle className="spin" size={18} /> Stiftebene wird geladen …</div> : null}>
                    <DrawingBoard
                      ref={drawingBoardRef}
                      key={drawingSession.key}
                      settings={settings}
                      drawingId={drawingSession.document?.id}
                      initialDrawingJson={drawingSession.document?.drawingJson}
                      title={`Handschrift · ${activeTab.title}`}
                      inline
                      inputActive={drawingOpen}
                      onClose={closeDrawing}
                      onSaveDrawing={saveDrawingAsset}
                      onInsertMarkdown={insertIntoNote}
                      onSettingsChange={handleDrawingSettingsChange}
                      onDirtyChange={handleDrawingDirtyChange}
                      onTrainingChanged={handleTrainingChanged}
                      onOpenGlyphenWerk={openGlyphenWerk}
                    />
                  </Suspense>}
                  {drawingOpen && drawingSession.key === 0 && <div className="inline-ink-loading"><LoaderCircle className="spin" size={18} /> Gespeicherte Stiftebene wird geladen …</div>}
                </article>
              </div>
            ) : (
              <div className="editor-placeholder"><div className="placeholder-glyph"><BookOpen size={28} /></div><span className="eyebrow">Bereit für deine nächste Idee</span><h2>Dein Wissen, in deiner Hand</h2><p>Schreibe mit Tastatur und Stift auf derselben Seite oder starte direkt mit einem Arbeitsblatt.</p><div className="placeholder-actions"><button className="primary-button" type="button" onClick={() => void createNote()}><FilePlus2 size={14} /> Neue Notiz</button><button className="secondary-button" type="button" onClick={openWorksheetImport}><FileUp size={14} /> Arbeitsblatt</button></div><button className="placeholder-command" type="button" onClick={() => setPaletteOpen(true)}><Command size={13} /> Alle Aktionen mit <kbd>Strg P</kbd></button></div>
              )}
            </Suspense>
          </div>
        </main>

        {inspectorVisible && settings.showOutline && !overviewOpen && !glyphenWerkOpen && <Suspense fallback={null}><RightInspector content={activeTab?.content ?? ''} path={activeTab?.path} /></Suspense>}
        {searchOpen && <Suspense fallback={null}><SearchPanel query={searchQuery} hits={searchHits} loading={searchLoading} onQueryChange={setSearchQuery} onOpen={(hit) => { void openSearchHit(hit) }} onClose={() => setSearchOpen(false)} /></Suspense>}
      </div>

      <footer className="statusbar">
        <div className="statusbar-left"><button type="button" title={sidebarVisible ? 'Seitenleiste einklappen' : 'Seitenleiste einblenden'} aria-label={sidebarVisible ? 'Seitenleiste einklappen' : 'Seitenleiste einblenden'} onClick={() => setSidebarVisible((value) => !value)}>{sidebarVisible ? <PanelLeftClose size={12} /> : <PanelLeftOpen size={12} />}</button><span>{glyphenWerkOpen ? `GlyphenWerk · ${GLYPHENWERK_VIEW_LABELS[glyphenWerkView]}` : activeTab ? drawingOpen ? 'Stiftmodus' : worksheetSession.documents.length ? 'Notiz mit Arbeitsblatt' : 'Schreibmodus' : 'Bereit'}</span>{worksheetSession.documents.length > 0 && <span>{worksheetSession.documents.length} {worksheetSession.documents.length === 1 ? 'Arbeitsblatt' : 'Arbeitsblätter'}</span>}</div>
        <div className="statusbar-right">{updateState.status === 'downloaded' && <button type="button" className="update-ready-button" title={`FaNotes ${updateState.latestVersion} installieren und neu starten`} onClick={() => void installUpdate()}><ShieldCheck size={11} /> Update bereit</button>}{updateState.status === 'downloading' && <span><LoaderCircle className="spin" size={11} /> Update {Math.round(updateState.progress * 100)} %</span>}{settings.spellcheck && activeTab && !drawingOpen && detectedTextLanguage !== 'unknown' && <span className="detected-text-language" title="Automatisch erkannte Sprache für die lokale Rechtschreibprüfung"><b>Aa</b> {detectedTextLanguage === 'de' ? 'Deutsch' : detectedTextLanguage === 'en' ? 'English' : 'DE / EN'}</span>}{settings.showWordCount && activeTab && <span>{activeWordCount} Wörter</span>}<button type="button" className={`save-status ${saveState === 'saved' ? 'save-ok' : 'save-pending'}`} title="Jetzt speichern (Strg+S)" aria-live="polite" onClick={() => void saveCurrentWork()}>{saveState === 'saved' ? <CheckCircle2 size={11} /> : saveState === 'saving' ? <LoaderCircle className="spin" size={11} /> : <CircleAlert size={11} />}{saveState === 'saved' ? 'Gespeichert' : saveState === 'saving' ? 'Speichert …' : 'Speicherfehler'}</button><span title={isWeb ? 'Die Daten bleiben in diesem Browser' : 'Dein Vault bleibt auf deinem Gerät'}><ShieldCheck size={11} /> {isWeb ? 'Im Browser gespeichert' : 'Lokal & privat'}</span></div>
      </footer>

      {paletteOpen && <Suspense fallback={null}><CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} /></Suspense>}
      {settingsOpen && <Suspense fallback={null}><SettingsModal platform={window.lernwerk.platform} settings={settings} vaultPath={bootstrap.vaultPath} updateState={updateState} onChange={applySettings} onClose={() => setSettingsOpen(false)} onSelectVault={() => void selectVault()} onOpenGlyphenWerk={() => { setSettingsOpen(false); openGlyphenWerk() }} onImportTraining={importTrainingFromSettings} onImportOneNote={importOneNote} onCheckUpdate={checkForUpdates} onDownloadUpdate={downloadUpdate} onInstallUpdate={installUpdate} onResetSettings={resetSettings} onResetAppData={resetAppData} /></Suspense>}
      {lmStudioOpen && <Suspense fallback={null}><AiPanel settings={settings} note={lmStudioNote} vaultNotes={vaultNoteReferences} onSettingsChange={(changes) => applySettings({ ...settingsRef.current, ...changes })} onApply={applyLmStudioResult} onClose={() => setLmStudioOpen(false)} /></Suspense>}
      {worksheetImportOpen && <div className="modal-backdrop worksheet-import-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setWorksheetImportOpen(false) }}>
        <section className="worksheet-import-dialog" role="dialog" aria-modal="true" aria-labelledby="worksheet-import-title">
          <header><div><span><FileUp size={19} /></span><div><small>Bild oder PDF</small><h2 id="worksheet-import-title">Arbeitsblatt importieren</h2></div></div><button type="button" aria-label="Schließen" onClick={() => setWorksheetImportOpen(false)}><X size={17} /></button></header>
          <p>Das Arbeitsblatt bleibt Teil deines Vaults. Anschließend kannst du direkt darauf Textfelder platzieren oder mit dem Grafiktablett schreiben.</p>
          <div className="worksheet-import-options">
            <button type="button" disabled={!activeTab || worksheetImportBusy} onClick={() => void importWorksheet('current')}><span><Files size={22} /></span><strong>In aktuelle Notiz</strong><small>{activeTab ? activeTab.title : 'Keine Notiz geöffnet'}</small></button>
            <button type="button" disabled={worksheetImportBusy} onClick={() => void importWorksheet('new')}><span><FilePlus2 size={22} /></span><strong>Als neue Notiz</strong><small>Dateiname wird zum Notiztitel</small></button>
            <button type="button" className="onenote-import-option" disabled={isWeb || oneNoteImportBusy} onClick={() => void importOneNote().catch((error) => toast(error instanceof Error ? error.message : 'OneNote-Import fehlgeschlagen.', 'error'))}><span>{oneNoteImportBusy ? <LoaderCircle className="spin" size={22} /> : <NotebookTabs size={22} />}</span><strong>Microsoft OneNote</strong><small>{isWeb ? 'In der Linux- oder Windows-App' : 'Ganzes Notizbuch inklusive Layout, Ink und Anlagen'}</small></button>
          </div>
          <footer><small>PDF · Bilder · ONE · ONETOC2 · ONEPKG · ZIP</small><button type="button" className="secondary-button" onClick={() => setWorksheetImportOpen(false)}>Abbrechen</button></footer>
        </section>
      </div>}
      <div className="toast-stack" aria-live="polite" aria-relevant="additions">{toasts.map((item) => <div className={`toast ${item.kind}`} role={item.kind === 'error' ? 'alert' : 'status'} key={item.id}>{item.kind === 'success' ? <CheckCircle2 size={16} /> : item.kind === 'error' ? <CircleAlert size={16} /> : <Info size={16} />}<span>{item.message}</span><button type="button" aria-label="Meldung schließen" onClick={() => dismissToast(item.id)}><X size={13} /></button></div>)}</div>
    </div>
  )
}
