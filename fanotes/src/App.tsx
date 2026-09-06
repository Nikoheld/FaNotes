import {
  Archive,
  ArrowLeft,
  Bot,
  Bug,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  ClipboardList,
  Columns2,
  Command,
  Database,
  Download,
  File,
  FileDown,
  FilePlus2,
  Files,
  FileText,
  FileUp,
  History,
  FolderOpen,
  FolderPlus,
  Info,
  Keyboard,
  Link2,
  LoaderCircle,
  LayoutGrid,
  Maximize2,
  MoreHorizontal,
  MoreVertical,
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
  Trash2,
  X,
} from 'lucide-react'
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PaletteAction } from './components/CommandPalette'
import type { DrawingBoardHandle, DrawingSavePayload } from './components/DrawingBoard'
import { FileTree } from './components/FileTree'
import { FormattingToolbar } from './components/FormattingToolbar'
import { NoteLinkLayer } from './components/NoteLinkLayer'
import type { GlyphenWerkView } from './components/GlyphenWerkWorkspace'
import type { MarkdownEditorHandle, MarkdownFormatAction } from './components/MarkdownEditor'
import type { WorksheetLayerHandle } from './components/WorksheetLayer'
import { companionNotePath, isPdfNotePath } from './lib/famd'
import { chooseRestoredNote, collectNotePaths } from './lib/lastOpenNote'
import {
  activateNoteLink,
  followNoteNav,
  goBackNoteNav,
  linkedNoteParent,
  linkedNotePreferredName,
  NOTE_LINK_STYLES,
  placeNewNoteLink,
  removeNoteLink,
  restyleNoteLink,
  type NoteLinkRecord,
  type NoteLinkStyleId,
} from './lib/noteLink'
import {
  createNoteBackup,
  listNoteBackups,
  noteBackupControlPolicy,
  restoreNoteBackup,
  type NoteBackupSnapshot,
} from './lib/noteBackup'
import {
  applySubjectBookPlacement,
  attachSubjectBook,
  detachSubjectBook,
  mergeSubjectBooksPreferDisk,
  parseSubjectBooks,
  patchSubjectBookPage,
  SUBJECT_BOOK_PLACEMENT_OPTIONS,
  subjectBookForNote,
  subjectBookMountRecord,
  subjectBookViewPolicy,
  toggleSubjectBookView,
  type SubjectBookPlacement,
  type SubjectBookRecord,
} from './lib/subjectBook'
import { drawingSessionFromLoad, INK_OVERLAY_CRASH_TITLE, INK_TOOLBAR_SLOT_ID, overlayAfterNoteSwitch, PDF_TOOLBAR_SLOT_ID, penModeToolbarSlot } from './lib/pdfInkHit'
import { APP_VERSION } from './lib/appVersion'
import { defaultSettingsForPlatform } from './defaults'
import { PaperStylePicker } from './components/PaperStylePicker'
import { PaperView } from './components/PaperView'
import { normalizePaperStyle } from './lib/paperStyles'
import { clampViewZoom, readSharedPaperView, writeSharedPaperView, writeSharedZoomMaxPercent, writeSharedZoomSpeed } from './lib/paperView'
import { diagnosticLog } from './lib/bugReport'
import {
  collectSendDataNutzerdaten,
  linuxHyprlandRuntimeContext,
  planSendDataTick,
  sendDataPolicy,
  sendDataSubmitTarget,
  SEND_DATA_MIN_INTERVAL_MS,
} from './lib/sendData'
import { HOMEWORK_CHANNEL_ID_PATTERN, homeworkApiOriginFromLocation, homeworkApiSecretReady, publishHomeworkList, queryHomeworkList } from './lib/homeworkApi'
import {
  buildRemoteSupportPollRequest,
  buildRemoteSupportRegisterRequest,
  buildRemoteSupportResultRequest,
  buildRemoteSupportStopRequest,
  applyRemoteSupportBoardDrive,
  collectVaultTreeNames,
  createRemoteSupportLiveState,
  dispatchRemoteSupportCommand,
  flushRemoteSupportBoardDrive,
  injectRemoteSupportKey,
  injectRemoteSupportPointer,
  noteTitleFromPath,
  startRemoteSupportSession,
  type RemoteSupportBoardQueue,
  type RemoteSupportCommand,
  type RemoteSupportSession,
} from './lib/remoteSupport'
import { HOMEWORK_NOTE_PATH, mergeHomeworkFromRemote, parseHomeworkMarkdown, rememberPublishedHomeworkIds, serializeHomeworkMarkdown, type HomeworkDocument } from './lib/homeworkStore'
import { SafeBoundary } from './components/SafeBoundary'
import { applyNoteTags, collectVaultTags, filterTreeByTag, parseNoteTags } from './lib/noteTags'
import { applyRendererResourceLimits } from './lib/resourceLimits'
import { getUiLocale, setUiLanguage, translateUiText } from './i18n'
import { bestContrastText, ensureReadableColor } from './lib/colorContrast'
import type { AppSettings, BootstrapData, CreateResult, DetectedTextLanguage, DrawingLibraryDocument, NoteHistorySnapshot, NoteTab, OneNoteImportResult, PaperStyle, SearchHit, UpdateState, VaultEntry, WorksheetDocument } from './types'

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
const BugReportModal = lazy(() => import('./components/BugReportModal').then((module) => ({ default: module.BugReportModal })))
const SubjectBookPane = lazy(() => import('./components/SubjectBookPane').then((module) => ({ default: module.SubjectBookPane })))
const VaultOverview = lazy(() => import('./components/VaultOverview').then((module) => ({ default: module.VaultOverview })))
const HomeworkBoard = lazy(() => import('./components/HomeworkBoard').then((module) => ({ default: module.HomeworkBoard })))
const WorksheetLayer = lazy(() => import('./components/WorksheetLayer').then((module) => ({ default: module.WorksheetLayer })))
const PdfNoteView = lazy(() => import('./components/PdfNoteView').then((module) => ({ default: module.PdfNoteView })))
const StableWorksheetLayer = memo(WorksheetLayer)
const STARTUP_TREE_REFRESH_DELAY_MS = 18_000
const STARTUP_DOCUMENT_LAYER_DELAY_MS = 160
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
  onSplit: (path: string) => void | Promise<void>
  onClose: (path: string) => void | Promise<void>
}

const NoteTabButton = memo(function NoteTabButton({ active, dirty, path, title, onOpen, onSplit, onClose }: NoteTabButtonProps) {
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
        onClick={(event) => { event.shiftKey ? void onSplit(path) : void onOpen(path) }}
        onAuxClick={(event) => { if (event.button === 1) void onClose(path) }}
      >
        {isPdfNotePath(path) ? <File aria-hidden="true" size={13} /> : <Files aria-hidden="true" size={13} />}
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
  currentVersion: APP_VERSION,
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

const stripExtension = (name: string) => name.replace(/\.(md|markdown|famd|pdf)$/i, '')
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

const detachWorksheet = (content: string, id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,96}$/u.test(id)) return content
  return content
    .replace(new RegExp(`(?:\\r?\\n)*<!--\\s*fanotes-worksheet:${id}\\s*-->\\s*`, 'gu'), '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/^\n+/u, '')
}

const stripNoteMetadata = (content: string) => content
  .replace(NOTE_INK_MARKER, '')
  .replace(NOTE_WORKSHEET_MARKER, '')
  .replace(/(?:^|\n)<!--\s*fanotes-famd:v1[\s\S]*$/u, '')
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

const isMarkdownTreeFile = (entry: VaultEntry) => (
  entry.kind === 'file' && ['md', '.md', 'famd', '.famd', 'markdown'].includes(entry.extension || '')
)

const firstMarkdown = (entries: VaultEntry[]): string | undefined => {
  const welcome = entries.find((entry) => entry.kind === 'file' && entry.name.toLocaleLowerCase('de') === 'willkommen.md')
  if (welcome) return welcome.relativePath
  for (const entry of entries) {
    if (isMarkdownTreeFile(entry)) return entry.relativePath
    if (entry.kind === 'folder') {
      const nested = firstMarkdown(entry.children ?? [])
      if (nested) return nested
    }
  }
  return undefined
}

const firstPdfNote = (entries: VaultEntry[]): string | undefined => {
  for (const entry of entries) {
    if (entry.kind === 'file' && isPdfNotePath(entry.relativePath)) return entry.relativePath
    if (entry.kind === 'folder') {
      const nested = firstPdfNote(entry.children ?? [])
      if (nested) return nested
    }
  }
  return undefined
}

const firstNote = (entries: VaultEntry[]): string | undefined => firstMarkdown(entries) ?? firstPdfNote(entries)

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
  dark: ['#1e1e1e', '#1a1a1a', '#262626', '#2a2a2a'],
  light: ['#ffffff', '#f6f6f6', '#f2f2f2', '#ffffff'],
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
  const isWeb = window.fanotes?.platform === 'web'
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null)
  const [tree, setTree] = useState<VaultEntry[]>([])
  const [tabs, setTabs] = useState<NoteTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings>(() => defaultSettingsForPlatform(window.fanotes?.platform))
  useEffect(() => {
    writeSharedZoomSpeed(settings.viewZoomSpeed)
  }, [settings.viewZoomSpeed])
  useEffect(() => {
    writeSharedZoomMaxPercent(settings.viewZoomMax ?? 325)
    const view = readSharedPaperView()
    const zoom = clampViewZoom(view.zoom)
    writeSharedPaperView(zoom === view.zoom ? { ...view } : { ...view, zoom })
  }, [settings.viewZoomMax])
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
  const [homeworkOpen, setHomeworkOpen] = useState(false)
  const [homeworkReloadToken, setHomeworkReloadToken] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [editorMenuOpen, setEditorMenuOpen] = useState(false)
  const [sidebarToolsOpen, setSidebarToolsOpen] = useState(false)
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
  const [bugReportOpen, setBugReportOpen] = useState(false)
  const [remoteSupportSession, setRemoteSupportSession] = useState<RemoteSupportSession | null>(null)
  const [revealPath, setRevealPath] = useState<string | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [tagIndex, setTagIndex] = useState<Record<string, string[]>>({})
  const [notePaperByPath, setNotePaperByPath] = useState<Record<string, PaperStyle>>({})
  const [noteLinks, setNoteLinks] = useState<NoteLinkRecord[]>([])
  const [noteLinkPlacing, setNoteLinkPlacing] = useState(false)
  const [noteLinkStyle, setNoteLinkStyle] = useState<NoteLinkStyleId>('symbol')
  const [selectedNoteLinkId, setSelectedNoteLinkId] = useState<string | null>(null)
  const [noteNavStack, setNoteNavStack] = useState<string[]>([])
  const [noteBackups, setNoteBackups] = useState<NoteBackupSnapshot[]>([])
  const [backupMenuOpen, setBackupMenuOpen] = useState(false)
  const [subjectBooks, setSubjectBooks] = useState<SubjectBookRecord[]>([])
  const [subjectBooksDisk, setSubjectBooksDisk] = useState<SubjectBookRecord[]>([])
  const [subjectBooksReady, setSubjectBooksReady] = useState(false)
  const [subjectBooksHydrating, setSubjectBooksHydrating] = useState(false)
  const [bookOpen, setBookOpen] = useState(false)
  const [bookPlacement, setBookPlacement] = useState<SubjectBookPlacement>('rechts')
  const popoutBookPath = typeof window === 'undefined' ? '' : (() => {
    const match = /^#subject-book=(.+)$/u.exec(window.location.hash)
    if (!match) return ''
    try { return decodeURIComponent(match[1]) } catch { return '' }
  })()
  const [tagDraft, setTagDraft] = useState('')
  const [splitPath, setSplitPath] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historySnapshots, setHistorySnapshots] = useState<NoteHistorySnapshot[]>([])
  const [historyBusy, setHistoryBusy] = useState(false)
  const tabsRef = useRef(tabs)
  const activePathRef = useRef(activePath)
  const noteNavStackRef = useRef<string[]>([])
  const noteLinksRef = useRef<NoteLinkRecord[]>([])
  const noteBackupsRef = useRef<NoteBackupSnapshot[]>([])
  const subjectBooksRef = useRef<SubjectBookRecord[]>([])
  const subjectBooksDiskRef = useRef<SubjectBookRecord[]>([])
  const bookPlacementRef = useRef<SubjectBookPlacement>('rechts')
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
  const lastHomeworkSecretRef = useRef('')
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
  useEffect(() => {
    diagnosticLog.record({
      at: Date.now(),
      kind: 'note',
      noteId: activePath || undefined,
      version: updateState.currentVersion,
      platform: window.fanotes?.platform,
    })
  }, [activePath, updateState.currentVersion])
  useEffect(() => {
    diagnosticLog.record({
      at: Date.now(),
      kind: 'app',
      version: updateState.currentVersion,
      platform: window.fanotes?.platform,
      message: 'session-start',
    })
    const onError = (event: ErrorEvent) => {
      diagnosticLog.record({
        at: Date.now(),
        kind: 'error',
        noteId: activePathRef.current || undefined,
        version: updateState.currentVersion,
        platform: window.fanotes?.platform,
        message: event.message,
      })
    }
    window.addEventListener('error', onError)
    return () => window.removeEventListener('error', onError)
  }, [updateState.currentVersion])
  useEffect(() => { setDetectedTextLanguage('unknown') }, [activePath])
  useEffect(() => { treeRef.current = tree }, [tree])
  useEffect(() => { settingsRef.current = settings }, [settings])
  useEffect(() => {
    if (!sendDataPolicy(settings.experimentalSendData).ongoing) return
    let lastSentAt: number | null = null
    let lastBodyHash: string | null = null
    let timer: number | null = null
    let stopped = false
    const tick = () => {
      if (stopped) return
      const planned = planSendDataTick({
        enabled: true,
        logs: diagnosticLog.snapshot(),
        nutzerdaten: collectSendDataNutzerdaten({
          version: updateState.currentVersion,
          platform: window.fanotes?.platform,
          theme: settingsRef.current.theme,
          uiLanguage: settingsRef.current.uiLanguage,
          paperStyle: settingsRef.current.paperStyle,
          penOnly: settingsRef.current.penOnly,
          experimentalHandwritingToText: settingsRef.current.experimentalHandwritingToText,
          experimentalNoteBackup: settingsRef.current.experimentalNoteBackup,
          experimentalRemoteSupport: settingsRef.current.experimentalRemoteSupport,
          hasOpenNote: Boolean(activePathRef.current),
        }),
        linux: bootstrap?.linuxRuntime ?? linuxHyprlandRuntimeContext({ platform: window.fanotes?.platform }),
        now: Date.now(),
        lastSentAt,
        lastBodyHash,
        idle: typeof document !== 'undefined' && document.hidden,
      })
      if (planned.send) {
        lastSentAt = Date.now()
        lastBodyHash = planned.hash ?? null
        const target = sendDataSubmitTarget()
        void fetch(target.url, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: planned.body,
          cache: 'no-store',
          credentials: 'omit',
          keepalive: true,
          referrerPolicy: 'no-referrer',
        }).catch(() => undefined)
      }
      timer = window.setTimeout(tick, SEND_DATA_MIN_INTERVAL_MS)
    }
    tick()
    return () => {
      stopped = true
      if (timer != null) window.clearTimeout(timer)
    }
  }, [bootstrap?.linuxRuntime, settings.experimentalSendData, updateState.currentVersion])
  useEffect(() => {
    applyRendererResourceLimits(settings)
  }, [settings.desktopOcrModel, settings.ocrModelKeepAliveSeconds, settings.ocrThreadLimit])
  useEffect(() => {
    if (bootstrap) void setUiLanguage(settings.uiLanguage)
  }, [bootstrap, settings.uiLanguage])
  useEffect(() => { drawingOpenRef.current = drawingOpen }, [drawingOpen])
  useEffect(() => {
    if (!editorMenuOpen && !backupMenuOpen) return
    const close = () => {
      setEditorMenuOpen(false)
      setBackupMenuOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [backupMenuOpen, editorMenuOpen])
  const activeTab = useMemo(() => tabs.find((tab) => tab.path === activePath) ?? null, [activePath, tabs])
  const backupPolicy = useMemo(
    () => noteBackupControlPolicy(settings.experimentalNoteBackup, noteBackups.length),
    [noteBackups.length, settings.experimentalNoteBackup],
  )
  const attachedBook = useMemo(
    () => subjectBookForNote(mergeSubjectBooksPreferDisk(subjectBooks, subjectBooksDisk), activePath),
    [activePath, subjectBooks, subjectBooksDisk],
  )
  const currentBook = useMemo(
    () => subjectBookMountRecord({
      memory: subjectBooks,
      disk: subjectBooksDisk,
      ready: subjectBooksReady,
      hydrating: subjectBooksHydrating,
      notePath: popoutBookPath ? undefined : activePath,
      bookPath: popoutBookPath || undefined,
    }),
    [activePath, popoutBookPath, subjectBooks, subjectBooksDisk, subjectBooksHydrating, subjectBooksReady],
  )
  const bookPolicy = useMemo(
    () => subjectBookViewPolicy({
      hasBook: Boolean(attachedBook) && !popoutBookPath,
      open: bookOpen,
      placement: bookPlacement,
    }),
    [attachedBook, bookOpen, bookPlacement, popoutBookPath],
  )
  useEffect(() => {
    subjectBooksRef.current = subjectBooks
  }, [subjectBooks])
  useEffect(() => {
    subjectBooksDiskRef.current = subjectBooksDisk
  }, [subjectBooksDisk])
  useEffect(() => {
    if (popoutBookPath) return
    if (bookOpen && bookPlacement === 'popout' && currentBook) {
      void window.fanotes.openSubjectBookPopout?.(currentBook.bookPath)
      return
    }
    if (bookPlacement !== 'popout') void window.fanotes.closeSubjectBookPopout?.()
  }, [bookOpen, bookPlacement, currentBook, popoutBookPath])
  useEffect(() => {
    bookPlacementRef.current = bookPlacement
  }, [bookPlacement])
  useEffect(() => {
    if (popoutBookPath || !window.fanotes.onSubjectBookPopoutClosed) return
    return window.fanotes.onSubjectBookPopoutClosed(() => {
      setBookOpen((open) => bookPlacementRef.current === 'popout' ? false : open)
      setSubjectBooksHydrating(true)
      void (async () => {
        try {
          const disk = window.fanotes.readSubjectBooks ? await window.fanotes.readSubjectBooks() : []
          const parsed = parseSubjectBooks(disk)
          subjectBooksDiskRef.current = parsed
          setSubjectBooksDisk(parsed)
          setSubjectBooks((memory) => mergeSubjectBooksPreferDisk(memory, parsed))
        } finally {
          setSubjectBooksHydrating(false)
        }
      })()
    })
  }, [popoutBookPath])
  const isPdfActive = Boolean(activeTab && (activeTab.kind === 'pdf' || isPdfNotePath(activeTab.path)))
  const activePaper = useMemo(
    () => normalizePaperStyle(activePath ? notePaperByPath[activePath] : undefined, settings.paperStyle),
    [activePath, notePaperByPath, settings.paperStyle],
  )
  const activeEntryMutating = useMemo(() => Boolean(activePath && mutatingEntryPaths.some(
    (path) => activePath === path || activePath.startsWith(`${path}/`),
  )), [activePath, mutatingEntryPaths])
  const counts = useMemo(() => countEntries(tree), [tree])
  const visibleTree = useMemo(() => filterTreeByTag(tree, tagFilter, new Map(Object.entries(tagIndex))), [tagFilter, tagIndex, tree])
  const knownTags = useMemo(() => collectVaultTags(Object.values(tagIndex).map((tags) => ({ content: tags.map((tag) => `#${tag}`).join(' ') }))), [tagIndex])
  const activeTags = activeTab ? parseNoteTags(activeTab.content) : []
  const splitTab = splitPath ? tabs.find((tab) => tab.path === splitPath) ?? null : null
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
    const path = activeTab?.path
    const id = activeTab ? noteInkId(activeTab.content) : null
    const initialNoteLoad = Boolean(path && initialDrawingLoadRef.current)
    if (path) initialDrawingLoadRef.current = false
    if (!path) {
      drawingOpenRef.current = false
      setDrawingOpen(false)
      setDrawingSession({ key: 0, document: null })
      return
    }
    const switched = overlayAfterNoteSwitch({
      session: { key: 0, document: null },
      drawingOpen: drawingOpenRef.current,
      host: null,
    }, requestId)
    drawingOpenRef.current = switched.drawingOpen
    setDrawingOpen(switched.drawingOpen)
    setDrawingSession(switched.session)

    let idleId: number | null = null
    let startTimer: number | null = null
    const load = () => {
      const apply = (document: DrawingLibraryDocument | null) => {
        if (requestId !== drawingLoadRequestRef.current || activePathRef.current !== path) return
        setDrawingSession(drawingSessionFromLoad(requestId, document))
      }
      const fromSidecar = () => {
        if (!id) {
          apply(null)
          return
        }
        void window.fanotes.readDrawing(id).then(apply).catch(() => apply(null))
      }
      if (typeof window.fanotes.readFamdInk === 'function') {
        void window.fanotes.readFamdInk(path)
          .then((embedded) => {
            if (requestId !== drawingLoadRequestRef.current || activePathRef.current !== path) return
            if (embedded) {
              setDrawingSession(drawingSessionFromLoad(requestId, embedded))
              return
            }
            fromSidecar()
          })
          .catch(fromSidecar)
        return
      }
      fromSidecar()
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
    const path = activePath
    if (!path || !window.fanotes.readNotePaperStyle) return
    let alive = true
    void window.fanotes.readNotePaperStyle(path)
      .then((style) => {
        if (!alive || !style) return
        setNotePaperByPath((current) => current[path] === style ? current : { ...current, [path]: style })
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [activePath])

  useEffect(() => {
    const path = activePath
    setNoteLinkPlacing(false)
    setSelectedNoteLinkId(null)
    if (!path || !window.fanotes.readNoteLinks) {
      noteLinksRef.current = []
      setNoteLinks([])
      return
    }
    let alive = true
    void window.fanotes.readNoteLinks(path)
      .then((links) => {
        if (!alive) return
        const next = Array.isArray(links) ? links : []
        noteLinksRef.current = next
        setNoteLinks(next)
      })
      .catch(() => {
        if (!alive) return
        noteLinksRef.current = []
        setNoteLinks([])
      })
    return () => { alive = false }
  }, [activePath])

  useEffect(() => {
    const path = activePath
    setBackupMenuOpen(false)
    if (!path || !window.fanotes.readNoteBackups) {
      noteBackupsRef.current = []
      setNoteBackups([])
      return
    }
    let alive = true
    void window.fanotes.readNoteBackups(path)
      .then((list) => {
        if (!alive) return
        const next = listNoteBackups(list, path)
        noteBackupsRef.current = next
        setNoteBackups(next)
      })
      .catch(() => {
        if (!alive) return
        noteBackupsRef.current = []
        setNoteBackups([])
      })
    return () => { alive = false }
  }, [activePath])

  useEffect(() => {
    if (!window.fanotes.readSubjectBooks) {
      setSubjectBooksReady(true)
      return
    }
    let alive = true
    setSubjectBooksReady(false)
    void window.fanotes.readSubjectBooks()
      .then((list) => {
        if (!alive) return
        const parsed = parseSubjectBooks(list)
        subjectBooksDiskRef.current = parsed
        setSubjectBooksDisk(parsed)
        setSubjectBooks(parsed)
      })
      .catch(() => {
        if (!alive) return
        subjectBooksDiskRef.current = []
        setSubjectBooksDisk([])
        setSubjectBooks([])
      })
      .finally(() => {
        if (alive) setSubjectBooksReady(true)
      })
    return () => { alive = false }
  }, [bootstrap?.vaultPath])

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
      void Promise.allSettled(ids.map((id) => window.fanotes.readWorksheet(id))).then((results) => {
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
    const unsubscribe = window.fanotes?.onUpdateState(applyUpdateState) ?? (() => undefined)
    const loadInitialState = () => {
      idleId = null
      void window.fanotes?.getUpdateState().then(applyUpdateState).catch(() => {})
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
    const nextTree = await window.fanotes.getTree()
    if (session !== vaultSessionGenerationRef.current) return treeRef.current
    treeRef.current = nextTree
    setTree(nextTree)
    return nextTree
  }, [])

  const rememberLastOpenNote = useCallback((path: string) => {
    if (!path || settingsRef.current.lastOpenNotePath === path) return
    const nextSettings = { ...settingsRef.current, lastOpenNotePath: path }
    settingsRef.current = nextSettings
    void window.fanotes.saveSettings(nextSettings).catch(() => undefined)
  }, [])

  const openNote = useCallback(async (path: string) => {
    if (activePathRef.current && activePathRef.current !== path && !await flushDocumentLayers()) return
    const session = vaultSessionGenerationRef.current
    const structureRevision = vaultStructureRevisionRef.current
    setOverviewOpen(false)
    setHomeworkOpen(false)
    setGlyphenWerkOpen(false)
    const existing = tabsRef.current.find((tab) => tab.path === path)
    if (existing) {
      setActivePath(path)
      setFocusToken((value) => value + 1)
      rememberLastOpenNote(path)
      return
    }
    const requestKey = `${session}:${structureRevision}:${path}`
    if (openingNotesRef.current.has(requestKey)) return
    openingNotesRef.current.add(requestKey)
    try {
      const pdfNote = isPdfNotePath(path)
      let content = ''
      if (pdfNote) {
        try {
          content = await window.fanotes.readFile(companionNotePath(path, '.famd'))
        } catch {
          content = ''
        }
      } else {
        content = await window.fanotes.readFile(path)
      }
      if (
        session !== vaultSessionGenerationRef.current ||
        structureRevision !== vaultStructureRevisionRef.current
      ) return
      const tab: NoteTab = {
        path,
        title: stripExtension(fileName(path)),
        content,
        savedContent: content,
        kind: pdfNote ? 'pdf' : 'markdown',
      }
      setTagIndex((current) => ({ ...current, [path]: parseNoteTags(content) }))
      setTabs((current) => current.some((item) => item.path === path) ? current : [...current, tab])
      setActivePath(path)
      setFocusToken((value) => value + 1)
      rememberLastOpenNote(path)
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
  }, [flushDocumentLayers, rememberLastOpenNote, toast])

  useEffect(() => {
    if (!window.fanotes) {
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
        const data = await (startupBootstrap ?? window.fanotes.bootstrap())
        if (!alive) return
        setBootstrap(data)
        const launchedSettings = { ...defaultSettingsForPlatform(window.fanotes.platform), ...data.settings }
        settingsRef.current = launchedSettings
        setSettings(launchedSettings)
        if (data.onboardingRequired) return
        // Let the shell paint first, then parse the editor chunk in parallel
        // with local tree-cache/NAS work. The shared promise also prevents the
        // later React.lazy render from scheduling a duplicate module request.
        editorWarmupFrame = window.requestAnimationFrame(() => {
          void loadMarkdownEditor()
          window.requestIdleCallback(() => { void import('./components/DrawingBoard') }, { timeout: 4_000 })
        })
        try {
          const loadFreshTree = async () => {
            let nextTree = await window.fanotes.getTree()
            if (!alive) return
            let nextNote = chooseRestoredNote(
              launchedSettings.lastOpenNotePath,
              collectNotePaths(nextTree),
              firstNote(nextTree),
            )
            if (!nextNote) {
              // Only a verified live scan may decide that the vault is empty.
              // A stale empty cache must never create a surprise note.
              const created = await window.fanotes.createNote(undefined, translateUiText('Erste Notiz'))
              if (!alive) return
              nextTree = await window.fanotes.getTree()
              nextNote = created.relativePath
            }
            treeRef.current = nextTree
            setTree(nextTree)
            if (nextNote && !activePathRef.current) await openNote(nextNote)
          }

          const cachedTree = await window.fanotes.getCachedTree().catch(() => null)
          if (!alive) return
          const startupTree = cachedTree ?? await window.fanotes.getFastTree()
          if (!alive) return
          if (startupTree.length) {
            treeRef.current = startupTree
            setTree(startupTree)
            const startupNote = chooseRestoredNote(
              launchedSettings.lastOpenNotePath,
              collectNotePaths(startupTree),
              firstNote(startupTree),
            )
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
      secondFrame = window.requestAnimationFrame(() => window.fanotes.reportRendererReady())
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [bootstrap?.vaultPath, bootstrap?.onboardingRequired])

  const completeOnboarding = useCallback(async (subjects: string[]) => {
    const data = await window.fanotes.completeOnboarding(subjects)
    setBootstrap(data)
    setSettings({ ...defaultSettingsForPlatform(window.fanotes.platform), ...data.settings })
    let initialTree = await window.fanotes.getTree()
    let initialNote = firstNote(initialTree)
    if (!initialNote) {
      const created = await window.fanotes.createNote(undefined, translateUiText('Erste Notiz'))
      initialTree = await window.fanotes.getTree()
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
      await window.fanotes.writeFile(isPdfNotePath(path) ? companionNotePath(path, '.famd') : path, content)
      setTagIndex((current) => ({ ...current, [path]: parseNoteTags(content) }))
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
        const persisted = await window.fanotes.saveSettings(snapshot)
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
    await window.fanotes.resetAppData()
  }, [flushDocumentLayers, flushPendingWrites])

  const updateContent = useCallback((content: string) => {
    if (!activePath) return
    if ([...mutatingEntryPathsRef.current].some((path) => activePath === path || activePath.startsWith(`${path}/`))) return
    setTabs((current) => current.map((tab) => tab.path === activePath ? { ...tab, content } : tab))
    setTagIndex((current) => ({ ...current, [activePath]: parseNoteTags(content) }))
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
    setSplitPath((current) => current === path ? null : current)
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
    const requestedParent = normalizePath(parent ?? settings.defaultFolder ?? '')
    const targetParent = requestedParent && folderPaths(tree).has(requestedParent)
      ? requestedParent
      : undefined
    let result: CreateResult
    try {
      result = await window.fanotes.createNote(targetParent)
    } catch (error) {
      if (session !== vaultSessionGenerationRef.current) return
      // A folder can disappear between the tree snapshot and the write (for
      // example through NAS sync). Retry only the actual creation at the vault
      // root; never create a duplicate merely because the later UI refresh or
      // editor opening failed.
      if (targetParent) {
        try {
          result = await window.fanotes.createNote()
        } catch (fallbackError) {
          if (session === vaultSessionGenerationRef.current) {
            toast(fallbackError instanceof Error ? fallbackError.message : 'Notiz konnte nicht erstellt werden.', 'error')
          }
          return
        }
      } else {
        toast(error instanceof Error ? error.message : 'Notiz konnte nicht erstellt werden.', 'error')
        return
      }
    }
    if (session !== vaultSessionGenerationRef.current) return
    vaultStructureRevisionRef.current += 1
    try {
      await refreshTree()
    } catch (error) {
      // The note already exists at this point. Opening it directly keeps the
      // editor usable even if a slow/remounted vault cannot refresh its full
      // tree in the same moment.
      console.warn('FaNotes-Dateibaum konnte nach dem Erstellen nicht aktualisiert werden:', error)
    }
    if (session !== vaultSessionGenerationRef.current) return
    try {
      await openNote(result.relativePath)
      toast('Neue Markdown-Notiz erstellt.', 'success')
    } catch (error) {
      toast(
        `Die Notiz wurde erstellt, konnte aber nicht geöffnet werden: ${error instanceof Error ? error.message : 'Unbekannter Fehler'}`,
        'error',
      )
    }
  }, [openNote, refreshTree, settings.defaultFolder, toast, tree])

  const persistNoteLinks = useCallback(async (path: string, links: NoteLinkRecord[]) => {
    noteLinksRef.current = links
    setNoteLinks(links)
    if (!window.fanotes.writeNoteLinks) return
    await window.fanotes.writeNoteLinks(path, links)
  }, [])

  const persistNoteBackups = useCallback(async (path: string, backups: NoteBackupSnapshot[]) => {
    const next = listNoteBackups(backups, path)
    noteBackupsRef.current = next
    setNoteBackups(next)
    if (!window.fanotes.writeNoteBackups) return
    await window.fanotes.writeNoteBackups(path, next)
  }, [])

  const persistSubjectBooks = useCallback(async (list: SubjectBookRecord[]) => {
    const next = parseSubjectBooks(list)
    subjectBooksRef.current = next
    subjectBooksDiskRef.current = next
    setSubjectBooks(next)
    setSubjectBooksDisk(next)
    if (window.fanotes.writeSubjectBooks) await window.fanotes.writeSubjectBooks(next)
  }, [])

  const refreshSubjectBooksFromDisk = useCallback(async () => {
    setSubjectBooksHydrating(true)
    try {
      const disk = window.fanotes.readSubjectBooks ? await window.fanotes.readSubjectBooks() : []
      const parsed = parseSubjectBooks(disk)
      subjectBooksDiskRef.current = parsed
      setSubjectBooksDisk(parsed)
      setSubjectBooks((memory) => mergeSubjectBooksPreferDisk(memory, parsed))
    } finally {
      setSubjectBooksHydrating(false)
    }
  }, [])

  const attachBookToSubject = useCallback(async (subjectPath: string) => {
    if (!window.fanotes.importSubjectBook) {
      toast('Bücher können in dieser Umgebung nicht hinzugefügt werden.', 'info')
      return
    }
    try {
      const created = await window.fanotes.importSubjectBook(subjectPath)
      if (!created) return
      const next = attachSubjectBook(subjectBooks, { subjectPath, bookPath: created.relativePath })
      await persistSubjectBooks(next.list)
      await refreshTree()
      toast('Buch zum Fach hinzugefügt. Oben blendest du die Ansicht ein.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das Buch konnte nicht hinzugefügt werden.', 'error')
    }
  }, [persistSubjectBooks, refreshTree, subjectBooks, toast])

  const detachBookFromSubject = useCallback(async (subjectPath: string) => {
    try {
      await persistSubjectBooks(detachSubjectBook(subjectBooks, subjectPath))
      if (currentBook?.subjectPath === subjectPath) setBookOpen(false)
      toast('Buch vom Fach entfernt. Die PDF-Datei bleibt im Ordner.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das Buch konnte nicht entfernt werden.', 'error')
    }
  }, [currentBook?.subjectPath, persistSubjectBooks, subjectBooks, toast])

  const toggleBookView = useCallback(() => {
    const next = toggleSubjectBookView(bookOpen, bookPlacement)
    const leavingPopout = bookPlacement === 'popout' && !next.open
    if (leavingPopout) setSubjectBooksHydrating(true)
    setBookOpen(next.open)
    setBookPlacement(next.placement)
    if (leavingPopout) void refreshSubjectBooksFromDisk()
  }, [bookOpen, bookPlacement, refreshSubjectBooksFromDisk])

  const placeBookView = useCallback((placement: SubjectBookPlacement) => {
    const next = applySubjectBookPlacement(placement)
    const leavingPopout = bookPlacement === 'popout' && next.placement !== 'popout'
    if (leavingPopout) setSubjectBooksHydrating(true)
    setBookOpen(next.open)
    if (next.placement) setBookPlacement(next.placement)
    if (leavingPopout) {
      void window.fanotes.closeSubjectBookPopout?.()
      void refreshSubjectBooksFromDisk()
    }
  }, [bookPlacement, refreshSubjectBooksFromDisk])

  const handleBookPage = useCallback((page: number, pageCount: number) => {
    if (!currentBook) return
    const patched = patchSubjectBookPage(subjectBooksDiskRef.current, currentBook, page, pageCount)
    const current = subjectBooksDiskRef.current.find((book) => book.subjectPath === currentBook.subjectPath)
    const next = patched.find((book) => book.subjectPath === currentBook.subjectPath)
    if (!next || next.lastPage === current?.lastPage) return
    subjectBooksDiskRef.current = patched
    setSubjectBooksDisk(patched)
    setSubjectBooks((memory) => mergeSubjectBooksPreferDisk(memory, patched))
    if (window.fanotes.writeSubjectBooks) void window.fanotes.writeSubjectBooks(patched)
  }, [currentBook])

  const snapshotCurrentNote = useCallback(async () => {
    const path = activePathRef.current
    if (!path) {
      toast('Öffne zuerst eine Notiz, die gesichert werden kann.', 'info')
      return
    }
    editorRef.current?.flushChanges()
    const live = pendingWrites.current.get(path) ?? tabsRef.current.find((tab) => tab.path === path)?.content ?? ''
    try {
      const { list } = createNoteBackup(noteBackupsRef.current, { notePath: path, content: live })
      await persistNoteBackups(path, list)
      toast('Backup gespeichert.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das Backup konnte nicht erstellt werden.', 'error')
    }
  }, [persistNoteBackups, toast])

  const restoreCurrentNoteBackup = useCallback(async (id: string) => {
    const path = activePathRef.current
    if (!path) return
    const content = restoreNoteBackup(noteBackupsRef.current, id, path)
    if (content === null) {
      toast('Dieses Backup gibt es nicht.', 'error')
      return
    }
    updateContent(content)
    await saveContent(path, content)
    toast('Backup wiederhergestellt.', 'success')
  }, [saveContent, toast, updateContent])

  const startNoteLinkPlacement = useCallback(() => {
    if (!activePathRef.current) {
      toast('Öffne zuerst eine Notiz, um eine Verlinkung zu setzen.', 'info')
      return
    }
    setNoteLinkPlacing((current) => !current)
  }, [toast])

  const applyNoteLinkStyle = useCallback(async (style: NoteLinkStyleId) => {
    setNoteLinkStyle(style)
    const selected = noteLinksRef.current.find((link) => link.id === selectedNoteLinkId)
    const path = activePathRef.current
    if (!selected || !path) return
    const next = restyleNoteLink(selected, style)
    const links = noteLinksRef.current.map((link) => link.id === next.id ? next : link)
    try {
      await persistNoteLinks(path, links)
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Der Verlinkungsstil konnte nicht gespeichert werden.', 'error')
    }
  }, [persistNoteLinks, selectedNoteLinkId, toast])

  const removePlacedNoteLink = useCallback(async (link: NoteLinkRecord) => {
    const path = activePathRef.current
    if (!path) return
    if (!window.confirm('Verlinkung wirklich entfernen? Die verlinkte Notiz bleibt im Vault.')) return
    try {
      const links = removeNoteLink(noteLinksRef.current, link.id)
      await persistNoteLinks(path, links)
      setSelectedNoteLinkId((current) => current === link.id ? null : current)
      toast('Verlinkung entfernt.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Die Verlinkung konnte nicht entfernt werden.', 'error')
    }
  }, [persistNoteLinks, toast])

  const removeSelectedNoteLink = useCallback(async () => {
    const selected = noteLinksRef.current.find((link) => link.id === selectedNoteLinkId)
    if (!selected) return
    await removePlacedNoteLink(selected)
  }, [removePlacedNoteLink, selectedNoteLinkId])

  const placeNoteLinkAt = useCallback(async (point: { page: number; x: number; y: number }) => {
    const sourcePath = activePathRef.current
    if (!sourcePath) return
    const session = vaultSessionGenerationRef.current
    const requestedParent = linkedNoteParent(sourcePath)
    const targetParent = requestedParent && folderPaths(treeRef.current).has(requestedParent)
      ? requestedParent
      : undefined
    try {
      const created = await window.fanotes.createNote(targetParent, linkedNotePreferredName(sourcePath))
      if (session !== vaultSessionGenerationRef.current) return
      vaultStructureRevisionRef.current += 1
      try {
        await refreshTree()
      } catch (error) {
        console.warn('FaNotes-Dateibaum konnte nach der Verlinkung nicht aktualisiert werden:', error)
      }
      if (session !== vaultSessionGenerationRef.current) return
      const link = placeNewNoteLink({
        sourcePath,
        page: point.page,
        x: point.x,
        y: point.y,
        style: noteLinkStyle,
      }, { targetPath: created.relativePath })
      await persistNoteLinks(sourcePath, [...noteLinksRef.current, link])
      setSelectedNoteLinkId(link.id)
      setNoteLinkPlacing(false)
      toast('Verlinkung gesetzt. Tippen öffnet die neue Notiz.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Die Verlinkung konnte nicht erstellt werden.', 'error')
    }
  }, [noteLinkStyle, persistNoteLinks, refreshTree, toast])

  const followPlacedNoteLink = useCallback(async (link: NoteLinkRecord) => {
    const target = activateNoteLink(link)
    const source = activePathRef.current
    if (!target || !source) return
    const next = followNoteNav(noteNavStackRef.current, source, target)
    await openNote(next.current)
    noteNavStackRef.current = next.stack
    setNoteNavStack(next.stack)
  }, [openNote])

  const goBackNoteLink = useCallback(async () => {
    const current = activePathRef.current || ''
    const next = goBackNoteNav(noteNavStackRef.current, current)
    if (!next.current || next.current === current) return
    await openNote(next.current)
    noteNavStackRef.current = next.stack
    setNoteNavStack(next.stack)
  }, [openNote])

  const importPdfNote = useCallback(async (parent?: string) => {
    const session = vaultSessionGenerationRef.current
    vaultStructureRevisionRef.current += 1
    const requestedParent = normalizePath(parent ?? settings.defaultFolder ?? '')
    const targetParent = requestedParent && folderPaths(tree).has(requestedParent)
      ? requestedParent
      : undefined
    try {
      const result = await window.fanotes.importPdfNote(targetParent)
      if (!result) return
      if (session !== vaultSessionGenerationRef.current) return
      vaultStructureRevisionRef.current += 1
      try {
        await refreshTree()
      } catch (error) {
        console.warn('FaNotes-Dateibaum konnte nach dem PDF-Import nicht aktualisiert werden:', error)
      }
      if (session !== vaultSessionGenerationRef.current) return
      await openNote(result.relativePath)
      toast(`PDF „${stripExtension(fileName(result.relativePath))}“ ist jetzt eine Notiz.`, 'success')
    } catch (error) {
      if (session === vaultSessionGenerationRef.current) {
        toast(error instanceof Error ? error.message : 'Das PDF konnte nicht als Notiz importiert werden.', 'error')
      }
    }
  }, [openNote, refreshTree, settings.defaultFolder, toast, tree])

  const createFolder = useCallback(async (parent?: string) => {
    const session = vaultSessionGenerationRef.current
    vaultStructureRevisionRef.current += 1
    try {
      const created = await window.fanotes.createFolder(parent)
      if (session !== vaultSessionGenerationRef.current) return
      vaultStructureRevisionRef.current += 1
      setRevealPath(created.relativePath)
      await refreshTree()
      toast(parent ? `Unterordner in „${parent.split('/').pop()}“ erstellt.` : 'Neuer Ordner erstellt.', 'success')
    } catch (error) {
      if (session === vaultSessionGenerationRef.current) toast(error instanceof Error ? error.message : 'Ordner konnte nicht erstellt werden.', 'error')
    }
  }, [refreshTree, toast])

  const setFolderColor = useCallback(async (path: string, color: string | null) => {
    const session = vaultSessionGenerationRef.current
    try {
      await window.fanotes.setFolderColor(path, color)
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
          const created = await window.fanotes.createFolder(folder, segment)
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
      const result = await window.fanotes.createNote(folder, title)
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

  const remapNotePaperPaths = useCallback((from: string, to: string | null) => {
    setNotePaperByPath((current) => {
      const next = { ...current }
      Object.entries(current).forEach(([candidate, style]) => {
        if (candidate !== from && !candidate.startsWith(`${from}/`)) return
        delete next[candidate]
        if (to !== null) next[candidate === from ? to : `${to}${candidate.slice(from.length)}`] = style
      })
      return next
    })
  }, [])

  const renameEntry = useCallback(async (path: string, nextName: string) => {
    const session = vaultSessionGenerationRef.current
    const active = activePathRef.current
    if (active && (active === path || active.startsWith(`${path}/`)) && !await flushDocumentLayers()) {
      toast('Umbenennen abgebrochen: Handschrift oder Arbeitsblatt konnte nicht sicher gespeichert werden.', 'error')
      return
    }
    vaultStructureRevisionRef.current += 1
    const nextPath = await window.fanotes.renameEntry(path, nextName)
    if (session !== vaultSessionGenerationRef.current) return
    remapNotePaperPaths(path, nextPath)
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
  }, [flushDocumentLayers, refreshTree, remapNotePaperPaths, saveContent, toast])

  const moveEntry = useCallback(async (path: string, destFolder = '') => {
    const session = vaultSessionGenerationRef.current
    const active = activePathRef.current
    if (active && (active === path || active.startsWith(`${path}/`)) && !await flushDocumentLayers()) {
      toast('Verschieben abgebrochen: Handschrift oder Arbeitsblatt konnte nicht sicher gespeichert werden.', 'error')
      return
    }
    vaultStructureRevisionRef.current += 1
    try {
      const nextPath = await window.fanotes.moveEntry(path, destFolder)
      if (session !== vaultSessionGenerationRef.current) return
      if (nextPath === path) return
      remapNotePaperPaths(path, nextPath)
      vaultStructureRevisionRef.current += 1
      ;[...saveTimers.current.entries()].forEach(([timerPath, timer]) => {
        if (timerPath === path || timerPath.startsWith(`${path}/`)) {
          window.clearTimeout(timer)
          saveTimers.current.delete(timerPath)
        }
      })
      setTabs((current) => current.map((tab) => {
        if (tab.path !== path && !tab.path.startsWith(`${path}/`)) return tab
        const movedPath = tab.path === path ? nextPath : `${nextPath}${tab.path.slice(path.length)}`
        return { ...tab, path: movedPath, title: stripExtension(fileName(movedPath)) }
      }))
      const pending = [...pendingWrites.current.entries()]
      const movedPending: [string, string][] = []
      pending.forEach(([pendingPath, content]) => {
        if (pendingPath !== path && !pendingPath.startsWith(`${path}/`)) return
        pendingWrites.current.delete(pendingPath)
        const movedPath = pendingPath === path ? nextPath : `${nextPath}${pendingPath.slice(path.length)}`
        pendingWrites.current.set(movedPath, content)
        movedPending.push([movedPath, content])
      })
      setActivePath((current) => current && (current === path || current.startsWith(`${path}/`))
        ? `${nextPath}${current.slice(path.length)}`
        : current)
      if (destFolder) setRevealPath(destFolder)
      await refreshTree()
      await Promise.all(movedPending.map(([movedPath, content]) => saveContent(movedPath, content)))
      const label = stripExtension(fileName(nextPath))
      toast(
        destFolder
          ? `„${label}“ nach „${destFolder.split('/').pop()}“ verschoben.`
          : `„${label}“ in die oberste Ebene verschoben.`,
        'success',
      )
    } catch (error) {
      if (session === vaultSessionGenerationRef.current) {
        toast(error instanceof Error ? error.message : 'Verschieben fehlgeschlagen.', 'error')
      }
    }
  }, [flushDocumentLayers, refreshTree, remapNotePaperPaths, saveContent, toast])

  const trashEntry = useCallback(async (path: string) => {
    const session = vaultSessionGenerationRef.current
    vaultStructureRevisionRef.current += 1
    let mutationMarked = false
    try {
      const active = activePathRef.current
      if (active && (active === path || active.startsWith(`${path}/`)) && !await flushDocumentLayers()) {
        toast('Verschieben abgebrochen: Handschrift oder Arbeitsblatt konnte nicht sicher gespeichert werden.', 'error')
        return
      }
      const saved = await flushPendingEntry(path)
      if (session !== vaultSessionGenerationRef.current) return
      if (!saved) {
        toast('Verschieben abgebrochen: Die letzten Änderungen konnten nicht sicher gespeichert werden.', 'error')
        return
      }
      mutatingEntryPathsRef.current.add(path)
      setMutatingEntryPaths((current) => current.includes(path) ? current : [...current, path])
      mutationMarked = true
      await window.fanotes.trashEntry(path)
      if (session !== vaultSessionGenerationRef.current) return
      remapNotePaperPaths(path, null)
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
  }, [flushDocumentLayers, flushPendingEntry, refreshTree, remapNotePaperPaths, toast])

  const syncPublishedHomework = useCallback(async (current: AppSettings, document?: HomeworkDocument) => {
    const channelId = current.homeworkApiChannelId
    if (!HOMEWORK_CHANNEL_ID_PATTERN.test(channelId)) return
    const origin = homeworkApiOriginFromLocation(window.fanotes?.platform)
    const previousSecret = lastHomeworkSecretRef.current
    const publishSecret = homeworkApiSecretReady(current.homeworkApiSecret) ? current.homeworkApiSecret : previousSecret
    const enabled = Boolean(current.experimentalHomeworkApi && homeworkApiSecretReady(current.homeworkApiSecret))
    if (!enabled) {
      if (!homeworkApiSecretReady(publishSecret)) return
      const result = await publishHomeworkList({
        enabled: false,
        channelId,
        secret: publishSecret,
        previousSecret,
        document: document ?? { version: 1, tasks: [] },
        origin,
      }).catch(() => undefined)
      if (result?.ok) lastHomeworkSecretRef.current = ''
      return
    }
    let nextDocument = document
    if (!nextDocument) {
      try {
        nextDocument = parseHomeworkMarkdown(await window.fanotes.readFile(HOMEWORK_NOTE_PATH))
      } catch {
        nextDocument = { version: 1, tasks: [] }
      }
    }
    const remote = await queryHomeworkList({
      channelId,
      secret: current.homeworkApiSecret,
      origin,
    }).catch(() => ({ ok: false, status: 0, payload: null }))
    if (remote.ok && remote.payload) {
      const merged = mergeHomeworkFromRemote(nextDocument, remote.payload.tasks)
      if (JSON.stringify(merged.tasks) !== JSON.stringify(nextDocument.tasks)) {
        try {
          await window.fanotes.writeFile(HOMEWORK_NOTE_PATH, serializeHomeworkMarkdown(merged))
          setHomeworkReloadToken((value) => value + 1)
        } catch {
          /* keep the merged copy in memory for the following publish */
        }
      }
      nextDocument = merged
    }
    const result = await publishHomeworkList({
      enabled: true,
      channelId,
      secret: current.homeworkApiSecret,
      previousSecret,
      document: nextDocument,
      origin,
    }).catch(() => undefined)
    if (result?.ok) {
      lastHomeworkSecretRef.current = current.homeworkApiSecret
      const remembered = rememberPublishedHomeworkIds(nextDocument, nextDocument.tasks.map((task) => task.id))
      if (JSON.stringify(remembered.publishedIds ?? []) !== JSON.stringify(nextDocument.publishedIds ?? [])) {
        try {
          await window.fanotes.writeFile(HOMEWORK_NOTE_PATH, serializeHomeworkMarkdown(remembered))
        } catch { /* ids are best-effort */ }
      }
    }
  }, [])

  const remoteSupportSessionRef = useRef(remoteSupportSession)
  useEffect(() => { remoteSupportSessionRef.current = remoteSupportSession }, [remoteSupportSession])

  const stopRemoteSupport = useCallback(() => {
    const current = remoteSupportSessionRef.current
    remoteSupportSessionRef.current = null
    setRemoteSupportSession(null)
    if (!current) return
    const request = buildRemoteSupportStopRequest(current.token, homeworkApiOriginFromLocation(window.fanotes.platform))
    void fetch(request.url, { method: request.method, headers: request.headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => undefined)
  }, [])

  const startRemoteSupport = useCallback(() => {
    if (!settingsRef.current.experimentalRemoteSupport) return
    const session = startRemoteSupportSession()
    remoteSupportSessionRef.current = session
    setRemoteSupportSession(session)
    const request = buildRemoteSupportRegisterRequest(session.token, homeworkApiOriginFromLocation(window.fanotes.platform))
    void fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }).catch(() => undefined)
  }, [])

  const applySettings = useCallback((next: AppSettings) => {
    const previous = settingsRef.current
    const revision = settingsRevisionRef.current + 1
    settingsRevisionRef.current = revision
    settingsRef.current = next
    writeSharedZoomSpeed(next.viewZoomSpeed)
    writeSharedZoomMaxPercent(next.viewZoomMax ?? 325)
    setSettings(next)
    if (previous.experimentalRemoteSupport && !next.experimentalRemoteSupport) stopRemoteSupport()
    if (settingsTimer.current) window.clearTimeout(settingsTimer.current)
    const timer = window.setTimeout(() => {
      if (settingsTimer.current === timer) settingsTimer.current = null
      void window.fanotes.saveSettings(next)
        .then(() => {
          settingsPersistedRevisionRef.current = Math.max(settingsPersistedRevisionRef.current, revision)
        })
        .catch(() => toast('Einstellungen konnten nicht gespeichert werden.', 'error'))
      const homeworkChanged = previous.experimentalHomeworkApi !== next.experimentalHomeworkApi
        || previous.homeworkApiChannelId !== next.homeworkApiChannelId
        || previous.homeworkApiSecret !== next.homeworkApiSecret
      if (homeworkChanged) void syncPublishedHomework(next)
    }, 180)
    settingsTimer.current = timer
  }, [stopRemoteSupport, syncPublishedHomework, toast])

  const resetSettings = useCallback(() => {
    if (settingsTimer.current) window.clearTimeout(settingsTimer.current)
    settingsTimer.current = null
    const previous = settingsRef.current
    const revision = settingsRevisionRef.current + 1
    settingsRevisionRef.current = revision
    const defaults = defaultSettingsForPlatform(window.fanotes.platform)
    settingsRef.current = { ...defaults }
    writeSharedZoomSpeed(defaults.viewZoomSpeed)
    writeSharedZoomMaxPercent(defaults.viewZoomMax)
    setSettings({ ...defaults })
    stopRemoteSupport()
    void syncPublishedHomework({ ...previous, experimentalHomeworkApi: false })
    void window.fanotes.saveSettings(defaults, { clearProtectedSecrets: true })
      .then((persisted) => {
        settingsPersistedRevisionRef.current = Math.max(settingsPersistedRevisionRef.current, revision)
        if (settingsRevisionRef.current !== revision) return
        secureSettingsLoadRef.current = null
        settingsRef.current = persisted
        setSettings(persisted)
        toast('Standardeinstellungen wiederhergestellt.', 'success')
      })
      .catch(() => toast('Die Standardeinstellungen konnten nicht gespeichert werden.', 'error'))
  }, [stopRemoteSupport, syncPublishedHomework, toast])

  const handleDrawingSettingsChange = useCallback((changes: Partial<AppSettings>) => {
    const { paperStyle: _ignoredPaper, ...rest } = changes
    if (Object.keys(rest).length) applySettings({ ...settingsRef.current, ...rest })
  }, [applySettings])

  const applyNotePaper = useCallback(async (path: string, paperStyle: PaperStyle) => {
    setNotePaperByPath((current) => current[path] === paperStyle ? current : { ...current, [path]: paperStyle })
    if (!window.fanotes.setNotePaperStyle) return
    try {
      await window.fanotes.setNotePaperStyle(path, paperStyle)
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Der Notizhintergrund konnte nicht gespeichert werden.', 'error')
    }
  }, [toast])

  const loadSecureSettings = useCallback(() => {
    if (!window.fanotes.loadSecureSettings) return Promise.resolve()
    secureSettingsLoadRef.current ??= window.fanotes.loadSecureSettings()
      .then((secrets) => {
        const next = { ...settingsRef.current, ...secrets }
        settingsRef.current = next
        setSettings((current) => ({ ...current, ...secrets }))
        if (
          next.experimentalHomeworkApi
          && homeworkApiSecretReady(next.homeworkApiSecret)
          && HOMEWORK_CHANNEL_ID_PATTERN.test(next.homeworkApiChannelId)
        ) {
          lastHomeworkSecretRef.current = next.homeworkApiSecret
          void syncPublishedHomework(next)
        }
      })
      .catch((error) => {
        secureSettingsLoadRef.current = null
        throw error
      })
    return secureSettingsLoadRef.current
  }, [syncPublishedHomework])

  useEffect(() => {
    if (!bootstrap?.vaultPath) return
    if (settingsRef.current.experimentalHomeworkApi) void loadSecureSettings()
  }, [bootstrap?.vaultPath, loadSecureSettings])

  const openSettings = useCallback(() => {
    void loadSecureSettings()
      .catch(() => undefined)
      .finally(() => setSettingsOpen(true))
  }, [loadSecureSettings])

  const openLmStudio = useCallback(() => {
    setPaletteOpen(false)
    setSearchOpen(false)
    setGlyphenWerkOpen(false)
    setOverviewOpen(false)
    setHomeworkOpen(false)
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
      const selected = await window.fanotes.selectVault()
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
      const selectedSettings = { ...defaultSettingsForPlatform(window.fanotes.platform), ...selected.settings }
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
      const first = firstNote(nextTree)
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
      const next = await window.fanotes.checkForUpdates()
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
      // Show progress immediately — the IPC download only resolves when finished,
      // while fine-grained updates arrive via onUpdateState.
      setUpdateState((current) => ({
        ...current,
        status: 'downloading',
        progress: current.status === 'downloading' ? Math.max(current.progress, 0.01) : 0.01,
        downloadedBytes: current.status === 'downloading' ? current.downloadedBytes : 0,
        error: null,
      }))
      toast('Update-Download gestartet …', 'info')
      setUpdateState(await window.fanotes.downloadUpdate())
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das Update konnte nicht heruntergeladen werden.', 'error')
      try {
        setUpdateState(await window.fanotes.getUpdateState())
      } catch {
        // Keep the optimistic downloading state only if recovery fails.
      }
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
      setUpdateState(await window.fanotes.installUpdate())
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
      void window.fanotes.search(query)
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
    if (!activePathRef.current || drawingOpen || overviewOpen || homeworkOpen) {
      toast('Öffne eine Notiz im Editor, um sie zu formatieren.', 'info')
      return
    }
    if (activeEntryMutating) {
      toast('Diese Notiz ist während der Dateiaktion schreibgeschützt.', 'error')
      return
    }
    if (!editorRef.current?.format(action)) toast('Die Formatierung konnte nicht angewandt werden.', 'error')
  }, [activeEntryMutating, drawingOpen, homeworkOpen, overviewOpen, toast])

  const handleDrawingDirtyChange = useCallback((dirty: boolean) => {
    drawingDirtyRef.current = dirty
  }, [])

  const closeDrawing = useCallback(() => {
    drawingOpenRef.current = false
    setDrawingOpen(false)
    return true
  }, [])

  useEffect(() => window.fanotes?.onBeforeClose(() => {
    if (closeInProgressRef.current) return
    // Stop Main's watchdog while a deliberate renderer confirmation dialog is
    // open; after confirmation requestClose below arms it again for the flush.
    window.fanotes.cancelClose()
    closeInProgressRef.current = true
    window.fanotes.requestClose()
    void flushDocumentLayers()
      .then(async (documentLayersSaved) => {
        const [notesSaved, settingsSaved] = documentLayersSaved
          ? await Promise.all([flushPendingWrites(), flushSettings()])
          : [false, false]
        if (notesSaved && settingsSaved && documentLayersSaved) {
          drawingDirtyRef.current = false
          window.fanotes.confirmClose()
          return
        }
        closeInProgressRef.current = false
        window.fanotes.cancelClose()
        toast('Beenden abgebrochen: Deine Änderungen bleiben geöffnet und können erneut gespeichert werden.', 'error')
      })
      .catch((error) => {
        closeInProgressRef.current = false
        window.fanotes.cancelClose()
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
    setHomeworkOpen(false)
    setSearchOpen(false)
    setDrawingOpen(true)
    if (drawingSession.key > 0) return
    const id = noteInkId(activeTab.content)
    if (!id) {
      setDrawingSession((current) => current.key > 0 ? current : drawingSessionFromLoad(1, null))
      return
    }
    const requestId = ++drawingLoadRequestRef.current
    void window.fanotes.readDrawing(id)
      .then((document) => {
        if (requestId !== drawingLoadRequestRef.current || activePathRef.current !== activeTab.path) return
        setDrawingSession(drawingSessionFromLoad(requestId, document))
      })
      .catch(() => {
        if (requestId === drawingLoadRequestRef.current && activePathRef.current === activeTab.path) {
          setDrawingSession(drawingSessionFromLoad(requestId, null))
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

  const openNoteRef = useRef(openNote)
  const openDrawingRef = useRef(openDrawing)
  const closeDrawingRef = useRef(closeDrawing)
  const pendingBoardDriveRef = useRef<RemoteSupportBoardQueue | null>(null)
  useEffect(() => { openNoteRef.current = openNote }, [openNote])
  useEffect(() => { openDrawingRef.current = openDrawing }, [openDrawing])
  useEffect(() => { closeDrawingRef.current = closeDrawing }, [closeDrawing])
  useEffect(() => {
    if (!drawingOpen) {
      pendingBoardDriveRef.current = null
      return
    }
    let cancelled = false
    const pump = () => {
      if (cancelled) return
      pendingBoardDriveRef.current = flushRemoteSupportBoardDrive(drawingBoardRef.current, pendingBoardDriveRef.current)
      if (pendingBoardDriveRef.current) window.requestAnimationFrame(pump)
    }
    pump()
    return () => { cancelled = true }
  }, [drawingOpen, drawingSession.key])

  useEffect(() => {
    if (!settings.experimentalRemoteSupport || !remoteSupportSession) return
    const session = remoteSupportSession
    const origin = homeworkApiOriginFromLocation(window.fanotes.platform)
    const fallbackSnapshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    let cancelled = false
    const readLive = async () => {
      let snapshot = fallbackSnapshot
      try {
        const captured = await window.fanotes.captureWindow?.()
        if (typeof captured === 'string' && captured.length > 8) snapshot = captured
      } catch { /* keep fallback */ }
      const board = drawingBoardRef.current?.supportSnapshot?.()
      return createRemoteSupportLiveState({
        version: APP_VERSION,
        platform: window.fanotes.platform || '',
        settings: { ...settingsRef.current },
        openNote: noteTitleFromPath(activePathRef.current || ''),
        openPath: activePathRef.current || '',
        vaultTree: collectVaultTreeNames(treeRef.current),
        tool: board?.tool || (drawingOpenRef.current ? 'pen' : 'keyboard'),
        mode: drawingOpenRef.current ? (board?.inkMode || 'ink') : 'keyboard',
        snapshot,
      })
    }
    const applySideEffect = async (command: RemoteSupportCommand) => {
      if (command.kind === 'open-note') await openNoteRef.current(command.path)
      if (command.kind === 'set-tool') {
        if (!drawingOpenRef.current) openDrawingRef.current()
        pendingBoardDriveRef.current = applyRemoteSupportBoardDrive(
          drawingBoardRef.current,
          pendingBoardDriveRef.current,
          command,
        )
      }
      if (command.kind === 'set-mode') {
        if (command.mode === 'keyboard') {
          pendingBoardDriveRef.current = applyRemoteSupportBoardDrive(
            drawingBoardRef.current,
            pendingBoardDriveRef.current,
            command,
          )
          closeDrawingRef.current()
        } else {
          if (!drawingOpenRef.current) openDrawingRef.current()
          pendingBoardDriveRef.current = applyRemoteSupportBoardDrive(
            drawingBoardRef.current,
            pendingBoardDriveRef.current,
            command,
          )
        }
      }
      if (command.kind === 'pointer') injectRemoteSupportPointer(command)
      if (command.kind === 'key') injectRemoteSupportKey(command)
    }
    const tick = async () => {
      if (cancelled) return
      const poll = buildRemoteSupportPollRequest(session.token, origin)
      try {
        const response = await fetch(poll.url, { method: poll.method, headers: poll.headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
        if (!response.ok) return
        const payload = await response.json() as { commands?: Array<{ id: string; command: RemoteSupportCommand }> }
        const live = await readLive()
        for (const item of payload.commands || []) {
          const result = dispatchRemoteSupportCommand(session, settingsRef.current.experimentalRemoteSupport, session.token, item.command, live)
          if (result.ok && item.command.kind !== 'inspect') await applySideEffect(item.command)
          const report = buildRemoteSupportResultRequest(session.token, item.id, result, origin)
          await fetch(report.url, {
            method: report.method,
            headers: report.headers,
            body: JSON.stringify(report.body),
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          }).catch(() => undefined)
        }
      } catch {
        /* relay may be offline until the site process picks up the route */
      }
    }
    const timer = window.setInterval(() => { void tick() }, 900)
    void tick()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [remoteSupportSession, settings.experimentalRemoteSupport])

  useEffect(() => {
    if (overviewOpen || glyphenWerkOpen) setSidebarToolsOpen(true)
  }, [overviewOpen, glyphenWerkOpen])

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
      const document = await window.fanotes.readDrawing(hit.drawingId)
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
    setHomeworkOpen(false)
    setGlyphenWerkOpen(false)
    setSidebarVisible(true)
  }, [closeDrawing])

  const openOverview = useCallback(() => {
    if (!closeDrawing()) return
    setGlyphenWerkOpen(false)
    setHomeworkOpen(false)
    setOverviewOpen(true)
  }, [closeDrawing])

  const openHomework = useCallback(() => {
    if (!closeDrawing()) return
    setGlyphenWerkOpen(false)
    setOverviewOpen(false)
    setSearchOpen(false)
    setHomeworkOpen(true)
  }, [closeDrawing])

  const openGlyphenWerk = useCallback(() => {
    if (!closeDrawing()) return
    setPaletteOpen(false)
    setSearchOpen(false)
    setOverviewOpen(false)
    setHomeworkOpen(false)
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
    if (tab.kind === 'pdf' || isPdfNotePath(notePath)) {
      toast('In einer PDF-Notiz bleibt erkannter Text in der Handschrift. Wechsle für Markdown in eine normale Notiz.', 'info')
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
    const asset = await window.fanotes.saveDrawing({
      ...payload,
      noteRelativePath: notePath ?? undefined,
    })
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
    const saved = await window.fanotes.saveWorksheet(document)
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
    setHomeworkOpen(false)
    setWorksheetImportOpen(true)
  }, [])

  const importWorksheet = useCallback(async (target: 'current' | 'new') => {
    if (worksheetImportBusy) return
    if (target === 'current' && !activeTab) {
      toast('Öffne zuerst eine Notiz oder wähle „Neue Notiz“.', 'info')
      return
    }
    if (target === 'current' && activeTab && (activeTab.kind === 'pdf' || isPdfNotePath(activeTab.path))) {
      toast('Arbeitsblätter gehören in Markdown-Notizen. Eine PDF-Notiz ist bereits das Dokument selbst.', 'info')
      return
    }
    const targetPath = target === 'current' ? activeTab!.path : null
    setWorksheetImportBusy(true)
    setWorksheetImportOpen(false)
    try {
      const document = await window.fanotes.importWorksheet()
      if (!document) return
      if (target === 'new') {
        vaultStructureRevisionRef.current += 1
        const created = await window.fanotes.createNote(settings.defaultFolder || undefined, document.title)
        const initialContent = await window.fanotes.readFile(created.relativePath)
        const nextContent = attachWorksheet(initialContent, document.id)
        await window.fanotes.writeFile(created.relativePath, nextContent)
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
        const currentContent = await window.fanotes.readFile(targetPath)
        await window.fanotes.writeFile(targetPath, attachWorksheet(currentContent, document.id))
      }
      toast(`Arbeitsblatt „${document.title}“ wurde in die Notiz eingefügt.`, 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das Arbeitsblatt konnte nicht importiert werden.', 'error')
    } finally {
      setWorksheetImportBusy(false)
    }
  }, [activeTab, openNote, refreshTree, settings.defaultFolder, toast, updateContent, worksheetImportBusy])

  const attachImportedWorksheet = useCallback(async (document: WorksheetDocument) => {
    const targetPath = activePathRef.current
    if (!targetPath) {
      toast('Öffne zuerst eine Notiz, dann Bild einfügen.', 'info')
      return
    }
    const tab = tabsRef.current.find((item) => item.path === targetPath)
    const currentContent = pendingWrites.current.get(targetPath) ?? tab?.content ?? ''
    const nextContent = attachWorksheet(currentContent, document.id)
    updateContent(nextContent)
    setWorksheetSession((current) => current.documents.some((item) => item.id === document.id)
      ? current
      : { key: current.key + 1, documents: [...current.documents, document] })
    toast(`„${document.title}“ liegt auf dem Blatt.`, 'success')
  }, [toast, updateContent])

  const importImageBytes = useCallback(async (file: File) => {
    if (!window.fanotes.importWorksheetFromData) {
      toast('Bilder auf das Blatt legen geht in dieser Version noch nicht.', 'error')
      return
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const document = await window.fanotes.importWorksheetFromData({ name: file.name || 'Bild.png', mimeType: file.type || 'image/png', bytes })
    await attachImportedWorksheet(document)
  }, [attachImportedWorksheet, toast])

  const openInSplit = useCallback(async (path: string) => {
    if (activePathRef.current === path) {
      toast('Wähle eine zweite Notiz für die geteilte Ansicht.', 'info')
      return
    }
    if (!tabsRef.current.some((tab) => tab.path === path)) await openNote(path)
    setSplitPath(path)
  }, [openNote, toast])

  const applyTagsToNote = useCallback((tags: string[]) => {
    if (!activeTab) return
    updateContent(applyNoteTags(activeTab.content, tags))
  }, [activeTab, updateContent])

  const historyPathFor = (path: string) => isPdfNotePath(path) ? companionNotePath(path, '.famd') : path

  const openHistory = useCallback(async () => {
    if (!activePath || !window.fanotes.listNoteHistory) return
    setHistoryOpen(true)
    setHistoryBusy(true)
    try {
      setHistorySnapshots(await window.fanotes.listNoteHistory(historyPathFor(activePath)))
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Verlauf konnte nicht geladen werden.', 'error')
    } finally {
      setHistoryBusy(false)
    }
  }, [activePath, toast])

  const restoreHistory = useCallback(async (snapshotId: string) => {
    if (!activePath || !window.fanotes.readNoteHistory) return
    setHistoryBusy(true)
    try {
      const snapshot = await window.fanotes.readNoteHistory(historyPathFor(activePath), snapshotId)
      updateContent(snapshot.content)
      setHistoryOpen(false)
      toast('Ältere Version wiederhergestellt. Speichern sichert sie.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Version konnte nicht geladen werden.', 'error')
    } finally {
      setHistoryBusy(false)
    }
  }, [activePath, toast, updateContent])

  const exportCurrentPdf = useCallback(async () => {
    if (!window.fanotes.exportNotePdf) {
      document.documentElement.classList.add('is-printing')
      window.print()
      window.setTimeout(() => document.documentElement.classList.remove('is-printing'), 800)
      return
    }
    try {
      const result = await window.fanotes.exportNotePdf()
      if (result?.filePath && result.filePath !== 'print') toast('PDF gespeichert.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'PDF-Export fehlgeschlagen.', 'error')
    }
  }, [toast])

  const removeWorksheetFromNote = useCallback(async (id: string) => {
    const document = worksheetSession.documents.find((item) => item.id === id)
    const label = document?.title ?? 'Arbeitsblatt'
    if (!window.confirm(`„${label}“ wirklich aus dieser Notiz entfernen? Die PDF-/Bilddatei wird aus dem Vault gelöscht.`)) {
      return
    }
    const notePath = activePathRef.current
    if (!notePath) return
    try {
      await window.fanotes.deleteWorksheet(id)
      const tab = tabsRef.current.find((item) => item.path === notePath)
      const currentContent = pendingWrites.current.get(notePath) ?? tab?.content ?? ''
      const nextContent = detachWorksheet(currentContent, id)
      if (nextContent !== currentContent) updateContent(nextContent)
      worksheetDirtyIdsRef.current.delete(id)
      worksheetLayerRefs.current.delete(id)
      setWorksheetSession((current) => ({
        key: current.key + 1,
        documents: current.documents.filter((item) => item.id !== id),
      }))
      toast(`„${label}“ wurde aus der Notiz entfernt.`, 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das Arbeitsblatt konnte nicht entfernt werden.', 'error')
    }
  }, [toast, updateContent, worksheetSession.documents])

  const importOneNote = useCallback(async (): Promise<OneNoteImportResult | null> => {
    if (oneNoteImportBusy) return null
    if (isWeb) throw new Error('Binäre OneNote-Notizbücher werden sicher in der Linux- oder Windows-App importiert.')
    setOneNoteImportBusy(true)
    setWorksheetImportOpen(false)
    try {
      const result = await window.fanotes.importOneNote()
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
    { id: 'import-pdf-note', label: 'PDF importieren', detail: 'PDF wird selbst zur Notiz — mit Handschrift und Viewer', group: 'Dateien', keywords: 'pdf import notiz viewer', icon: <FileText size={15} />, run: () => void importPdfNote() },
    { id: 'new-folder', label: 'Neuer Ordner', detail: 'Fach auf oberster Ebene anlegen', group: 'Dateien', icon: <FolderPlus size={15} />, run: () => void createFolder() },
    { id: 'new-subfolder', label: 'Unterordner anlegen', detail: activeTab ? `In ${parentPath(activeTab.path) || 'Vault-Wurzel'}` : 'Rechtsklick auf einen Ordner oder hier nach dem Öffnen einer Notiz', group: 'Dateien', keywords: 'unterordner ordner verschachteln fach', icon: <FolderPlus size={15} />, run: () => void createFolder(activeTab ? parentPath(activeTab.path) || undefined : undefined) },
    { id: 'save', label: 'Aktuelle Notiz speichern', detail: 'Text, Handschrift und Arbeitsblätter sichern', shortcut: 'Ctrl S', group: 'Dateien', icon: <Save size={15} />, run: () => { void saveCurrentWork(true) } },
    { id: 'search', label: 'Im Vault suchen', shortcut: 'Ctrl ⇧ F', group: 'Navigation', icon: <Search size={15} />, run: () => setSearchOpen(true) },
    { id: 'drawing', label: drawingOpen ? 'Zur Tastatur wechseln' : 'Mit Stift schreiben', detail: 'Eingabeart auf derselben Notizseite wechseln', shortcut: 'Ctrl D', group: 'Werkzeuge', keywords: 'tablet stift erkennen mathe', icon: <PenLine size={15} />, run: toggleDrawing },
    { id: 'note-link', label: 'Verlinkung setzen', detail: 'Irgendwo auf der Seite eine neue Notiz verlinken', group: 'Werkzeuge', keywords: 'verlinkung link notiz pdf symbol text', icon: <Link2 size={15} />, run: startNoteLinkPlacement },
    { id: 'subject-book', label: bookOpen ? 'Buch ausblenden' : 'Buch einblenden', detail: currentBook ? 'PDF-Buch des Fachs neben der Notiz' : 'Zuerst über das Fachmenü ein Buch hinzufügen', group: 'Werkzeuge', keywords: 'buch pdf fach links rechts oben unten auspoppen', icon: <BookOpen size={15} />, run: () => {
      if (!currentBook) {
        const subject = activePath ? parentPath(activePath) : ''
        if (subject) void attachBookToSubject(subject)
        else toast('Öffne eine Notiz in einem Fach, um ein Buch hinzuzufügen.', 'info')
        return
      }
      toggleBookView()
    } },
    { id: 'worksheet', label: 'Bild oder PDF als Arbeitsblatt', detail: 'In die aktuelle oder eine neue Notiz importieren und ausfüllen', shortcut: 'Ctrl ⇧ I', group: 'Werkzeuge', keywords: 'pdf bild import arbeitsblatt ausfüllen', icon: <FileUp size={15} />, run: openWorksheetImport },
    { id: 'onenote-import', label: 'Microsoft OneNote importieren', detail: 'Notizbuch, Abschnitte, Layout, Ink und Anlagen sicher übernehmen', group: 'Dateien', keywords: 'one onetoc2 onepkg onedrive migration', icon: <NotebookTabs size={15} />, run: () => { void importOneNote().catch((error) => toast(error instanceof Error ? error.message : 'OneNote-Import fehlgeschlagen.', 'error')) } },
    { id: 'ai-assistant', label: 'AI-Assistent', detail: 'LM Studio, Ollama, OpenAI, Gemini, Anthropic oder OpenCode nutzen', shortcut: 'Ctrl ⇧ A', group: 'Werkzeuge', keywords: 'ki ai lm studio ollama openai gemini anthropic opencode rechtschreibung fakten', icon: <Bot size={15} />, run: openLmStudio },
    { id: 'glyphenwerk', label: 'GlyphenWerk öffnen', detail: 'Handschrift trainieren, live testen, korrigieren und verwalten', shortcut: 'Ctrl ⇧ G', group: 'Werkzeuge', keywords: 'training erkennung symbole test datensatz', icon: <Database size={15} />, run: openGlyphenWerk },
    { id: 'overview', label: 'Vault-Übersicht', detail: 'Ordner und offene Notizen überblicken', group: 'Navigation', icon: <Network size={15} />, run: openOverview },
    { id: 'homework', label: 'Hausaufgaben & Termine', detail: 'To-dos, Hausaufgaben und Termine mit Fälligkeit', group: 'Navigation', keywords: 'todo hausaufgaben schule termin fällig aufgabe checklist', icon: <ClipboardList size={15} />, run: openHomework },
    { id: 'daily', label: 'Heutige Tagesnotiz', detail: settings.dailyNotesFolder, group: 'Dateien', icon: <CalendarDays size={15} />, run: () => void createDailyNote() },
    { id: 'export-pdf', label: 'Notiz als PDF exportieren', detail: 'Text, Handschrift und Arbeitsblatt drucken oder speichern', group: 'Dateien', keywords: 'pdf export drucken print', icon: <FileDown size={15} />, run: () => void exportCurrentPdf() },
    { id: 'history', label: 'Versionsverlauf', detail: 'Frühere Stände dieser Notiz ansehen und wiederherstellen', group: 'Dateien', keywords: 'history version wiederherstellen', icon: <History size={15} />, run: () => void openHistory() },
    { id: 'split', label: splitPath ? 'Geteilte Ansicht schließen' : 'Notiz rechts öffnen', detail: 'Zwei Notizen nebeneinander', group: 'Ansicht', keywords: 'split teilen nebeneinander', icon: <Columns2 size={15} />, run: () => {
      if (splitPath) setSplitPath(null)
      else {
        const other = tabs.find((tab) => tab.path !== activePath)
        if (other) void openInSplit(other.path)
        else toast('Öffne zuerst eine zweite Notiz.', 'info')
      }
    } },
    { id: 'focus', label: focusMode ? 'Fokusmodus verlassen' : 'Fokusmodus starten', detail: 'Blendet Seitenleisten für ungestörtes Schreiben aus', shortcut: 'Ctrl ⇧ E', group: 'Ansicht', icon: <Maximize2 size={15} />, run: toggleFocusMode },
    { id: 'sidebar', label: 'Dateileiste umschalten', group: 'Ansicht', icon: <PanelLeftClose size={15} />, run: () => setSidebarVisible((value) => !value) },
    { id: 'inspector', label: 'Gliederung umschalten', group: 'Ansicht', icon: <PanelRightClose size={15} />, run: () => setInspectorVisible((value) => !value) },
    { id: 'settings', label: 'Einstellungen öffnen', shortcut: 'Ctrl ,', group: 'FaNotes', icon: <Settings size={15} />, run: () => openSettings() },
    { id: 'reveal', label: isWeb ? 'Notiz herunterladen' : 'Im Dateimanager zeigen', detail: isWeb ? 'Aktuelle Notiz exportieren' : 'Speicherort der geöffneten Notiz öffnen', group: 'Dateien', keywords: 'ordner explorer finder dateimanager download export', icon: isWeb ? <Download size={15} /> : <FolderOpen size={15} />, run: () => { if (activePath) void window.fanotes.revealInFolder(activePath) } },
    { id: 'bug-report', label: 'Fehler melden', detail: 'Kurz beschreiben; die letzten fünf Minuten werden angehängt', group: 'FaNotes', keywords: 'bug report fehler logs support', icon: <Bug size={15} />, run: () => setBugReportOpen(true) },
    { id: 'quit', label: isWeb ? 'Zur FaNotes-Website' : 'FaNotes beenden', shortcut: 'Ctrl Q', group: 'FaNotes', icon: <X size={15} />, run: () => window.fanotes.requestClose() },
  ], [activePath, activeTab, attachBookToSubject, bookOpen, createDailyNote, createFolder, createNote, currentBook, drawingOpen, exportCurrentPdf, focusMode, importOneNote, importPdfNote, isWeb, openGlyphenWerk, openHistory, openHomework, openInSplit, openLmStudio, openOverview, openSettings, openWorksheetImport, saveCurrentWork, settings.dailyNotesFolder, splitPath, startNoteLinkPlacement, tabs, toast, toggleBookView, toggleDrawing, toggleFocusMode])

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
      if (mod && event.key === ',') { event.preventDefault(); openSettings() }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'e') { event.preventDefault(); toggleFocusMode() }
      if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); toggleDrawing() }
      if (mod && event.key.toLowerCase() === 'q') { event.preventDefault(); window.fanotes.requestClose() }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedNoteLinkId) {
        const target = event.target as HTMLElement | null
        if (target?.closest('textarea, input, [contenteditable="true"], .cm-editor, .markdown-editor, .worksheet-textbox')) return
        event.preventDefault()
        void removeSelectedNoteLink()
        return
      }
      if (event.key === 'Escape') {
        if (noteLinkPlacing) setNoteLinkPlacing(false)
        else if (selectedNoteLinkId) setSelectedNoteLinkId(null)
        else if (worksheetImportOpen) setWorksheetImportOpen(false)
        else if (paletteOpen) setPaletteOpen(false)
        else if (searchOpen) setSearchOpen(false)
        else if (settingsOpen) setSettingsOpen(false)
        else if (lmStudioOpen) setLmStudioOpen(false)
        else if (homeworkOpen) setHomeworkOpen(false)
        else if (overviewOpen) setOverviewOpen(false)
        else if (glyphenWerkOpen) setGlyphenWerkOpen(false)
        else if (drawingOpenRef.current) closeDrawing()
        else if (focusMode) toggleFocusMode()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [closeDrawing, closeTab, createNote, cycleTabs, focusMode, glyphenWerkOpen, homeworkOpen, lmStudioOpen, noteLinkPlacing, openGlyphenWerk, openLmStudio, openSettings, openWorksheetImport, overviewOpen, paletteOpen, removeSelectedNoteLink, saveCurrentWork, searchOpen, selectedNoteLinkId, settingsOpen, toggleDrawing, toggleFocusMode, worksheetImportOpen])

  useEffect(() => {
    const imageFile = (file: File | undefined) => file && file.type.startsWith('image/')
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('textarea, input, [contenteditable="true"]')) return
      const file = [...(event.clipboardData?.files ?? [])].find(imageFile)
      if (!file) return
      event.preventDefault()
      void importImageBytes(file).catch((error) => toast(error instanceof Error ? error.message : 'Bild konnte nicht eingefügt werden.', 'error'))
    }
    const onDrop = (event: DragEvent) => {
      const file = [...(event.dataTransfer?.files ?? [])].find(imageFile)
      if (!file) return
      event.preventDefault()
      void importImageBytes(file).catch((error) => toast(error instanceof Error ? error.message : 'Bild konnte nicht abgelegt werden.', 'error'))
    }
    const onDragOver = (event: DragEvent) => {
      if ([...(event.dataTransfer?.types ?? [])].includes('Files')) event.preventDefault()
    }
    window.addEventListener('paste', onPaste)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragover', onDragOver)
    return () => {
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragover', onDragOver)
    }
  }, [importImageBytes, toast])

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
  if (popoutBookPath) {
    if (!currentBook) {
      return (
        <div className="subject-book-popout-root">
          <div className="subject-book-loading"><LoaderCircle className="spin" size={18} /> Buchseite wird geladen …</div>
        </div>
      )
    }
    return (
      <div className="subject-book-popout-root">
        <Suspense fallback={<div className="subject-book-loading"><LoaderCircle className="spin" size={18} /> Buch wird geladen …</div>}>
          <SubjectBookPane book={currentBook} settings={settings} popout onPageChange={handleBookPage} />
        </Suspense>
      </div>
    )
  }
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
        <button type="button" className={!searchOpen && !overviewOpen && !homeworkOpen && !lmStudioOpen && !glyphenWerkOpen ? 'active' : ''} title="Dateien" data-tooltip="Notizen" aria-label="Notizen" onClick={showFiles}><Files size={19} /></button>
        <button type="button" className={searchOpen ? 'active' : ''} title="Im Vault suchen (Strg+Umschalt+F)" data-tooltip="Suchen · Strg ⇧ F" aria-label="Im gesamten Vault suchen" onClick={() => { setSearchOpen(true); setSidebarVisible(true) }}><Search size={19} /></button>
        <button type="button" className={drawingOpen ? 'active' : ''} title={drawingOpen ? 'Zur Tastatureingabe wechseln' : 'Auf derselben Seite mit Stift schreiben'} data-tooltip={drawingOpen ? 'Zur Tastatur · Strg D' : 'Mit Stift schreiben · Strg D'} aria-pressed={drawingOpen} onClick={toggleDrawing}><PenLine size={19} /></button>
        <button type="button" className={homeworkOpen ? 'active' : ''} title="Hausaufgaben & Termine" data-tooltip="Hausaufgaben" aria-label="Hausaufgaben und Termine öffnen" onClick={openHomework}><ClipboardList size={18} /></button>
        <div className="ribbon-spacer" />
        <button
          type="button"
          className={sidebarToolsOpen ? 'active' : ''}
          title={sidebarToolsOpen ? 'Zusätzliche Werkzeuge einklappen' : 'Zusätzliche Werkzeuge ausklappen'}
          data-tooltip={sidebarToolsOpen ? 'Weniger' : 'Weitere Werkzeuge'}
          aria-label={sidebarToolsOpen ? 'Zusätzliche Werkzeuge einklappen' : 'Zusätzliche Werkzeuge ausklappen'}
          aria-expanded={sidebarToolsOpen}
          onClick={() => setSidebarToolsOpen((open) => !open)}
        >
          <MoreVertical size={18} />
        </button>
        {sidebarToolsOpen && (
          <div className="ribbon-extras" role="group" aria-label="Weitere Werkzeuge">
            <button type="button" title="Heutige Tagesnotiz" data-tooltip="Tagesnotiz" aria-label="Heutige Tagesnotiz öffnen" onClick={() => void createDailyNote()}><CalendarDays size={18} /></button>
            <button type="button" className={overviewOpen ? 'active' : ''} title="Vault-Übersicht" data-tooltip="Übersicht" aria-label="Vault-Übersicht öffnen" onClick={openOverview}><Network size={18} /></button>
            <button type="button" className={glyphenWerkOpen ? 'active' : ''} title="GlyphenWerk" data-tooltip="GlyphenWerk" aria-label="GlyphenWerk öffnen" onClick={openGlyphenWerk}><Database size={18} /></button>
            <button type="button" title="Befehlspalette (Strg+P)" data-tooltip="Befehle · Strg P" aria-label="Befehlspalette öffnen" onClick={() => setPaletteOpen(true)}><Command size={18} /></button>
          </div>
        )}
        <button type="button" title="Einstellungen (Strg+,)" data-tooltip="Einstellungen · Strg ," aria-label="Einstellungen öffnen" onClick={() => openSettings()}><Settings size={19} /></button>
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
              <div className="sidebar-vault" title={bootstrap.vaultPath}>
                <strong>{bootstrap.vaultName}</strong>
              </div>
              <div className="sidebar-actions">
                <button className="icon-button" type="button" title="Neue Notiz" aria-label="Neue Notiz" onClick={() => void createNote()}><FilePlus2 size={16} /></button>
                <button className="icon-button" type="button" title="Neuer Ordner" aria-label="Neuer Ordner" onClick={() => void createFolder()}><FolderPlus size={16} /></button>
                <button className="icon-button pdf-import-button" type="button" title="PDF importieren" aria-label="PDF importieren" onClick={() => void importPdfNote()}>PDF</button>
                <button className="icon-button sidebar-collapse-button" type="button" title="Seitenleiste einklappen" aria-label="Seitenleiste einklappen" onClick={() => setSidebarVisible(false)}><PanelLeftClose size={16} /></button>
              </div>
            </div>
            <div className="sidebar-search" role="search" title="Notizen und Handschrift durchsuchen">
              <Search aria-hidden="true" size={14} />
              <input value={searchQuery} placeholder="Suchen …" aria-label="Notizen suchen" onChange={(event) => { setSearchQuery(event.target.value); setSearchOpen(true) }} onFocus={() => setSearchOpen(true)} />
              {searchQuery ? <button className="search-clear" type="button" aria-label="Suche leeren" title="Suche leeren" onMouseDown={(event) => event.preventDefault()} onClick={() => { setSearchQuery(''); setSearchHits([]) }}><X size={13} /></button> : null}
            </div>
            {knownTags.length > 0 && (
              <div className="tag-filter" aria-label="Nach Schlagwort filtern">
                {knownTags.map((tag) => (
                  <button key={tag} type="button" className={tagFilter === tag ? 'is-active' : ''} onClick={() => setTagFilter((current) => current === tag ? null : tag)}>#{tag}</button>
                ))}
                {tagFilter && <button type="button" className="tag-filter-clear" onClick={() => setTagFilter(null)}>Filter aus</button>}
              </div>
            )}
            <div className="file-tree-wrap">
              <FileTree
                entries={visibleTree}
                activePath={activePath}
                revealPath={revealPath}
                rootLabel="Notizen"
                showHeader={false}
                onOpen={openNote}
                onCreateNote={createNote}
                onCreateFolder={createFolder}
                onImportPdf={importPdfNote}
                onAttachBook={attachBookToSubject}
                onDetachBook={detachBookFromSubject}
                bookFolderPaths={subjectBooks.map((book) => book.subjectPath)}
                onSetFolderColor={setFolderColor}
                onRename={renameEntry}
                onMove={moveEntry}
                onTrash={trashEntry}
              />
            </div>
            <div className="sidebar-footer"><span>{counts.files} {counts.files === 1 ? 'Notiz' : 'Notizen'}</span></div>
          </>}
        </aside>

        <main className="workspace">
          <div className="tabs-bar">
            <button
              type="button"
              className="note-nav-back"
              title="Zurück"
              aria-label="Zurück"
              disabled={!noteNavStack.length}
              onClick={() => void goBackNoteLink()}
            >
              <ArrowLeft size={14} /> Zurück
            </button>
            <div className="tabs-scroll" role="tablist" aria-label="Offene Notizen">{tabs.map((tab) => <NoteTabButton key={tab.path} active={tab.path === activePath} dirty={tab.content !== tab.savedContent} path={tab.path} title={tab.title} onOpen={openNote} onSplit={openInSplit} onClose={closeTab} />)}</div>
            <button type="button" className="tabs-menu" title="Neue Notiz (Strg+N)" aria-label="Neue Notiz" onClick={() => void createNote()}><Plus size={15} /></button>
          </div>
          <div className={`editor-toolbar ${drawingOpen ? 'is-ink' : 'is-type'}`}>
            <div className="mode-switch" role="group" aria-label="Eingabemodus">
              <button
                type="button"
                className={!drawingOpen ? 'is-active' : ''}
                aria-pressed={!drawingOpen}
                title="Mit der Tastatur schreiben (Strg+D)"
                onClick={() => { if (drawingOpen) toggleDrawing() }}
              >
                <Keyboard size={14} />
                <span>Tastatur</span>
              </button>
              <button
                type="button"
                className={drawingOpen ? 'is-active' : ''}
                aria-pressed={drawingOpen}
                title="Mit dem Stift schreiben (Strg+D)"
                onClick={() => { if (!drawingOpen) toggleDrawing() }}
              >
                <PenLine size={14} />
                <span>Stift</span>
              </button>
            </div>
            <div className="toolbar-context">
              {(() => {
                const slot = penModeToolbarSlot(drawingOpen, isPdfActive)
                if (slot === 'ink') return <div id={INK_TOOLBAR_SLOT_ID} className="ink-toolbar-slot" />
                if (slot === 'pdf') return <div id={PDF_TOOLBAR_SLOT_ID} className="pdf-toolbar-slot" />
                return <FormattingToolbar disabled={!activeTab || overviewOpen || homeworkOpen || glyphenWerkOpen || activeEntryMutating} onFormat={formatMarkdown} />
              })()}
            </div>
            <div className="toolbar-group toolbar-end">
              {bookPolicy.controlVisible && (
                <div className="subject-book-control">
                  <button
                    type="button"
                    className={`toolbar-button ${bookOpen ? 'active' : ''}`}
                    title="Buchansicht"
                    aria-label="Buch"
                    aria-pressed={bookOpen}
                    onClick={toggleBookView}
                  >
                    <BookOpen size={14} /><span>Buch</span>
                  </button>
                  {bookOpen && (
                    <div className="subject-book-placements" role="group" aria-label="Buchplatzierung">
                      {SUBJECT_BOOK_PLACEMENT_OPTIONS.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className={bookPlacement === option.id ? 'is-active' : ''}
                          aria-pressed={bookPlacement === option.id}
                          title={option.label}
                          onClick={() => placeBookView(option.id)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {backupPolicy.visible && (
                <div className="note-backup-control">
                  <button
                    type="button"
                    className={`toolbar-button ${backupMenuOpen ? 'active' : ''}`}
                    title={backupPolicy.restore ? 'Backup: weiteres Backup oder wiederherstellen' : 'Backup der aktuellen Notiz'}
                    aria-label="Backup"
                    aria-haspopup={backupPolicy.restore ? 'menu' : undefined}
                    aria-expanded={backupPolicy.restore ? backupMenuOpen : undefined}
                    disabled={!activeTab}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (!backupPolicy.restore) {
                        void snapshotCurrentNote()
                        return
                      }
                      setEditorMenuOpen(false)
                      setBackupMenuOpen((open) => !open)
                    }}
                  >
                    <Archive size={14} /><span>Backup</span>
                  </button>
                  {backupPolicy.restore && backupMenuOpen && (
                    <div className="note-backup-menu" role="menu" aria-label="Backup" onPointerDown={(event) => event.stopPropagation()}>
                      <button type="button" role="menuitem" onClick={() => { setBackupMenuOpen(false); void snapshotCurrentNote() }}>
                        <strong>Weiteres Backup</strong>
                        <small>Aktuelle Notiz so sichern, wie sie ist</small>
                      </button>
                      {[...noteBackups].reverse().map((snapshot) => (
                        <button
                          key={snapshot.id}
                          type="button"
                          role="menuitem"
                          onClick={() => { setBackupMenuOpen(false); void restoreCurrentNoteBackup(snapshot.id) }}
                        >
                          <strong>Wiederherstellen</strong>
                          <small>{Number.isFinite(Date.parse(snapshot.createdAt)) ? new Date(snapshot.createdAt).toLocaleString(getUiLocale(), { dateStyle: 'short', timeStyle: 'short' }) : snapshot.createdAt}</small>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {activeTab && (
                <div className="note-link-styles" role="group" aria-label="Verlinkungsstil">
                  {NOTE_LINK_STYLES.map((style) => (
                    <button
                      key={style.id}
                      type="button"
                      className={noteLinkStyle === style.id ? 'is-active' : ''}
                      aria-pressed={noteLinkStyle === style.id}
                      title={style.label}
                      onClick={() => void applyNoteLinkStyle(style.id)}
                    >
                      {style.label}
                    </button>
                  ))}
                </div>
              )}
              {selectedNoteLinkId && (
                <button
                  type="button"
                  className="toolbar-button note-link-remove"
                  title="Verlinkung entfernen"
                  aria-label="Verlinkung entfernen"
                  onClick={() => void removeSelectedNoteLink()}
                >
                  <Trash2 size={14} /><span>Entfernen</span>
                </button>
              )}
              <button
                type="button"
                className={`toolbar-button ${noteLinkPlacing ? 'active' : ''}`}
                title="Verlinkung setzen"
                aria-label="Verlinkung setzen"
                aria-pressed={noteLinkPlacing}
                disabled={!activeTab}
                onClick={startNoteLinkPlacement}
              >
                <Link2 size={14} /><span>Verlinkung</span>
              </button>
              {!isPdfActive && <button type="button" className="toolbar-button" title="Bild oder PDF als Arbeitsblatt importieren" aria-label="Arbeitsblatt importieren" onClick={openWorksheetImport}><FileUp size={14} /><span>Blatt</span></button>}
              <button type="button" className={`toolbar-button ai ${lmStudioOpen ? 'active' : ''}`} title="Mit einem AI-Anbieter bearbeiten" aria-label="AI-Assistent öffnen" onClick={openLmStudio}><Bot size={14} /><span>AI</span></button>
              <div className="editor-more">
                <button type="button" className={`toolbar-button menu-trigger ${editorMenuOpen ? 'active' : ''}`} title="Weitere Notizaktionen" aria-label="Weitere Notizaktionen" aria-haspopup="menu" aria-expanded={editorMenuOpen} onClick={(event) => { event.stopPropagation(); setEditorMenuOpen((open) => !open) }}><MoreHorizontal size={16} /></button>
                {editorMenuOpen && <div className="editor-more-menu" role="menu" aria-label="Weitere Notizaktionen" onPointerDown={(event) => event.stopPropagation()}>
                  <span className="editor-menu-label">Ansicht</span>
                  <button type="button" role="menuitemcheckbox" aria-checked={focusMode} onClick={() => { setEditorMenuOpen(false); toggleFocusMode() }}><span><Maximize2 size={15} /></span><span><strong>{focusMode ? 'Fokusmodus verlassen' : 'Fokusmodus'}</strong><small>Seitenleisten ausblenden</small></span><kbd>⌃⇧E</kbd></button>
                  <button type="button" role="menuitemcheckbox" aria-checked={inspectorVisible} onClick={() => { setEditorMenuOpen(false); setInspectorVisible((value) => !value) }}><span>{inspectorVisible ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}</span><span><strong>{inspectorVisible ? 'Gliederung ausblenden' : 'Gliederung anzeigen'}</strong><small>Überschriften und Dokumentinfo</small></span><i className={inspectorVisible ? 'is-on' : ''} /></button>
                  <span className="editor-menu-separator" role="separator" />
                  <span className="editor-menu-label">Datei</span>
                  <button type="button" role="menuitem" disabled={!activeTab} onClick={() => { setEditorMenuOpen(false); void exportCurrentPdf() }}><span><FileDown size={15} /></span><span><strong>Als PDF exportieren</strong><small>Text, Handschrift und Arbeitsblatt</small></span></button>
                  <button type="button" role="menuitem" disabled={!activePath} onClick={() => { setEditorMenuOpen(false); void openHistory() }}><span><History size={15} /></span><span><strong>Versionsverlauf</strong><small>Frühere Stände wiederherstellen</small></span></button>
                  <button type="button" role="menuitem" onClick={() => { setEditorMenuOpen(false); if (splitPath) setSplitPath(null); else { const other = tabs.find((tab) => tab.path !== activePath); if (other) void openInSplit(other.path); else toast('Öffne zuerst eine zweite Notiz (Umschalt+Klick auf einen Tab).', 'info') } }}><span><Columns2 size={15} /></span><span><strong>{splitPath ? 'Teilung schließen' : 'Geteilte Ansicht'}</strong><small>Zwei Notizen nebeneinander</small></span></button>
                  <button type="button" role="menuitem" disabled={!activePath} onClick={() => { setEditorMenuOpen(false); if (activePath) void window.fanotes.revealInFolder(activePath) }}><span>{isWeb ? <Download size={15} /> : <FolderOpen size={15} />}</span><span><strong>{isWeb ? (isPdfActive ? 'PDF herunterladen' : 'Markdown herunterladen') : 'Im Dateimanager zeigen'}</strong><small>{isWeb ? 'Aktuelle Notiz exportieren' : 'Speicherort der Notiz öffnen'}</small></span></button>
                </div>}
              </div>
            </div>
          </div>
          <div className={`editor-stage ${bookPolicy.paneVisible && bookPolicy.placement && bookPolicy.placement !== 'popout' ? `has-subject-book is-${bookPolicy.placement}` : ''}`}>
            {bookPolicy.paneVisible && bookPolicy.placement && bookPolicy.placement !== 'popout' && (
              currentBook ? (
              <Suspense fallback={<div className="subject-book-loading"><LoaderCircle className="spin" size={18} /> Buch wird geladen …</div>}>
                <SubjectBookPane
                  book={currentBook}
                  settings={settings}
                  onPageChange={handleBookPage}
                  onClose={() => setBookOpen(false)}
                />
              </Suspense>
              ) : (
                <div className="subject-book-loading"><LoaderCircle className="spin" size={18} /> Buchseite wird geladen …</div>
              )
            )}
            <div className="editor-stage-main">
            <Suspense fallback={<div className="editor-module-loading"><LoaderCircle className="spin" size={20} /><span>Ansicht wird geladen …</span></div>}>
              {glyphenWerkOpen ? (
              <SafeBoundary name="GlyphenWerk" fallbackTitle="GlyphenWerk ist abgestürzt">
                <GlyphenWerkWorkspace appearance={{ theme, reduceMotion: settings.reduceMotion }} activeView={glyphenWerkView} onViewChange={setGlyphenWerkView} onClose={() => setGlyphenWerkOpen(false)} onTrainingChanged={handleGlyphenWerkTrainingChanged} onImportTraining={importTrainingFromSettings} />
              </SafeBoundary>
            ) : homeworkOpen ? (
              <SafeBoundary name="Hausaufgaben" fallbackTitle="Hausaufgaben sind abgestürzt">
                <HomeworkBoard
                  subjects={tree.filter((entry) => entry.kind === 'folder').map((entry) => entry.name)}
                  reloadToken={homeworkReloadToken}
                  onClose={() => setHomeworkOpen(false)}
                  onOpenNote={(path) => { setHomeworkOpen(false); return openNote(path) }}
                  onDocumentPersisted={(document) => { void syncPublishedHomework(settingsRef.current, document) }}
                />
              </SafeBoundary>
            ) : overviewOpen ? (
              <VaultOverview entries={tree} openTabs={tabs} onOpen={(path) => { setOverviewOpen(false); return openNote(path) }} onCreateNote={() => createNote()} onClose={() => setOverviewOpen(false)} />
            ) : activeTab ? (
              <>
              {activeTab && (
                <div className="note-meta-bar">
                  <div className="note-tags" aria-label="Schlagwörter">
                    {activeTags.map((tag) => (
                      <button key={tag} type="button" className="note-tag" onClick={() => applyTagsToNote(activeTags.filter((item) => item !== tag))} title="Tag entfernen">#{tag}<X size={10} /></button>
                    ))}
                    <form onSubmit={(event) => { event.preventDefault(); const next = tagDraft.trim(); if (!next) return; applyTagsToNote([...activeTags, next]); setTagDraft('') }}>
                      <input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="Tag hinzufügen" maxLength={40} aria-label="Neues Schlagwort" />
                    </form>
                  </div>
                  {!isPdfActive && (
                  <PaperStylePicker
                    value={activePaper}
                    disabled={activeEntryMutating}
                    onChange={(style) => { if (activeTab) void applyNotePaper(activeTab.path, style) }}
                  />
                  )}
                </div>
              )}
              <div className={`editor-split ${splitTab ? 'is-split' : ''}`}>
              <PaperView
                className={`unified-note-view paper-${isPdfActive ? 'blank' : activePaper} ${drawingOpen ? 'is-inking' : ''} ${isPdfActive ? 'is-pdf-note' : ''}`}
                viewKey={activeTab.path}
                showHud={!drawingOpen}
              >
                <article className={`unified-paper ${worksheetSession.documents.length ? 'has-worksheet' : ''} ${isPdfActive ? 'is-pdf-note' : ''} ${noteLinkPlacing ? 'is-placing-note-link' : ''}`} aria-label={`${activeTab.title} · ${isPdfActive ? 'PDF-Notiz mit Handschrift' : 'gemeinsame Tastatur- und Handschriftseite'}`}>
                  {isPdfActive ? (
                    <Suspense fallback={<div className="pdf-note-status"><LoaderCircle className="spin" size={20} /> PDF wird geladen …</div>}>
                      <SafeBoundary name="PDF-Notiz" fallbackTitle="Der PDF-Viewer ist abgestürzt">
                        <PdfNoteView
                          path={activeTab.path}
                          title={activeTab.title}
                          inputDisabled={drawingOpen || activeEntryMutating}
                        />
                      </SafeBoundary>
                    </Suspense>
                  ) : (
                  <div className="editor-pane">
                    <SafeBoundary name="Editor" fallbackTitle="Der Editor ist abgestürzt">
                      <MarkdownEditor ref={editorRef} key={activeTab.path} content={activeTab.content} onChange={updateContent} onSave={async (content) => { await saveContent(activeTab.path, content) }} settings={settings} focusToken={focusToken} readOnly={activeEntryMutating || drawingOpen} paperMode onLanguageDetected={setDetectedTextLanguage} />
                    </SafeBoundary>
                  </div>
                  )}
                  {!isPdfActive && worksheetSession.documents.map((document) => <Suspense key={document.id} fallback={<div className="worksheet-loading"><LoaderCircle className="spin" size={20} /> Arbeitsblatt wird geladen …</div>}>
                    <SafeBoundary name={`Arbeitsblatt ${document.title}`} fallbackTitle="Das Arbeitsblatt ist abgestürzt">
                      <StableWorksheetLayer
                        ref={worksheetLayerRefFor(document.id)}
                        document={document}
                        inputDisabled={drawingOpen || activeEntryMutating}
                        onSave={saveWorksheetDocument}
                        onDirtyChange={worksheetDirtyCallbackFor(document.id)}
                        onRemove={() => void removeWorksheetFromNote(document.id)}
                      />
                    </SafeBoundary>
                  </Suspense>)}
                  {drawingSession.key > 0 && <Suspense fallback={drawingOpen ? <div className="inline-ink-loading"><LoaderCircle className="spin" size={18} /> Stiftebene wird geladen …</div> : null}>
                    <SafeBoundary
                      key={`stiftebene:${activeTab.path}:${drawingSession.key}`}
                      name="Handschrift"
                      fallbackTitle={INK_OVERLAY_CRASH_TITLE}
                    >
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
                        pagePaperStyle={activePaper}
                        onPagePaperChange={(style) => { if (activeTab) void applyNotePaper(activeTab.path, style) }}
                        onSettingsChange={handleDrawingSettingsChange}
                        onDirtyChange={handleDrawingDirtyChange}
                        onTrainingChanged={handleTrainingChanged}
                        onOpenGlyphenWerk={openGlyphenWerk}
                      />
                    </SafeBoundary>
                  </Suspense>}
                  {drawingOpen && drawingSession.key === 0 && <div className="inline-ink-loading"><LoaderCircle className="spin" size={18} /> Gespeicherte Stiftebene wird geladen …</div>}
                  <NoteLinkLayer
                    links={noteLinks}
                    placing={noteLinkPlacing}
                    selectedId={selectedNoteLinkId}
                    pdf={isPdfActive}
                    onPlace={(point) => void placeNoteLinkAt(point)}
                    onActivate={(link) => void followPlacedNoteLink(link)}
                    onSelect={(link) => {
                      setSelectedNoteLinkId(link.id)
                      setNoteLinkStyle(link.style)
                    }}
                    onRemove={(link) => void removePlacedNoteLink(link)}
                  />
                </article>
              </PaperView>
              {splitTab && (
                <PaperView className={`unified-note-view is-split-pane paper-${splitTab.kind === 'pdf' || isPdfNotePath(splitTab.path) ? 'blank' : activePaper}`} viewKey={`split:${splitTab.path}`} showHud={false}>
                  <article className={`unified-paper ${splitTab.kind === 'pdf' || isPdfNotePath(splitTab.path) ? 'is-pdf-note' : ''}`} aria-label={`${splitTab.title} · zweite Spalte`}>
                    <header className="split-pane-head">
                      <strong>{splitTab.title}</strong>
                      <button type="button" onClick={() => void openNote(splitTab.path)}>Fokus</button>
                      <button type="button" aria-label="Teilung schließen" onClick={() => setSplitPath(null)}><X size={14} /></button>
                    </header>
                    {splitTab.kind === 'pdf' || isPdfNotePath(splitTab.path) ? (
                      <Suspense fallback={<div className="pdf-note-status"><LoaderCircle className="spin" size={18} /> PDF wird geladen …</div>}>
                        <SafeBoundary name="Zweite PDF-Notiz" fallbackTitle="Der PDF-Viewer ist abgestürzt">
                          <PdfNoteView path={splitTab.path} title={splitTab.title} inputDisabled />
                        </SafeBoundary>
                      </Suspense>
                    ) : (
                    <div className="editor-pane">
                      <SafeBoundary name="Zweite Notiz" fallbackTitle="Die zweite Notiz ist abgestürzt">
                        <MarkdownEditor
                          key={`split-${splitTab.path}`}
                          content={splitTab.content}
                          onChange={(content) => {
                            setTabs((current) => current.map((tab) => tab.path === splitTab.path ? { ...tab, content } : tab))
                            pendingWrites.current.set(splitTab.path, content)
                            const existing = saveTimers.current.get(splitTab.path)
                            if (existing) window.clearTimeout(existing)
                            const timer = window.setTimeout(() => { void saveContent(splitTab.path, content) }, settings.autosaveDelay)
                            saveTimers.current.set(splitTab.path, timer)
                          }}
                          onSave={async (content) => { await saveContent(splitTab.path, content) }}
                          settings={settings}
                          paperMode
                        />
                      </SafeBoundary>
                    </div>
                    )}
                  </article>
                </PaperView>
              )}
              </div>
              </>
            ) : (
              <div className="editor-placeholder"><div className="placeholder-glyph"><BookOpen size={28} /></div><span className="eyebrow">Bereit für deine nächste Idee</span><h2>Dein Wissen, in deiner Hand</h2><p>Schreibe mit Tastatur und Stift auf derselben Seite, importiere ein PDF als eigene Notiz oder starte mit einem Arbeitsblatt.</p><div className="placeholder-actions"><button className="primary-button" type="button" onClick={() => void createNote()}><FilePlus2 size={14} /> Neue Notiz</button><button className="secondary-button" type="button" onClick={() => void importPdfNote()}><FileText size={14} /> PDF</button><button className="secondary-button" type="button" onClick={openWorksheetImport}><FileUp size={14} /> Arbeitsblatt</button></div><button className="placeholder-command" type="button" onClick={() => setPaletteOpen(true)}><Command size={13} /> Alle Aktionen mit <kbd>Strg P</kbd></button></div>
              )}
            </Suspense>
            </div>
          </div>
        </main>

        {inspectorVisible && settings.showOutline && !overviewOpen && !homeworkOpen && !glyphenWerkOpen && !isPdfActive && <Suspense fallback={null}><RightInspector content={activeTab?.content ?? ''} path={activeTab?.path} onJumpToLine={(line) => { editorRef.current?.revealLine(line) }} /></Suspense>}
        {searchOpen && <Suspense fallback={null}><SearchPanel query={searchQuery} hits={searchHits} loading={searchLoading} onQueryChange={setSearchQuery} onOpen={(hit) => { void openSearchHit(hit) }} onClose={() => setSearchOpen(false)} /></Suspense>}
      </div>

      <footer className="statusbar">
        <div className="statusbar-left"><button type="button" title={sidebarVisible ? 'Seitenleiste einklappen' : 'Seitenleiste einblenden'} aria-label={sidebarVisible ? 'Seitenleiste einklappen' : 'Seitenleiste einblenden'} onClick={() => setSidebarVisible((value) => !value)}>{sidebarVisible ? <PanelLeftClose size={12} /> : <PanelLeftOpen size={12} />}</button><span>{glyphenWerkOpen ? `GlyphenWerk · ${GLYPHENWERK_VIEW_LABELS[glyphenWerkView]}` : homeworkOpen ? 'Hausaufgaben & Termine' : overviewOpen ? 'Vault-Übersicht' : activeTab ? drawingOpen ? 'Stiftmodus' : isPdfActive ? 'PDF-Notiz' : worksheetSession.documents.length ? 'Notiz mit Arbeitsblatt' : 'Schreibmodus' : 'Bereit'}</span>{worksheetSession.documents.length > 0 && <span>{worksheetSession.documents.length} {worksheetSession.documents.length === 1 ? 'Arbeitsblatt' : 'Arbeitsblätter'}</span>}</div>
        <div className="statusbar-right">{updateState.status === 'downloaded' && <button type="button" className="update-ready-button" title={`FaNotes ${updateState.latestVersion} installieren und neu starten`} onClick={() => void installUpdate()}><ShieldCheck size={11} /> Update bereit</button>}{updateState.status === 'downloading' && <span><LoaderCircle className="spin" size={11} /> Update {Math.round(updateState.progress * 100)} %</span>}{settings.spellcheck && activeTab && !drawingOpen && detectedTextLanguage !== 'unknown' && <span className="detected-text-language" title="Automatisch erkannte Sprache für die lokale Rechtschreibprüfung"><b>Aa</b> {detectedTextLanguage === 'de' ? 'Deutsch' : detectedTextLanguage === 'en' ? 'English' : 'DE / EN'}</span>}{settings.showWordCount && activeTab && <span>{activeWordCount} Wörter</span>}<button type="button" className={`save-status ${saveState === 'saved' ? 'save-ok' : 'save-pending'}`} title="Jetzt speichern (Strg+S)" aria-live="polite" onClick={() => void saveCurrentWork()}>{saveState === 'saved' ? <CheckCircle2 size={11} /> : saveState === 'saving' ? <LoaderCircle className="spin" size={11} /> : <CircleAlert size={11} />}{saveState === 'saved' ? 'Gespeichert' : saveState === 'saving' ? 'Speichert …' : 'Speicherfehler'}</button><span title={isWeb ? 'Die Daten bleiben in diesem Browser' : 'Dein Vault bleibt auf deinem Gerät'}><ShieldCheck size={11} /> {isWeb ? 'Im Browser gespeichert' : 'Lokal & privat'}</span></div>
      </footer>

      {historyOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryOpen(false) }}>
          <section className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title">
            <header>
              <div><History size={18} /><div><small>Lokaler Verlauf</small><h2 id="history-title">Frühere Versionen</h2></div></div>
              <button type="button" aria-label="Schließen" onClick={() => setHistoryOpen(false)}><X size={17} /></button>
            </header>
            {historyBusy && <p className="history-empty"><LoaderCircle className="spin" size={16} /> Verlauf wird geladen …</p>}
            {!historyBusy && historySnapshots.length === 0 && <p className="history-empty">Noch keine älteren Stände. Nach dem nächsten Speichern erscheint hier die vorherige Version.</p>}
            <ul>
              {historySnapshots.map((snapshot) => (
                <li key={snapshot.id}>
                  <div>
                    <strong>{new Date(snapshot.createdAt).toLocaleString()}</strong>
                    <small>{Math.max(1, Math.round(snapshot.bytes / 1024))} KB</small>
                  </div>
                  <button type="button" className="secondary-button" onClick={() => void restoreHistory(snapshot.id)}>Wiederherstellen</button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
      {paletteOpen && <Suspense fallback={null}><SafeBoundary name="Befehlspalette"><CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} /></SafeBoundary></Suspense>}
      {settingsOpen && <Suspense fallback={null}><SafeBoundary name="Einstellungen" fallbackTitle="Die Einstellungen sind abgestürzt"><SettingsModal platform={window.fanotes.platform} settings={settings} vaultPath={bootstrap.vaultPath} updateState={updateState} onChange={applySettings} onClose={() => setSettingsOpen(false)} onSelectVault={() => void selectVault()} onOpenGlyphenWerk={() => { setSettingsOpen(false); openGlyphenWerk() }} onImportTraining={importTrainingFromSettings} onImportOneNote={importOneNote} onCheckUpdate={checkForUpdates} onDownloadUpdate={downloadUpdate} onInstallUpdate={installUpdate} onResetSettings={resetSettings} onResetAppData={resetAppData} onOpenBugReport={() => { setSettingsOpen(false); setBugReportOpen(true) }} remoteSupportSession={remoteSupportSession} onRemoteSupportStart={startRemoteSupport} onRemoteSupportStop={stopRemoteSupport} /></SafeBoundary></Suspense>}
      {bugReportOpen && <Suspense fallback={null}><SafeBoundary name="Fehlerbericht"><BugReportModal version={updateState.currentVersion} platform={window.fanotes.platform} onClose={() => setBugReportOpen(false)} onSent={() => toast('Fehlerbericht wurde an fanotes.fasrv.ch gesendet.', 'success')} /></SafeBoundary></Suspense>}
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
