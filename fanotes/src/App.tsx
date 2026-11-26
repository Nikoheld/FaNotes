import {
  Archive,
  ClipboardList,
  BarChart3,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Bot,
  Bug,
  Lightbulb,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock,
  Cloud,
  CloudOff,
  Columns2,
  SquareSplitHorizontal,
  Command,
  Copy,
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
  ListChecks,
  LoaderCircle,
  LayoutGrid,
  Maximize,
  Maximize2,
  Minimize,
  MoreHorizontal,
  MoreVertical,
  Network,
  NotebookTabs,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  Rows2,
  Save,
  ScanLine,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  Type,
  X,
} from 'lucide-react'
import { notifyStoryWritten, storySyncBusy } from './writing/liveSync'
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, startTransition, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react'
import type { PaletteAction } from './components/CommandPalette'
import type { DrawingBoardHandle, DrawingSavePayload, InkActivity } from './components/DrawingBoard'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ExternalChangeBanner } from './components/ExternalChangeBanner'
import { FolderPathDialog } from './components/FolderPathDialog'
import { FileTree } from './components/FileTree'
import { EditorExportControls } from './components/EditorExportControls'
import { FormattingToolbar } from './components/FormattingToolbar'
import { NoteLinkLayer } from './components/NoteLinkLayer'
import { NoteTextFieldLayer, NoteTextFieldToolbar } from './components/NoteTextFieldLayer'
import { StudyAnnotationLayer } from './components/StudyAnnotationLayer'
import type { GlyphenWerkView } from './components/GlyphenWerkWorkspace'
import type { MarkdownEditorHandle, MarkdownFormatAction } from './components/MarkdownEditor'
import type { WorksheetLayerHandle } from './components/WorksheetLayer'
import { hasConnectedAiProvider } from './lib/aiProviderConnection'
import { clipboardImageFile } from './lib/clipboardImage'
import { retitleGeneratedHeading } from './lib/autoHeading'
import { errorLocation, friendlyFileError, sanitizeToastMessage } from './lib/fileErrors'
import { companionNotePath, emptyFamdPayload, famdEncodingForSave, inkHasMarks, isNoteFileName, isPdfNotePath, parseFamd, readPageStatsFromNote, serializeFamd, stripFamdPayload, writePageStatsIntoNote } from './lib/famd'
import { inkJsonForRewrite } from './lib/packedInk'
import { createAppAddonBridge, safeSettingsView, type AppAddonDeps } from './lib/addons/appBridge'
import { sanitizeCustomCss } from './lib/customCss'
import { addonIndexCache } from './lib/addons/indexCache'
import { parseAddonSource } from './lib/addons/registry'
import { addonRuntime } from './lib/addons/runtime'
import { syncEngine } from './lib/sync/engine'
import { userShares } from './lib/sync/userShares'
import { SHARED_INBOX_FOLDER } from './lib/sync/sharedInbox'
import { SharedWithMePanel } from './components/SharedWithMePanel'
import { DialogFrame } from './components/DialogFrame'
import { ShareWithUserDialog, type ShareWithUserTarget } from './components/ShareWithUserDialog'
import { LivePeople } from './components/LivePeople'
import { useLiveNote } from './components/useLiveNote'
import { externalArrivals, loadArrivals, saveArrivals } from './lib/newArrivals.mjs'
import { useExternalTabChanges, useTabHolds } from './lib/useExternalTabChanges'
import { WorkRequestsClient } from './lib/workRequests'
import { failedLabel, syncStatusLabel } from './lib/sync/status'
import { SharePresence, type SharePeople } from './components/SharePresence'
import type { SettingsSection } from './components/SettingsModal'
import { ProfileOverviewPublisher } from './components/ProfileOverviewPublisher'
import { createAddonFetchText, createAddonStoragePort } from './lib/addons/storagePort'
import type { AddonPromptRequest } from './components/addons/AddonPromptDialog'
import { convertNoteSourceToCurrentStandard } from './lib/noteStandard'
import { applySimpleLatexButton, noteExportBaseName, type SimpleLatexButton, type SimpleLatexOperands } from './lib/simpleLatex'
import type { NoteExportKind } from './components/NoteExportDialog'
import type { NoteExportOptions } from './lib/noteExport/types'
import { deleteConfirmHost } from './lib/confirmUx'
import {
  closePageStats,
  idlePageStatsSession,
  markPageStatsPersisted,
  openPageStats,
  pageStatsNeedPersist,
  parsePageStats,
  recordDocumentSaved,
  recordEditActivity,
  recordInkErased,
  recordInkSnapshot,
  recordInkStroke,
  snapshotPageStats,
  tickPageStats,
  touchPageModified,
  type EditActivity,
  type InkStrokeActivity,
  type InkSummary,
  type PageStatsSession,
} from './lib/pageStats'
import { clearNoteTextFieldRescue, readNoteTextFieldRescue, writeNoteTextFieldRescue } from './lib/noteTextFieldRescue'
import { chooseRestoredNote, collectNotePaths } from './lib/lastOpenNote'
import { headingFoldKey, headingFoldScope, pruneHeadingFolds, remapHeadingFolds } from './lib/headingFolds'
import { chooseStartSurface } from './lib/dashboardLayout'
import {
  clonedWorksheetDocument,
  drawingTitleFromJson,
  dailyNoteStem,
  duplicatePreferredStem,
  formatNoteStamp,
  recentNotePaths,
  shiftDailyNote,
  retargetWorksheetMarkers,
  stampToInsert,
  wikiLinkForNote,
  withInkMarker,
  withoutInkMarker,
  withoutWorksheetMarker,
  worksheetIdsIn,
} from './lib/noteQoL'
import {
  canGoBack,
  canGoForward,
  clampSplitRatio,
  editorPaneForCommand,
  DEFAULT_SPLIT_LAYOUT,
  EMPTY_NOTE_HISTORY,
  forgetNoteHistory,
  loadSplitLayout,
  loadWorkspaceMemory,
  nudgeSplitRatio,
  pruneWorkspaceMemory,
  rankSwitcherNotes,
  remapNoteHistory,
  remapPath,
  rememberClosedTab,
  reorderTabs,
  saveSplitLayout,
  saveWorkspaceMemory,
  snapToDevicePixels,
  splitDropZone,
  splitFitZoom,
  splitPlacementForZone,
  type SplitDropZone,
  splitFirstPaneSize,
  splitRatioFromPointer,
  stepNoteHistory,
  tabIndexForDigit,
  tabsToClose,
  togglePinnedTab,
  visitNote,
  type NoteHistory,
  type SplitLayout,
} from './lib/workspaceNav'
import { InkPreviewLayer } from './components/InkPreviewLayer'
import { SplitInkEditor } from './components/SplitInkEditor'
import {
  activateNoteLink,
  linkedNoteParent,
  linkedNotePreferredName,
  newNoteLinkId,
  NOTE_LINK_STYLES,
  placeNewNoteLink,
  removeNoteLink,
  restyleNoteLink,
  type NoteLinkRecord,
  type NoteLinkStyleId,
} from './lib/noteLink'
import {
  createSerialJobQueue,
  newNoteTextFieldId,
  parseNoteTextFields,
  patchNoteTextField,
  placeNoteTextField,
  type NoteTextField,
} from './lib/noteTextField'
import {
  diffNoteTextFields,
  mergeNoteTextFields,
  noteTextFieldsEqual,
  persistableNoteTextFields,
} from '../electron/noteTextFieldMerge.mjs'
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
import {
  noteInkDocument,
  overlaySessionAfterInkReady,
  overlaySessionAfterNoteSwitch,
  overlaySessionForNote,
  type NoteOverlaySession,
} from './lib/overlayInteract'
import { installChromeTextSelect } from './lib/chromeTextSelect'
import { readDocInputMode, writeDocInputMode } from './lib/docInputMode'
import { drawingSessionFromLoad, INK_OVERLAY_CRASH_TITLE, INK_TOOLBAR_SLOT_ID, overlayAfterNoteSwitch, PDF_TOOLBAR_SLOT_ID, penModeToolbarSlot, SPLIT_PDF_TOOLBAR_SLOT_ID } from './lib/pdfInkHit'
import { APP_VERSION } from './lib/appVersion'
import { defaultSettingsForPlatform } from './defaults'
import { collectShareNotes, createFetchSharePort, loadShareEntries, parseShareDirectory, publicShareInk, publicShareTextFields, publishShare, queueLiveShareRefresh, readShare, resolveShareOrigin, serializeShareDirectory, type ShareTextField } from './lib/sync/share'
import { applyRemoteTextFields, beginDesktopShareOpen, chooseShareFolder, confirmShareIdentity, drawingJsonWithRemoteInk, openShareEditor, parseShareProtocol, remoteTextForEditor, shareTickDecision, type ShareEditClient, type ShareOpenState } from './lib/sync/shareEdit'
import { claimUsername, createFetchProfilePort, createProfileOwnerId, ProfileRequestError } from './lib/sync/profile'
import { PaperStylePicker } from './components/PaperStylePicker'
import { PaperView } from './components/PaperView'
import { normalizePaperStyle } from './lib/paperStyles'
import { clampPaperSquareMm, paperSheetPx, paperSquarePx } from './lib/paperSquare'
import { clampSheetPlacement, measurePaperFrame, placementAround, markFreshSheetImage } from './lib/sheetImage'
import { clampViewZoom, createPaperViewStore, resolvePaperZoomScroller, sharedPaperViewStore, writeSharedZoomMaxPercent, writeSharedZoomSpeed, type PaperViewStore } from './lib/paperView'
import { flushPaperViewMemory, loadPaperViewMemory, paperViewMemoryKey, recallPaperView, recallPaperViewForWidth } from './lib/paperViewMemory'
import { diagnosticLog } from './lib/bugReport'
import { configureDiagnostics, recordFeature, setDiagnosticsVault } from './lib/diagnosticsClient'
import { startStallMonitor, trackActivity } from './lib/stallMonitor'
import { SendDataNotice } from './components/SendDataNotice'
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
import { HOMEWORK_NOTE_PATH, loadHomeworkMarkdown, mergeHomeworkFromRemote, rememberPublishedHomeworkIds, serializeHomeworkMarkdown, type HomeworkDocument } from './lib/homeworkStore'
import { scrollTopForNormalizedY } from './lib/searchInkAnchor'
import { headingLineForSection } from './lib/inkSectionMarkdown'
import { syncPrefixesFromSetting, toggleSyncPrefix, RECOGNITION_MODEL_SYNC_PATH } from './lib/sync/folderSync'
import { parseRecognitionBundle, serializeRecognitionBundle, emptyRecognitionBundle } from './lib/sync/recognitionModelBundle'
import { polishRecognizedText } from './lib/recognitionPolish'
import { sanitizeAddonStrokes, inkDocumentWithStrokes } from './lib/addonInk'
import { sanitizeCalendarDocument, serializeCalendarMarkdown, emptyCalendarDocument, isMissingNoteError, loadCalendarMarkdown, CALENDAR_NOTE_PATH } from './lib/calendarModel'
import { templatesToSeed, localizeTemplate, templatesFolderName, NOTE_TEMPLATES, type NoteProfileId } from './lib/noteTemplates'
import { backlinksFor } from './lib/backlinks'
import { highlightPdfImportantMarks } from './lib/pdfImportantMarks'
import { readPdfMarks, writePdfMarks, addPdfMark } from './lib/pdfTextMarks'
import { createPdfMarkEraseHost, unmarkPdfNote } from './lib/pdfMarkEraseHost'
import { getHandwritingSamples, getMathLayoutExamples, getImportedLabels, putHandwritingSamples, putMathLayoutExamples, putHandwritingLabels } from './lib/handwritingDb'
import { SafeBoundary } from './components/SafeBoundary'
import { createTreeSync, type TreeSync } from './lib/treeSync.mjs'
import { useSettledValue, LARGE_NOTE_CHARS, LARGE_NOTE_SETTLE_MS } from './lib/useSettledValue'
import { applyNoteTags, collectVaultTags, filterTreeByTag, parseNoteTags } from './lib/noteTags'
import { applyRendererResourceLimits } from './lib/resourceLimits'
import { useModalFocus } from './lib/useModalFocus'
import { useMenuKeyboard } from './lib/useMenuKeyboard'
import { getUiLanguage, getUiLocale, setUiLanguage, translateUiText, uiText } from './i18n'
import { bestContrastText, ensureReadableColor } from './lib/colorContrast'
import { snowLayerActive } from './lib/snowTheme'
import { SnowLayer } from './components/SnowLayer'
import type { AppSettings, BootstrapData, CreateResult, DrawingLibraryDocument, NoteHistorySnapshot, NoteTab, OneNoteImportResult, PaperStyle, SearchHit, UpdateState, VaultEntry, WorksheetDocument } from './types'

/** Set once the ink board module is loaded (see InkBoardComponent). */
let loadedDrawingBoard: typeof import('./components/DrawingBoard').DrawingBoard | null = null
const loadDrawingBoardModule = () => import('./components/DrawingBoard').then((module) => {
  loadedDrawingBoard = module.DrawingBoard
  return module
})
const DrawingBoard = lazy(() => loadDrawingBoardModule().then((module) => ({ default: module.DrawingBoard })))
const NoteExportDialog = lazy(() => import('./components/NoteExportDialog').then((module) => ({ default: module.NoteExportDialog })))
const FirstRunOnboarding = lazy(() => import('./components/FirstRunOnboarding').then((module) => ({ default: module.FirstRunOnboarding })))
const GlyphenWerkWorkspace = lazy(() => import('./components/GlyphenWerkWorkspace').then((module) => ({ default: module.GlyphenWerkWorkspace })))
const WritingMode = lazy(() => import('./writing/ui/WritingMode').then((module) => ({ default: module.WritingMode })))
const StoryImportDialog = lazy(() => import('./writing/import/ImportDialog').then((module) => ({ default: module.ImportDialog })))
const OneNoteImportDialog = lazy(() => import('./components/OneNoteImportDialog').then((module) => ({ default: module.OneNoteImportDialog })))
const CommandPalette = lazy(() => import('./components/CommandPalette').then((module) => ({ default: module.CommandPalette })))
const StudyOverview = lazy(() => import('./components/StudyOverview').then((module) => ({ default: module.StudyOverview })))
const FlashcardReview = lazy(() => import('./components/FlashcardReview').then((module) => ({ default: module.FlashcardReview })))
const AiPanel = lazy(() => import('./components/AiPanel').then((module) => ({ default: module.AiPanel })))
type MarkdownEditorComponent = typeof import('./components/MarkdownEditor')['MarkdownEditor']
type MarkdownEditorModule = { default: MarkdownEditorComponent }
let resolvedMarkdownEditor: MarkdownEditorComponent | null = null
let markdownEditorModulePromise: Promise<MarkdownEditorModule> | null = null
const loadMarkdownEditor = () => {
  markdownEditorModulePromise ??= import('./components/MarkdownEditor')
    .then((module) => {
      resolvedMarkdownEditor = module.MarkdownEditor
      return { default: module.MarkdownEditor }
    })
  return markdownEditorModulePromise
}
function MarkdownEditor(props: ComponentProps<MarkdownEditorComponent>) {
  if (!resolvedMarkdownEditor) throw loadMarkdownEditor()
  const Impl = resolvedMarkdownEditor
  return <Impl {...props} />
}
const RightInspector = lazy(() => import('./components/RightInspector').then((module) => ({ default: module.RightInspector })))
const AddonStoreModal = lazy(() => import('./components/addons/AddonStoreModal').then((module) => ({ default: module.AddonStoreModal })))
const AddonPanelDock = lazy(() => import('./components/addons/AddonPanelDock').then((module) => ({ default: module.AddonPanelDock })))
const AddonPromptDialog = lazy(() => import('./components/addons/AddonPromptDialog').then((module) => ({ default: module.AddonPromptDialog })))
const SearchPanel = lazy(() => import('./components/SearchPanel').then((module) => ({ default: module.SearchPanel })))
const SettingsModal = lazy(() => import('./components/SettingsModal').then((module) => ({ default: module.SettingsModal })))
const WorkRequestsPanel = lazy(() => import('./components/WorkRequestsPanel').then((module) => ({ default: module.WorkRequestsPanel })))
const BugReportModal = lazy(() => import('./components/BugReportModal').then((module) => ({ default: module.BugReportModal })))
const SubjectBookPane = lazy(() => import('./components/SubjectBookPane').then((module) => ({ default: module.SubjectBookPane })))
const VaultOverview = lazy(() => import('./components/VaultOverview').then((module) => ({ default: module.VaultOverview })))
const HomeworkBoard = lazy(() => import('./components/HomeworkBoard').then((module) => ({ default: module.HomeworkBoard })))
const CalendarView = lazy(() => import('./components/CalendarView').then((module) => ({ default: module.CalendarView })))
const WorksheetLayer = lazy(() => import('./components/WorksheetLayer').then((module) => ({ default: module.WorksheetLayer })))
import { usePdfSidePages } from './components/usePdfSidePages'
const loadPdfNoteViewModule = () => import('./components/PdfNoteView')
const PdfNoteView = lazy(() => loadPdfNoteViewModule().then((module) => ({ default: module.PdfNoteView })))
const StableWorksheetLayer = memo(WorksheetLayer)
const STARTUP_TREE_REFRESH_DELAY_MS = 18_000
const STARTUP_DOCUMENT_LAYER_DELAY_MS = 160
/**
 * Opening a document keeps the previous one on screen while the next one's
 * PDF and handwriting load, at most this long. Then the switch is one commit:
 * no loading box, no text that gets its ink a moment later.
 */
const DOCUMENT_OPEN_PREPARE_MS = 450
/** Handwriting read for an open that never committed is not used after this. */
const PREPARED_INK_TTL_MS = 3_000
type PreparedNoteInk = { path: string; content: string; at: number; document: DrawingLibraryDocument | null }
/** How long a renamed/moved path still redirects late editor flushes to the new name. */
const MOVED_PATH_ALIAS_MS = 30_000
/** Statistics of the open note reach the disk at least this often (in one-second ticks). */
/** Width of the split divider track; mirrors `--split-divider` in styles.css. */
const SPLIT_DIVIDER_PX = 7
const PAGE_STATS_PERSIST_TICKS = 90
/** Leaving a note after a shorter stay does not rewrite its file just for the dwell. */
const PAGE_STATS_MIN_DWELL_DELTA_MS = 3_000
type AppProps = { startupBootstrap?: Promise<BootstrapData> }

type SaveState = 'saved' | 'saving' | 'error'
/** How long a toast with an undo button stays; the removed file is deleted after the same time. */
const UNDO_TOAST_MS = 9000
type Toast = { id: number; kind: 'success' | 'error' | 'info'; message: string; action?: { label: string; run: () => void } }
type DrawingSession = NoteOverlaySession<DrawingLibraryDocument>
const EMPTY_DRAWING_SESSION: DrawingSession = { key: 0, document: null, path: null }
type WorksheetSession = { key: number; documents: WorksheetDocument[] }
type NoteTabButtonProps = {
  active: boolean
  inSplit: boolean
  dirty: boolean
  pinned: boolean
  /** Paused because the file was deleted or edited outside FaNotes. */
  hold?: 'deleted' | 'conflict'
  path: string
  title: string
  index: number
  dropSide: 'before' | 'after' | null
  onOpen: (path: string) => unknown
  onSplit: (path: string) => unknown
  onClose: (path: string) => void | Promise<void>
  onContextMenu: (path: string, x: number, y: number) => void
  onDragStart: (path: string) => void
  onDragOver: (path: string, side: 'before' | 'after') => void
  onDrop: (path: string, side: 'before' | 'after') => void
  onDragEnd: () => void
}

const NOTE_TAB_DRAG_TYPE = 'application/x-fanotes-tab'

const NoteTabButton = memo(function NoteTabButton({
  active, inSplit, dirty, pinned, hold, path, title, index, dropSide,
  onOpen, onSplit, onClose, onContextMenu, onDragStart, onDragOver, onDrop, onDragEnd,
}: NoteTabButtonProps) {
  const tabRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active) tabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  const sideFor = (event: React.DragEvent<HTMLElement>): 'before' | 'after' => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
  }
  // Ctrl+1…8 pick a tab by position, Ctrl+9 the last one.
  const shortcut = index < 8 ? `Control+${index + 1}` : null

  return (
    <div
      ref={tabRef}
      className={`note-tab ${active ? 'active' : ''} ${inSplit ? 'in-split' : ''} ${pinned ? 'is-pinned' : ''} ${hold ? `is-${hold}` : ''} ${dropSide ? `drop-${dropSide}` : ''}`}
      title={path}
      role="presentation"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(NOTE_TAB_DRAG_TYPE, path)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart(path)
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(NOTE_TAB_DRAG_TYPE)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        onDragOver(path, sideFor(event))
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(NOTE_TAB_DRAG_TYPE)) return
        event.preventDefault()
        onDrop(path, sideFor(event))
      }}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu(path, event.clientX, event.clientY)
      }}
    >
      <button
        type="button"
        className="note-tab-main"
        aria-current={active ? 'true' : undefined}
        aria-keyshortcuts={shortcut ?? undefined}
        aria-label={`${title}${pinned ? uiText(', angeheftet', ', pinned') : ''}${inSplit ? uiText(', in der zweiten Spalte', ', in the second pane') : ''}${dirty ? uiText(', nicht gespeicherte Änderungen', ', unsaved changes') : ''}${hold === 'deleted' ? uiText(', Datei wurde ausserhalb von FaNotes gelöscht', ', file was deleted outside FaNotes') : hold === 'conflict' ? uiText(', Datei wurde ausserhalb von FaNotes geändert', ', file was changed outside FaNotes') : ''}`}
        onClick={(event) => { event.shiftKey ? void onSplit(path) : void onOpen(path) }}
        onAuxClick={(event) => { if (event.button === 1 && !pinned) void onClose(path) }}
      >
        {pinned ? <Pin aria-hidden="true" size={12} /> : isPdfNotePath(path) ? <File aria-hidden="true" size={13} /> : <Files aria-hidden="true" size={13} />}
        <span>{title}</span>
        {inSplit && <Columns2 aria-hidden="true" size={11} className="tab-split-mark" />}
        {hold && <span className="tab-hold-mark" title={hold === 'deleted' ? uiText('Datei wurde ausserhalb von FaNotes gelöscht', 'File was deleted outside FaNotes') : uiText('Datei wurde ausserhalb von FaNotes geändert', 'File was changed outside FaNotes')}><CircleAlert aria-hidden="true" size={12} /></span>}
        {dirty && <i className="dirty-dot" title={uiText('Noch nicht gespeichert', 'Not saved yet')} />}
      </button>
      {!pinned && <button className="tab-close" type="button" aria-label={`${title} ${uiText('schließen', 'close')}`} title={uiText('Tab schließen (Strg+W)', 'Close tab (Ctrl+W)')} onClick={() => { void onClose(path) }}><X aria-hidden="true" size={12} /></button>}
    </div>
  )
})

type TabMenuState = { path: string; x: number; y: number }

type TabContextMenuProps = {
  menu: TabMenuState
  title: string
  pinned: boolean
  inSplit: boolean
  isWeb: boolean
  canCloseOthers: boolean
  canCloseRight: boolean
  onClose: () => void
  onOpenInSplit: () => void
  onTogglePin: () => void
  onCloseTab: () => void
  onCloseOthers: () => void
  onCloseRight: () => void
  onCopyPath: () => void
  onCopyWikiLink: () => void
  onDuplicate: () => void
  onReveal: () => void
}

function TabContextMenu({ menu, title, pinned, inSplit, isWeb, canCloseOthers, canCloseRight, onClose, onOpenInSplit, onTogglePin, onCloseTab, onCloseOthers, onCloseRight, onCopyPath, onCopyWikiLink, onDuplicate, onReveal }: TabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const onMenuKeyDown = useMenuKeyboard(menuRef, true, onClose)
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onClose)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', onClose)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose])
  const run = (action: () => void) => () => { onClose(); action() }
  return (
    <div
      ref={menuRef}
      className="file-tree__context-menu tab-context-menu"
      role="menu"
      onKeyDown={onMenuKeyDown}
      aria-label={`${uiText('Aktionen für', 'Actions for')} ${title}`}
      onPointerDown={(event) => event.stopPropagation()}
      style={{ left: Math.min(Math.max(8, menu.x), window.innerWidth - 240), top: Math.min(Math.max(8, menu.y), window.innerHeight - 420) }}
    >
      <div className="file-tree__menu-head"><span>{isPdfNotePath(menu.path) ? <File size={16} /> : <FileText size={16} />}</span><div><small>Tab</small><strong>{title}</strong></div></div>
      <button type="button" role="menuitem" disabled={inSplit} onClick={run(onOpenInSplit)}><Columns2 aria-hidden="true" size={15} /> Rechts öffnen</button>
      <button type="button" role="menuitem" onClick={run(onTogglePin)}>{pinned ? <PinOff aria-hidden="true" size={15} /> : <Pin aria-hidden="true" size={15} />} {pinned ? 'Lösen' : 'Anheften'}</button>
      <span className="file-tree__menu-separator" role="separator" />
      <button type="button" role="menuitem" onClick={run(onDuplicate)}><Files aria-hidden="true" size={15} /> Notiz duplizieren</button>
      <button type="button" role="menuitem" onClick={run(onCopyWikiLink)}><Link2 aria-hidden="true" size={15} /> Wiki-Link kopieren</button>
      <button type="button" role="menuitem" onClick={run(onCopyPath)}><Copy aria-hidden="true" size={15} /> Pfad kopieren</button>
      <button type="button" role="menuitem" onClick={run(onReveal)}>{isWeb ? <Download aria-hidden="true" size={15} /> : <FolderOpen aria-hidden="true" size={15} />} {isWeb ? 'Herunterladen' : 'Im Dateimanager zeigen'}</button>
      <span className="file-tree__menu-separator" role="separator" />
      <button type="button" role="menuitem" disabled={pinned} onClick={run(onCloseTab)}><X aria-hidden="true" size={15} /> Schließen</button>
      <button type="button" role="menuitem" disabled={!canCloseOthers} onClick={run(onCloseOthers)}><X aria-hidden="true" size={15} /> Andere schließen</button>
      <button type="button" role="menuitem" disabled={!canCloseRight} onClick={run(onCloseRight)}><ArrowRight aria-hidden="true" size={15} /> Rechts davon schließen</button>
    </div>
  )
}

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
  block: null,
  checkedAt: null,
  installationKind: 'managed-appimage',
  autoCheckUpdates: true,
  autoDownloadUpdates: true,
  installUpdatesOnQuit: true,
  updateChannel: 'stable',
}

const stripExtension = (name: string) => name.replace(/\.(md|markdown|famd|pdf)$/i, '')
function collectTreePaths(entries: VaultEntry[], files = false, out: string[] = []): string[] {
  for (const entry of entries) {
    if (!files || entry.kind !== 'folder') out.push(entry.relativePath)
    if (entry.children) collectTreePaths(entry.children, files, out)
  }
  return out
}
/** Background indexing waits this long after the file tree first appears. */
const DOC_SEARCH_START_DELAY_MS = 1_500

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

type NoteCompanionFields = {
  ink: DrawingLibraryDocument | null
  pageStats: unknown
  paperStyle: PaperStyle | null
  noteLinks: NoteLinkRecord[]
  noteBackups: NoteBackupSnapshot[]
  textFields: NoteTextField[]
}

/** One in-flight companion read per note, shared by open, ink, and the field effect. */
const noteCompanionLoads = new Map<string, Promise<NoteCompanionFields | null>>()

/** Used only when the desktop build has no combined companion read. */
const readCompanionFields = async (path: string): Promise<NoteCompanionFields> => {
  const api = window.fanotes
  const [pageStats, paperStyle, noteLinks, noteBackups, ink] = await Promise.all([
    api.readNotePageStats?.(path) ?? null,
    api.readNotePaperStyle?.(path) ?? null,
    api.readNoteLinks?.(path) ?? [],
    api.readNoteBackups?.(path) ?? [],
    typeof api.readFamdInk === 'function' ? api.readFamdInk(path).catch(() => null) : null,
  ])
  return {
    ink: ink ?? null,
    pageStats: pageStats ?? null,
    paperStyle: paperStyle ?? null,
    noteLinks: Array.isArray(noteLinks) ? noteLinks : [],
    noteBackups: Array.isArray(noteBackups) ? noteBackups : [],
    textFields: [],
  }
}

const attachNoteInk = (content: string, id: string) => {
  if (noteInkId(content)) return content
  // The marker line is hidden in the editor; a blank line before it is not.
  // That blank line grew the text on the first ink save and pushed a
  // worksheet below it away from the ink just written on it.
  const separator = content && !content.endsWith('\n') ? '\n' : ''
  return `${content}${separator}<!-- fanotes-ink:${id} -->\n`
}

const replaceNoteInk = (content: string, id: string) => noteInkId(content)
  ? content.replace(NOTE_INK_MARKER, `<!-- fanotes-ink:${id} -->`)
  : attachNoteInk(content, id)

/**
 * The note's saved handwriting: the `.famd` companion first (it is rewritten
 * on every ink save), then the drawing-library record the note's ink marker
 * points at. Every path that opens ink for a note goes through this, so the
 * pen never resumes from an older copy of the page.
 */
const readNoteInk = async (path: string, content: string): Promise<DrawingLibraryDocument | null> => {
  const markerId = noteInkId(content)
  const pending = noteCompanionLoads.get(path)
  if (pending) {
    try {
      const loaded = await pending
      if (loaded?.ink) return noteInkDocument(loaded.ink, markerId)
    } catch {
      // The shared read failed; the file read below is the fallback.
    }
  }
  if (typeof window.fanotes.readFamdInk === 'function') {
    try {
      const embedded = await window.fanotes.readFamdInk(path)
      if (embedded) return noteInkDocument(embedded, markerId)
    } catch {
      // Fall through to the drawing library.
    }
  }
  if (!markerId) return null
  try {
    return await window.fanotes.readDrawing(markerId)
  } catch {
    return null
  }
}

const noteWorksheetIds = (content: string) => content.includes('fanotes-worksheet') ? [...content.matchAll(NOTE_WORKSHEET_MARKER)].map((match) => match[1]) : []

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
  // Only notes count; PDFs, images and other attachments do not.
  if (entry.kind === 'file') total.files += /\.(?:md|markdown|famd)$/iu.test(entry.name) ? 1 : 0
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

const formatDate = (pattern: string, date = new Date()) => formatNoteStamp(pattern, date)

const hexRgb = (hex: string) => {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((part) => part + part).join('') : value
  const parsed = Number.parseInt(full, 16)
  if (!Number.isFinite(parsed)) return '42, 111, 151'
  return `${(parsed >> 16) & 255}, ${(parsed >> 8) & 255}, ${parsed & 255}`
}

const effectiveTheme = (settings: AppSettings, systemDark: boolean) => settings.theme === 'system'
  ? (systemDark ? 'dark' : 'light')
  : settings.theme

const THEME_CONTRAST_SURFACES: Record<string, string[]> = {
  dark: ['#191919', '#202020', '#202020', '#2f2f2f', '#3a3a3a'],
  light: ['#ffffff', '#f7f6f3', '#f7f6f3', '#ffffff', '#e3e2de'],
  midnight: ['#17181b', '#1e1f23', '#1e1f23', '#2a2c31'],
  forest: ['#171a18', '#1e221f', '#1e221f', '#2a2f2c'],
  aurora: ['#18181c', '#1f1f24', '#1f1f24', '#2c2c33'],
  sepia: ['#fbfaf7', '#f4f1ea', '#f4f1ea', '#fffdf8'],
  snow: ['#eef5fc', '#dfecf8', '#e1edf8', '#fafdff'],
  oled: ['#000000', '#000000', '#000000', '#000000'],
}

const saveExportFile = (filename: string, blob: Blob) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
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
  // The second split pane drives its own camera: zooming one sheet must never
  // move the other. The main pane stays on the shared store the ink board uses.
  const splitPaperViewStore = useMemo<PaperViewStore>(() => createPaperViewStore(), [])
  useEffect(() => {
    writeSharedZoomMaxPercent(settings.viewZoomMax ?? 325)
    for (const store of [sharedPaperViewStore, splitPaperViewStore]) {
      const view = store.read()
      const zoom = clampViewZoom(view.zoom)
      store.write(zoom === view.zoom ? { ...view } : { ...view, zoom })
    }
  }, [settings.viewZoomMax, splitPaperViewStore])
  useEffect(() => installChromeTextSelect(), [])
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [inspectorVisible, setInspectorVisible] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  // Window fullscreen where only the toolbar and the document stay. Pure CSS hides the rest, so leaving restores the layout as it was.
  const [toolbarFullscreen, setToolbarFullscreen] = useState(false)
  const [drawingOpen, setDrawingOpen] = useState(false)
  const [drawingSession, setDrawingSession] = useState<DrawingSession>(EMPTY_DRAWING_SESSION)
  const [worksheetSession, setWorksheetSession] = useState<WorksheetSession>({ key: 0, documents: [] })
  const [worksheetImportOpen, setWorksheetImportOpen] = useState(false)
  const [worksheetImportBusy, setWorksheetImportBusy] = useState(false)
  const [oneNoteDialogOpen, setOneNoteDialogOpen] = useState(false)
  const [mutatingEntryPaths, setMutatingEntryPaths] = useState<string[]>([])
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [homeworkOpen, setHomeworkOpen] = useState(false)
  const [homeworkReloadToken, setHomeworkReloadToken] = useState(0)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [editorMenuOpen, setEditorMenuOpen] = useState(false)
  const [sidebarToolsOpen, setSidebarToolsOpen] = useState(false)
  // Search-row slot that receives the folder tree's collapse/expand-all button.
  // Heading-fold memory is scoped per vault (hash of the vault path).
  const headingFoldScopeRef = useRef('')
  headingFoldScopeRef.current = headingFoldScope(bootstrap?.vaultPath)
  const [foldSlot, setFoldSlot] = useState<HTMLElement | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [lmStudioOpen, setLmStudioOpen] = useState(false)
  const [glyphenWerkOpen, setGlyphenWerkOpen] = useState(false)
  /** The `.story` project open in the writing mode (full screen). */
  const [writingPath, setWritingPath] = useState<string | null>(null)
  const writingPathRef = useRef<string | null>(null)
  writingPathRef.current = writingPath
  const [glyphenWerkView, setGlyphenWerkView] = useState<GlyphenWerkView>('capture')
  const [glyphenWerkSampleCount, setGlyphenWerkSampleCount] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searchFailed, setSearchFailed] = useState(false)
  const [inkReveal, setInkReveal] = useState<{ path: string; y: number; token: number } | null>(null)
  const [studyOpen, setStudyOpen] = useState(false)
  const [cardsOpen, setCardsOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [focusToken, setFocusToken] = useState(0)
  /** Asks the file tree to start inline renaming of a freshly created note or folder. */
  const [renameRequest, setRenameRequest] = useState<{ path: string; token: number } | null>(null)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [updateState, setUpdateState] = useState<UpdateState>(INITIAL_UPDATE_STATE)
  const [bugReportOpen, setBugReportOpen] = useState(false)
  const [workRequestsOpen, setWorkRequestsOpen] = useState(false)
  const [workRequestsAllowed, setWorkRequestsAllowed] = useState(false)
  const workRequestsClient = useMemo(() => new WorkRequestsClient({ getSession: () => syncEngine.getSession() }), [])
  const [addonStoreOpen, setAddonStoreOpen] = useState(false)
  const [addonPrompt, setAddonPrompt] = useState<AddonPromptRequest | null>(null)
  const addonState = useSyncExternalStore(addonRuntime.subscribe, addonRuntime.getState, addonRuntime.getState)
  const syncState = useSyncExternalStore(syncEngine.subscribe, syncEngine.getState, syncEngine.getState)
  const syncAccountId = syncState.account?.accountId ?? null
  const syncApi = window.fanotes?.sync ?? null
  useEffect(() => {
    let cancelled = false
    setWorkRequestsAllowed(false)
    if (syncAccountId) void workRequestsClient.capabilities().then((allowed) => { if (!cancelled) setWorkRequestsAllowed(allowed) })
    return () => { cancelled = true }
  }, [syncAccountId, workRequestsClient])
  const openWorkRequestsOrBugReport = useCallback(() => { if (workRequestsAllowed) setWorkRequestsOpen(true); else setBugReportOpen(true) }, [workRequestsAllowed])
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined)
  const [shareWithUser, setShareWithUser] = useState<ShareWithUserTarget | null>(null)
  const [shareLinkDialog, setShareLinkDialog] = useState<{ link: string; mode: 'copy' | 'live' | 'edit' } | null>(null)
  const shareLinkInputRef = useRef<HTMLInputElement>(null)
  const shareInFlight = useRef(false)
  const shareEditRef = useRef<ShareEditClient | null>(null)
  const shareEditApplyingRef = useRef(false)
  const [sharePeople, setSharePeople] = useState<SharePeople | null>(null)
  // Test seam for scripts/check-share-presence.mjs: a live share needs a server, the presence UI only needs this state.
  useEffect(() => {
    const onTestPeople = (event: Event) => setSharePeople((event as CustomEvent<SharePeople | null>).detail ?? null)
    window.addEventListener('fanotes:test-share-people', onTestPeople)
    return () => window.removeEventListener('fanotes:test-share-people', onTestPeople)
  }, [])
  const [shareJoin, setShareJoin] = useState<ShareOpenState | null>(null)
  const [shareNameDraft, setShareNameDraft] = useState('')
  const [shareSessionToken, setShareSessionToken] = useState(0)
  const addonNoteChangedRef = useRef<((path: string, content: string) => void) | null>(null)
  const [confirmRequest, setConfirmRequest] = useState<{
    message: string
    title?: string
    confirmLabel?: string
    resolve: (value: boolean) => void
  } | null>(null)
  const [remoteSupportSession, setRemoteSupportSession] = useState<RemoteSupportSession | null>(null)
  const [revealPath, setRevealPath] = useState<string | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [tagIndex, setTagIndex] = useState<Record<string, string[]>>({})
  const [notePaperByPath, setNotePaperByPath] = useState<Record<string, PaperStyle>>({})
  const [noteLinks, setNoteLinks] = useState<NoteLinkRecord[]>([])
  const [noteTextFields, setNoteTextFields] = useState<NoteTextField[]>([])
  const [noteLinkPlacing, setNoteLinkPlacing] = useState(false)
  const [textFieldPlacing, setTextFieldPlacing] = useState(false)
  const unifiedPaperRef = useRef<HTMLElement | null>(null)
  const [selectedTextFieldId, setSelectedTextFieldId] = useState<string | null>(null)
  const [textFieldFocusId, setTextFieldFocusId] = useState<string | null>(null)
  const [noteLinkStyle, setNoteLinkStyle] = useState<NoteLinkStyleId>('symbol')
  const [selectedNoteLinkId, setSelectedNoteLinkId] = useState<string | null>(null)
  const [noteHistory, setNoteHistory] = useState<NoteHistory>(EMPTY_NOTE_HISTORY)
  const [noteBackups, setNoteBackups] = useState<NoteBackupSnapshot[]>([])
  const [backupMenuOpen, setBackupMenuOpen] = useState(false)
  const editorMenuRef = useRef<HTMLDivElement>(null)
  const backupMenuRef = useRef<HTMLDivElement>(null)
  const closeEditorMenu = useCallback(() => setEditorMenuOpen(false), [])
  const closeBackupMenu = useCallback(() => setBackupMenuOpen(false), [])
  const onEditorMenuKeyDown = useMenuKeyboard(editorMenuRef, editorMenuOpen, closeEditorMenu)
  const onBackupMenuKeyDown = useMenuKeyboard(backupMenuRef, backupMenuOpen, closeBackupMenu)
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
  const [tagMenuOpen, setTagMenuOpen] = useState(false)
  const tagMenuRef = useRef<HTMLDivElement>(null)
  const tagPopoverRef = useRef<HTMLDivElement>(null)
  const closeTagMenu = useCallback(() => setTagMenuOpen(false), [])
  const onTagMenuKeyDown = useMenuKeyboard(tagPopoverRef, tagMenuOpen, closeTagMenu, { selector: 'button:not(:disabled), input:not(:disabled)', tab: 'edge', initial: 'input' })
  const [splitPath, setSplitPath] = useState<string | null>(null)
  const [splitLayout, setSplitLayout] = useState<SplitLayout>(() => loadSplitLayout())
  const [splitDragging, setSplitDragging] = useState(false)
  const [splitDrop, setSplitDrop] = useState<SplitDropZone | null>(null)
  const [focusedPane, setFocusedPane] = useState<'main' | 'split'>('main')
  const focusedPaneRef = useRef(focusedPane)
  focusedPaneRef.current = focusedPane
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  const [tabDrag, setTabDrag] = useState<{ path: string; over: string | null; side: 'before' | 'after' } | null>(null)
  const [paletteMode, setPaletteMode] = useState<'commands' | 'notes'>('commands')
  const [historyOpen, setHistoryOpen] = useState(false)
  const worksheetDialogRef = useRef<HTMLElement>(null)
  const shareJoinDialogRef = useRef<HTMLElement>(null)
  const shareLinkDialogRef = useRef<HTMLElement>(null)
  useModalFocus(worksheetDialogRef, { active: worksheetImportOpen })
  useModalFocus(shareJoinDialogRef, { active: Boolean(shareJoin), onEscape: () => setShareJoin(null) })
  useModalFocus(shareLinkDialogRef, { active: Boolean(shareLinkDialog) })
  const [folderPathTarget, setFolderPathTarget] = useState<string | null>(null)
  const [folderPathInitial, setFolderPathInitial] = useState<string[]>([])
  const [folderPathError, setFolderPathError] = useState<string | null>(null)
  const [folderPathBusy, setFolderPathBusy] = useState(false)
  const [folderPathMoved, setFolderPathMoved] = useState<number | null>(null)
  const [folderPathConflicts, setFolderPathConflicts] = useState<string[]>([])
  const [historySnapshots, setHistorySnapshots] = useState<NoteHistorySnapshot[]>([])
  const [historyBusy, setHistoryBusy] = useState(false)
  const tabsRef = useRef(tabs)
  const activePathRef = useRef(activePath)
  const splitPathRef = useRef<string | null>(null)
  const noteHistoryRef = useRef<NoteHistory>(EMPTY_NOTE_HISTORY)
  const closedTabsRef = useRef<string[]>([])
  /** old → new path of renamed/moved entries, so late keystrokes never recreate the old file. */
  const movedPathsRef = useRef<Map<string, { to: string; at: number }>>(new Map())
  const workspaceRestoredRef = useRef(false)
  // True once the remembered tabs and split are applied; a pagehide flush before that would overwrite them with the startup note alone.
  const workspaceAppliedRef = useRef(false)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const noteLinksRef = useRef<NoteLinkRecord[]>([])
  const noteTextFieldsRef = useRef<NoteTextField[]>([])
  /** The boxes as last read from or written to disk, per note: the common ground of the next per-box merge. */
  const textFieldBasesRef = useRef(new Map<string, NoteTextField[]>())
  const textFieldDirtyRef = useRef(false)
  const textFieldSavePathRef = useRef<string | null>(null)
  const textFieldTimerRef = useRef<number | null>(null)
  /** When the box state first became dirty without a flush since: the debounce may slide, but not forever. */
  const textFieldDirtySinceRef = useRef(0)
  /** Every text box read and write runs on this queue, one after the other. The boxes are unsaved while a write is queued. */
  const textFieldQueueRef = useRef(createSerialJobQueue())
  /** Counts note opens. A text box job that began in an earlier open must not touch the boxes of the next one. */
  const textFieldSessionRef = useRef(0)
  const refreshNoteTextFieldsRef = useRef<() => void>(() => undefined)
  const flushNoteTextFieldsRef = useRef<(closing?: boolean) => Promise<boolean>>(async () => true)
  const noteBackupsRef = useRef<NoteBackupSnapshot[]>([])
  const subjectBooksRef = useRef<SubjectBookRecord[]>([])
  const subjectBooksDiskRef = useRef<SubjectBookRecord[]>([])
  /** False until a subject-book read succeeds. A failed read must not be saved back as an empty list. */
  const subjectBooksLoadedRef = useRef(false)
  const bookPlacementRef = useRef<SubjectBookPlacement>('rechts')
  const editorRef = useRef<MarkdownEditorHandle>(null)
  /** The second pane keeps its own 90 ms keystroke buffer. Save and quit must flush it too. */
  const splitEditorRef = useRef<MarkdownEditorHandle>(null)
  const commandPane = () => editorPaneForCommand(focusedPaneRef.current, Boolean(splitPathRef.current))
  const commandEditor = () => commandPane() === 'split' ? splitEditorRef.current : editorRef.current
  const commandNotePath = () => commandPane() === 'split' ? splitPathRef.current : activePathRef.current
  const drawingBoardRef = useRef<DrawingBoardHandle>(null)
  const worksheetLayerRefs = useRef(new Map<string, WorksheetLayerHandle>())
  const worksheetLayerRefCallbacks = useRef(new Map<string, (handle: WorksheetLayerHandle | null) => void>())
  const worksheetDirtyCallbacks = useRef(new Map<string, (dirty: boolean) => void>())
  const focusRestoreRef = useRef({ sidebar: true, inspector: true })
  const treeRef = useRef(tree)
  const lastOwnTreeRefreshRef = useRef(0)
  // path -> arrival time. Persisted per vault (localStorage) so the dots survive a restart.
  const [newArrivals, setNewArrivals] = useState<Map<string, number>>(() => new Map())
  const arrivalsVaultRef = useRef<string | null>(null)
  /** Paths the sync engine wrote and when; those are never "new from outside". */
  const syncWrittenRef = useRef(new Map<string, number>())
  const syncEndedAtRef = useRef(0)
  const newMarkedPaths = useMemo(() => {
    const marked = new Set(newArrivals.keys())
    for (const entryPath of newArrivals.keys()) {
      let cut = entryPath.lastIndexOf('/')
      while (cut > 0) { marked.add(entryPath.slice(0, cut)); cut = entryPath.lastIndexOf('/', cut - 1) }
    }
    return marked
  }, [newArrivals])
  const saveTimers = useRef(new Map<string, number>())
  /** Consecutive failed saves per note; drives the retry backoff and keeps the error toast to one. */
  const saveFailuresRef = useRef(new Map<string, number>())
  const saveContentRef = useRef<((path: string, content: string) => Promise<boolean>) | null>(null)
  const pendingWrites = useRef(new Map<string, string>())
  // Tabs whose file was deleted or edited outside FaNotes are paused: nothing is saved over either side until the user decides.
  const { holds: tabHolds, holdsRef: tabHoldsRef, ownWritesRef: tabOwnWritesRef, setHold: setTabHold, noteOwnWrite, moveTabState, pruneTabState } = useTabHolds()
  const parkHeldTabRef = useRef<(path: string) => Promise<boolean>>(async () => true)
  const checkTabPathRef = useRef<(path: string) => Promise<void>>(async () => undefined)
  const settingsTimer = useRef<number | null>(null)
  const pageStatsRef = useRef(new Map<string, PageStatsSession>())
  /** A failed page-stats read. Saving must not invent a fresh session over the companion. */
  const pageStatsUnreadableRef = useRef(new Set<string>())
  const loadNoteCompanionRef = useRef<(path: string) => Promise<NoteCompanionFields | null>>(async () => null)
  /** Ink from a PDF history snapshot. The next save of that note writes it back. */
  const pendingHistoryInkRef = useRef(new Map<string, Record<string, unknown>>())
  const worksheetEffectPathRef = useRef('')
  const previousActivePathRef = useRef<string | null>(null)
  const settingsRef = useRef(settings)
  const applySettingsRef = useRef<(next: AppSettings) => void>(() => undefined)
  const settingsRevisionRef = useRef(0)
  const settingsPersistedRevisionRef = useRef(0)
  const lastHomeworkSecretRef = useRef('')
  const drawingOpenRef = useRef(drawingOpen)
  const modePathRef = useRef<string | null>(null)
  const drawingDirtyRef = useRef(false)
  const drawingSessionRef = useRef(drawingSession)
  const drawingSessionKeyRef = useRef(0)
  const drawingLoadRequestRef = useRef(0)
  const worksheetLoadRequestRef = useRef(0)
  const preparedInkRef = useRef<PreparedNoteInk | null>(null)
  /** The companion read during prepareDocumentOpen: text boxes, links and paper are in the note's first frame. */
  const preparedCompanionRef = useRef<{ path: string; fields: NoteCompanionFields | null; at: number } | null>(null)
  const openSequenceRef = useRef(0)
  const initialWorksheetLoadRef = useRef(true)
  const worksheetDirtyIdsRef = useRef(new Set<string>())
  const closeInProgressRef = useRef(false)
  const mutatingEntryPathsRef = useRef(new Set<string>())
  const vaultSessionGenerationRef = useRef(0)
  const vaultStructureRevisionRef = useRef(0)
  // Every tree result goes through this: a request issued earlier never overwrites a later one.
  const treeSyncRef = useRef<TreeSync<VaultEntry[]> | null>(null)
  if (!treeSyncRef.current) treeSyncRef.current = createTreeSync<VaultEntry[]>((next) => {
    treeRef.current = next; setTree(next)
    // Folded-heading memory of notes that no longer exist goes away.
    if (next.length) pruneHeadingFolds(headingFoldScopeRef.current, new Set(collectNotePaths(next)))
  })
  const vaultSwitchInProgressRef = useRef(false)
  const searchRequestRef = useRef(0)
  const openingNotesRef = useRef(new Set<string>())
  const toastCounter = useRef(0)
  const updateStatusRef = useRef<UpdateState['status']>('idle')
  const justUpdatedNoteRef = useRef<string | null>(null)
  const rolledBackNoteRef = useRef<string | null>(null)
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
  useEffect(() => { pruneTabState(new Set(tabs.map((tab) => tab.path))) }, [pruneTabState, tabs])
  useEffect(() => { activePathRef.current = activePath }, [activePath])
  useEffect(() => { splitPathRef.current = splitPath }, [splitPath])
  useEffect(() => { saveSplitLayout(splitLayout) }, [splitLayout])
  useEffect(() => { if (!splitPath) setFocusedPane('main') }, [splitPath])
  // The first pane's track is a whole number of device pixels, so the second
  // pane's scroller never sits on a half pixel (that composites its text soft).
  const [splitTracks, setSplitTracks] = useState<{ first: number; divider: number; size: number } | null>(null)
  useEffect(() => {
    const container = splitContainerRef.current
    if (!splitPath || !container || typeof ResizeObserver !== 'function') {
      setSplitTracks(null)
      return
    }
    const { ratio, orientation } = splitLayout
    const measure = () => {
      const size = orientation === 'columns' ? container.clientWidth : container.clientHeight
      const dpr = window.devicePixelRatio || 1
      const divider = snapToDevicePixels(SPLIT_DIVIDER_PX, dpr)
      setSplitTracks(size > 0 ? { first: splitFirstPaneSize(size, divider, ratio, dpr), divider, size } : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    const media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    media.addEventListener('change', measure)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', measure)
    }
  }, [splitLayout, splitPath])

  // Every activation is a visit; back/forward walk this list. A history jump
  // has already moved the cursor onto the note, so visitNote records nothing.
  useEffect(() => {
    if (!activePath) return
    const next = visitNote(noteHistoryRef.current, activePath)
    if (next !== noteHistoryRef.current) {
      noteHistoryRef.current = next
      setNoteHistory(next)
    }
  }, [activePath])

  // The open tabs, the split and the pins come back with the vault.
  useEffect(() => {
    if (!workspaceRestoredRef.current || !bootstrap) return
    const write = () => {
      saveWorkspaceMemory(bootstrap.vaultPath, {
        tabs: tabs.map((tab) => tab.path),
        pinned: tabs.filter((tab) => tab.pinned).map((tab) => tab.path),
        active: activePath,
        split: splitPath,
      })
    }
    const timer = window.setTimeout(write, 250)
    // A reload or quit inside the debounce window must not lose the last change.
    const flush = () => { if (workspaceAppliedRef.current) write() }
    window.addEventListener('pagehide', flush)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pagehide', flush)
    }
  }, [activePath, bootstrap, splitPath, tabs])
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
        where: errorLocation(event.filename, event.lineno),
      })
    }
    window.addEventListener('error', onError)
    return () => window.removeEventListener('error', onError)
  }, [updateState.currentVersion])
  useEffect(() => { setTagMenuOpen(false); setTagDraft('') }, [activePath])
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
        logs: diagnosticLog.snapshot().map(({ noteId: _noteId, ...rest }) => rest),
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
  useEffect(() => { if (modePathRef.current) writeDocInputMode(modePathRef.current, drawingOpen) }, [drawingOpen])
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
  useEffect(() => {
    if (!tagMenuOpen) return
    const close = (event: PointerEvent) => {
      if (tagMenuRef.current?.contains(event.target as Node)) return
      setTagMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTagMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [tagMenuOpen])
  const activeTab = useMemo(() => tabs.find((tab) => tab.path === activePath) ?? null, [activePath, tabs])
  // The overlay renders only the session loaded for the active note; the
  // switch effect below replaces a previous note's session one commit later.
  const noteDrawingSession = overlaySessionForNote(drawingSession, activeTab?.path ?? null)
  // Closures below read these instead of `drawingSession` / `noteDrawingSession`: a variable that any closure
  // captures lives in the render's context, and the stale contexts that memoized callbacks keep alive
  // would then hold every earlier session's whole drawing JSON (one copy per note open, for good).
  const noteDrawingKey = noteDrawingSession.key
  drawingSessionRef.current = drawingSession
  // The dirty flag belongs to the mounted board. A board that just unmounted
  // still reports (its unmount save, a resize during teardown); those reports
  // must not describe the next note's page.
  if (drawingSessionKeyRef.current !== noteDrawingSession.key) {
    drawingSessionKeyRef.current = noteDrawingSession.key
    drawingDirtyRef.current = false
  }
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
          subjectBooksLoadedRef.current = true
          subjectBooksDiskRef.current = parsed
          setSubjectBooksDisk(parsed)
          setSubjectBooks((memory) => mergeSubjectBooksPreferDisk(memory, parsed))
        } catch {
          // A failed re-read is not an empty book list.
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
  /** The open note's file was deleted or edited outside FaNotes; it is read-only until the user decides. */
  const activeHeld = Boolean(activePath && tabHolds[activePath])
  // A paused tab (file deleted or changed outside) is not saved, whatever the last write said.
  const shownSaveState: SaveState = activeHeld ? 'error' : saveState
  const counts = useMemo(() => countEntries(tree), [tree])
  const visibleTree = useMemo(() => filterTreeByTag(tree, tagFilter, new Map(Object.entries(tagIndex))), [tagFilter, tagIndex, tree])
  const knownTags = useMemo(() => collectVaultTags(Object.values(tagIndex).map((tags) => ({ content: tags.map((tag) => `#${tag}`).join(' ') }))), [tagIndex])
  // Whole-text tag parsing waits for a typing pause in huge notes (QA-006).
  const activeTagSource = useSettledValue(activeTab?.content ?? '', activeTab?.content.length ?? 0, activeTab?.path ?? '')
  const inspectorNotes = useMemo(() => tabs.map((tab) => ({ path: tab.path, content: tab.content })), [tabs])
  const activeTags = useMemo(() => parseNoteTags(activeTagSource), [activeTagSource])
  const splitTab = splitPath ? tabs.find((tab) => tab.path === splitPath) ?? null : null
  // The outline and backlinks follow the pane that has focus.
  const inspectorTab = focusedPane === 'split' && splitTab ? splitTab : activeTab
  const vaultNoteReferences = useMemo(() => lmStudioOpen ? [...filePaths(tree)]
    .filter((path) => path !== activePath)
    .map((path) => ({ title: stripExtension(fileName(path)), relativePath: path })) : [], [activePath, lmStudioOpen, tree])
  const lmStudioNote = useMemo(() => lmStudioOpen && activeTab ? {
    title: activeTab.title,
    relativePath: activeTab.path,
    markdown: visibleNoteContent(pendingWrites.current.get(activeTab.path) ?? activeTab.content),
  } : null, [activeTab, lmStudioOpen])
  // A layout effect: handwriting read before the switch (prepareDocumentOpen)
  // mounts in the same commit as the note's text, not one paint later.
  useLayoutEffect(() => {
    const requestId = ++drawingLoadRequestRef.current
    drawingDirtyRef.current = false
    const path = activeTab?.path
    const content = activeTab?.content ?? ''
    if (!path) {
      if (modePathRef.current) writeDocInputMode(modePathRef.current, drawingOpenRef.current)
      modePathRef.current = null
      drawingOpenRef.current = false
      setDrawingOpen(false)
      setDrawingSession(EMPTY_DRAWING_SESSION)
      return
    }
    // Each document returns to the input mode it was last left in; a document
    // without a record keeps the mode carried over from the previous one.
    const previousModePath = modePathRef.current
    if (previousModePath && previousModePath !== path) writeDocInputMode(previousModePath, drawingOpenRef.current)
    modePathRef.current = path
    const rememberedPen = readDocInputMode(path)
    const switched = overlayAfterNoteSwitch({
      session: { key: 0, document: null },
      drawingOpen: rememberedPen ?? drawingOpenRef.current,
      host: null,
    }, requestId)
    drawingOpenRef.current = switched.drawingOpen
    setDrawingOpen(switched.drawingOpen)
    const prepared = preparedInkRef.current
    preparedInkRef.current = null
    // The note open at start takes its prepared ink as well: deferred, it
    // came a quarter of a second after the note's text.
    if (
      prepared && prepared.path === path && prepared.content === content
      && Date.now() - prepared.at <= PREPARED_INK_TTL_MS
    ) {
      setDrawingSession({
        ...overlaySessionAfterInkReady(switched.drawingOpen, drawingSessionFromLoad(requestId, prepared.document)),
        path,
      })
      return
    }
    setDrawingSession({ ...overlaySessionAfterNoteSwitch(switched), path })

    // Saved handwriting loads in both input modes; keyboard mode mounts it
    // inert and only when the note has ink (overlaySessionAfterInkReady).
    const load = () => {
      void readNoteInk(path, content).then((document) => {
        if (requestId !== drawingLoadRequestRef.current || activePathRef.current !== path) return
        setDrawingSession({
          ...overlaySessionAfterInkReady(drawingOpenRef.current, drawingSessionFromLoad(requestId, document)),
          path,
        })
      })
    }
    // Not prepared in time (a slow read): the ink is read now, not when the
    // window is next idle, so it follows the text as closely as it can.
    load()
  }, [activeTab?.path])

  // A layout effect: with the companion read before the switch, the text
  // boxes, note links and paper are in the note's first frame instead of
  // appearing (laid out on a sheet without its page) a read later.
  useLayoutEffect(() => {
    const path = activePath
    const previousFieldPath = textFieldSavePathRef.current
    if (previousFieldPath && previousFieldPath !== path) void flushNoteTextFieldsRef.current()
    setNoteLinkPlacing(false)
    setTextFieldPlacing(false)
    setTextFieldFocusId(null)
    setSelectedNoteLinkId(null)
    setBackupMenuOpen(false)
    textFieldSessionRef.current += 1
    noteTextFieldsRef.current = []
    setNoteTextFields([])
    textFieldDirtyRef.current = false
    textFieldSavePathRef.current = path
    if (path) textFieldBasesRef.current.delete(path)
    if (!path) {
      noteLinksRef.current = []
      setNoteLinks([])
      textFieldSavePathRef.current = null
      noteBackupsRef.current = []
      setNoteBackups([])
      return
    }
    let alive = true
    const applyCompanion = (fields: NoteCompanionFields | null) => {
      if (!alive) return
      const style = fields?.paperStyle
      if (style) setNotePaperByPath((current) => current[path] === style ? current : { ...current, [path]: style })
      const links = Array.isArray(fields?.noteLinks) ? fields.noteLinks : []
      noteLinksRef.current = links
      setNoteLinks(links)
      // A write that already finished holds a newer copy of the disk than this read.
      if (!textFieldBasesRef.current.has(path)) {
        const loadedFields = parseNoteTextFields(fields?.textFields)
        textFieldBasesRef.current.set(path, loadedFields)
        // Boxes a closing browser tab could not save any more come back first.
        const rescue = readNoteTextFieldRescue(path)
        const fromRescue = rescue ? parseNoteTextFields(mergeNoteTextFields(rescue.base, rescue.fields, loadedFields)) : null
        const rescuedSomething = fromRescue !== null && !noteTextFieldsEqual(fromRescue, loadedFields)
        if (rescue && !rescuedSomething) clearNoteTextFieldRescue(path)
        const rescued = rescuedSomething ? fromRescue : loadedFields
        const local = noteTextFieldsRef.current
        if (local.length || rescuedSomething) {
          // The user placed or typed a box before the read came back: keep it next to the stored ones.
          const merged = local.length ? parseNoteTextFields(mergeNoteTextFields([], local, rescued)) : rescued
          noteTextFieldsRef.current = merged
          setNoteTextFields(merged)
          textFieldDirtyRef.current = true
          textFieldSavePathRef.current = path
          void flushNoteTextFieldsRef.current()
        } else {
          noteTextFieldsRef.current = loadedFields
          setNoteTextFields(loadedFields)
        }
      }
      const backups = listNoteBackups(fields?.noteBackups ?? [], path)
      noteBackupsRef.current = backups
      setNoteBackups(backups)
    }
    const prepared = preparedCompanionRef.current
    preparedCompanionRef.current = null
    if (prepared && prepared.path === path && Date.now() - prepared.at <= PREPARED_INK_TTL_MS) applyCompanion(prepared.fields)
    const pending = noteCompanionLoads.get(path) ?? loadNoteCompanionRef.current(path)
    void pending.then(applyCompanion).catch(() => {
      if (!alive) return
      noteLinksRef.current = []
      setNoteLinks([])
      noteBackupsRef.current = []
      setNoteBackups([])
    })
    return () => { alive = false }
  }, [activePath])

  useEffect(() => {
    if (!window.fanotes.readSubjectBooks) {
      subjectBooksLoadedRef.current = true
      setSubjectBooksReady(true)
      return
    }
    // Nothing to read before the vault exists and first-run onboarding is done.
    if (!bootstrap || bootstrap.onboardingRequired) return
    let alive = true
    subjectBooksLoadedRef.current = false
    setSubjectBooksReady(false)
    void window.fanotes.readSubjectBooks()
      .then((list) => {
        if (!alive) return
        const parsed = parseSubjectBooks(list)
        subjectBooksLoadedRef.current = true
        subjectBooksDiskRef.current = parsed
        setSubjectBooksDisk(parsed)
        setSubjectBooks(parsed)
      })
      .catch(() => {
        if (!alive) return
        subjectBooksLoadedRef.current = false
      })
      .finally(() => {
        if (alive) setSubjectBooksReady(true)
      })
    return () => { alive = false }
  }, [bootstrap?.vaultPath, bootstrap?.onboardingRequired])

  const activeWorksheetMarkerKey = activeTab ? noteWorksheetIds(activeTagSource).join('\0') : ''
  useEffect(() => {
    const requestId = ++worksheetLoadRequestRef.current
    const path = activeTab?.path
    const ids = activeWorksheetMarkerKey ? activeWorksheetMarkerKey.split('\0') : []
    const pathChanged = worksheetEffectPathRef.current !== (path ?? '')
    worksheetEffectPathRef.current = path ?? ''
    if (pathChanged) {
      worksheetDirtyIdsRef.current.clear()
      setWorksheetSession({ key: requestId, documents: [] })
    } else {
      for (const id of [...worksheetDirtyIdsRef.current]) {
        if (!ids.includes(id)) worksheetDirtyIdsRef.current.delete(id)
      }
    }
    const initialNoteLoad = Boolean(path && pathChanged && initialWorksheetLoadRef.current)
    if (path && pathChanged) initialWorksheetLoadRef.current = false
    if (!path || !ids.length) {
      if (!pathChanged) setWorksheetSession({ key: requestId, documents: [] })
      return
    }
    let idleId: number | null = null
    let startTimer: number | null = null
    const load = () => {
      void Promise.allSettled(ids.map((id) => window.fanotes.readWorksheet(id))).then((results) => {
        if (requestId !== worksheetLoadRequestRef.current || activePathRef.current !== path) return
        const loaded = new Map(results.flatMap((result) => result.status === 'fulfilled' ? [[result.value.id, result.value] as const] : []))
        setWorksheetSession((current) => {
          const documents = ids.flatMap((id) => {
            if (worksheetDirtyIdsRef.current.has(id)) {
              const kept = current.documents.find((document) => document.id === id)
              if (kept) return [kept]
            }
            const document = loaded.get(id)
            return document ? [document] : []
          })
          return { key: requestId, documents }
        })
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
  }, [activeTab?.path, activeWorksheetMarkerKey])

  useEffect(() => {
    const activeIds = new Set(worksheetSession.documents.map((document) => document.id))
    for (const id of worksheetLayerRefCallbacks.current.keys()) {
      if (!activeIds.has(id)) worksheetLayerRefCallbacks.current.delete(id)
    }
    for (const id of worksheetDirtyCallbacks.current.keys()) {
      if (!activeIds.has(id)) worksheetDirtyCallbacks.current.delete(id)
    }
  }, [worksheetSession.documents])

  const toast = useCallback((rawMessage: string, kind: Toast['kind'] = 'info', action?: Toast['action']) => {
    const message = kind === 'error' ? sanitizeToastMessage(rawMessage) : rawMessage
    // Error toasts feed the opt-in diagnostics: a hash and a count, never the text itself.
    if (kind === 'error') diagnosticLog.record({ at: Date.now(), kind: 'error', message })
    const id = ++toastCounter.current
    setToasts((current) => [...current.slice(-3), { id, kind, message, ...(action ? { action } : {}) }])
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), action ? UNDO_TOAST_MS : kind === 'error' ? 6500 : 4000)
  }, [])

  // Shared notes (desktop): live co-editing with the other person. Unshared notes cost nothing.
  const liveEnabled = window.fanotes.platform !== 'web' && window.fanotes.platform !== 'browser-preview'
  const live = useLiveNote(liveEnabled && activeTab ? activeTab.path : null, activeTab?.content ?? '', (copy) => toast(`Deine Änderungen aus der Zeit ohne Verbindung konnten nicht zusammengeführt werden. Sie liegen als Kopie unter „${fileName(copy)}“.`, 'info'))

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id))
  }, [])

  const requestConfirm = useCallback((message: string, options?: { title?: string; confirmLabel?: string }) => {
    const host = deleteConfirmHost({
      sendDataEnabled: settingsRef.current.experimentalSendData,
      linux: bootstrap?.linuxRuntime ?? linuxHyprlandRuntimeContext({ platform: window.fanotes?.platform }),
    })
    if (host !== 'fanotes') return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      setConfirmRequest({
        message,
        title: options?.title,
        confirmLabel: options?.confirmLabel,
        resolve,
      })
    })
  }, [bootstrap?.linuxRuntime])

  // Page statistics are recorded quietly into the .famd payload; nothing here
  // touches React state, so the one-second tick never re-renders the app.
  const flushPageStats = useCallback((path: string, now = Date.now(), keepActive = true) => {
    const session = pageStatsRef.current.get(path)
    if (!session) return null
    const visible = typeof document === 'undefined' ? true : !document.hidden
    const focused = typeof document === 'undefined' || typeof document.hasFocus !== 'function' ? true : document.hasFocus()
    const next = tickPageStats(session, now, keepActive && visible && activePathRef.current === path, focused)
    pageStatsRef.current.set(path, next)
    return snapshotPageStats(next)
  }, [])

  /**
   * The editor only holds stripped markdown, so page stats have to be read
   * from the `.famd` companion. A failed read is remembered: the next save
   * must not replace the companion's statistics with a new session.
   */
  const preparePageStats = useCallback(async (path: string) => {
    if (pageStatsRef.current.has(path) || pageStatsUnreadableRef.current.has(path)) return
    const read = window.fanotes.readNotePageStats
    if (typeof read !== 'function') return
    try {
      const raw = await read(path)
      if (pageStatsRef.current.has(path)) return
      pageStatsUnreadableRef.current.delete(path)
      if (raw && typeof raw === 'object') {
        pageStatsRef.current.set(path, idlePageStatsSession(parsePageStats(raw)))
      }
    } catch {
      pageStatsUnreadableRef.current.add(path)
    }
  }, [])

  /** Session for a note that has a tab, created from the note's payload on first use. */
  const ensurePageStatsSession = useCallback((path: string) => {
    const existing = pageStatsRef.current.get(path)
    if (existing) return existing
    if (pageStatsUnreadableRef.current.has(path)) return null
    if (noteCompanionLoads.has(path)) return null
    const tab = tabsRef.current.find((candidate) => candidate.path === path)
    if (!tab) return null
    const session = idlePageStatsSession(readPageStatsFromNote(pendingWrites.current.get(path) ?? tab.content))
    pageStatsRef.current.set(path, session)
    return session
  }, [])

  const updatePageStats = useCallback((path: string, update: (session: PageStatsSession) => PageStatsSession) => {
    const session = ensurePageStatsSession(path)
    if (!session) return
    pageStatsRef.current.set(path, update(session))
  }, [ensurePageStatsSession])

  const recordEditActivityFor = useCallback((path: string, activity: EditActivity) => {
    updatePageStats(path, (session) => recordEditActivity(session, activity, Date.now()))
  }, [updatePageStats])

  const recordInkStrokeFor = useCallback((path: string, stroke: InkStrokeActivity) => {
    updatePageStats(path, (session) => recordInkStroke(session, stroke, Date.now()))
    addonRuntime.emit('ink:stroke', { path, ...stroke })
  }, [updatePageStats])

  const recordInkErasedFor = useCallback((path: string, removed: number) => {
    updatePageStats(path, (session) => recordInkErased(session, removed, Date.now()))
  }, [updatePageStats])

  const recordInkSnapshotFor = useCallback((path: string, summary: InkSummary) => {
    updatePageStats(path, (session) => recordInkSnapshot(session, summary, Date.now()))
  }, [updatePageStats])

  /**
   * Queues a write for a note whose statistics moved on since the last save
   * but whose text did not: the autosave path does not fire without typing.
   * Returns true when a write was queued.
   */
  const queuePageStatsWrite = useCallback((path: string, minDwellDeltaMs = PAGE_STATS_MIN_DWELL_DELTA_MS) => {
    const session = pageStatsRef.current.get(path)
    if (!session || !pageStatsNeedPersist(session, minDwellDeltaMs)) return false
    if (pendingWrites.current.has(path)) return true
    const tab = tabsRef.current.find((candidate) => candidate.path === path)
    if (!tab) return false
    pendingWrites.current.set(path, tab.content)
    return true
  }, [])

  const activatePageStats = useCallback((path: string, content: string, now = Date.now()) => {
    const previousPath = activePathRef.current
    if (previousPath && previousPath !== path) flushPageStats(previousPath, now, false)
    if (pageStatsUnreadableRef.current.has(path)) return null
    const existing = pageStatsRef.current.get(path)
    const opened = openPageStats(existing ?? readPageStatsFromNote(content, now), now)
    pageStatsRef.current.set(path, opened)
    return opened
  }, [flushPageStats])

  const installUpdateOnQuit = useCallback(async (requested: boolean) => {
    try {
      setUpdateState(await (window.fanotes.installUpdateOnQuit?.(requested) ?? window.fanotes.getUpdateState()))
      if (requested) toast('Das Update wird installiert, sobald du FaNotes beendest.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das Update konnte nicht vorgemerkt werden.', 'error')
    }
  }, [toast])

  useEffect(() => {
    let alive = true
    let idleId: number | null = null
    const applyUpdateState = (next: UpdateState) => {
      if (!alive) return
      const previous = updateStatusRef.current
      updateStatusRef.current = next.status
      setUpdateState(next)
      if (next.status === 'downloaded' && previous !== 'downloaded') {
        // One short line of release notes, so the toast says what is new without another click.
        const firstNote = next.releaseNotes[0]?.replaceAll('**', '').replaceAll('`', '').trim()
        const note = firstNote ? ` Neu: ${firstNote.length > 90 ? `${firstNote.slice(0, 89)}…` : firstNote}` : ''
        toast(next.installUpdatesOnQuit || next.installOnQuitRequested
          ? `FaNotes ${next.latestVersion} ist geprüft und wird beim Beenden installiert.${note}`
          : `FaNotes ${next.latestVersion} ist geprüft und bereit. Installiere es unter „Update bereit“, wann es dir passt.${note}`, 'success')
      }
      if (next.status === 'error' && previous !== 'error' && next.failedPhase === 'download') {
        toast('Der Update-Download ist fehlgeschlagen. FaNotes versucht es automatisch erneut; Details stehen in den Einstellungen unter Updates.', 'error')
      }
      // A restart into the update that could not start: the app stays open, so a later close must work again.
      if (next.status === 'downloaded' && next.error && closeInProgressRef.current) {
        closeInProgressRef.current = false
        toast(`Das Update konnte nicht gestartet werden: ${next.error}`, 'error')
      }
      if (next.installNotCompleted && rolledBackNoteRef.current !== next.installNotCompleted.version) {
        rolledBackNoteRef.current = next.installNotCompleted.version
        toast(`FaNotes ${next.installNotCompleted.version} wurde nicht installiert. ${next.installNotCompleted.message} Das Update wird nicht erneut automatisch versucht; du kannst es unter Einstellungen › Updates manuell installieren.`, 'error')
      }
      if (next.rolledBack && rolledBackNoteRef.current !== next.rolledBack.version) {
        rolledBackNoteRef.current = next.rolledBack.version
        toast(`FaNotes ${next.rolledBack.version} ließ sich nicht starten. Die bisherige Version ${next.currentVersion} wurde wiederhergestellt. ${next.rolledBack.message}`, 'error')
      }
      // A short, silent note once after an update (quit, launch or background); never a dialog.
      if (next.justUpdated && justUpdatedNoteRef.current !== next.justUpdated.to) {
        justUpdatedNoteRef.current = next.justUpdated.to
        toast(`Auf Version ${next.justUpdated.to} aktualisiert`, 'success')
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
    const [drawingSaved, worksheetsSaved, textFieldsSaved] = await Promise.all([
      flushDrawing(),
      flushWorksheets(),
      flushNoteTextFieldsRef.current(),
    ])
    return drawingSaved && worksheetsSaved && textFieldsSaved
  }, [flushDrawing, flushWorksheets])

  const refreshTree = useCallback(async () => {
    const session = vaultSessionGenerationRef.current
    const sync = treeSyncRef.current!
    const ticket = sync.begin()
    const nextTree = await window.fanotes.getTree()
    if (session !== vaultSessionGenerationRef.current) return treeRef.current
    // A request issued after this one may already have been applied: keep that one.
    const applied = sync.accept(ticket, nextTree)
    syncEngine.notifyLocalChange()
    lastOwnTreeRefreshRef.current = Date.now()
    return applied ? nextTree : treeRef.current
  }, [])

  // Files that arrived from outside FaNotes; the mark goes away when the note is opened.
  useEffect(() => {
    if (!window.fanotes?.onVaultChanged) return undefined
    return window.fanotes.onVaultChanged((change) => {
      const session = vaultSessionGenerationRef.current
      const known = new Set(collectTreePaths(treeRef.current))
      const ownRecently = Date.now() - lastOwnTreeRefreshRef.current < 4000
      const active = activePathRef.current
      const onlyActiveChanged = !change.truncated && !change.added.length && !change.removed.length &&
        change.changed.every((entryPath) => entryPath === active)
      // The open note's own autosave also shows up as a change: nothing to do then.
      if (onlyActiveChanged) return
      const sync = treeSyncRef.current!
      const ticket = sync.begin()
      void window.fanotes.getTree({ fromWatcher: true }).then((fetchedTree) => {
        // Only the tree is swapped. Open tabs, unsaved edits, selection, expanded
        // folders and scroll position live elsewhere and stay untouched.
        if (session !== vaultSessionGenerationRef.current) return
        // This walk may be older than our own refresh (for example a folder created
        // meanwhile): then the newer tree stays and only the arrival handling runs.
        const nextTree = sync.accept(ticket, fetchedTree) ? fetchedTree : treeRef.current
        syncEngine.notifyLocalChange()
        const present = new Set(collectTreePaths(nextTree))
        // A truncated change list must not silently drop entries: derive arrivals from the full tree.
        const addedPaths = change.truncated ? [...present] : change.added
        const arrived = addedPaths.filter((entryPath) => !known.has(entryPath) && present.has(entryPath) && !tabsRef.current.some((tab) => tab.path === entryPath))
        const fileSet = new Set(collectTreePaths(nextTree, true))
        const now = Date.now()
        // Sync-pulled files and our own writes are not "from outside": only the rest gets a dot and a toast.
        const files = externalArrivals({
          files: arrived.filter((entryPath) => fileSet.has(entryPath)),
          now,
          syncBusy: syncEngine.getState().status === 'syncing',
          syncEndedAt: syncEndedAtRef.current,
          syncWritten: syncWrittenRef.current,
          ownRecently,
        })
        setNewArrivals((current) => {
          const next = new Map([...current].filter(([entryPath]) => present.has(entryPath)))
          for (const entryPath of files) next.set(entryPath, now)
          return next.size === current.size && [...next.keys()].every((entryPath) => current.has(entryPath)) ? current : next
        })
        if (files.length) {
          const folder = files[0].includes('/') ? files[0].slice(0, files[0].lastIndexOf('/')).split('/').pop() : ''
          const sameFolder = files.every((entryPath) => entryPath.slice(0, Math.max(0, entryPath.lastIndexOf('/'))) === files[0].slice(0, Math.max(0, files[0].lastIndexOf('/'))))
          const where = sameFolder && folder ? ` in ${folder}` : ''
          toast(files.length === 1
            ? `1 neue Datei${where}`
            : `${files.length} neue Dateien${where}`, 'info')
        }
      }).catch(() => undefined)
    })
  }, [toast])

  // Opening a note in either pane clears its mark.
  useEffect(() => {
    const opened = [activePath, splitPath].filter((entryPath): entryPath is string => Boolean(entryPath))
    if (!opened.length) return
    setNewArrivals((current) => {
      if (!opened.some((entryPath) => current.has(entryPath))) return current
      const next = new Map(current)
      for (const entryPath of opened) next.delete(entryPath)
      return next
    })
  }, [activePath, splitPath])

  // Load the stored marks for the vault, and save every change back.
  const arrivalsVaultPath = bootstrap?.vaultPath ?? null
  useEffect(() => {
    if (!arrivalsVaultPath || arrivalsVaultRef.current === arrivalsVaultPath) return
    arrivalsVaultRef.current = arrivalsVaultPath
    syncWrittenRef.current = new Map()
    const stored = loadArrivals(typeof localStorage === 'undefined' ? null : localStorage, arrivalsVaultPath)
    if (treeRef.current.length) {
      const present = new Set(collectTreePaths(treeRef.current))
      for (const entryPath of [...stored.keys()]) if (!present.has(entryPath)) stored.delete(entryPath)
    }
    setNewArrivals(stored)
  }, [arrivalsVaultPath])
  useEffect(() => {
    if (!arrivalsVaultPath || arrivalsVaultRef.current !== arrivalsVaultPath) return
    saveArrivals(typeof localStorage === 'undefined' ? null : localStorage, arrivalsVaultPath, newArrivals)
  }, [arrivalsVaultPath, newArrivals])
  // Marks for files that vanished while the app was closed go away once the tree is known.
  useEffect(() => {
    if (!tree.length) return
    const present = new Set(collectTreePaths(tree))
    setNewArrivals((current) => {
      const next = new Map([...current].filter(([entryPath]) => present.has(entryPath)))
      return next.size === current.size ? current : next
    })
  }, [tree])

  // Remember when a sync run ends: its last file writes can surface in a watcher event a moment later.
  const syncBusyNow = syncState.status === 'syncing'
  const syncWasBusyRef = useRef(false)
  useEffect(() => {
    if (!syncBusyNow && syncWasBusyRef.current) syncEndedAtRef.current = Date.now()
    syncWasBusyRef.current = syncBusyNow
  }, [syncBusyNow])

  const rememberLastOpenNote = useCallback((path: string) => {
    if (!path || settingsRef.current.lastOpenNotePath === path) return
    const nextSettings = { ...settingsRef.current, lastOpenNotePath: path }
    settingsRef.current = nextSettings
    void window.fanotes.saveSettings(nextSettings).catch(() => undefined)
  }, [])

  /** Read a note into a tab record without activating it. */
  const readNoteTab = useCallback(async (path: string): Promise<NoteTab> => {
    const pdfNote = isPdfNotePath(path)
    let content = ''
    if (pdfNote) {
      try {
        content = stripFamdPayload(await window.fanotes.readFile(companionNotePath(path, '.famd')))
      } catch {
        content = ''
      }
    } else {
      content = stripFamdPayload(await window.fanotes.readFile(path))
    }
    return {
      path,
      title: stripExtension(fileName(path)),
      content,
      savedContent: content,
      kind: pdfNote ? 'pdf' : 'markdown',
    }
  }, [])

  /**
   * File stats become the open session only after the companion returns, so a
   * blank session cannot swallow them or count the open twice. A failed read
   * is latched and any session created during the wait is dropped: the next
   * save must not replace the statistics still on disk.
   */
  const installCompanionPageStats = useCallback((path: string, fields: NoteCompanionFields | null, hadSession: boolean) => {
    if (hadSession || pageStatsRef.current.has(path)) return
    pageStatsUnreadableRef.current.delete(path)
    const raw = fields?.pageStats
    if (raw && typeof raw === 'object') {
      const idle = idlePageStatsSession(parsePageStats(raw))
      pageStatsRef.current.set(path, idle)
      if (activePathRef.current === path) activatePageStats(path, '')
      return
    }
    if (activePathRef.current === path) {
      const tab = tabsRef.current.find((candidate) => candidate.path === path)
      if (tab) activatePageStats(path, tab.content)
    }
  }, [activatePageStats])

  const loadNoteCompanion = useCallback((path: string) => {
    const existing = noteCompanionLoads.get(path)
    if (existing) return existing
    const task = (async (): Promise<NoteCompanionFields | null> => {
      const hadSession = pageStatsRef.current.has(path)
      try {
        const loaded = typeof window.fanotes.readNoteCompanion === 'function'
          ? await window.fanotes.readNoteCompanion(path)
          : await readCompanionFields(path)
        const fields = loaded
          ? { ...loaded, textFields: parseNoteTextFields(loaded.textFields) }
          : null
        installCompanionPageStats(path, fields, hadSession)
        return fields
      } catch {
        if (!hadSession) {
          pageStatsRef.current.delete(path)
          pageStatsUnreadableRef.current.add(path)
        }
        return null
      }
    })()
    noteCompanionLoads.set(path, task)
    void task.finally(() => {
      if (noteCompanionLoads.get(path) === task) noteCompanionLoads.delete(path)
    })
    return task
  }, [installCompanionPageStats])
  loadNoteCompanionRef.current = loadNoteCompanion

  const revealOpenedNote = useCallback((path: string, content: string, splitSwap: string | null) => {
    const previousPath = activePathRef.current
    if (previousPath && previousPath !== path) flushPageStats(previousPath, Date.now(), false)
    if (pageStatsRef.current.has(path)) activatePageStats(path, content)
    activePathRef.current = path
    setActivePath(path)
    if (splitSwap) setSplitPath(splitSwap)
    setFocusToken((value) => value + 1)
    rememberLastOpenNote(path)
    void loadNoteCompanion(path)
  }, [activatePageStats, flushPageStats, loadNoteCompanion, rememberLastOpenNote])

  /**
   * Load what the next document shows in its first frame while the current
   * one stays on screen: a PDF's parsed document (handed to PdfNoteView) and
   * the note's handwriting (picked up by the drawing session effect). Capped
   * at DOCUMENT_OPEN_PREPARE_MS; a slower load finishes after the switch.
   */
  const prepareDocumentOpen = useCallback(async (path: string, content: string) => {
    const work: Promise<unknown>[] = []
    // Started first: the ink read below shares this one file read.
    preparedCompanionRef.current = null
    if (!isPdfNotePath(path)) {
      work.push(loadNoteCompanionRef.current(path).then((fields) => {
        preparedCompanionRef.current = { path, fields, at: Date.now() }
      }))
    }
    if (isPdfNotePath(path)) {
      work.push(Promise.all([loadPdfNoteViewModule(), import('./lib/pdfPrepare')])
        .then(([, prepare]) => prepare.preparePdfDocument(path)))
    } else if (content.includes('![')) {
      // Pictures with their size in the first frame: the sheet and its ink stay put.
      work.push(import('./components/MarkdownEditor').then((editor) => editor.prepareNoteImages(path, content)))
    }
    work.push(readNoteInk(path, content).then((document) => {
      preparedInkRef.current = { path, content, at: Date.now(), document }
      if (document || drawingOpenRef.current) return loadDrawingBoardModule()
      return undefined
    }))
    let timer = 0
    await Promise.race([
      Promise.all(work).catch(() => undefined),
      new Promise<void>((resolve) => { timer = window.setTimeout(resolve, DOCUMENT_OPEN_PREPARE_MS) }),
    ])
    window.clearTimeout(timer)
  }, [])

  const openNoteUntracked = useCallback(async (path: string): Promise<boolean> => {
    if (activePathRef.current && activePathRef.current !== path) {
      // Book the last keystrokes under the note that is leaving before its editor unmounts.
      editorRef.current?.flushChanges()
      // Activating the split note swaps the panes. Its buffer has to land first,
      // or the new main editor opens the copy from before those keystrokes.
      if (splitPathRef.current === path) splitEditorRef.current?.flushChanges()
      if (!await flushDocumentLayers()) return false
    }
    if (/\.story$/iu.test(path)) {
      // A story opens in the writing mode; the notes stay as they are underneath.
      setWritingPath(path)
      return true
    }
    const session = vaultSessionGenerationRef.current
    const structureRevision = vaultStructureRevisionRef.current
    setOverviewOpen(false)
    setHomeworkOpen(false)
    setCalendarOpen(false)
    setGlyphenWerkOpen(false)
    // Activating the note shown in the second pane swaps the panes instead of
    // showing the same note twice.
    const previousActive = activePathRef.current
    const swapIntoSplit = splitPathRef.current === path && previousActive && previousActive !== path
    const existing = tabsRef.current.find((tab) => tab.path === path)
    // A later open wins; an earlier one still preparing must not switch back.
    const sequence = ++openSequenceRef.current
    if (existing) {
      if (session !== vaultSessionGenerationRef.current) return false
      if (!isPdfNotePath(path)) await loadMarkdownEditor()
      if (path !== previousActive) await prepareDocumentOpen(path, existing.content)
      if (session !== vaultSessionGenerationRef.current || sequence !== openSequenceRef.current) return false
      revealOpenedNote(path, existing.content, swapIntoSplit ? previousActive : null)
      return true
    }
    const requestKey = `${session}:${structureRevision}:${path}`
    if (openingNotesRef.current.has(requestKey)) return false
    openingNotesRef.current.add(requestKey)
    try {
      const tab = await readNoteTab(path)
      if (
        session !== vaultSessionGenerationRef.current ||
        structureRevision !== vaultStructureRevisionRef.current
      ) return false
      const { content } = tab
      if (!isPdfNotePath(path)) await loadMarkdownEditor()
      await prepareDocumentOpen(path, content)
      if (
        session !== vaultSessionGenerationRef.current ||
        structureRevision !== vaultStructureRevisionRef.current ||
        sequence !== openSequenceRef.current
      ) return false
      setTagIndex((current) => ({ ...current, [path]: parseNoteTags(content) }))
      setTabs((current) => current.some((item) => item.path === path) ? current : [...current, tab])
      revealOpenedNote(path, content, swapIntoSplit ? previousActive : null)
      return true
    } catch (error) {
      if (
        session === vaultSessionGenerationRef.current &&
        structureRevision === vaultStructureRevisionRef.current
      ) {
        toast(error instanceof Error ? error.message : 'Notiz konnte nicht geöffnet werden.', 'error')
        // Typing must not continue in the note that is still shown behind the failed click.
        const focused = document.activeElement
        if (focused instanceof HTMLElement && focused.closest('.cm-editor')) focused.blur()
      }
      return false
    } finally {
      openingNotesRef.current.delete(requestKey)
    }
  }, [flushDocumentLayers, prepareDocumentOpen, readNoteTab, revealOpenedNote, toast])
  const openNote = useCallback((path: string) => trackActivity('open', openNoteUntracked(path)), [openNoteUntracked])

  /**
   * Bring back the tabs, pins and split the vault was left with. The active
   * note was already chosen by the startup path; the other tabs load quietly.
   */
  const restoreWorkspace = useCallback(async (vaultPath: string, currentTree: VaultEntry[]) => {
    if (workspaceRestoredRef.current) return
    workspaceRestoredRef.current = true
    const session = vaultSessionGenerationRef.current
    workspaceAppliedRef.current = false
    const memory = loadWorkspaceMemory(vaultPath)
    if (!memory) { workspaceAppliedRef.current = true; return }
    const existing = new Set(collectNotePaths(currentTree))
    const remembered = pruneWorkspaceMemory(memory, (path) => existing.has(path))
    if (!remembered.tabs.length) { workspaceAppliedRef.current = true; return }
    const missing = remembered.tabs.filter((path) => !tabsRef.current.some((tab) => tab.path === path))
    const loaded = await Promise.all(missing.map((path) => readNoteTab(path).catch(() => null)))
    if (session !== vaultSessionGenerationRef.current) return
    const loadedByPath = new Map(loaded.flatMap((tab) => tab ? [[tab.path, tab] as const] : []))
    setTabs((current) => {
      const byPath = new Map(current.map((tab) => [tab.path, tab] as const))
      const ordered: NoteTab[] = []
      for (const path of remembered.tabs) {
        const tab = byPath.get(path) ?? loadedByPath.get(path)
        if (tab) ordered.push({ ...tab, pinned: remembered.pinned.includes(path) })
      }
      for (const tab of current) if (!remembered.tabs.includes(tab.path)) ordered.push(tab)
      return ordered
    })
    for (const tab of loadedByPath.values()) {
      setTagIndex((current) => current[tab.path] ? current : { ...current, [tab.path]: parseNoteTags(tab.content) })
    }
    if (remembered.split && remembered.split !== activePathRef.current) setSplitPath(remembered.split)
    workspaceAppliedRef.current = true
  }, [readNoteTab])

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
        const start = chooseStartSurface(Boolean(data.onboardingRequired))
        if (start.surface === 'onboarding') return
        // Let the shell paint first, then parse the editor chunk in parallel
        // with local tree-cache/NAS work. The shared promise also prevents the
        // later React.lazy render from scheduling a duplicate module request.
        editorWarmupFrame = window.requestAnimationFrame(() => {
          void loadMarkdownEditor()
          // Through the board loader: a board mounted after this renders
          // directly instead of suspending its first frame (InkBoardComponent).
          window.requestIdleCallback(() => { void loadDrawingBoardModule() }, { timeout: 4_000 })
        })
        try {
          const sync = treeSyncRef.current!
          // The workspace memory is written on every tab/split change; lastOpenNotePath
          // goes through an async settings save and can lag behind a swap or a quick reload.
          const preferredStartNote = () => loadWorkspaceMemory(data.vaultPath)?.active ?? launchedSettings.lastOpenNotePath
          const loadFreshTree = async () => {
            const freshTicket = sync.begin()
            let nextTree = await window.fanotes.getTree()
            if (!alive) return
            let nextNote = chooseRestoredNote(
              preferredStartNote(),
              collectNotePaths(nextTree),
              firstNote(nextTree),
            )
            if (!nextNote) {
              // Only a verified live scan may decide that the vault is empty.
              // A stale empty cache must never create a surprise note.
              const created = await window.fanotes.createNote(undefined, translateUiText('Erste Notiz'))
              if (!alive) return
              const createdTicket = sync.begin()
              nextTree = await window.fanotes.getTree()
              sync.accept(createdTicket, nextTree)
              nextNote = created.relativePath
            }
            if (!sync.accept(freshTicket, nextTree)) nextTree = treeRef.current
            if (nextNote && !activePathRef.current) await openNote(nextNote)
            if (alive) await restoreWorkspace(data.vaultPath, nextTree)
          }

          const startupTicket = sync.begin()
          const cachedTree = await window.fanotes.getCachedTree().catch(() => null)
          if (!alive) return
          const startupTree = cachedTree ?? await window.fanotes.getFastTree()
          if (!alive) return
          if (startupTree.length) {
            sync.accept(startupTicket, startupTree)
            const startupNote = chooseRestoredNote(
              preferredStartNote(),
              collectNotePaths(startupTree),
              firstNote(startupTree),
            )
            if (start.openLastNote && startupNote) await openNote(startupNote)
            if (alive) await restoreWorkspace(data.vaultPath, startupTree)

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

  const completeOnboarding = useCallback(async (subjects: string[], profile: NoteProfileId = 'school') => {
    const data = await window.fanotes.completeOnboarding(subjects)
    setBootstrap(data)
    try {
      const language = getUiLanguage()
      const folderName = templatesFolderName(language)
      await window.fanotes.createFolder(undefined, folderName)
      for (const seed of templatesToSeed([], profile)) {
        const template = localizeTemplate(seed, language)
        const created = await window.fanotes.createNote(folderName, template.fileName)
        await window.fanotes.writeFile(created.relativePath, template.markdown)
      }
    } catch {
      /* templates are also available from the command palette */
    }
    setSettings({ ...defaultSettingsForPlatform(window.fanotes.platform), ...data.settings })
    const onboardingSync = treeSyncRef.current!
    let onboardingTicket = onboardingSync.begin()
    let initialTree = await window.fanotes.getTree()
    let initialNote = firstNote(initialTree)
    if (!initialNote) {
      const created = await window.fanotes.createNote(undefined, translateUiText('Erste Notiz'))
      onboardingTicket = onboardingSync.begin()
      initialTree = await window.fanotes.getTree()
      initialNote = created.relativePath
    }
    onboardingSync.accept(onboardingTicket, initialTree)
    if (initialNote) await openNote(initialNote)
    // A fresh vault has no workspace to restore, but from here on it remembers one.
    await restoreWorkspace(data.vaultPath, initialTree)
  }, [openNote, restoreWorkspace])

  /** The same gate pushEditableShare checks first: a live share that owns this note. */
  const editableShareOwns = useCallback((path: string) => {
    const liveEdit = shareEditRef.current
    if (!liveEdit || shareEditApplyingRef.current || !liveEdit.owns(path)) return false
    return Boolean(liveEdit.sharePathFor(path))
  }, [])

  const pushEditableShare = useCallback((path: string, patch: Parameters<ShareEditClient['editNote']>[1]) => {
    const liveEdit = shareEditRef.current
    if (!liveEdit || shareEditApplyingRef.current || !liveEdit.owns(path)) return
    const sharePath = liveEdit.sharePathFor(path)
    if (!sharePath) return
    const sent = patch.content
    void liveEdit.editNote(sharePath, patch).then(() => {
      if (shareEditRef.current !== liveEdit) return
      setSharePeople({ editors: liveEdit.peopleWhoCanEdit(), present: liveEdit.peopleEditing(), self: liveEdit.name })
      if (sent === undefined) return
      const tab = tabsRef.current.find((candidate) => candidate.path === path)
      if (!tab || tab.content !== sent) return
      if (pendingWrites.current.has(path) && pendingWrites.current.get(path) !== sent) return
      const merged = liveEdit.noteContent(sharePath)
      if (tab.content !== merged) {
        if (pendingWrites.current.get(path) === sent) pendingWrites.current.delete(path)
        const updated = tabsRef.current.map((candidate) => (
          candidate.path === path && candidate.content === sent
            ? { ...candidate, content: merged, savedContent: merged }
            : candidate
        ))
        tabsRef.current = updated
        shareEditApplyingRef.current = true
        setTabs((current) => current.map((candidate) => (
          candidate.path === path && candidate.content === sent
            ? { ...candidate, content: merged, savedContent: merged }
            : candidate
        )))
        window.setTimeout(() => { shareEditApplyingRef.current = false }, 0)
      }
      const open = tabsRef.current.find((candidate) => candidate.path === path)
      const buffered = pendingWrites.current.get(path) ?? open?.content
      if (open && buffered === merged) {
        if (pendingWrites.current.get(path) === merged) pendingWrites.current.delete(path)
        liveEdit.absorb(sharePath, { content: merged })
      }
    }).catch(() => undefined)
  }, [])

  const saveContentUntracked = useCallback(async (path: string, content: string, options?: { quiet?: boolean }): Promise<boolean> => {
    const timer = saveTimers.current.get(path)
    if (timer) window.clearTimeout(timer)
    saveTimers.current.delete(path)
    // The file was deleted or edited outside FaNotes and nobody has decided yet: write nothing, keep the text.
    if (tabHoldsRef.current[path]) {
      if (!options?.quiet) toast('Speichern ist pausiert: Diese Notiz wurde ausserhalb von FaNotes verändert. Entscheide zuerst im Hinweis über dem Text.', 'info')
      return false
    }
    // A statistics-only write (no typing happened) must not flash "Speichern…".
    if (!options?.quiet) setSaveState('saving')
    try {
      const now = Date.now()
      flushPageStats(path, now, true)
      const body = stripFamdPayload(content)
      const unreadableStats = pageStatsUnreadableRef.current.has(path)
      const session = unreadableStats ? null : pageStatsRef.current.get(path)
      const savedSession = session ? recordDocumentSaved(session, body, now) : null
      if (savedSession) pageStatsRef.current.set(path, savedSession)
      // No session and a failed companion read: write the markdown only.
      // Embedding a fresh session would replace the statistics still on disk.
      let nextContent = savedSession ? writePageStatsIntoNote(content, snapshotPageStats(savedSession)) : content
      const historyInk = pendingHistoryInkRef.current.get(path)
      if (historyInk) {
        const parsed = parseFamd(nextContent)
        nextContent = serializeFamd(stripFamdPayload(nextContent), {
          ...(parsed.payload ?? emptyFamdPayload()),
          ink: historyInk,
        }, famdEncodingForSave(nextContent))
      }
      const visibleContent = stripFamdPayload(nextContent)
      // The vault watcher reports this write a moment later; it must not look like an outside edit.
      noteOwnWrite(path, visibleContent)
      await window.fanotes.writeFile(isPdfNotePath(path) ? companionNotePath(path, '.famd') : path, nextContent)
      addonRuntime.emit('note:saved', { path, title: fileName(path).replace(/\.(md|markdown|pdf)$/iu, ''), length: visibleContent.length })
      // Document search re-reads changed notes in the background (debounced).
      if (!options?.quiet) void import('./lib/docSearch/service').then(({ docSearch }) => docSearch.notifyChanged())
      // A statistics-only save must not start a sync. The timer still runs;
      // the engine then sees the same note and skips the upload.
      // A statistics tick must not count as the user clearing the note.
      if (!options?.quiet) {
        const parsed = parseFamd(content)
        const prose = stripFamdPayload(content).replace(/<!--\s*fanotes-ink:[a-zA-Z0-9_-]{1,96}\s*-->/gu, '').trim()
        const fieldText = parsed.payload?.textFields?.some((field) => field.text.trim().length > 0) ?? false
        if (!prose && !inkHasMarks(parsed.payload) && !fieldText) {
          syncEngine.markCleared(isPdfNotePath(path) ? companionNotePath(path, '.famd') : path)
        }
        syncEngine.notifyLocalChange()
      }
      if (!options?.quiet) pushEditableShare(path, { content: visibleContent })
      if (!options?.quiet) queueLiveShareRefresh({
        settingsRecent: () => settingsRef.current.shareRecent ?? '',
        loadEntries: () => loadShareEntries(treeRef.current, (notePath) => window.fanotes.readFile(notePath), (notePath) => (
        window.fanotes.readNoteCompanion ? window.fanotes.readNoteCompanion(notePath).catch(() => null) : Promise.resolve(null)
      ), {
        fontSize: settingsRef.current.editorFontSize,
        lineHeight: settingsRef.current.lineHeight,
        contentWidth: settingsRef.current.contentWidth,
        readable: settingsRef.current.readableLineLength,
      }),
      })
      if (savedSession) {
        // Activity during the write builds on the saved session; only the
        // revision that actually reached the disk counts as persisted.
        const latest = pageStatsRef.current.get(path)
        if (latest) pageStatsRef.current.set(path, markPageStatsPersisted(latest, savedSession.revision, savedSession.dwellMs))
      }
      setTagIndex((current) => ({ ...current, [path]: parseNoteTags(visibleContent) }))
      if (pendingWrites.current.get(path) === content || pendingWrites.current.get(path) === nextContent || pendingWrites.current.get(path) === visibleContent) {
        pendingWrites.current.delete(path)
      }
      pendingHistoryInkRef.current.delete(path)
      // The editor keeps the text exactly as typed. The saved body only differs
      // in trailing whitespace (stripFamdPayload trims it), and pushing that
      // trimmed body back replaced the document after every autosave — a new
      // empty line was dropped and the cursor snapped to the last line with text.
      setTabs((current) => current.map((tab) => (
        tab.path === path ? { ...tab, savedContent: tab.content === content ? content : visibleContent } : tab
      )))
      saveFailuresRef.current.delete(path)
      setSaveState(pendingWrites.current.size ? 'saving' : 'saved')
      return true
    } catch (error) {
      setSaveState('error')
      const failures = (saveFailuresRef.current.get(path) ?? 0) + 1
      saveFailuresRef.current.set(path, failures)
      // One toast per outage; the retries stay quiet and the indicator shows the state.
      if (failures === 1) toast(friendlyFileError(error, 'Speichern fehlgeschlagen.'), 'error')
      // The note may have been deleted, renamed or replaced outside FaNotes: reconcile the tab with its file.
      void checkTabPathRef.current?.(path)
      // Keep trying (1 s, 2 s, 4 s ... up to 30 s) until the write goes through.
      // A typed edit replaces this timer with its own autosave.
      if (!options?.quiet) {
        const delay = Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5))
        const timer = window.setTimeout(() => {
          saveTimers.current.delete(path)
          const latest = pendingWrites.current.get(path)
          if (latest === undefined || tabHoldsRef.current[path]) return
          void saveContentRef.current?.(path, latest)
        }, delay)
        saveTimers.current.set(path, timer)
      }
      return false
    }
  }, [flushPageStats, noteOwnWrite, pushEditableShare, tabHoldsRef, toast])
  const saveContent = useCallback((path: string, content: string, options?: { quiet?: boolean }) => trackActivity('save', saveContentUntracked(path, content, options)), [saveContentUntracked])
  saveContentRef.current = (path, content) => saveContent(path, content)

  /** Writes statistics that moved on without any typing, without touching the save indicator. */
  const persistPageStatsQuietly = useCallback((path: string, minDwellDeltaMs: number) => {
    const session = pageStatsRef.current.get(path)
    if (!session || !pageStatsNeedPersist(session, minDwellDeltaMs)) return
    // A pending typed edit already carries the statistics with it.
    if (pendingWrites.current.has(path) || saveTimers.current.has(path)) return
    const tab = tabsRef.current.find((candidate) => candidate.path === path)
    if (!tab) return
    void saveContent(path, tab.content, { quiet: true })
  }, [saveContent])

  useEffect(() => {
    let ticks = 0
    const id = window.setInterval(() => {
      // Hidden window: the visibilitychange handler below already closed the visible span.
      if (typeof document !== 'undefined' && document.hidden) return
      const path = activePathRef.current
      if (!path) return
      flushPageStats(path, Date.now(), true)
      ticks += 1
      if (ticks % PAGE_STATS_PERSIST_TICKS === 0) persistPageStatsQuietly(path, 0)
    }, 1000)
    const onVisibility = () => {
      const path = activePathRef.current
      if (!path) return
      const visible = typeof document === 'undefined' ? true : !document.hidden
      flushPageStats(path, Date.now(), visible)
      if (!visible) persistPageStatsQuietly(path, PAGE_STATS_MIN_DWELL_DELTA_MS)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [flushPageStats, persistPageStatsQuietly])

  // Leaving a note writes its statistics once the text is settled.
  useEffect(() => {
    const previous = previousActivePathRef.current
    previousActivePathRef.current = activePath
    if (previous && previous !== activePath) persistPageStatsQuietly(previous, PAGE_STATS_MIN_DWELL_DELTA_MS)
  }, [activePath, persistPageStatsQuietly])

  const convertAllNotesToCurrentStandard = useCallback(async () => {
    const paths = collectNotePaths(treeRef.current)
    let converted = 0
    let skipped = 0
    let failed = 0
    for (const path of paths) {
      const name = path.split('/').pop() || path
      if (!isNoteFileName(name)) {
        skipped += 1
        continue
      }
      const readPath = isPdfNotePath(path) ? companionNotePath(path, '.famd') : path
      try {
        const open = tabsRef.current.find((tab) => tab.path === path)
        const live = pendingWrites.current.get(path) ?? (open && open.content !== open.savedContent ? open.content : null)
        let markdown = ''
        try {
          markdown = live ?? await window.fanotes.readFile(readPath)
        } catch {
          skipped += 1
          continue
        }
        // Handwriting lives in the companion, and readFile strips that payload.
        // Without it the upgrade always looks like a note that has no ink.
        const embedded = await readNoteInk(path, markdown)
        let source = markdown
        if (embedded?.drawingJson) {
          try {
            const ink = JSON.parse(inkJsonForRewrite(embedded)) as Record<string, unknown>
            source = serializeFamd(markdown, { ...emptyFamdPayload(), ink })
          } catch {
            source = markdown
          }
        }
        const latest = pendingWrites.current.get(path) ?? tabsRef.current.find((tab) => tab.path === path)?.content
        if (live !== null && latest !== markdown) {
          skipped += 1
          continue
        }
        const result = convertNoteSourceToCurrentStandard(source)
        if (!result.converted) {
          skipped += 1
          continue
        }
        if (!result.source || result.source === source) {
          skipped += 1
          continue
        }
        await window.fanotes.writeFile(readPath, result.source)
        converted += 1
        const visibleSource = stripFamdPayload(result.source)
        const timer = saveTimers.current.get(path)
        if (timer) window.clearTimeout(timer)
        saveTimers.current.delete(path)
        if (pendingWrites.current.get(path) === markdown) pendingWrites.current.delete(path)
        setTabs((current) => current.map((tab) => {
          if (tab.path !== path) return tab
          if (tab.content !== markdown && pendingWrites.current.get(path) !== markdown) return { ...tab, savedContent: visibleSource }
          return { ...tab, content: visibleSource, savedContent: visibleSource }
        }))
      } catch {
        failed += 1
      }
    }
    return { converted, skipped, failed }
  }, [])

  const convertAllFamdNotes = useCallback(async () => {
    if (!window.fanotes.convertFamdNotes) return { converted: 0, skipped: 0, failed: 0 }
    return window.fanotes.convertFamdNotes()
  }, [])

  const flushPendingWrites = useCallback(async (options?: { keepHeld?: boolean }): Promise<boolean> => {
    editorRef.current?.flushChanges()
    splitEditorRef.current?.flushChanges()
    saveTimers.current.forEach((timer) => window.clearTimeout(timer))
    saveTimers.current.clear()
    // Paused tabs (their file was deleted or edited outside FaNotes) are not written. Whoever closes the
    // app or the vault gets their unsaved text kept as conflict copies instead, so that neither side is lost.
    if (!options?.keepHeld) {
      for (const path of Object.keys(tabHoldsRef.current)) {
        if (!await parkHeldTabRef.current(path)) return false
      }
    }

    // A new edit can arrive while an earlier IPC write is in flight. Repeat
    // with the latest snapshots instead of silently dropping that newer edit.
    // Open notes whose statistics moved on since their last write go along.
    for (const tab of tabsRef.current) queuePageStatsWrite(tab.path)
    for (let pass = 0; pass < 8; pass += 1) {
      const pending = [...pendingWrites.current.entries()].filter(([path]) => !tabHoldsRef.current[path])
      if (!pending.length) return true
      const results = await Promise.all(pending.map(([path, content]) => saveContent(path, content)))
      if (results.some((saved) => !saved)) return false
    }
    return [...pendingWrites.current.keys()].every((path) => tabHoldsRef.current[path])
  }, [queuePageStatsWrite, saveContent, tabHoldsRef])

  const saveCurrentWork = useCallback(async (announce = false): Promise<boolean> => {
    if (!activePathRef.current) {
      if (announce) toast('Öffne zuerst eine Notiz, die gespeichert werden kann.', 'info')
      return false
    }
    const documentLayersSaved = await flushDocumentLayers()
    const notesSaved = documentLayersSaved && await flushPendingWrites({ keepHeld: true })
    if (notesSaved && tabHoldsRef.current[activePathRef.current ?? '']) {
      toast('Speichern ist pausiert: Diese Notiz wurde ausserhalb von FaNotes verändert. Entscheide zuerst im Hinweis über dem Text.', 'info')
      return false
    }
    if (notesSaved) {
      setSaveState('saved')
      if (announce) toast('Alles sicher gespeichert.', 'success')
      return true
    }
    if (documentLayersSaved) toast('Die Notiz konnte nicht vollständig gespeichert werden.', 'error')
    return false
  }, [flushDocumentLayers, flushPendingWrites, tabHoldsRef, toast])

  const flushPendingEntry = useCallback(async (entryPath: string): Promise<boolean> => {
    const belongsToEntry = (candidate: string) => candidate === entryPath || candidate.startsWith(`${entryPath}/`)
    if (activePathRef.current && belongsToEntry(activePathRef.current)) editorRef.current?.flushChanges()
    if (splitPathRef.current && belongsToEntry(splitPathRef.current)) splitEditorRef.current?.flushChanges()
    ;[...saveTimers.current.entries()].forEach(([path, timer]) => {
      if (!belongsToEntry(path)) return
      window.clearTimeout(timer)
      saveTimers.current.delete(path)
    })
    // Paused tabs inside the entry keep their unsaved text as conflict copies; nothing is written to their files.
    for (const path of Object.keys(tabHoldsRef.current)) {
      if (belongsToEntry(path) && !await parkHeldTabRef.current(path)) return false
    }
    for (let pass = 0; pass < 8; pass += 1) {
      const pending = [...pendingWrites.current.entries()].filter(([path]) => belongsToEntry(path) && !tabHoldsRef.current[path])
      if (!pending.length) return true
      const results = await Promise.all(pending.map(([path, content]) => saveContent(path, content)))
      if (results.some((saved) => !saved)) return false
    }
    return ![...pendingWrites.current.keys()].some((path) => belongsToEntry(path) && !tabHoldsRef.current[path])
  }, [saveContent, tabHoldsRef])

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

  /**
   * Typed text arrives bound to the note it was typed into. Each editor passes
   * its own path, so a change flushed while the panes switch is booked under
   * the note it belongs to and never under whichever note is active by then.
   */
  // Tag index per note: immediate for normal notes, after a typing pause for huge ones (QA-006).
  const tagIndexTimers = useRef(new Map<string, number>())
  const scheduleTagIndex = useCallback((path: string, content: string) => {
    const pending = tagIndexTimers.current.get(path)
    if (pending !== undefined) { window.clearTimeout(pending); tagIndexTimers.current.delete(path) }
    if (content.length < LARGE_NOTE_CHARS) {
      setTagIndex((current) => ({ ...current, [path]: parseNoteTags(content) }))
      return
    }
    tagIndexTimers.current.set(path, window.setTimeout(() => {
      tagIndexTimers.current.delete(path)
      const tags = parseNoteTags(content)
      startTransition(() => setTagIndex((current) => ({ ...current, [path]: tags })))
    }, LARGE_NOTE_SETTLE_MS * 2))
  }, [])
  const updateContentFor = useCallback((rawPath: string, content: string) => {
    if (!rawPath) return
    // An editor that flushes after its note was renamed or moved books the text under the new name.
    let path = rawPath
    const now = Date.now()
    for (let hop = 0; hop < 8; hop += 1) {
      const moved = [...movedPathsRef.current.entries()]
        .find(([from, move]) => now - move.at < MOVED_PATH_ALIAS_MS && (path === from || path.startsWith(`${from}/`)))
      if (!moved) break
      path = `${moved[1].to}${path.slice(moved[0].length)}`
    }
    if (path !== rawPath && !tabsRef.current.some((tab) => tab.path === path)) return
    if ([...mutatingEntryPathsRef.current].some((entry) => path === entry || path.startsWith(`${entry}/`))) return
    const session = pageStatsRef.current.get(path)
    if (session) pageStatsRef.current.set(path, touchPageModified(session, now))
    setTabs((current) => current.map((tab) => tab.path === path ? { ...tab, content } : tab))
    scheduleTagIndex(path, content)
    // First keystroke after a save: the file may have changed outside FaNotes since; check before autosave can win.
    const firstKeystroke = !pendingWrites.current.has(path) && !tabHoldsRef.current[path]
    pendingWrites.current.set(path, content)
    if (firstKeystroke) void checkTabPathRef.current?.(path)
    addonNoteChangedRef.current?.(path, content)
    // A paused tab (its file was deleted or edited outside FaNotes) keeps what is typed but saves nothing.
    if (tabHoldsRef.current[path]) return
    setSaveState('saving')
    const existing = saveTimers.current.get(path)
    if (existing) window.clearTimeout(existing)
    const timer = window.setTimeout(() => { void saveContent(path, content) }, settings.autosaveDelay)
    saveTimers.current.set(path, timer)
  }, [saveContent, settings.autosaveDelay, tabHoldsRef])

  const updateContent = useCallback((content: string) => {
    if (activePath) updateContentFor(activePath, content)
  }, [activePath, updateContentFor])

  /**
   * The note's text with everything typed so far. The editor hands its changes over in coalesced batches, so a marker
   * added to the stale text would overwrite the last words (or be overwritten by them): flush first.
   */
  const noteContentFlushed = useCallback((path: string) => {
    if (path === activePathRef.current) editorRef.current?.flushChanges()
    return pendingWrites.current.get(path) ?? tabsRef.current.find((tab) => tab.path === path)?.content ?? ''
  }, [])

  // The eraser in pen mode also takes PDF text highlights off, undoable with the ink.
  const updateContentForRef = useRef(updateContentFor)
  updateContentForRef.current = updateContentFor
  const latestNoteContent = useCallback((path: string) => (
    pendingWrites.current.get(path) ?? tabsRef.current.find((tab) => tab.path === path)?.content ?? null
  ), [])
  const pdfMarkEraseHost = useMemo(() => createPdfMarkEraseHost({
    notePath: () => activePathRef.current || null,
    pages: () => document.querySelector('.unified-note-view.is-main-pane .unified-paper.is-pdf-note')
      ?? document.querySelector('.unified-paper.is-pdf-note'),
    read: latestNoteContent,
    write: (path, content) => updateContentForRef.current(path, content),
  }), [latestNoteContent])

  const closeTab = useCallback(async (path: string) => {
    const session = pageStatsRef.current.get(path)
    let statsNeedWrite = false
    if (session) {
      const closed = closePageStats(session, Date.now())
      const idle: PageStatsSession = {
        ...idlePageStatsSession(closed),
        revision: session.revision,
        persistedRevision: session.persistedRevision,
        persistedDwellMs: session.persistedDwellMs,
      }
      pageStatsRef.current.set(path, idle)
      // The stay on the page is written with the note even when nothing was typed.
      statsNeedWrite = pageStatsNeedPersist(idle, PAGE_STATS_MIN_DWELL_DELTA_MS)
    }
    if (activePathRef.current === path) editorRef.current?.flushChanges()
    if (splitPathRef.current === path) splitEditorRef.current?.flushChanges()
    if (activePathRef.current === path && !await flushDocumentLayers()) return
    // A paused tab is not written. Its unsaved text is kept as a conflict copy before the tab goes.
    const held = Boolean(tabHoldsRef.current[path])
    if (held && !await parkHeldTabRef.current(path)) return
    const currentTabs = tabsRef.current
    const closing = currentTabs.find((tab) => tab.path === path)
    const latestContent = pendingWrites.current.get(path) ?? closing?.content
    if (!held && closing && latestContent !== undefined && (latestContent !== closing.savedContent || statsNeedWrite)) {
      // pendingWrites is updated synchronously by CodeMirror and can be newer
      // than tabsRef until React's passive effect runs. Never overwrite it
      // with the stale tab snapshot during a rapid type-and-close gesture.
      pendingWrites.current.set(closing.path, latestContent)
      const saved = await saveContent(closing.path, latestContent)
      // Keep the tab open after an I/O failure or if the user produced a newer
      // edit while this save was in flight.
      if (!saved || pendingWrites.current.has(closing.path)) return
    }
    if (activePathRef.current === path) {
      // The neighbour that takes over opens like any other document: prepared first.
      const index = tabsRef.current.findIndex((tab) => tab.path === path)
      const remaining = tabsRef.current.filter((tab) => tab.path !== path)
      const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]
      if (next) await prepareDocumentOpen(next.path, next.content)
    }
    closedTabsRef.current = rememberClosedTab(closedTabsRef.current, path)
    setTabs((current) => current.filter((tab) => tab.path !== path))
    setSplitPath((current) => current === path ? null : current)
    setActivePath((currentActive) => {
      if (currentActive !== path) return currentActive
      const latestTabs = tabsRef.current
      const latestIndex = latestTabs.findIndex((tab) => tab.path === path)
      const remaining = latestTabs.filter((tab) => tab.path !== path)
      return remaining[Math.min(Math.max(latestIndex, 0), remaining.length - 1)]?.path ?? null
    })
  }, [flushDocumentLayers, prepareDocumentOpen, saveContent, tabHoldsRef])

  /** True while this device holds unsaved work for a path – the sync engine then leaves that file alone until the next cycle. */
  const isSyncPathBusy = useCallback((path: string) => {
    // The open story's files: the writing mode holds them in memory and saves from there.
    // Its other files wait until it is closed (the sync then merges them paragraph by paragraph).
    // Its scenes and manifest may be written while nothing is unsaved there; the editor then merges them live.
    if (writingPathRef.current && path.startsWith(`${writingPathRef.current}/`)) return storySyncBusy(writingPathRef.current, path)
    const companionOwner = path.endsWith('.famd') ? tabsRef.current.find((tab) => companionNotePath(tab.path, '.famd') === path)?.path : undefined
    const notePath = companionOwner ?? path
    if (pendingWrites.current.has(notePath) || saveTimers.current.has(notePath)) return true
    // Paused until the user decides what happens to the outside change: the sync must not decide it either.
    if (tabHoldsRef.current[notePath]) return true
    const tab = tabsRef.current.find((candidate) => candidate.path === notePath)
    if (tab && tab.content !== tab.savedContent) return true
    // Ink and worksheet layers live in the .famd companion; while they are open here, the other device's copy waits.
    if (path.endsWith('.famd') && activePathRef.current === notePath && (drawingOpenRef.current || drawingDirtyRef.current)) return true
    return false
  }, [tabHoldsRef])

  /**
   * A file changed under an open tab (another device through the sync, another
   * program through the vault watcher): take its text for a tab that holds
   * nothing unsaved. `content` is the text when the caller already read it. A
   * changed `.famd` also reloads the statistics and the handwriting. A tab with
   * unsaved text is left alone: false.
   */
  const reloadCleanTab = useCallback(async (path: string, famdTouched: boolean, content?: string): Promise<boolean> => {
    const tab = tabsRef.current.find((candidate) => candidate.path === path)
    if (!tab || tab.content !== tab.savedContent || pendingWrites.current.has(path)) return false
    try {
      const fresh = content === undefined ? await readNoteTab(path) : { content }
      const open = tabsRef.current.find((candidate) => candidate.path === path)
      if (!open || open.content !== open.savedContent || pendingWrites.current.has(path)) return false
      setTabs((current) => current.map((candidate) => candidate.path === path && candidate.content === candidate.savedContent ? { ...candidate, content: fresh.content, savedContent: fresh.content } : candidate))
      setTagIndex((current) => ({ ...current, [path]: parseNoteTags(fresh.content) }))
      // The file is there again with its own text: whatever paused this tab is over.
      setTabHold(path, null)
      if (!famdTouched || (activePathRef.current === path && drawingDirtyRef.current)) return true
      // The open session was loaded from the previous companion. Keeping it
      // would write those statistics and that ink back over the other device.
      pageStatsRef.current.delete(path)
      pageStatsUnreadableRef.current.delete(path)
      await preparePageStats(path)
      if (activePathRef.current === path && !pageStatsUnreadableRef.current.has(path)) {
        activatePageStats(path, fresh.content)
      }
      if (activePathRef.current !== path || drawingDirtyRef.current) return true
      const requestId = ++drawingLoadRequestRef.current
      const document = await readNoteInk(path, fresh.content)
      if (requestId !== drawingLoadRequestRef.current || activePathRef.current !== path || drawingDirtyRef.current) return true
      setDrawingSession({
        ...overlaySessionAfterInkReady(drawingOpenRef.current, drawingSessionFromLoad(requestId, document)),
        path,
      })
      return true
    } catch {
      // The note vanished between the change list and the read; the next tree refresh reflects that.
      return false
    }
  }, [activatePageStats, preparePageStats, readNoteTab, setTabHold])

  /** Files another device changed: refresh the tree, reload clean open tabs, drop tabs of deleted notes. */
  const applyRemoteChanges = useCallback(async ({ written, removed }: { written: string[]; removed: string[] }) => {
    if (writingPathRef.current) notifyStoryWritten(writingPathRef.current, written)
    const writtenAt = Date.now()
    for (const entryPath of written) syncWrittenRef.current.set(entryPath, writtenAt)
    await refreshTree()
    const stories = new Set([...written, ...removed].flatMap((path) => /^(.+?\.story)\//iu.exec(path)?.[1] ?? []))
    if (stories.size) void import('./lib/docSearch/service').then(({ docSearch }) => { for (const story of stories) docSearch.notifyStoryChanged(story) })
    for (const path of removed) {
      if (!tabsRef.current.some((tab) => tab.path === path)) continue
      setTabs((current) => current.filter((tab) => tab.path !== path))
      setSplitPath((current) => current === path ? null : current)
      setActivePath((currentActive) => {
        if (currentActive !== path) return currentActive
        const remaining = tabsRef.current.filter((tab) => tab.path !== path)
        return remaining[0]?.path ?? null
      })
    }
    const touched = new Set<string>()
    if (written.includes(RECOGNITION_MODEL_SYNC_PATH) && settingsRef.current.syncHandwritingModel && window.fanotes.readRecognitionModel) {
      const raw = await window.fanotes.readRecognitionModel().catch(() => null)
      const bundle = raw ? parseRecognitionBundle(raw) : null
      if (bundle) {
        await putHandwritingSamples(bundle.samples as Awaited<ReturnType<typeof getHandwritingSamples>>).catch(() => undefined)
        await putMathLayoutExamples(bundle.layouts as Awaited<ReturnType<typeof getMathLayoutExamples>>).catch(() => undefined)
        await putHandwritingLabels(bundle.labels as Awaited<ReturnType<typeof getImportedLabels>>).catch(() => undefined)
      }
    }
    for (const path of written) {
      for (const tab of tabsRef.current) {
        if (tab.path === path || companionNotePath(tab.path, '.famd') === path) touched.add(tab.path)
      }
    }
    for (const path of touched) {
      const famdPath = companionNotePath(path, '.famd')
      await reloadCleanTab(path, written.includes(famdPath) || (isPdfNotePath(path) && written.includes(path)))
    }
  }, [reloadCleanTab, refreshTree])

  const syncDepsRef = useRef({ isSyncPathBusy, applyRemoteChanges, toast })
  syncDepsRef.current = { isSyncPathBusy, applyRemoteChanges, toast }

  useEffect(() => {
    if (!syncApi) return
    syncEngine.attach(syncApi, {
      platform: window.fanotes.platform,
      deviceName: () => settingsRef.current.syncDeviceName,
      automatic: () => settingsRef.current.syncAutomatic,
      vaultSync: () => settingsRef.current.syncVaultEnabled !== false,
      setVaultSync: (enabled) => { applySettingsRef.current({ ...settingsRef.current, syncVaultEnabled: enabled }) },
      excludedPrefixes: () => syncPrefixesFromSetting(settingsRef.current.syncExcludedFolders),
      includeRecognitionModel: () => settingsRef.current.syncHandwritingModel === true,
      includeHistory: () => settingsRef.current.syncNoteHistory === true,
      includeAttachments: () => settingsRef.current.syncAttachments !== false,
      isPathBusy: (path) => syncDepsRef.current.isSyncPathBusy(path),
      onApplied: (change) => { void syncDepsRef.current.applyRemoteChanges(change) },
      onConflict: (conflict) => syncDepsRef.current.toast(`Sync-Konflikt bei „${fileName(conflict.path)}“ – beide Fassungen sind gesichert. Vergleichen unter Einstellungen → Konflikte.`, 'info'),
      onSignedOut: (reason) => syncDepsRef.current.toast(reason, 'error'),
    })
    if (window.fanotes.platform !== 'web' && window.fanotes.platform !== 'browser-preview') {
      // Shares between users (desktop): the push channel opens once the sync engine has an account.
      userShares.attach(syncApi, {
        isPathBusy: (path) => syncDepsRef.current.isSyncPathBusy(path),
        onApplied: (change) => { void syncDepsRef.current.applyRemoteChanges(change) },
        onIncoming: (share) => {
          const text = share.status === 'accepted'
            ? uiText(`${share.peer} hat „${share.name}“ mit dir geteilt. Es liegt unter „${SHARED_INBOX_FOLDER}“.`, `${share.peer} shared “${share.name}” with you. It is under “${SHARED_INBOX_FOLDER}”.`)
            : uiText(`${share.peer} möchte „${share.name}“ mit dir teilen. Nimm es in der Seitenleiste unter „${SHARED_INBOX_FOLDER}“ an.`, `${share.peer} wants to share “${share.name}” with you. Accept it in the sidebar under “${SHARED_INBOX_FOLDER}”.`)
          syncDepsRef.current.toast(text, 'info')
          try {
            if (typeof Notification !== 'undefined' && !document.hasFocus()) {
              const show = () => { new Notification('FaNotes', { body: text }) }
              if (Notification.permission === 'granted') show()
              else if (Notification.permission !== 'denied') void Notification.requestPermission().then((permission) => { if (permission === 'granted') show() })
            }
          } catch { /* notifications are optional */ }
        },
        onGone: (share, why) => syncDepsRef.current.toast(why === 'revoked' ? `${share.peer} hat die Freigabe „${share.name}“ beendet. Die Kopie wurde entfernt.` : `Die Freigabe „${share.name}“ von ${share.peer} ist beendet.`, 'info'),
      })
      userShares.start()
    }
    // Sync never delays startup: the first cycle runs once the notes are on screen.
    let cancelled = false
    const timer = window.setTimeout(() => { if (!cancelled) void syncEngine.start() }, 2500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      syncEngine.dispose()
    }
  }, [syncApi])

  useEffect(() => {
    if (!settings.syncHandwritingModel || !window.fanotes.writeRecognitionModel) return
    let cancelled = false
    const publish = async () => {
      const [samples, layouts, labels, previousRaw] = await Promise.all([
        getHandwritingSamples(),
        getMathLayoutExamples(),
        getImportedLabels(),
        window.fanotes.readRecognitionModel?.() ?? Promise.resolve(null),
      ])
      if (cancelled) return
      const previous = typeof previousRaw === 'string' ? parseRecognitionBundle(previousRaw) : null
      const bundle = {
        ...(previous ?? emptyRecognitionBundle()),
        samples,
        layouts,
        labels,
        exportedAt: new Date().toISOString(),
      }
      await window.fanotes.writeRecognitionModel?.(serializeRecognitionBundle(bundle))
      syncEngine.notifyLocalChange()
    }
    void publish().catch(() => undefined)
    return () => { cancelled = true }
  }, [settings.syncHandwritingModel])

  const cycleTabs = useCallback((direction: 1 | -1) => {
    const currentTabs = tabsRef.current
    if (currentTabs.length < 2) return
    const currentIndex = Math.max(0, currentTabs.findIndex((tab) => tab.path === activePathRef.current))
    const nextIndex = (currentIndex + direction + currentTabs.length) % currentTabs.length
    void openNote(currentTabs[nextIndex].path)
  }, [openNote])

  /** Ctrl+1 … Ctrl+9 */
  const openTabByDigit = useCallback((digit: number) => {
    const index = tabIndexForDigit(digit, tabsRef.current.length)
    if (index === null) return
    void openNote(tabsRef.current[index].path)
  }, [openNote])

  /** Ctrl+Shift+T: the most recently closed tab that still exists. */
  const reopenClosedTab = useCallback(async () => {
    const existing = new Set(collectNotePaths(treeRef.current))
    while (closedTabsRef.current.length) {
      const [path, ...rest] = closedTabsRef.current
      closedTabsRef.current = rest
      if (existing.has(path) && !tabsRef.current.some((tab) => tab.path === path)) {
        await openNote(path)
        return
      }
    }
    toast('Kein kürzlich geschlossener Tab.', 'info')
  }, [openNote, toast])

  const closeTabsOf = useCallback(async (anchor: string, scope: 'others' | 'right') => {
    for (const path of tabsToClose(tabsRef.current, anchor, scope)) await closeTab(path)
  }, [closeTab])

  const togglePinTab = useCallback((path: string) => {
    setTabs((current) => togglePinnedTab(current, path))
  }, [])

  const moveTab = useCallback((fromPath: string, toPath: string | null, side: 'before' | 'after') => {
    setTabs((current) => {
      if (toPath === null) return reorderTabs(current, fromPath, null)
      if (side === 'before') return reorderTabs(current, fromPath, toPath)
      const toIndex = current.findIndex((tab) => tab.path === toPath)
      const after = current[toIndex + 1]
      return reorderTabs(current, fromPath, after && after.path !== fromPath ? after.path : after ? toPath : null)
    })
  }, [])

  const navigateHistory = useCallback(async (direction: -1 | 1) => {
    const exists = (path: string) => tabsRef.current.some((tab) => tab.path === path) || collectNotePaths(treeRef.current).includes(path)
    const before = noteHistoryRef.current
    const step = stepNoteHistory(before, direction, exists)
    if (!step.path || step.path === activePathRef.current) return
    // Point the history at the target first: the visit effect then sees the
    // active note already at the cursor and records nothing new.
    noteHistoryRef.current = step.history
    setNoteHistory(step.history)
    if (!await openNote(step.path)) {
      noteHistoryRef.current = before
      setNoteHistory(before)
    }
  }, [openNote])

  const swapSplitPanes = useCallback(async () => {
    const split = splitPathRef.current
    const active = activePathRef.current
    if (!split || !active || split === active) return
    // openNote swaps the panes itself when the split note is activated.
    await openNote(split)
  }, [openNote])

  const toggleSplitOrientation = useCallback(() => {
    setSplitLayout((current) => ({ ...current, orientation: current.orientation === 'columns' ? 'rows' : 'columns' }))
  }, [])

  const createStory = useCallback(async (parent?: string) => {
    const { storyHost, createProject } = await import('./writing/storage')
    const { writerId } = await import('./writing/model/ids')
    const host = storyHost()
    if (!host) {
      toast('Geschichten gibt es in dieser Version nicht.', 'error')
      return
    }
    try {
      const english = getUiLanguage() === 'en'
      const path = await createProject(host, parent ?? '', { title: english ? 'New story' : 'Neue Geschichte', language: english ? 'en-US' : 'de', size: 'A5', deviceId: writerId() })
      await refreshTree()
      syncEngine.notifyLocalChange()
      setWritingPath(path)
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Die Geschichte konnte nicht angelegt werden.', 'error')
    }
  }, [refreshTree, toast])

  /** Folder an imported story goes into; undefined while the import dialog is closed. */
  const [storyImportParent, setStoryImportParent] = useState<string | undefined>(undefined)
  const importStoryFile = useCallback(async (story: import('./writing/import/build').ImportedStory) => {
    const { storyHost, saveImportedProject } = await import('./writing/storage')
    const host = storyHost()
    if (!host) throw new Error('Geschichten gibt es in dieser Version nicht.')
    const path = await saveImportedProject(host, storyImportParent ?? '', story)
    setStoryImportParent(undefined)
    await refreshTree()
    syncEngine.notifyLocalChange()
    setWritingPath(path)
  }, [refreshTree, storyImportParent])

  const createNote = useCallback(async (parent?: string, startRename = false) => {
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
      if (startRename) setRenameRequest({ path: result.relativePath, token: Date.now() })
      toast('Neue Markdown-Notiz erstellt.', 'success')
    } catch (error) {
      toast(
        `Die Notiz wurde erstellt, konnte aber nicht geöffnet werden: ${error instanceof Error ? error.message : 'Unbekannter Fehler'}`,
        'error',
      )
    }
  }, [openNote, refreshTree, settings.defaultFolder, toast, tree])

  const copyPlainText = useCallback(async (value: string, success: string) => {
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(value)
        toast(success, 'success')
        return
      }
    } catch {
      // Some browsers reject the async clipboard API even after a click.
    }
    try {
      const area = document.createElement('textarea')
      area.value = value
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.append(area)
      area.select()
      const copied = document.execCommand('copy')
      area.remove()
      if (!copied) throw new Error('copy failed')
      toast(success, 'success')
    } catch {
      toast('Kopieren wurde vom Browser blockiert.', 'error')
    }
  }, [toast])

  const copyWikiLink = useCallback((path: string) => {
    void copyPlainText(wikiLinkForNote(path), 'Wiki-Link kopiert.')
  }, [copyPlainText, toast])

  const insertStamp = useCallback((withTime: boolean) => {
    const path = commandNotePath()
    const tab = path ? tabsRef.current.find((item) => item.path === path) : null
    if (!path || !tab || tab.kind === 'pdf' || isPdfNotePath(path)) {
      toast('Öffne eine Markdown-Notiz, um das Datum einzufügen.', 'info')
      return
    }
    if (drawingOpenRef.current && focusedPaneRef.current === commandPane()) {
      toast('Wechsle zur Tastatur, um das Datum in den Text zu setzen.', 'info')
      return
    }
    const editor = commandEditor()
    const stamp = formatNoteStamp(settingsRef.current.dateFormat || 'YYYY-MM-DD', new Date(), withTime)
    const text = editor?.getText()
    const selection = editor?.getSelection()
    const before = text && selection ? text.slice(0, selection.from) : ''
    const inserted = editor?.insertText(stampToInsert(before, stamp), 'cursor') ?? false
    if (!inserted) toast('Das Datum konnte nicht eingefügt werden.', 'error')
  }, [toast])

  const toggleTask = useCallback(() => {
    const path = commandNotePath()
    if (!path || isPdfNotePath(path)) {
      toast('Öffne eine Markdown-Notiz, um die Aufgabe umzuschalten.', 'info')
      return
    }
    if (drawingOpenRef.current && focusedPaneRef.current === commandPane()) {
      toast('Wechsle zur Tastatur, um Text einzufügen.', 'info')
      return
    }
    if (!commandEditor()?.toggleTasks()) toast('Wechsle zur Tastatur, um Text einzufügen.', 'info')
  }, [toast])

  /**
   * A second note with the same text. Handwriting gets its own drawing, and
   * each worksheet is copied so answers on the original stay put.
   */
  const duplicateNote = useCallback(async (path: string) => {
    if (!path || isPdfNotePath(path)) {
      toast('Eine PDF-Notiz bleibt die Datei selbst.', 'info')
      return
    }
    if (activePathRef.current === path || splitPathRef.current === path) {
      if (activePathRef.current === path) editorRef.current?.flushChanges()
      if (splitPathRef.current === path) splitEditorRef.current?.flushChanges()
      if (activePathRef.current === path && !await flushDocumentLayers()) return
    }
    const openTab = tabsRef.current.find((item) => item.path === path)
    const pending = pendingWrites.current.get(path)
    const dirty = pending ?? (openTab && openTab.content !== openTab.savedContent ? openTab.content : null)
    if (dirty !== null && !await saveContent(path, dirty)) return

    const session = vaultSessionGenerationRef.current
    let createdPath: string | null = null
    const clonedWorksheetIds: string[] = []
    try {
      const sourceTab = tabsRef.current.find((item) => item.path === path)
      const sourceMarkdown = stripFamdPayload(sourceTab?.content ?? await window.fanotes.readFile(path))
      const ink = await readNoteInk(path, sourceMarkdown)
      const links = window.fanotes.readNoteLinks ? await window.fanotes.readNoteLinks(path) : []
      const paper = window.fanotes.readNotePaperStyle ? await window.fanotes.readNotePaperStyle(path) : null
      const parent = parentPath(path)
      const stem = duplicatePreferredStem(fileName(path), translateUiText('Kopie'))
      vaultStructureRevisionRef.current += 1
      let created: CreateResult
      try {
        created = await window.fanotes.createNote(parent || undefined, stem)
      } catch {
        created = await window.fanotes.createNote(undefined, stem)
      }
      if (session !== vaultSessionGenerationRef.current) return
      createdPath = created.relativePath

      let markdown = withoutInkMarker(sourceMarkdown)
      let worksheetSkipped = false
      const idMap = new Map<string, string>()
      const importFromData = window.fanotes.importWorksheetFromData
      for (const worksheetId of worksheetIdsIn(sourceMarkdown)) {
        if (!importFromData) {
          markdown = withoutWorksheetMarker(markdown, worksheetId)
          worksheetSkipped = true
          continue
        }
        try {
          const original = await window.fanotes.readWorksheet(worksheetId)
          const extension = original.sourceRelativePath.split('.').pop()?.toLocaleLowerCase('en-US') || 'png'
          const bytes = await window.fanotes.readAssetBytes(original.sourceRelativePath)
          const createdWorksheet = await importFromData({
            name: `Kopie.${extension === 'jpeg' ? 'jpg' : extension}`,
            mimeType: original.mimeType,
            bytes,
          })
          const saved = await window.fanotes.saveWorksheet(clonedWorksheetDocument(createdWorksheet, original))
          clonedWorksheetIds.push(saved.id)
          idMap.set(worksheetId, saved.id)
        } catch {
          markdown = withoutWorksheetMarker(markdown, worksheetId)
          worksheetSkipped = true
        }
      }
      markdown = retargetWorksheetMarkers(markdown, idMap)

      let inkCopied = false
      if (ink?.drawingJson) {
        try {
          const drawingJson = inkJsonForRewrite(ink)
          const asset = await window.fanotes.saveDrawing({
            title: drawingTitleFromJson(drawingJson, ink.title || stem),
            drawingJson,
            noteRelativePath: created.relativePath,
          })
          markdown = withInkMarker(markdown, asset.id)
          inkCopied = true
        } catch {
          inkCopied = false
        }
      }
      await window.fanotes.writeFile(created.relativePath, markdown)
      if (links.length && window.fanotes.writeNoteLinks) {
        await window.fanotes.writeNoteLinks(created.relativePath, links.map((link) => ({
          ...link,
          id: newNoteLinkId(),
          sourcePath: created.relativePath,
        }))).catch(() => undefined)
      }
      let textFields: NoteTextField[] = []
      if (path === activePathRef.current) {
        await flushNoteTextFieldsRef.current()
        textFields = noteTextFieldsRef.current
      } else if (window.fanotes.readNoteCompanion) {
        const companion = await window.fanotes.readNoteCompanion(path).catch(() => null)
        textFields = parseNoteTextFields(companion?.textFields)
      }
      if (textFields.length && window.fanotes.writeNoteTextFields) {
        await window.fanotes.writeNoteTextFields(created.relativePath, textFields.map((field) => ({
          ...field,
          id: newNoteTextFieldId(),
        }))).catch(() => undefined)
      }
      if (paper && window.fanotes.setNotePaperStyle) {
        await window.fanotes.setNotePaperStyle(created.relativePath, paper).catch(() => undefined)
      }
      if (session !== vaultSessionGenerationRef.current) return
      vaultStructureRevisionRef.current += 1
      try {
        await refreshTree()
      } catch (error) {
        console.warn('FaNotes-Dateibaum konnte nach dem Duplizieren nicht aktualisiert werden:', error)
      }
      if (session !== vaultSessionGenerationRef.current) return
      createdPath = null
      const opened = await openNote(created.relativePath)
      if (!opened) {
        toast('Die Notiz wurde dupliziert, konnte aber nicht geöffnet werden.', 'info')
        return
      }
      if (worksheetSkipped || (ink?.drawingJson && !inkCopied)) toast('Notiz dupliziert. Handschrift oder ein Arbeitsblatt ließ sich nicht mitkopieren.', 'info')
      else toast('Notiz dupliziert.', 'success')
    } catch (error) {
      for (const worksheetId of clonedWorksheetIds) {
        await window.fanotes.deleteWorksheet(worksheetId).catch(() => undefined)
      }
      if (createdPath) {
        await window.fanotes.trashEntry(createdPath).catch(() => undefined)
        syncEngine.markDeleted(createdPath)
      }
      if (session === vaultSessionGenerationRef.current) {
        toast(error instanceof Error ? error.message : 'Notiz konnte nicht dupliziert werden.', 'error')
      }
    }
  }, [flushDocumentLayers, openNote, refreshTree, saveContent, toast])

  /**
   * Fold the boxes now on disk (`stored`) into the open note, box by box.
   * `known` is the disk state this window compared against: what it sent
   * for a write, or the state it saw last for a plain re-read. Boxes another
   * window, device or share editor added or changed come in. What this window
   * changed since `known` stays, and so does a box that was rejected because
   * it lost against a newer edit or a later delete only if it changed again.
   */
  const absorbStoredTextFields = useCallback((path: string, known: readonly NoteTextField[], stored: readonly NoteTextField[], session: number) => {
    if (session !== textFieldSessionRef.current) {
      // The note was closed and opened again meanwhile. The new copy may have read the disk before this
      // write landed, so read once more when the queue gets to it.
      if (textFieldSavePathRef.current === path) refreshNoteTextFieldsRef.current()
      return
    }
    textFieldBasesRef.current.set(path, [...stored])
    if (textFieldSavePathRef.current !== path) return
    const live = noteTextFieldsRef.current
    const merged = parseNoteTextFields(mergeNoteTextFields(known, live, stored))
    if (noteTextFieldsEqual(merged, live)) return
    noteTextFieldsRef.current = merged
    setNoteTextFields(merged)
  }, [])

  /**
   * Writes the open note's boxes. The caller waits until this write and every
   * earlier one has finished, so `true` means the boxes are on disk.
   * Only what changed since the last read or write is sent, and the main
   * process merges it into the boxes stored right now. Another window's boxes
   * therefore survive, and they come back in the result.
   */
  /** `closing`: the page is going away, so the save must not wait behind a queued re-read. */
  const flushNoteTextFields = useCallback((closing = false): Promise<boolean> => {
    if (textFieldTimerRef.current !== null) {
      window.clearTimeout(textFieldTimerRef.current)
      textFieldTimerRef.current = null
    }
    const path = textFieldSavePathRef.current
    if (!path || !textFieldDirtyRef.current) {
      return textFieldQueueRef.current.writes() > 0 ? textFieldQueueRef.current.drained() : Promise.resolve(true)
    }
    const api = window.fanotes
    if (typeof api.mergeNoteTextFields !== 'function' && typeof api.writeNoteTextFields !== 'function') {
      textFieldDirtyRef.current = false
      return Promise.resolve(true)
    }
    // Captured now: the open note and its boxes are swapped as soon as another note opens.
    const fields = noteTextFieldsRef.current
    const session = textFieldSessionRef.current
    textFieldDirtyRef.current = false
    const job = async () => {
      try {
        const base = textFieldBasesRef.current.get(path) ?? []
        const persist = persistableNoteTextFields(fields, base)
        let stored: NoteTextField[]
        if (typeof api.mergeNoteTextFields === 'function') {
          const ops = diffNoteTextFields(base, persist, Date.now())
          if (!ops.upserts.length && !ops.deletes.length) return true
          const result = await api.mergeNoteTextFields(path, ops)
          stored = Array.isArray(result) ? parseNoteTextFields(result) : persist
        } else {
          stored = parseNoteTextFields(await api.writeNoteTextFields!(path, persist))
        }
        absorbStoredTextFields(path, persist, stored, session)
        // This window's boxes are on disk now, including anything a closed tab had rescued.
        clearNoteTextFieldRescue(path)
        pushEditableShare(path, { textFields: publicShareTextFields(stored) })
        return true
      } catch (error) {
        if (textFieldSavePathRef.current === path && textFieldSessionRef.current === session) textFieldDirtyRef.current = true
        toast(error instanceof Error ? error.message : 'Das Textfeld konnte nicht gespeichert werden.', 'error')
        return false
      }
    }
    // Only re-reads may be queued ahead of a closing save; a running save keeps its order.
    return closing && textFieldQueueRef.current.writes() === 0 ? job() : textFieldQueueRef.current.run(job)
  }, [absorbStoredTextFields, pushEditableShare, toast])
  flushNoteTextFieldsRef.current = flushNoteTextFields

  /** Reads the boxes on disk again, so another window's or device's boxes show up without a local edit. */
  const refreshNoteTextFields = useCallback(() => {
    const path = textFieldSavePathRef.current
    const api = window.fanotes
    if (!path || path !== activePathRef.current || typeof api.mergeNoteTextFields !== 'function') return
    const session = textFieldSessionRef.current
    void textFieldQueueRef.current.run(async () => {
      try {
        if (session !== textFieldSessionRef.current) return true
        const result = await api.mergeNoteTextFields!(path, { upserts: [], deletes: [] })
        const known = textFieldBasesRef.current.get(path)
        // No companion yet, or the note was not read yet: there is nothing to compare with.
        if (!Array.isArray(result) || !known) return true
        absorbStoredTextFields(path, known, parseNoteTextFields(result), session)
      } catch {
        // A failed re-read changes nothing; the next focus tries again.
      }
      return true
    }, false)
  }, [absorbStoredTextFields])
  refreshNoteTextFieldsRef.current = refreshNoteTextFields

  useEffect(() => {
    const onWake = () => { if (!document.hidden) refreshNoteTextFields() }
    window.addEventListener('focus', onWake)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [refreshNoteTextFields])

  const queueNoteTextFields = useCallback((path: string) => {
    textFieldSavePathRef.current = path
    textFieldDirtyRef.current = true
    const now = Date.now()
    if (textFieldTimerRef.current !== null) window.clearTimeout(textFieldTimerRef.current)
    else textFieldDirtySinceRef.current = now
    // Typing keeps pushing the save back, but never past 5 s after the first unsaved edit.
    const wait = Math.max(0, Math.min(650, 5000 - (now - textFieldDirtySinceRef.current)))
    textFieldTimerRef.current = window.setTimeout(() => {
      textFieldTimerRef.current = null
      void flushNoteTextFieldsRef.current()
    }, wait)
  }, [])

  const rememberNoteTextFields = useCallback((path: string, fields: readonly NoteTextField[], commit: boolean) => {
    const next = parseNoteTextFields(fields)
    noteTextFieldsRef.current = next
    setNoteTextFields(next)
    if (commit) {
      textFieldDirtyRef.current = true
      textFieldSavePathRef.current = path
      void flushNoteTextFields()
      return
    }
    queueNoteTextFields(path)
  }, [flushNoteTextFields, queueNoteTextFields])

  const persistNoteLinks = useCallback(async (path: string, links: readonly NoteLinkRecord[]) => {
    const next = [...links]
    noteLinksRef.current = next
    setNoteLinks(next)
    if (!window.fanotes.writeNoteLinks) return
    await window.fanotes.writeNoteLinks(path, next)
  }, [])

  const remapPlacedNoteLinks = useCallback((links: readonly NoteLinkRecord[]) => {
    if (isPdfActive) return
    const path = activeTab?.path
    if (!path || links === noteLinksRef.current) return
    void persistNoteLinks(path, links)
  }, [activeTab?.path, isPdfActive, persistNoteLinks])

  const remapPlacedTextFields = useCallback((fields: readonly NoteTextField[]) => {
    if (isPdfActive) return
    const path = activeTab?.path
    if (!path || fields === noteTextFieldsRef.current) return
    rememberNoteTextFields(path, fields, true)
  }, [activeTab?.path, isPdfActive, rememberNoteTextFields])

  const persistNoteBackups = useCallback(async (path: string, backups: NoteBackupSnapshot[]) => {
    const next = listNoteBackups(backups, path)
    noteBackupsRef.current = next
    setNoteBackups(next)
    if (!window.fanotes.writeNoteBackups) return
    await window.fanotes.writeNoteBackups(path, next)
  }, [])

  const persistSubjectBooks = useCallback(async (list: SubjectBookRecord[]) => {
    if (!subjectBooksLoadedRef.current) {
      throw new Error('Die Fachbücher konnten nicht gelesen werden. Es wurde nichts überschrieben.')
    }
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
      subjectBooksLoadedRef.current = true
      subjectBooksDiskRef.current = parsed
      setSubjectBooksDisk(parsed)
      setSubjectBooks((memory) => mergeSubjectBooksPreferDisk(memory, parsed))
    } catch {
      // Keep the books already on screen when the file cannot be read.
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
    if (!currentBook || !subjectBooksLoadedRef.current) return
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

  // Toggled on the element, not through className: the drawing board adds its own classes
  // (has-ink-extent) to the sheet, and a className re-render would wipe them and squish the ink.
  useLayoutEffect(() => {
    const paper = unifiedPaperRef.current
    if (!paper) return
    paper.classList.toggle('is-placing-note-link', noteLinkPlacing)
    paper.classList.toggle('is-placing-text-field', textFieldPlacing)
  }, [noteLinkPlacing, textFieldPlacing, activeTab?.path])

  const startNoteLinkPlacement = useCallback(() => {
    if (!activePathRef.current) {
      toast('Öffne zuerst eine Notiz, um eine Verlinkung zu setzen.', 'info')
      return
    }
    setTextFieldPlacing(false)
    setNoteLinkPlacing((current) => !current)
  }, [toast])

  const startTextFieldPlacement = useCallback(() => {
    if (!activePathRef.current) {
      toast('Öffne zuerst eine Notiz, um ein Textfeld einzufügen.', 'info')
      return
    }
    setNoteLinkPlacing(false)
    setTextFieldPlacing((current) => !current)
  }, [toast])

  const placeTextFieldAt = useCallback((point: { page: number; x: number; y: number; aspect?: number }) => {
    const path = activePathRef.current
    if (!path) return
    if (noteTextFieldsRef.current.length >= 200) {
      toast('Auf dieser Notiz sind schon 200 Textfelder.', 'info')
      return
    }
    const field = placeNoteTextField(point)
    // Not committed yet: an empty box that is never typed into is dropped again
    // by the layer and must not reach the disk.
    rememberNoteTextFields(path, [...noteTextFieldsRef.current, field], false)
    setTextFieldPlacing(false)
    setTextFieldFocusId(field.id)
  }, [rememberNoteTextFields, toast])

  const changeTextFieldText = useCallback((id: string, text: string) => {
    const path = activePathRef.current
    if (!path) return
    rememberNoteTextFields(path, patchNoteTextField(noteTextFieldsRef.current, id, { text }), false)
  }, [rememberNoteTextFields])

  const changeTextFieldGeometry = useCallback((id: string, patch: { page?: number; x?: number; y?: number; width?: number; aspect?: number }, commit: boolean) => {
    const path = activePathRef.current
    if (!path) return
    rememberNoteTextFields(path, patchNoteTextField(noteTextFieldsRef.current, id, patch), commit)
  }, [rememberNoteTextFields])

  const changeTextFieldStyle = useCallback((id: string, patch: { fontSize?: number; color?: string | undefined; bold?: boolean | undefined }) => {
    const path = activePathRef.current
    if (!path) return
    rememberNoteTextFields(path, patchNoteTextField(noteTextFieldsRef.current, id, patch), true)
  }, [rememberNoteTextFields])

  const finishTextFieldEdit = useCallback(() => { void flushNoteTextFieldsRef.current() }, [])

  const clearTextFieldFocus = useCallback(() => setTextFieldFocusId(null), [])

  const removePlacedTextField = useCallback((id: string) => {
    const path = activePathRef.current
    if (!path) return
    rememberNoteTextFields(path, noteTextFieldsRef.current.filter((field) => field.id !== id), true)
    setTextFieldFocusId((current) => current === id ? null : current)
  }, [rememberNoteTextFields])

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
    if (!await requestConfirm('Verlinkung wirklich entfernen? Die verlinkte Notiz bleibt im Vault.', { title: 'Verlinkung entfernen' })) return
    try {
      const links = removeNoteLink(noteLinksRef.current, link.id)
      await persistNoteLinks(path, links)
      setSelectedNoteLinkId((current) => current === link.id ? null : current)
      toast('Verlinkung entfernt.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Die Verlinkung konnte nicht entfernt werden.', 'error')
    }
  }, [persistNoteLinks, requestConfirm, toast])

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
    // The visit history records the jump; Zurück (Alt+←) returns to the source.
    await openNote(target)
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

  const createFolder = useCallback(async (parent?: string, startRename = false) => {
    const session = vaultSessionGenerationRef.current
    vaultStructureRevisionRef.current += 1
    try {
      const created = await window.fanotes.createFolder(parent)
      if (session !== vaultSessionGenerationRef.current) return
      vaultStructureRevisionRef.current += 1
      // An active tag filter hides folders without matching notes: the new folder must stay visible.
      setTagFilter(null)
      setRevealPath(created.relativePath)
      await refreshTree()
      if (startRename) setRenameRequest({ path: created.relativePath, token: Date.now() })
      toast(parent ? `Unterordner in „${parent.split('/').pop()}“ erstellt.` : 'Neuer Ordner erstellt.', 'success')
    } catch (error) {
      if (session === vaultSessionGenerationRef.current) toast(error instanceof Error ? error.message : 'Ordner konnte nicht erstellt werden.', 'error')
    }
  }, [refreshTree, toast])

  const duplicateFolder = useCallback(async (path: string) => {
    const session = vaultSessionGenerationRef.current
    try {
      // Unsaved text of open notes in the folder goes to disk first, so the copy has it.
      editorRef.current?.flushChanges()
      splitEditorRef.current?.flushChanges()
      for (const [pendingPath, content] of [...pendingWrites.current.entries()]) {
        if (pendingPath.startsWith(`${path}/`) && !await saveContent(pendingPath, content)) return
      }
      vaultStructureRevisionRef.current += 1
      const created = await window.fanotes.duplicateFolder!(path)
      if (session !== vaultSessionGenerationRef.current) return
      vaultStructureRevisionRef.current += 1
      setTagFilter(null)
      setRevealPath(created.relativePath)
      await refreshTree()
      toast('Ordner dupliziert.', 'success')
    } catch (error) {
      if (session === vaultSessionGenerationRef.current) toast(friendlyFileError(error, 'Der Ordner konnte nicht dupliziert werden.'), 'error')
    }
  }, [refreshTree, saveContent, toast])

  const openFolderPath = useCallback((path: string) => {
    setFolderPathTarget(path)
    setFolderPathInitial([])
    setFolderPathError(null)
    setFolderPathMoved(null)
    setFolderPathConflicts([])
    void window.fanotes.getFolderLocations(path).then((result) => {
      setFolderPathInitial(result.paths)
    }).catch((error: unknown) => {
      setFolderPathError(error instanceof Error ? error.message : 'Ordnerpfad konnte nicht gelesen werden.')
    })
  }, [])

  const saveFolderPath = useCallback(async (paths: string[], moveContents: boolean) => {
    if (!folderPathTarget) return
    const session = vaultSessionGenerationRef.current
    setFolderPathBusy(true)
    setFolderPathError(null)
    try {
      const result = await window.fanotes.setFolderLocations(folderPathTarget, paths, moveContents)
      if (session !== vaultSessionGenerationRef.current) return
      vaultStructureRevisionRef.current += 1
      setFolderPathInitial(result.paths)
      setFolderPathMoved(result.moved)
      setFolderPathConflicts(result.conflicts)
      await refreshTree()
      if (session !== vaultSessionGenerationRef.current) return
      if (result.conflicts.length === 0) {
        setFolderPathTarget(null)
        toast(result.moved > 0 ? (result.moved === 1 ? '1 Datei verschoben.' : `${result.moved} Dateien verschoben.`) : 'Ordnerpfad gespeichert.', 'success')
      }
    } catch (error) {
      if (session === vaultSessionGenerationRef.current) {
        setFolderPathError(error instanceof Error ? error.message : 'Ordnerpfad konnte nicht gespeichert werden.')
      }
    } finally {
      if (session === vaultSessionGenerationRef.current) setFolderPathBusy(false)
    }
  }, [folderPathTarget, refreshTree, toast])

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

  const setFileColor = useCallback(async (path: string, color: string | null) => {
    const session = vaultSessionGenerationRef.current
    try {
      if (!window.fanotes.setFileColor) throw new Error('Dokumentfarben gibt es in dieser Version nicht.')
      await window.fanotes.setFileColor(path, color)
      if (session !== vaultSessionGenerationRef.current) return
      await refreshTree()
      if (session !== vaultSessionGenerationRef.current) return
      toast(color ? 'Dokumentfarbe gespeichert.' : 'Dokumentfarbe auf Standard zurückgesetzt.', 'success')
    } catch (error) {
      if (session === vaultSessionGenerationRef.current) {
        toast(error instanceof Error ? error.message : 'Dokumentfarbe konnte nicht gespeichert werden.', 'error')
      }
    }
  }, [refreshTree, toast])

  const createDailyNote = useCallback(async (when?: Date) => {
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
      const title = formatDate(settings.dateFormat || 'YYYY-MM-DD', when ?? new Date())
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

  const openAdjacentDaily = useCallback(async (days: number) => {
    const path = activePathRef.current
    const folder = normalizePath(settingsRef.current.dailyNotesFolder || translateUiText('Tagesnotizen'))
    const pattern = settingsRef.current.dateFormat || 'YYYY-MM-DD'
    const when = path ? shiftDailyNote(path, folder, pattern, days) : null
    if (!when) {
      toast('Diese Notiz ist keine Tagesnotiz.', 'info')
      return
    }
    await createDailyNote(when)
  }, [createDailyNote, toast])

  const remapNotePaperPaths = useCallback((from: string, to: string | null) => {
    remapHeadingFolds(headingFoldScopeRef.current, from, to)
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

  const renamedPageStatsKey = (key: string, from: string, to: string) => (
    key === from || key.startsWith(`${from}/`)
      ? (key === from ? to : `${to}${key.slice(from.length)}`)
      : key
  )

  const remapPageStats = useCallback((from: string, to: string) => {
    const next = new Map<string, PageStatsSession>()
    pageStatsRef.current.forEach((session, key) => {
      next.set(renamedPageStatsKey(key, from, to), session)
    })
    pageStatsRef.current = next
    pageStatsUnreadableRef.current = new Set([...pageStatsUnreadableRef.current].map((key) => renamedPageStatsKey(key, from, to)))
    const nextInk = new Map<string, Record<string, unknown>>()
    pendingHistoryInkRef.current.forEach((ink, key) => {
      nextInk.set(renamedPageStatsKey(key, from, to), ink)
    })
    pendingHistoryInkRef.current = nextInk
  }, [])

  const forgetPageStats = useCallback((path: string) => {
    for (const key of [...pageStatsRef.current.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) pageStatsRef.current.delete(key)
    }
    for (const key of [...pageStatsUnreadableRef.current]) {
      if (key === path || key.startsWith(`${path}/`)) pageStatsUnreadableRef.current.delete(key)
    }
    for (const key of [...pendingHistoryInkRef.current.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) pendingHistoryInkRef.current.delete(key)
    }
  }, [])

  /** The split, the history and the closed-tab stack follow a renamed or moved entry. */
  const remapWorkspacePaths = useCallback((from: string, to: string) => {
    movedPathsRef.current.delete(to)
    movedPathsRef.current.set(from, { to, at: Date.now() })
    setSplitPath((current) => (current ? remapPath(current, from, to) ?? current : current))
    const nextHistory = remapNoteHistory(noteHistoryRef.current, from, to)
    noteHistoryRef.current = nextHistory
    setNoteHistory(nextHistory)
    closedTabsRef.current = closedTabsRef.current.map((path) => remapPath(path, from, to) ?? path)
  }, [])

  const forgetWorkspacePaths = useCallback((path: string) => {
    setSplitPath((current) => (current && (current === path || current.startsWith(`${path}/`)) ? null : current))
    const nextHistory = forgetNoteHistory(noteHistoryRef.current, path)
    noteHistoryRef.current = nextHistory
    setNoteHistory(nextHistory)
    closedTabsRef.current = closedTabsRef.current.filter((entry) => entry !== path && !entry.startsWith(`${path}/`))
  }, [])

  const renameEntry = useCallback(async (path: string, nextName: string) => {
    const session = vaultSessionGenerationRef.current
    const active = activePathRef.current
    const split = splitPathRef.current
    if (split && (split === path || split.startsWith(`${path}/`))) splitEditorRef.current?.flushChanges()
    if (active && (active === path || active.startsWith(`${path}/`))) {
      editorRef.current?.flushChanges()
      if (!await flushDocumentLayers()) {
        toast('Umbenennen abgebrochen: Handschrift oder Arbeitsblatt konnte nicht sicher gespeichert werden.', 'error')
        return
      }
    }
    vaultStructureRevisionRef.current += 1
    const nextPath = await window.fanotes.renameEntry(path, nextName)
    if (nextPath && nextPath !== path) syncEngine.markDeleted(path)
    if (session !== vaultSessionGenerationRef.current) return
    remapNotePaperPaths(path, nextPath)
    remapWorkspacePaths(path, nextPath)
    remapPageStats(path, nextPath)
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
    // The generated "# Untitled note" first line follows the new name; a heading the user wrote stays.
    if (/\.(?:md|markdown)$/iu.test(nextPath) && nextPath !== path) {
      const oldStem = stripExtension(fileName(path))
      const newStem = stripExtension(fileName(nextPath))
      try {
        const openTab = tabsRef.current.find((tab) => tab.path === nextPath || tab.path === path)
        if (openTab) {
          const current = pendingWrites.current.get(nextPath) ?? openTab.content
          const updated = retitleGeneratedHeading(current, oldStem, newStem)
          if (updated !== null) updateContentFor(nextPath, updated)
        } else {
          const updated = retitleGeneratedHeading(await window.fanotes.readFile(nextPath), oldStem, newStem)
          if (updated !== null) await window.fanotes.writeFile(nextPath, updated)
        }
      } catch (error) {
        console.warn('FaNotes: Überschrift der umbenannten Notiz konnte nicht angepasst werden:', error)
      }
    }
  }, [flushDocumentLayers, refreshTree, remapNotePaperPaths, remapPageStats, remapWorkspacePaths, saveContent, toast, updateContentFor])

  /**
   * An open note whose file was renamed or moved outside FaNotes: the tab, the
   * split, the history and the statistics follow it, as they do for a rename in
   * the app (without the file operation, which already happened). Returns the
   * unsaved text that now belongs to the new path; the caller saves it there.
   */
  const retargetOpenNote = useCallback((from: string, to: string): Array<[string, string]> => {
    remapNotePaperPaths(from, to)
    remapWorkspacePaths(from, to)
    remapPageStats(from, to)
    moveTabState(from, to)
    vaultStructureRevisionRef.current += 1
    const timer = saveTimers.current.get(from)
    if (timer) window.clearTimeout(timer)
    saveTimers.current.delete(from)
    const title = stripExtension(fileName(to))
    const follow = (tab: NoteTab): NoteTab => (tab.path === from ? { ...tab, path: to, title } : tab)
    // The ref is behind the state until React has rendered; whatever runs next must already see the new path.
    tabsRef.current = tabsRef.current.map(follow)
    setTabs((current) => current.map(follow))
    const moved: Array<[string, string]> = []
    const unsaved = pendingWrites.current.get(from)
    if (unsaved !== undefined) {
      pendingWrites.current.delete(from)
      pendingWrites.current.set(to, unsaved)
      moved.push([to, unsaved])
    }
    if (activePathRef.current === from) activePathRef.current = to
    setActivePath((current) => (current === from ? to : current))
    return moved
  }, [moveTabState, remapNotePaperPaths, remapPageStats, remapWorkspacePaths])

  const externalTabs = useExternalTabChanges({
    holdsRef: tabHoldsRef,
    setHold: setTabHold,
    ownWritesRef: tabOwnWritesRef,
    tabsRef,
    setTabs,
    pendingWrites,
    saveTimers,
    treeRef,
    mutatingEntryPathsRef,
    vaultSessionGenerationRef,
    activePathRef,
    flushEditors: () => {
      editorRef.current?.flushChanges()
      splitEditorRef.current?.flushChanges()
    },
    flushDocumentLayers,
    reloadCleanTab,
    retargetOpenNote,
    saveContent,
    refreshTree,
    toast,
    deviceName: () => settingsRef.current.syncDeviceName ?? '',
  })
  parkHeldTabRef.current = externalTabs.parkHeldTab
  checkTabPathRef.current = externalTabs.checkPath

  const moveEntry = useCallback(async (path: string, destFolder = ''): Promise<string | undefined> => {
    const session = vaultSessionGenerationRef.current
    const active = activePathRef.current
    const split = splitPathRef.current
    if (split && (split === path || split.startsWith(`${path}/`))) splitEditorRef.current?.flushChanges()
    if (active && (active === path || active.startsWith(`${path}/`))) {
      editorRef.current?.flushChanges()
      if (!await flushDocumentLayers()) {
        toast('Verschieben abgebrochen: Handschrift oder Arbeitsblatt konnte nicht sicher gespeichert werden.', 'error')
        return
      }
    }
    vaultStructureRevisionRef.current += 1
    try {
      const nextPath = await window.fanotes.moveEntry(path, destFolder)
      if (nextPath !== path) syncEngine.markDeleted(path)
      if (session !== vaultSessionGenerationRef.current) return
      if (nextPath === path) return
      remapNotePaperPaths(path, nextPath)
      remapWorkspacePaths(path, nextPath)
      remapPageStats(path, nextPath)
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
      return nextPath
    } catch (error) {
      if (session === vaultSessionGenerationRef.current) {
        toast(error instanceof Error ? error.message : 'Verschieben fehlgeschlagen.', 'error')
      }
    }
  }, [flushDocumentLayers, refreshTree, remapNotePaperPaths, remapPageStats, remapWorkspacePaths, saveContent, toast])

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
      syncEngine.markDeleted(path)
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
      forgetPageStats(path)
      forgetWorkspacePaths(path)
      setActivePath((current) => {
        if (!current || (current !== path && !current.startsWith(`${path}/`))) return current
        // Fall through to the neighbouring tab instead of an empty workspace.
        const remaining = tabsRef.current.filter((tab) => tab.path !== path && !tab.path.startsWith(`${path}/`))
        const previousIndex = tabsRef.current.findIndex((tab) => tab.path === current)
        return remaining[Math.min(Math.max(previousIndex, 0), remaining.length - 1)]?.path ?? null
      })
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
  }, [flushDocumentLayers, flushPendingEntry, forgetPageStats, forgetWorkspacePaths, refreshTree, remapNotePaperPaths, toast])

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
        const loaded = loadHomeworkMarkdown(await window.fanotes.readFile(HOMEWORK_NOTE_PATH))
        if (!loaded.ok) return
        nextDocument = loaded.document
      } catch (error) {
        if (!isMissingNoteError(error)) return
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
  applySettingsRef.current = applySettings

  const shareVaultEntry = useCallback(async (relativePath: string, mode: 'copy' | 'live' | 'edit') => {
    if (shareInFlight.current || !relativePath || !window.fanotes?.getTree || !window.fanotes.readFile) return
    shareInFlight.current = true
    try {
      const saved = await flushPendingEntry(relativePath)
      if (!saved) {
        toast('Die Notiz konnte nicht vollständig gespeichert werden.', 'error')
        return
      }
      const entries = await loadShareEntries(await window.fanotes.getTree(), (path) => window.fanotes.readFile(path), (path) => (
        window.fanotes.readNoteCompanion ? window.fanotes.readNoteCompanion(path).catch(() => null) : Promise.resolve(null)
      ), {
        fontSize: settingsRef.current.editorFontSize,
        lineHeight: settingsRef.current.lineHeight,
        contentWidth: settingsRef.current.contentWidth,
        readable: settingsRef.current.readableLineLength,
      })
      const collected = collectShareNotes(entries, relativePath)
      if (collected.notes.length === 0) {
        toast(collected.kind === 'folder' ? 'Noch keine Notizen vorhanden' : 'Diese Notiz ist noch leer.', 'info')
        return
      }
      toast('Lädt hoch', 'info')
      const shareMode = mode === 'live' ? 'live' : mode === 'edit' ? 'edit' : 'copy'
      const published = await publishShare({
        entries,
        rootPath: relativePath,
        mode: shareMode,
        port: createFetchSharePort(),
        origin: resolveShareOrigin(),
        directory: parseShareDirectory(settingsRef.current.shareRecent),
      })
      applySettings({ ...settingsRef.current, shareRecent: serializeShareDirectory(published.directory) })
      setShareLinkDialog({ link: published.record.link, mode: shareMode })
      if (shareMode === 'edit' && settingsRef.current.profileUsername) {
        try {
          const vaultPaths: Record<string, string> = {}
          for (const note of published.payload.notes) vaultPaths[collected.kind === 'note' ? relativePath : note.path] = note.path
          await shareEditRef.current?.leave().catch(() => undefined)
          const client = await openShareEditor({
            share: published.payload,
            name: settingsRef.current.profileUsername,
            port: createFetchSharePort(),
            origin: resolveShareOrigin(),
            vaultPaths,
          })
          shareEditRef.current = client
          setSharePeople({ editors: client.peopleWhoCanEdit(), present: client.peopleEditing(), self: client.name })
          setShareSessionToken((current) => current + 1)
        } catch {
          /* The link is already public. This device joins when the note is opened from it. */
        }
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Die Freigabe konnte nicht hochgeladen werden.', 'error')
    } finally {
      shareInFlight.current = false
    }
  }, [applySettings, flushPendingEntry, toast])

  useEffect(() => {
    if (!shareLinkDialog) return
    shareLinkInputRef.current?.focus()
    shareLinkInputRef.current?.select()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setShareLinkDialog(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shareLinkDialog])

  const shareFolders = useCallback(() => {
    const folders = ['']
    const walk = (nodes: typeof treeRef.current) => {
      for (const node of nodes) {
        if (node.kind !== 'folder') continue
        folders.push(node.relativePath)
        if (node.children?.length) walk(node.children)
      }
    }
    walk(treeRef.current)
    return folders
  }, [])

  const acceptEditableShare = useCallback(async (rawId: string) => {
    const id = parseShareProtocol(rawId.includes('://') ? rawId : `fanotes://share/${rawId}`)
    if (!id) return
    try {
      const payload = await readShare({ id, port: createFetchSharePort(), origin: resolveShareOrigin() })
      if (!payload || payload.mode !== 'edit') {
        toast('Diese Freigabe kann nicht bearbeitet werden.', 'info')
        return
      }
      setShareNameDraft(settingsRef.current.profileUsername || '')
      setShareJoin(beginDesktopShareOpen(payload, shareFolders()))
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Die Freigabe konnte nicht geladen werden.', 'error')
    }
  }, [shareFolders, toast])

  useEffect(() => {
    if (!window.fanotes.onShareOpen) return undefined
    return window.fanotes.onShareOpen((id) => { void acceptEditableShare(id) })
  }, [acceptEditableShare])

  useEffect(() => {
    const session = shareEditRef.current
    if (!session) return undefined
    let stopped = false
    let shownFieldSignature = ''
    let shownInkSignature = ''
    // The ink pass below parses and serialises the whole drawing; when neither the share nor the open
    // drawing changed since it last ran, it would only repeat itself (once a second, for as long as the note is open).
    let inkPassKey = ''
    let inkPassJson: string | null = null
    const tick = async () => {
      if (stopped || shareEditRef.current !== session) return
      await session.pull().catch(() => undefined)
      if (stopped || shareEditRef.current !== session) return
      // Same people as a second ago: no new state, or the whole app renders once a second for nothing.
      const nextPeople = { editors: session.peopleWhoCanEdit(), present: session.peopleEditing(), self: session.name }
      setSharePeople((current) => (current
        && current.editors.join('\n') === nextPeople.editors.join('\n')
        && current.present.join('\n') === nextPeople.present.join('\n')
        && current.self === nextPeople.self ? current : nextPeople))
      const owned = tabsRef.current.filter((candidate) => session.owns(candidate.path))
      const tab = owned.find((candidate) => candidate.path === activePathRef.current)
        ?? owned.find((candidate) => candidate.path === splitPathRef.current)
        ?? owned[0]
      if (!tab) return
      const sharePath = session.sharePathFor(tab.path)
      if (!sharePath) return
      const editorHandle = tab.path === activePathRef.current
        ? editorRef.current
        : tab.path === splitPathRef.current
          ? splitEditorRef.current
          : null
      const pending = editorHandle?.changesPending() ?? { coalescer: false, composing: false }
      const editorDoc = editorHandle?.getText() ?? null
      const remoteText = session.noteContent(sharePath)
      const basisText = session.basisContent(sharePath)
      const decision = shareTickDecision({
        editorDoc,
        coalescerPending: pending.coalescer,
        composing: pending.composing,
        remoteText,
        basisText,
      })
      if (decision === 'showRemote') {
        const next = remoteTextForEditor(basisText, remoteText, false)
        if (next !== null) {
          const applyShown = <T extends { path: string; content: string; savedContent: string }>(candidate: T): T => (
            candidate.path === tab.path && candidate.content === candidate.savedContent && !pendingWrites.current.has(candidate.path)
              ? { ...candidate, content: next, savedContent: next }
              : candidate
          )
          tabsRef.current = tabsRef.current.map(applyShown)
          shareEditApplyingRef.current = true
          setTabs((current) => current.map(applyShown))
          window.setTimeout(() => { shareEditApplyingRef.current = false }, 0)
        }
      } else if (decision === 'absorb' && editorDoc !== null) {
        session.absorb(sharePath, { content: editorDoc })
      }
      // Settled boxes only: while a box is being typed or saved, the next tick looks again.
      const boxesSettled = !textFieldDirtyRef.current && textFieldTimerRef.current === null && textFieldQueueRef.current.writes() === 0
      if (boxesSettled && tab.path === activePathRef.current) {
        const remoteFields = session.noteFields(sharePath)
        const fieldSig = (fields: readonly { page?: number; x?: number; y?: number; width?: number; fontSize?: number; text?: string }[]) => (
          JSON.stringify(fields.map((field) => [field.page, field.x, field.y, field.width, field.fontSize, field.text]))
        )
        const remoteSig = `${sharePath}\n${fieldSig(remoteFields)}`
        // The share holds boxes with text only, so a box still empty is not part of the comparison.
        const openFields = publicShareTextFields(noteTextFieldsRef.current)
        const openSig = `${sharePath}\n${fieldSig(openFields)}`
        if (openSig !== remoteSig) {
          // Per-box three-way merge against the share's basis: boxes others added or changed come in,
          // and what this window changed (and the share has not seen yet) stays.
          let sharedFields: ShareTextField[] | null = null
          try {
            sharedFields = session.prepareLocalEdit(sharePath, { textFields: openFields }).textFields ?? []
          } catch {
            sharedFields = null
          }
          if (sharedFields && fieldSig(sharedFields) !== fieldSig(openFields)) {
            const absorbed = applyRemoteTextFields(noteTextFieldsRef.current, sharedFields)
            const inProgress = noteTextFieldsRef.current.filter((field) => field.text.trim() === '')
            const mergedFields = parseNoteTextFields([...absorbed, ...inProgress])
            noteTextFieldsRef.current = mergedFields
            setNoteTextFields(mergedFields)
            // The note on disk gets the boxes that arrived.
            textFieldDirtyRef.current = true
            textFieldSavePathRef.current = tab.path
            void flushNoteTextFieldsRef.current()
          }
          shownFieldSignature = remoteSig
        } else if (shownFieldSignature === remoteSig) {
          session.absorb(sharePath, { textFields: openFields })
        } else {
          shownFieldSignature = remoteSig
        }
      }
      const remoteInk = session.noteInk(sharePath)
      const openDrawing = drawingSessionRef.current
      const inkKeyOf = (current: typeof openDrawing) => `${sharePath}|${tab.path}|${session.version()}|${current.key}|${current.path}`
      if (!drawingDirtyRef.current && openDrawing.document && inkKeyOf(openDrawing) === inkPassKey && openDrawing.document.drawingJson === inkPassJson) return
      if (!drawingDirtyRef.current && openDrawing.path === tab.path && openDrawing.document) {
        const nextJson = drawingJsonWithRemoteInk(openDrawing.document.drawingJson, remoteInk)
        const wroteInk = nextJson !== openDrawing.document.drawingJson
        const painted = wroteInk ? { ...openDrawing.document, drawingJson: nextJson } : openDrawing.document
        if (wroteInk) {
          const nextSession = { ...openDrawing, document: painted }
          drawingSessionRef.current = nextSession
          setDrawingSession(nextSession)
        }
        if (remoteInk) {
          try {
            const shown = publicShareInk(JSON.parse(painted.drawingJson))
            const inkSig = shown ? `${sharePath}\n${JSON.stringify(shown)}` : ''
            if (wroteInk) {
              shownInkSignature = inkSig
            } else if (shown && shownInkSignature === inkSig) {
              session.absorb(sharePath, { ink: shown })
            } else {
              shownInkSignature = inkSig
            }
          } catch {
            /* The open drawing stays as it is when its ink cannot be read. */
          }
        }
        const settled = drawingSessionRef.current
        inkPassKey = inkKeyOf(settled)
        inkPassJson = settled.document?.drawingJson ?? null
      }
    }
    const timer = window.setInterval(() => { void trackActivity('sync', tick()) }, 1000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [shareSessionToken])

  const finishShareIdentity = useCallback(async (kind: 'account' | 'name') => {
    if (!shareJoin || shareJoin.step !== 'identity') return
    const origin = resolveShareOrigin()
    const port = createFetchSharePort()
    try {
      const confirmed = await confirmShareIdentity({
        state: shareJoin,
        choice: { kind, name: shareNameDraft },
        port,
        origin,
        claim: kind === 'account' ? async (name) => {
          const ownerId = settingsRef.current.profileOwnerId || createProfileOwnerId()
          const claimed = await claimUsername({ username: name, ownerId, port: createFetchProfilePort() })
          applySettings({ ...settingsRef.current, profileOwnerId: ownerId, profileUsername: claimed.username, profilePublic: claimed.public })
          return claimed.username
        } : undefined,
      })
      for (const file of shareJoin.files) {
        await window.fanotes.writeFile(file.relativePath, file.content)
        if (file.ink && window.fanotes.saveDrawing) {
          await window.fanotes.saveDrawing({
            title: file.title || 'Handschrift',
            drawingJson: JSON.stringify(file.ink),
            noteRelativePath: file.relativePath,
          }).catch(() => undefined)
        }
      }
      const vaultPaths: Record<string, string> = {}
      for (const file of shareJoin.files) vaultPaths[file.relativePath] = file.sharePath
      await shareEditRef.current?.leave().catch(() => undefined)
      const client = await openShareEditor({
        share: shareJoin.share,
        name: confirmed.name,
        port,
        origin,
        vaultPaths,
      })
      shareEditRef.current = client
      setSharePeople({ editors: confirmed.editors, present: client.peopleEditing(), self: client.name })
      setShareSessionToken((current) => current + 1)
      setShareJoin(null)
      await refreshTree()
      const first = shareJoin.files[0]
      if (first) await openNote(first.relativePath)
    } catch (error) {
      const text = error instanceof ProfileRequestError && error.taken
        ? 'Dieser Benutzername ist schon vergeben.'
        : error instanceof Error ? error.message : 'Die Freigabe konnte nicht bearbeitet werden.'
      toast(text, 'error')
    }
  }, [applySettings, openNote, refreshTree, shareJoin, shareNameDraft, toast])

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

  // Document search: one local index per vault, filled in the background.
  // It starts only after the file tree is on screen and the renderer is idle: opening the index
  // (IndexedDB, a second tree scan, the OCR host) used to compete with the first paint on slow machines.
  const startupTreeShown = tree.length > 0
  useEffect(() => {
    const vaultPath = bootstrap?.vaultPath
    if (!vaultPath || bootstrap?.onboardingRequired || !startupTreeShown) return
    let cancelled = false
    let idleHandle: number | null = null
    const timer = window.setTimeout(() => {
      idleHandle = window.requestIdleCallback(() => {
        idleHandle = null
        void import('./lib/docSearch/service').then(({ docSearch }) => {
          if (!cancelled) void docSearch.start({ api: window.fanotes, platform: window.fanotes.platform, vaultPath, version: APP_VERSION }).catch(() => undefined)
        })
      }, { timeout: 8_000 })
    }, DOC_SEARCH_START_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (idleHandle !== null) window.cancelIdleCallback(idleHandle)
      void import('./lib/docSearch/service').then(({ docSearch }) => docSearch.stop())
    }
  }, [bootstrap?.vaultPath, bootstrap?.onboardingRequired, startupTreeShown])
  useEffect(() => {
    if (!tree.length) return
    void import('./lib/docSearch/service').then(({ docSearch }) => docSearch.notifyChanged())
  }, [tree])

  const openSettings = useCallback((section?: SettingsSection) => {
    setSettingsSection(section)
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
    setCalendarOpen(false)
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
      pageStatsRef.current = new Map()
      pageStatsUnreadableRef.current = new Set()
      pendingHistoryInkRef.current = new Map()
      treeRef.current = []
      setTree([])
      setSearchLoading(false)
      drawingDirtyRef.current = false
      drawingOpenRef.current = false
      drawingLoadRequestRef.current += 1
      worksheetLoadRequestRef.current += 1
      worksheetDirtyIdsRef.current.clear()
      setDrawingOpen(false)
      setDrawingSession((current) => ({ key: current.key + 1, document: null, path: null }))
      setWorksheetSession((current) => ({ key: current.key + 1, documents: [] }))
      setBootstrap(selected)
      void syncEngine.switchVault().catch(() => undefined)
      void userShares.switchVault().catch(() => undefined)
      const selectedSettings = { ...defaultSettingsForPlatform(window.fanotes.platform), ...selected.settings }
      const selectedSettingsRevision = settingsRevisionRef.current + 1
      settingsRevisionRef.current = selectedSettingsRevision
      settingsPersistedRevisionRef.current = selectedSettingsRevision
      settingsRef.current = selectedSettings
      setSettings(selectedSettings)
      setTabs([])
      setActivePath(null)
      setSplitPath(null)
      noteHistoryRef.current = EMPTY_NOTE_HISTORY
      setNoteHistory(EMPTY_NOTE_HISTORY)
      closedTabsRef.current = []
      workspaceRestoredRef.current = false
      setSearchQuery('')
      setSearchHits([])
      setSearchFailed(false)
      const nextTree = await refreshTree()
      const start = chooseStartSurface(Boolean(selected.onboardingRequired))
      const remembered = chooseRestoredNote(selectedSettings.lastOpenNotePath, collectNotePaths(nextTree), firstNote(nextTree))
      if (start.openLastNote && remembered) await openNote(remembered)
      await restoreWorkspace(selected.vaultPath, nextTree)
      toast(`Vault „${selected.vaultName}“ geöffnet.`, 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Der Vault konnte nicht sicher gewechselt werden.', 'error')
    } finally {
      vaultSwitchInProgressRef.current = false
    }
  }, [flushDocumentLayers, flushPendingWrites, flushSettings, openNote, refreshTree, restoreWorkspace, toast])

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
        block: null,
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
      // Main closes the window through the normal save path, then the helper swaps the file and starts the new version.
      setUpdateState(await window.fanotes.installUpdate())
      toast('Notizen werden gespeichert, dann startet FaNotes mit der neuen Version neu.', 'info')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das Update konnte nicht installiert werden.', 'error')
    }
  }, [flushDocumentLayers, flushPendingWrites, flushSettings, toast])

  useEffect(() => {
    const query = searchQuery.trim()
    const session = vaultSessionGenerationRef.current
    const requestId = ++searchRequestRef.current
    if (query.length < 2) { setSearchHits([]); setSearchFailed(false); setSearchLoading(false); return }
    setSearchLoading(true)
    const timer = window.setTimeout(() => {
      void window.fanotes.search(query)
        .then((hits) => {
          if (session === vaultSessionGenerationRef.current && requestId === searchRequestRef.current) {
            setSearchHits(hits)
            setSearchFailed(false)
          }
        })
        .catch(() => {
          if (session === vaultSessionGenerationRef.current && requestId === searchRequestRef.current) {
            setSearchHits([])
            setSearchFailed(true)
          }
        })
        .finally(() => {
          if (session === vaultSessionGenerationRef.current && requestId === searchRequestRef.current) setSearchLoading(false)
        })
    }, 240)
    return () => window.clearTimeout(timer)
  }, [searchQuery])

  const setToolbarFullscreenMode = useCallback((on: boolean) => {
    const api = window.fanotes
    if (!api?.setFullscreen) return
    setToolbarFullscreen(on)
    void api.setFullscreen(on).catch(() => setToolbarFullscreen(false))
  }, [])
  useEffect(() => window.fanotes?.onFullscreenChange?.((on) => { if (!on) setToolbarFullscreen(false) }), [])

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
    const path = commandNotePath()
    if (!path || isPdfNotePath(path)) {
      toast('Öffne eine Notiz im Editor, um sie zu formatieren.', 'info')
      return
    }
    if ([...mutatingEntryPathsRef.current].some((entry) => path === entry || path.startsWith(`${entry}/`))) {
      toast('Diese Notiz ist während der Dateiaktion schreibgeschützt.', 'error')
      return
    }
    if (!commandEditor()?.format(action)) toast('Die Formatierung konnte nicht angewandt werden.', 'error')
  }, [drawingOpen, homeworkOpen, overviewOpen, toast])

  const handleDrawingDirtyChange = useMemo(() => {
    const session = noteDrawingKey
    return (dirty: boolean) => {
      if (session !== drawingSessionKeyRef.current) return
      drawingDirtyRef.current = dirty
    }
  }, [noteDrawingKey])

  const handleInkActivity = useCallback((activity: InkActivity) => {
    const path = activePathRef.current
    if (!path) return
    if (activity.kind === 'stroke') recordInkStrokeFor(path, activity.stroke)
    else recordInkErasedFor(path, activity.removed)
  }, [recordInkErasedFor, recordInkStrokeFor])

  const closeDrawing = useCallback(() => {
    drawingOpenRef.current = false
    setDrawingOpen(false)
    return true
  }, [])

  useEffect(() => window.fanotes?.onBeforeClose(() => {
    if (closeInProgressRef.current) return
    // The sheet is still laid out. pagehide can run after the scroller has
    // collapsed, which used to store the top of the page.
    flushPaperViewMemory()
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

  // In the browser there is no Main process to hold the window open: hand the
  // coalesced keystrokes to the app, start the writes, and let the browser ask
  // before it discards a page with unsaved work.
  useEffect(() => {
    if (!isWeb) return
    // Keeps a synchronous copy of unsaved boxes; the async save may not outlive the page.
    const rescueBoxes = () => {
      const path = textFieldSavePathRef.current
      const unsaved = textFieldDirtyRef.current || textFieldTimerRef.current !== null || textFieldQueueRef.current.writes() > 0
      if (path && unsaved) writeNoteTextFieldRescue(path, noteTextFieldsRef.current, textFieldBasesRef.current.get(path) ?? [])
      return unsaved
    }
    const guard = (event: BeforeUnloadEvent) => {
      flushPaperViewMemory()
      editorRef.current?.flushChanges()
      splitEditorRef.current?.flushChanges()
      // A text box is unsaved while it waits for its debounce and while a write is still running.
      const boxesUnsaved = rescueBoxes()
      const unsaved = pendingWrites.current.size > 0 || drawingDirtyRef.current || worksheetDirtyIdsRef.current.size > 0 || boxesUnsaved
      if (!unsaved) return
      void flushDocumentLayers().then(() => flushPendingWrites()).catch(() => undefined)
      event.preventDefault()
      event.returnValue = ''
    }
    // A tab that is hidden, frozen or put in the back/forward cache may never run beforeunload.
    const saveBoxesOnHide = () => {
      if (document.visibilityState !== 'hidden') return
      rescueBoxes()
      void flushNoteTextFieldsRef.current()
    }
    const saveBoxesOnPageHide = () => {
      rescueBoxes()
      void flushNoteTextFieldsRef.current(true)
    }
    window.addEventListener('beforeunload', guard)
    window.addEventListener('pagehide', saveBoxesOnPageHide)
    document.addEventListener('visibilitychange', saveBoxesOnHide)
    return () => {
      window.removeEventListener('beforeunload', guard)
      window.removeEventListener('pagehide', saveBoxesOnPageHide)
      document.removeEventListener('visibilitychange', saveBoxesOnHide)
    }
  }, [flushDocumentLayers, flushPendingWrites, isWeb])

  const openDrawing = useCallback(() => {
    if (!activeTab) {
      toast('Öffne zuerst eine Notiz, um darauf handschriftlich zu schreiben.', 'info')
      return
    }
    if (tabHoldsRef.current[activeTab.path]) {
      toast('Diese Notiz ist pausiert, bis du den Hinweis über dem Text beantwortet hast.', 'info')
      return
    }
    const splitNote = splitPathRef.current
    if (focusedPaneRef.current === 'split' && splitNote && (isPdfNotePath(splitNote) || tabsRef.current.find((tab) => tab.path === splitNote)?.kind === 'pdf')) {
      // The pen layer of a PDF lives in the main pane only; say so instead of doing nothing.
      toast('Handschrift auf einem PDF gibt es in der Hauptspalte. Öffne es dort über „Als einzige Notiz öffnen“.', 'info')
      return
    }
    drawingOpenRef.current = true
    setOverviewOpen(false)
    setHomeworkOpen(false)
    setCalendarOpen(false)
    setSearchOpen(false)
    setDrawingOpen(true)
    // A mounted session already shows this note's saved ink (keyboard mode
    // keeps one for notes with handwriting); the pen just becomes the input.
    if (noteDrawingKey > 0) return
    // Same FAMD-first read as the note switch. Reading only the library
    // record here resumed the pen on a stale copy of the page whenever the
    // `.famd` companion was newer, and the next save then overwrote the
    // newer strokes for good.
    const requestId = ++drawingLoadRequestRef.current
    const { path, content } = activeTab
    void readNoteInk(path, content).then((document) => {
      if (requestId !== drawingLoadRequestRef.current || activePathRef.current !== path) return
      setDrawingSession({ ...drawingSessionFromLoad(requestId, document), path })
    })
  }, [activeTab, noteDrawingKey, toast])

  const toggleDrawing = useCallback(() => {
    if (drawingOpenRef.current) closeDrawing()
    else {
      setGlyphenWerkOpen(false)
      openDrawing()
    }
  }, [closeDrawing, openDrawing])

  // The pen is put down while the note is paused: strokes could not be saved into a file that is gone or was edited elsewhere.
  useEffect(() => {
    if (drawingOpen && activePath && tabHolds[activePath]) closeDrawing()
  }, [activePath, closeDrawing, drawingOpen, tabHolds])

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
  }, [drawingOpen, noteDrawingKey])

  useEffect(() => {
    if (!settings.experimentalRemoteSupport || !remoteSupportSession) return
    const session = remoteSupportSession
    const origin = homeworkApiOriginFromLocation(window.fanotes.platform)
    let cancelled = false
    const readLive = async () => {
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

  // Send data: the main process owns queue and sending; this only tells the renderer which events to report.
  useEffect(() => {
    const on = settings.diagnosticsEnabled
    configureDiagnostics({ crashes: on && settings.diagnosticsCrashes, errors: on && settings.diagnosticsLogs, perf: on && settings.diagnosticsPerf, usage: on && settings.diagnosticsUsage }, { vaultPath: bootstrap?.vaultPath })
    startStallMonitor(on && settings.diagnosticsPerf)
  }, [settings.diagnosticsEnabled, settings.diagnosticsCrashes, settings.diagnosticsLogs, settings.diagnosticsPerf, settings.diagnosticsUsage, bootstrap?.vaultPath])

  useEffect(() => {
    if (!bootstrap) return
    let notes = 0
    let bytes = 0
    const walk = (entries: VaultEntry[]) => { for (const entry of entries) { if (entry.kind === 'folder') walk(entry.children ?? []); else { notes += 1; bytes += entry.size ?? 0 } } }
    walk(tree)
    setDiagnosticsVault(notes, bytes)
  }, [bootstrap, tree])

  useEffect(() => { if (settingsOpen) recordFeature(`view.settings-${settingsSection ?? 'open'}`) }, [settingsOpen, settingsSection])

  useEffect(() => {
    if (overviewOpen || glyphenWerkOpen) setSidebarToolsOpen(true)
  }, [overviewOpen, glyphenWerkOpen])

  const openSearchHit = useCallback(async (hit: SearchHit) => {
    setSearchOpen(false)
    // The sidebar box is only a launcher for the vault search: a stale query would look like an active filter.
    setSearchQuery('')
    setSearchHits([])
    setSearchFailed(false)
    const reveal = (path: string) => {
      if (!hit.inkAnchor) return
      setInkReveal({ path, y: hit.inkAnchor.y, token: Date.now() })
    }
    if (hit.unit === 'scene' && hit.sceneId) {
      // A story hit opens the writing mode at that scene (and the paragraph with the words).
      const { requestStoryReveal } = await import('./writing/reveal')
      requestStoryReveal(hit.relativePath, { sceneId: hit.sceneId, query: hit.query ?? '' })
    }
    if (hit.kind !== 'drawing' || !hit.drawingId) {
      await openNote(hit.relativePath)
      reveal(hit.relativePath)
      // Document index hit on a PDF page: go to the page and mark the words there.
      if (hit.unit === 'pdf-page' && hit.page) {
        const { requestPdfReveal } = await import('./lib/docSearch/reveal')
        requestPdfReveal(hit.relativePath, hit.page, hit.query ?? '')
      }
      return
    }
    if (hit.notePath) {
      await openNote(hit.notePath)
      reveal(hit.notePath)
      drawingOpenRef.current = true
      setDrawingOpen(true)
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
      setDrawingSession((current) => ({ key: current.key + 1, document, path: activeTab.path }))
      openDrawing()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Handschrift-Seite konnte nicht geöffnet werden.', 'error')
    }
  }, [activeTab, openDrawing, openNote, toast, updateContent])

  useEffect(() => {
    if (!inkReveal || inkReveal.path !== activePath) return
    const frame = window.requestAnimationFrame(() => {
      const scroller = document.querySelector('.unified-note-view .cm-scroller') as HTMLElement | null
      if (!scroller) return
      scroller.scrollTop = scrollTopForNormalizedY(scroller.scrollHeight, scroller.clientHeight, inkReveal.y)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activePath, inkReveal])

  const showFiles = useCallback(() => {
    if (!closeDrawing()) return
    setSearchOpen(false)
    setOverviewOpen(false)
    setHomeworkOpen(false)
    setCalendarOpen(false)
    setGlyphenWerkOpen(false)
    setSidebarVisible(true)
  }, [closeDrawing])

  const openOverview = useCallback(() => {
    if (!closeDrawing()) return
    setGlyphenWerkOpen(false)
    setHomeworkOpen(false)
    setCalendarOpen(false)
    setOverviewOpen(true)
  }, [closeDrawing])

  const openHomework = useCallback(() => {
    if (!closeDrawing()) return
    setGlyphenWerkOpen(false)
    setOverviewOpen(false)
    setSearchOpen(false)
    setCalendarOpen(false)
    setHomeworkOpen(true)
  }, [closeDrawing])

  const openCalendar = useCallback(() => {
    if (!closeDrawing()) return
    setGlyphenWerkOpen(false)
    setOverviewOpen(false)
    setSearchOpen(false)
    setHomeworkOpen(false)
    setCalendarOpen(true)
  }, [closeDrawing])

  const openGlyphenWerk = useCallback(() => {
    if (!closeDrawing()) return
    setPaletteOpen(false)
    setSearchOpen(false)
    setOverviewOpen(false)
    setHomeworkOpen(false)
    setCalendarOpen(false)
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

  const saveDrawingAssetUntracked = useCallback(async (payload: DrawingSavePayload, notePathOverride?: string | null) => {
    const session = vaultSessionGenerationRef.current
    const notePath = notePathOverride ?? activePath
    // The note's file is gone: saving the strokes would create its handwriting file again as a note of its own.
    if (notePath && tabHoldsRef.current[notePath]?.kind === 'deleted') {
      throw new Error('Diese Notiz wurde ausserhalb von FaNotes gelöscht. Stelle sie wieder her oder speichere sie unter neuem Namen, damit die Handschrift gesichert werden kann.')
    }
    const { inkSummary, ...drawing } = payload
    const asset = await window.fanotes.saveDrawing({
      ...drawing,
      noteRelativePath: notePath ?? undefined,
    })
    // Both reads below parse the whole drawing on this thread (about 0.3 s each
    // on a 320k-sample note, after every autosave). Each now runs only when its
    // result is used: shared ink for a live share of this note, and the
    // drawing's own timestamp when the save did not return one.
    if (notePath && editableShareOwns(notePath)) {
      try {
        const parsed = JSON.parse(payload.drawingJson) as unknown
        if (parsed && typeof parsed === 'object') {
          pushEditableShare(notePath, { ink: publicShareInk(parsed) ?? null })
        }
      } catch {
        /* A local drawing still saves when the shared ink cannot be read. */
      }
    }
    if (notePath && inkSummary) recordInkSnapshotFor(notePath, inkSummary)
    let updatedAt = asset.updatedAt ?? new Date().toISOString()
    if (!asset.updatedAt) {
      try {
        const drawingData = JSON.parse(payload.drawingJson) as { updatedAt?: unknown }
        if (typeof drawingData.updatedAt === 'string') updatedAt = drawingData.updatedAt
      } catch {
        // Main validates the JSON; this fallback only keeps the immediate UI resilient.
      }
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
    setDrawingSession((current) => current.path === notePath ? { ...current, document } : current)
    return result
  }, [activePath, editableShareOwns, pushEditableShare, recordInkSnapshotFor, saveContent, tabHoldsRef])
  const saveDrawingAsset = useCallback((payload: DrawingSavePayload, notePathOverride?: string | null) => trackActivity('save', saveDrawingAssetUntracked(payload, notePathOverride)), [saveDrawingAssetUntracked])

  // "Leere Seiten daneben" on PDF notes (desktop): while on, the ink board covers the side pages too.
  const reloadNoteInk = useCallback((path: string) => {
    const requestId = ++drawingLoadRequestRef.current
    void readNoteInk(path, latestNoteContent(path) ?? '').then((document) => {
      if (requestId !== drawingLoadRequestRef.current || activePathRef.current !== path) return
      setDrawingSession({ ...overlaySessionAfterInkReady(drawingOpenRef.current, drawingSessionFromLoad(requestId, document)), path })
    })
  }, [latestNoteContent])
  const pdfSide = usePdfSidePages({
    activePath,
    isPdfActive,
    sessionKey: noteDrawingSession.key,
    title: activeTab?.title ?? '',
    readPdfInk: (path) => readNoteInk(path, latestNoteContent(path) ?? ''),
    flushBoard: async () => { await drawingBoardRef.current?.flush() },
    reloadNoteInk,
    saveDrawing: saveDrawingAsset,
    onError: (message) => toast(message, 'error'),
  })
  const inkBoard = pdfSide.board ?? noteDrawingSession
  // A board mounts with the component itself once the module is loaded (the
  // open prepares it): the lazy wrapper suspends its first render for a turn
  // even then, and the note's first frames showed without its page. Picked
  // per board key, so a mounted board never changes its component type.
  const InkBoardComponent = useMemo(() => loadedDrawingBoard ?? DrawingBoard, [inkBoard.key])

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
    setCalendarOpen(false)
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
        const currentContent = noteContentFlushed(targetPath)
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
  }, [activeTab, noteContentFlushed, openNote, refreshTree, settings.defaultFolder, toast, updateContent, worksheetImportBusy])

  const attachImportedWorksheet = useCallback(async (document: WorksheetDocument) => {
    const targetPath = activePathRef.current
    if (!targetPath) {
      toast('Öffne zuerst eine Notiz, dann Bild einfügen.', 'info')
      return
    }
    const tab = tabsRef.current.find((item) => item.path === targetPath)
    const currentContent = noteContentFlushed(targetPath)
    const nextContent = attachWorksheet(currentContent, document.id)
    updateContent(nextContent)
    setWorksheetSession((current) => current.documents.some((item) => item.id === document.id)
      ? current
      : { key: current.key + 1, documents: [...current.documents, document] })
    toast(/^(bild|image|eingefügt|pasted)(\s|\d|\.|$)/iu.test(document.title.trim()) ? 'Bild eingefügt.' : `„${document.title}“ eingefügt.`, 'success')
  }, [noteContentFlushed, toast, updateContent])

  /**
   * Where a new picture lands on the sheet: centred on the drop point, or on the middle of what the reader sees.
   * Undefined when no sheet is open or the picture's size cannot be read; it then stays a full-width block.
   */
  const placeNewSheetImage = useCallback(async (file: File, at?: { x: number; y: number }) => {
    const paper = unifiedPaperRef.current
    if (!paper) return null
    const natural = await createImageBitmap(file).then((bitmap) => {
      const size = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return size
    }).catch(() => null)
    if (!natural || natural.width < 1 || natural.height < 1) return null
    const frame = measurePaperFrame(paper)
    const layoutPaperPx = frame.unit / Math.max(0.01, frame.zoom)
    if (at) {
      return placementAround({ x: (at.x - frame.left) / frame.unit, y: (at.y - frame.top) / frame.unit }, natural, layoutPaperPx)
    }
    // No drop point: the first free room, so a paste never lands on text, ink or another picture.
    const size = placementAround({ x: 0.5, y: 0 }, natural, layoutPaperPx)
    const width = size.placement.width
    const height = width * size.aspect
    const gap = 0.03
    const obstacles: Array<{ top: number; bottom: number }> = []
    const unitsOf = (rect: DOMRect) => ({ top: (rect.top - frame.top) / frame.unit, bottom: (rect.bottom - frame.top) / frame.unit })
    paper.querySelectorAll<HTMLElement>('.cm-line').forEach((line) => {
      if (line.textContent?.trim()) obstacles.push(unitsOf(line.getBoundingClientRect()))
    })
    paper.querySelectorAll<HTMLElement>('.note-text-field, .worksheet-page').forEach((node) => {
      const rect = node.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) obstacles.push(unitsOf(rect))
    })
    const inkBottom = drawingBoardRef.current?.inkBottom?.() ?? 0
    if (inkBottom > 0) obstacles.push({ top: 0, bottom: inkBottom })
    let top = gap
    const caret = globalThis.document.activeElement?.closest('.cm-editor') && paper.contains(globalThis.document.activeElement)
      ? (globalThis.getSelection()?.rangeCount ? globalThis.getSelection()?.getRangeAt(0) : null)
      : null
    if (caret) {
      const rect = caret.getClientRects()[0] ?? (caret.startContainer instanceof Element ? caret.startContainer : caret.startContainer.parentElement)?.closest('.cm-line')?.getBoundingClientRect()
      if (rect && rect.height > 0) top = unitsOf(rect).bottom + gap
    } else {
      top = Math.max(gap, ...obstacles.map((item) => item.bottom + gap))
    }
    // Slide below whatever the picture would overlap at that height.
    for (let pass = 0; pass < obstacles.length + 1; pass += 1) {
      const hit = obstacles.find((item) => item.top < top + height && item.bottom > top)
      if (!hit) break
      top = hit.bottom + gap
    }
    return { placement: clampSheetPlacement({ width, x: (1 - width) / 2, y: top }), aspect: size.aspect }
  }, [])

  const importImageBytes = useCallback(async (file: File, at?: { x: number; y: number }) => {
    if (!window.fanotes.importWorksheetFromData) {
      toast('Bilder auf das Blatt legen geht in dieser Version noch nicht.', 'error')
      return
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    let document = await window.fanotes.importWorksheetFromData({ name: file.name || 'Bild.png', mimeType: file.type || 'image/png', bytes })
    const placed = document.kind === 'image' ? await placeNewSheetImage(file, at) : null
    if (placed) {
      document = await window.fanotes.saveWorksheet({ ...document, placement: placed.placement, aspect: placed.aspect })
      markFreshSheetImage(document.id)
    }
    await attachImportedWorksheet(document)
  }, [attachImportedWorksheet, placeNewSheetImage, toast])

  /** Swaps the picture of a worksheet for another file, on the same spot of the sheet. */
  const replaceWorksheetImage = useCallback(async (id: string, file: File) => {
    const notePath = activePathRef.current
    const previous = worksheetSession.documents.find((item) => item.id === id)
    if (!notePath || !previous || !window.fanotes.importWorksheetFromData) return
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const created = await window.fanotes.importWorksheetFromData({ name: file.name || 'Bild.png', mimeType: file.type || 'image/png', bytes })
      if (created.kind !== 'image') {
        await window.fanotes.deleteWorksheet(created.id).catch(() => undefined)
        throw new Error('Bitte wähle eine Bilddatei.')
      }
      const natural = previous.placement
        ? await createImageBitmap(file).then((bitmap) => {
          const size = bitmap.height / Math.max(1, bitmap.width)
          bitmap.close()
          return size
        }).catch(() => null)
        : null
      const saved = await window.fanotes.saveWorksheet(previous.placement && natural
        ? { ...created, placement: previous.placement, aspect: natural }
        : created)
      markFreshSheetImage(saved.id)
      const tab = tabsRef.current.find((item) => item.path === notePath)
      const currentContent = noteContentFlushed(notePath)
      updateContent(retargetWorksheetMarkers(currentContent, new Map([[id, saved.id]])))
      worksheetDirtyIdsRef.current.delete(id)
      worksheetLayerRefs.current.delete(id)
      setWorksheetSession((current) => ({ key: current.key + 1, documents: current.documents.map((item) => item.id === id ? saved : item) }))
      await window.fanotes.deleteWorksheet(id).catch(() => undefined)
      toast('Bild ersetzt.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das Bild konnte nicht ersetzt werden.', 'error')
    }
  }, [toast, updateContent, worksheetSession.documents])

  // The second pane's handwriting, read right before the pane shows it
  // (capped), so the pane's first frame has its ink. Like the main pane's
  // prepared ink it is trusted only for PREPARED_INK_TTL_MS: the page can be
  // written elsewhere (its pen editor, the main pane) without its text changing.
  const splitInkReadsRef = useRef(new Map<string, { content: string; at: number; document: DrawingLibraryDocument | null }>())
  const readSplitInk = useCallback(async (path: string, content: string) => {
    const document = await readNoteInk(path, content)
    const reads = splitInkReadsRef.current
    reads.delete(path)
    reads.set(path, { content, at: Date.now(), document })
    while (reads.size > 3) reads.delete(reads.keys().next().value as string)
    return document
  }, [])
  const prepareSplitInk = useCallback(async (path: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.path === path)
    if (!tab || tab.kind === 'pdf' || isPdfNotePath(path)) return
    let timer = 0
    await Promise.race([
      readSplitInk(path, tab.savedContent).catch(() => null),
      new Promise<void>((resolve) => { timer = window.setTimeout(resolve, DOCUMENT_OPEN_PREPARE_MS) }),
    ])
    window.clearTimeout(timer)
  }, [readSplitInk])

  const openInSplit = useCallback(async (path: string) => {
    if (/\.story$/iu.test(path)) {
      setWritingPath(path)
      return
    }
    if (activePathRef.current === path) {
      // Splitting the note you are on: keep it on the left and put the last
      // other note on the right, like duplicating a browser tab side by side.
      const other = noteHistoryRef.current.entries.slice().reverse().find((entry) => entry !== path && tabsRef.current.some((tab) => tab.path === entry))
        ?? tabsRef.current.find((tab) => tab.path !== path)?.path
      if (!other) {
        toast('Öffne zuerst eine zweite Notiz für die geteilte Ansicht.', 'info')
        return
      }
      await prepareSplitInk(other)
      setSplitPath(other)
      return
    }
    if (!tabsRef.current.some((tab) => tab.path === path)) {
      // Load the tab quietly; the main pane keeps its note.
      try {
        const tab = await readNoteTab(path)
        setTagIndex((current) => ({ ...current, [path]: parseNoteTags(tab.content) }))
        setTabs((current) => current.some((item) => item.path === path) ? current : [...current, tab])
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Notiz konnte nicht geöffnet werden.', 'error')
        return
      }
    }
    await prepareSplitInk(path)
    setSplitPath(path)
  }, [prepareSplitInk, readNoteTab, toast])

  /** Ctrl+\ — open the second pane with the most recent other note, or close it. */
  const toggleSplit = useCallback(() => {
    if (splitPathRef.current) {
      splitEditorRef.current?.flushChanges()
      setSplitPath(null)
      return
    }
    const active = activePathRef.current
    if (!active) return
    void openInSplit(active)
  }, [openInSplit])

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
      const raw = typeof snapshot.content === 'string' ? snapshot.content : ''
      const companion = typeof snapshot.companion === 'string' ? snapshot.companion : ''
      // A markdown snapshot stores the text. Its .famd companion, or a PDF
      // snapshot that is the .famd file itself, carries the handwriting.
      const restored = stripFamdPayload(raw)
      const inkSource = companion || raw
      const ink = parseFamd(inkSource).payload?.ink
      if (ink && typeof ink === 'object' && !Array.isArray(ink)) {
        pendingHistoryInkRef.current.set(activePath, ink)
        const markerId = noteInkId(restored)
        const id = markerId || (typeof ink.id === 'string' ? ink.id : 'famd-ink')
        setDrawingSession({
          key: drawingSessionKeyRef.current + 1,
          document: {
            id,
            title: typeof ink.title === 'string' ? ink.title : 'Handschrift',
            updatedAt: new Date().toISOString(),
            imageRelativePath: '',
            dataRelativePath: companionNotePath(activePath, '.famd'),
            drawingJson: JSON.stringify({ ...ink, id }),
          },
          path: activePath,
        })
        drawingSessionKeyRef.current += 1
      } else {
        pendingHistoryInkRef.current.delete(activePath)
      }
      updateContent(restored)
      setHistoryOpen(false)
      toast('Ältere Version wiederhergestellt. Speichern sichert sie.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Version konnte nicht geladen werden.', 'error')
    } finally {
      setHistoryBusy(false)
    }
  }, [activePath, toast, updateContent])

  const readExportNote = useCallback(() => {
    const path = activePathRef.current
    if (!path) return null
    editorRef.current?.flushChanges()
    const tab = tabsRef.current.find((item) => item.path === path)
    const note = editorRef.current?.getText() ?? pendingWrites.current.get(path) ?? tab?.content ?? ''
    return { note, title: tab?.title || 'FaNotes' }
  }, [])

  // ---- Non-text notes (handwriting, PDF notes) -------------------------------------------------------------
  // A handwriting note becomes a vector PDF (or a DOCX of page pictures plus its text boxes); a PDF note is its
  // original PDF with the user's ink, highlights and text boxes drawn onto the pages (or the untouched original).
  const exportNonTextNote = useCallback(async (
    kind: 'ink' | 'pdf',
    format: 'pdf' | 'docx',
    options: NoteExportOptions,
    current: { note: string; title: string },
  ): Promise<{ filename: string; blob: Blob; message: string } | null> => {
    const { exportNonTextNoteBytes } = await import('./lib/noteExport/nonTextNote')
    const pdfPath = activePathRef.current ?? undefined
    // A handwriting note is the sheet on screen, with every section open.
    const folds = kind === 'ink' ? editorRef.current?.captureFolds() ?? [] : null
    try {
      const bytes = await exportNonTextNoteBytes(kind, format, options, {
        board: drawingBoardRef.current,
        pdfPath,
        note: current.note,
        title: current.title,
      })
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      const docx = format === 'docx'
      const type = docx ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf'
      const original = kind === 'pdf' && format === 'pdf' && options.annotations === false
      return {
        filename: `${noteExportBaseName(current.title)}.${docx ? 'docx' : 'pdf'}`,
        blob: new Blob([copy], { type }),
        message: docx ? 'Word-Dokument gespeichert.' : original ? 'Original-PDF gespeichert. Handschrift und Markierungen sind nicht enthalten.' : kind === 'pdf' ? 'PDF mit Handschrift und Markierungen gespeichert.' : 'PDF gespeichert.',
      }
    } finally {
      if (folds) editorRef.current?.restoreFolds(folds)
      if (kind === 'ink') drawingBoardRef.current?.finishCanvasExport()
    }
  }, [])

  const [exportDialog, setExportDialog] = useState<{ kind: NoteExportKind; title: string } | null>(null)
  const openExportDialog = useCallback(() => {
    const current = readExportNote()
    if (!current) {
      toast('Öffne eine Notiz im Editor, um sie zu exportieren.', 'info')
      return
    }
    const pdfPath = activePathRef.current
    const kind: NoteExportKind = pdfPath && isPdfNotePath(pdfPath) ? 'pdf' : noteInkId(current.note) ? 'ink' : 'text'
    setExportDialog({ kind, title: current.title })
  }, [readExportNote, toast])

  const runNoteExport = useCallback(async (options: NoteExportOptions, signal: AbortSignal) => {
    const current = readExportNote()
    if (!current) throw new Error('Öffne eine Notiz im Editor, um sie zu exportieren.')
    const notePath = activePathRef.current ?? ''
    const kind = exportDialog?.kind ?? 'text'
    try {
      let file: { filename: string; blob: Blob }
      let message = 'Export gespeichert.'
      if (kind === 'text') {
        // Loaded on first use: Markdown, KaTeX, OOXML and JSZip stay off the startup path.
        const { exportTextNote, createVaultImageResolver } = await import('./lib/noteExport')
        file = await exportTextNote({
          markdown: current.note,
          title: current.title,
          signal,
          resolveImage: createVaultImageResolver(notePath, (relativePath) => window.fanotes.readAssetBytes(relativePath)),
        }, options)
        message = options.format === 'pdf' ? 'PDF gespeichert.' : options.format === 'docx' ? 'Word-Dokument gespeichert.' : options.format === 'latex' ? 'LaTeX-Code exportiert.' : 'Markdown exportiert.'
      } else {
        const result = await exportNonTextNote(kind, options.format === 'docx' ? 'docx' : 'pdf', options, current)
        if (!result) throw new Error('Der Export ist fehlgeschlagen.')
        file = result
        message = result.message
      }
      if (signal.aborted) throw new DOMException('Der Export wurde abgebrochen.', 'AbortError')
      saveExportFile(file.filename, file.blob)
      toast(message, kind === 'pdf' ? 'info' : 'success')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      if (signal.aborted) throw new DOMException('Der Export wurde abgebrochen.', 'AbortError')
      throw error
    }
  }, [exportDialog?.kind, exportNonTextNote, readExportNote, toast])

  const insertSimpleLatex = useCallback((button: SimpleLatexButton, operands: SimpleLatexOperands) => {
    if (!activePathRef.current || drawingOpen || overviewOpen || homeworkOpen || calendarOpen || glyphenWerkOpen) {
      toast('Öffne eine Notiz im Editor, um LaTeX einzufügen.', 'info')
      return
    }
    if (activeEntryMutating) {
      toast('Diese Notiz ist während der Dateiaktion schreibgeschützt.', 'error')
      return
    }
    const text = editorRef.current?.getText()
    const selection = editorRef.current?.getSelection()
    if (text == null) {
      toast('Die Formel konnte nicht eingefügt werden.', 'error')
      return
    }
    try {
      const cursor = selection?.to ?? text.length
      const result = applySimpleLatexButton(text, button, operands, cursor)
      const chunk = result.note.slice(cursor, cursor + (result.note.length - text.length))
      if (!editorRef.current?.insertText(chunk, 'cursor')) toast('Die Formel konnte nicht eingefügt werden.', 'error')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Nur Zahlen oder Wörter, kein LaTeX-Code.', 'error')
    }
  }, [activeEntryMutating, calendarOpen, drawingOpen, glyphenWerkOpen, homeworkOpen, overviewOpen, toast])

  const pendingWorksheetDeletes = useRef(new Map<string, number>())

  /**
   * A picture goes at once and comes back with one click: only the note's marker and the layer disappear, the files
   * are deleted when the undo toast is gone.
   */
  const removeSheetImageWithUndo = useCallback(async (document: WorksheetDocument) => {
    const notePath = activePathRef.current
    if (!notePath) return
    const id = document.id
    await worksheetLayerRefs.current.get(id)?.flush().catch(() => undefined)
    const tab = tabsRef.current.find((item) => item.path === notePath)
    const currentContent = noteContentFlushed(notePath)
    const nextContent = detachWorksheet(currentContent, id)
    if (nextContent !== currentContent) updateContent(nextContent)
    worksheetDirtyIdsRef.current.delete(id)
    worksheetLayerRefs.current.delete(id)
    setWorksheetSession((current) => ({ key: current.key + 1, documents: current.documents.filter((item) => item.id !== id) }))
    pendingWorksheetDeletes.current.set(id, window.setTimeout(() => {
      pendingWorksheetDeletes.current.delete(id)
      void window.fanotes.deleteWorksheet(id).catch(() => undefined)
    }, UNDO_TOAST_MS + 1500))
    toast('Bild entfernt', 'info', {
      label: 'Rückgängig',
      run: () => {
        const timer = pendingWorksheetDeletes.current.get(id)
        if (timer === undefined) return
        window.clearTimeout(timer)
        pendingWorksheetDeletes.current.delete(id)
        void (async () => {
          try {
            const restored = await window.fanotes.readWorksheet(id)
            if (activePathRef.current === notePath) {
              const latestTab = tabsRef.current.find((item) => item.path === notePath)
              const latest = noteContentFlushed(notePath)
              updateContent(attachWorksheet(latest, id))
              markFreshSheetImage(id)
              setWorksheetSession((current) => current.documents.some((item) => item.id === id)
                ? current
                : { key: current.key + 1, documents: [...current.documents, restored] })
            } else {
              await window.fanotes.writeFile(notePath, attachWorksheet(await window.fanotes.readFile(notePath), id))
            }
          } catch {
            toast('Das Bild ließ sich nicht wiederherstellen.', 'error')
          }
        })()
      },
    })
  }, [toast, updateContent])

  const removeWorksheetFromNote = useCallback(async (id: string) => {
    const document = worksheetSession.documents.find((item) => item.id === id)
    const label = document?.title ?? 'Arbeitsblatt'
    if (document?.kind === 'image') {
      await removeSheetImageWithUndo(document)
      return
    }
    if (!await requestConfirm(`„${label}“ wirklich aus dieser Notiz entfernen? Die PDF-/Bilddatei wird aus dem Vault gelöscht.`, { title: 'Arbeitsblatt entfernen' })) {
      return
    }
    const notePath = activePathRef.current
    if (!notePath) return
    try {
      await window.fanotes.deleteWorksheet(id)
      const tab = tabsRef.current.find((item) => item.path === notePath)
      const currentContent = noteContentFlushed(notePath)
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
  }, [removeSheetImageWithUndo, requestConfirm, toast, updateContent, worksheetSession.documents])

  /** Opens the OneNote page picker; the dialog asks for the file, converts it and imports the chosen pages. */
  const importOneNote = useCallback(async (): Promise<null> => {
    if (isWeb) throw new Error('Binäre OneNote-Notizbücher werden sicher in der Linux- oder Windows-App importiert.')
    setWorksheetImportOpen(false)
    setOneNoteDialogOpen(true)
    return null
  }, [isWeb])

  const oneNoteFolders = useMemo(() => oneNoteDialogOpen
    ? [...folderPaths(tree)].filter((entry) => !entry.split('/').some((segment) => segment.startsWith('.') || /\.story$/iu.test(segment)))
    : [], [oneNoteDialogOpen, tree])

  const finishOneNoteImport = useCallback((result: OneNoteImportResult) => {
    vaultStructureRevisionRef.current += 1
    void refreshTree().then(async () => {
      if (result.imported[0]) await openNote(result.imported[0].path)
    }).catch(() => undefined)
    toast(`${result.imported.length} ${result.imported.length === 1 ? 'OneNote-Seite' : 'OneNote-Seiten'} als normale Notizen importiert.`, 'success')
  }, [openNote, refreshTree, toast])

  /** Commands contributed by running add-ons; each run is isolated by the runtime and can never throw here. */
  const addonPaletteActions = useMemo<PaletteAction[]>(() => addonState.commands.map((command) => {
    const addonName = addonState.installed.find((record) => record.id === command.addonId)?.manifest.name ?? command.addonId
    return {
      id: `addon:${command.addonId}:${command.id}`,
      label: command.title,
      detail: command.detail,
      shortcut: command.shortcut,
      group: `Add-on: ${addonName}`,
      keywords: `${command.keywords ?? ''} ${addonName} addon`,
      icon: <Puzzle size={15} />,
      run: () => { void addonRuntime.runCommand(command.addonId, command.id) },
    }
  }), [addonState.commands, addonState.installed])

  const paletteActions = useMemo<PaletteAction[]>(() => [
    { id: 'new-note', label: 'Neue Notiz', detail: 'Markdown-Datei im Standardordner', shortcut: 'Ctrl N', group: 'Dateien', icon: <FilePlus2 size={15} />, run: () => void createNote() },
    { id: 'import-pdf-note', label: 'PDF importieren', detail: 'PDF wird selbst zur Notiz — mit Handschrift und Viewer', group: 'Dateien', keywords: 'pdf import notiz viewer', icon: <FileText size={15} />, run: () => void importPdfNote() },
    { id: 'new-folder', label: 'Neuer Ordner', detail: 'Fach auf oberster Ebene anlegen', group: 'Dateien', icon: <FolderPlus size={15} />, run: () => void createFolder() },
    { id: 'new-story', label: 'Neue Geschichte', detail: 'Schreibmodus mit Seiten, Kapiteln und Szenen', group: 'Dateien', keywords: 'geschichte roman buch schreiben story novel writing kapitel', icon: <BookOpen size={15} />, run: () => void createStory() },
    { id: 'import-story', label: 'Geschichte importieren …', detail: 'Word (.docx), Markdown oder Text als Geschichte öffnen', group: 'Dateien', keywords: 'import docx word markdown geschichte roman story', icon: <BookOpen size={15} />, run: () => setStoryImportParent('') },
    { id: 'new-subfolder', label: 'Unterordner anlegen', detail: activeTab ? `In ${parentPath(activeTab.path) || 'Vault-Wurzel'}` : 'Rechtsklick auf einen Ordner oder hier nach dem Öffnen einer Notiz', group: 'Dateien', keywords: 'unterordner ordner verschachteln fach', icon: <FolderPlus size={15} />, run: () => void createFolder(activeTab ? parentPath(activeTab.path) || undefined : undefined) },
    { id: 'save', label: 'Aktuelle Notiz speichern', detail: 'Text, Handschrift und Arbeitsblätter sichern', shortcut: 'Ctrl S', group: 'Dateien', icon: <Save size={15} />, run: () => { void saveCurrentWork(true) } },
    { id: 'search', label: 'Im Vault suchen', shortcut: 'Ctrl ⇧ F', group: 'Navigation', icon: <Search size={15} />, run: () => setSearchOpen(true) },
    { id: 'drawing', label: drawingOpen ? 'Zur Tastatur wechseln' : 'Mit Stift schreiben', detail: 'Eingabeart auf derselben Notizseite wechseln', shortcut: 'Ctrl D', group: 'Werkzeuge', keywords: 'tablet stift erkennen mathe', icon: <PenLine size={15} />, run: toggleDrawing },
    { id: 'note-link', label: 'Verlinkung setzen', detail: 'Irgendwo auf der Seite eine neue Notiz verlinken', group: 'Werkzeuge', keywords: 'verlinkung link notiz pdf symbol text', icon: <Link2 size={15} />, run: startNoteLinkPlacement },
    { id: 'text-field', label: 'Textfeld einfügen', detail: 'Irgendwo auf der Seite mit der Tastatur schreiben', group: 'Werkzeuge', keywords: 'textfeld text tastatur pdf schreiben', icon: <Type size={15} />, run: startTextFieldPlacement },
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
    { id: 'onenote-import', label: 'Microsoft OneNote importieren', detail: 'Seiten und Zielordner wählen, Handschrift als .famd-Ink übernehmen', group: 'Dateien', keywords: 'one onetoc2 onepkg onedrive migration', icon: <NotebookTabs size={15} />, run: () => { void importOneNote().catch((error) => toast(error instanceof Error ? error.message : 'OneNote-Import fehlgeschlagen.', 'error')) } },
    { id: 'ai-assistant', label: 'AI-Assistent', detail: 'LM Studio, Ollama, OpenAI, Gemini, Anthropic, Grok oder OpenCode nutzen', shortcut: 'Ctrl ⇧ A', group: 'Werkzeuge', keywords: 'ki ai lm studio ollama openai gemini anthropic grok opencode rechtschreibung fakten', icon: <Bot size={15} />, run: openLmStudio },
    { id: 'glyphenwerk', label: 'GlyphenWerk öffnen', detail: 'Handschrift trainieren, live testen, korrigieren und verwalten', shortcut: 'Ctrl ⇧ G', group: 'Werkzeuge', keywords: 'training erkennung symbole test datensatz', icon: <Database size={15} />, run: openGlyphenWerk },
    { id: 'overview', label: 'Vault-Übersicht', detail: 'Ordner und offene Notizen überblicken', group: 'Navigation', icon: <Network size={15} />, run: openOverview },
    { id: 'study', label: 'Lernzeit', detail: 'Zeit, Tippen und Handschrift je Fach, nur lokal', group: 'Ansicht', keywords: 'statistik lernen heatmap', icon: <BarChart3 size={15} />, run: () => { setStudyOpen(true); setOverviewOpen(false); setHomeworkOpen(false); setCalendarOpen(false); setGlyphenWerkOpen(false) } },
    ...(pdfSide.available ? [{ id: 'pdf-side-pages', label: pdfSide.shown ? 'Leere Seiten daneben ausblenden' : 'Leere Seiten daneben', detail: 'Neben jeder PDF-Seite eine leere Schreibseite gleicher Grösse', group: 'Ansicht', keywords: 'pdf leer seite daneben rechts notizen schreiben platz side blank page', icon: <SquareSplitHorizontal size={15} />, run: () => { if (isPdfActive) void pdfSide.toggle(); else toast('Öffne zuerst ein PDF.', 'info') } }] : []),
    { id: 'flashcards', label: 'Karteikarten', detail: 'Lernfragen dieser Notiz wiederholen', group: 'Lernen', keywords: 'flashcards karten spaced', icon: <Sparkles size={15} />, run: () => { editorRef.current?.flushChanges(); setCardsOpen(true) } },
    ...NOTE_TEMPLATES.map((german) => {
      const template = localizeTemplate(german, getUiLanguage())
      return {
      id: `template-${template.id}`,
      label: `Vorlage: ${german.title}`,
      detail: 'In den aktuellen Ordner einfügen',
      group: 'Vorlagen',
      keywords: `vorlage template ${template.profile} ${template.title}`,
      icon: <FilePlus2 size={15} />,
      run: () => {
        const folder = activePathRef.current ? activePathRef.current.split('/').slice(0, -1).join('/') : settingsRef.current.defaultFolder
        void window.fanotes.createNote(folder || undefined, template.fileName).then(async (created) => {
          await window.fanotes.writeFile(created.relativePath, template.markdown)
          await openNoteRef.current(created.relativePath)
        }).catch((error) => toast(error instanceof Error ? error.message : 'Vorlage konnte nicht angelegt werden.', 'error'))
      },
    }
    }),
    { id: 'homework', label: 'Hausaufgaben & Termine', detail: 'To-dos, Hausaufgaben und Termine mit Fälligkeit', group: 'Navigation', keywords: 'todo hausaufgaben schule termin fällig aufgabe checklist', icon: <ClipboardList size={15} />, run: openHomework },
    { id: 'calendar', label: 'Kalender', detail: 'Tag, 3 Tage, Woche, Monat und Agenda', group: 'Navigation', keywords: 'kalender termin woche monat agenda notion calendar event', icon: <CalendarDays size={15} />, run: openCalendar },
    { id: 'daily', label: 'Heutige Tagesnotiz', detail: settings.dailyNotesFolder, group: 'Dateien', icon: <CalendarDays size={15} />, run: () => void createDailyNote() },
    { id: 'daily-previous', label: 'Vorherige Tagesnotiz', detail: settings.dailyNotesFolder, group: 'Dateien', keywords: 'gestern tagesnotiz daily previous', icon: <ArrowLeft size={15} />, run: () => { void openAdjacentDaily(-1) } },
    { id: 'daily-next', label: 'Nächste Tagesnotiz', detail: settings.dailyNotesFolder, group: 'Dateien', keywords: 'morgen tagesnotiz daily next', icon: <ArrowRight size={15} />, run: () => { void openAdjacentDaily(1) } },
    { id: 'duplicate-note', label: 'Notiz duplizieren', detail: 'Text, Handschrift und Verlinkungen als neue Notiz', shortcut: 'Alt ⇧ D', group: 'Dateien', keywords: 'duplizieren kopie copy duplicate klonen', icon: <Files size={15} />, run: () => { if (activePath) void duplicateNote(activePath) } },
    { id: 'copy-wiki-link', label: 'Wiki-Link kopieren', detail: '[[Titel]] in die Zwischenablage', group: 'Dateien', keywords: 'wiki link kopieren verweis', icon: <Link2 size={15} />, run: () => { if (activePath) copyWikiLink(activePath) } },
    { id: 'insert-date', label: 'Datum einfügen', detail: 'Setzt das Datumsformat an der Schreibmarke ein', shortcut: 'Ctrl ⇧ D', group: 'Werkzeuge', keywords: 'datum date stempel', icon: <CalendarDays size={15} />, run: () => insertStamp(false) },
    { id: 'insert-date-time', label: 'Datum und Uhrzeit einfügen', detail: 'Datum plus Stunde und Minute', group: 'Werkzeuge', keywords: 'datum uhrzeit date time stempel', icon: <CalendarDays size={15} />, run: () => insertStamp(true) },
    { id: 'toggle-task', label: 'Aufgabe umschalten', detail: 'Die Aufgabe der aktuellen Zeile umschalten', shortcut: 'Ctrl Enter', group: 'Schreiben', keywords: 'aufgabe checkbox todo erledigt task', icon: <ListChecks size={15} />, run: toggleTask },
    { id: 'export-note', label: 'Notiz exportieren …', detail: 'PDF, Word, LaTeX oder Markdown', group: 'Dateien', keywords: 'pdf export drucken print formel word docx latex tex markdown md', icon: <FileDown size={15} />, run: () => openExportDialog() },
    { id: 'history', label: 'Versionsverlauf', detail: 'Frühere Stände dieser Notiz ansehen und wiederherstellen', group: 'Dateien', keywords: 'history version wiederherstellen', icon: <History size={15} />, run: () => void openHistory() },
    { id: 'quick-open', label: 'Notiz öffnen …', detail: 'Schnell zu einer Notiz springen', shortcut: 'Ctrl O', group: 'Navigation', keywords: 'quick open switcher wechseln springen', icon: <Files size={15} />, run: () => { setPaletteMode('notes'); setPaletteOpen(true) } },
    { id: 'nav-back', label: 'Zurück', detail: 'Zur zuvor geöffneten Notiz', shortcut: 'Alt ←', group: 'Navigation', keywords: 'zurück verlauf history', icon: <ArrowLeft size={15} />, run: () => void navigateHistory(-1) },
    { id: 'nav-forward', label: 'Vorwärts', detail: 'Wieder zur nächsten Notiz im Verlauf', shortcut: 'Alt →', group: 'Navigation', keywords: 'vorwärts verlauf history', icon: <ArrowRight size={15} />, run: () => void navigateHistory(1) },
    { id: 'reopen-tab', label: 'Geschlossenen Tab wieder öffnen', shortcut: 'Ctrl ⇧ T', group: 'Navigation', keywords: 'tab wieder öffnen geschlossen', icon: <History size={15} />, run: () => void reopenClosedTab() },
    { id: 'split', label: splitPath ? 'Geteilte Ansicht schließen' : 'Geteilte Ansicht öffnen', detail: 'Zwei Notizen nebeneinander oder untereinander', shortcut: 'Ctrl \\', group: 'Ansicht', keywords: 'split teilen nebeneinander zweite spalte', icon: <Columns2 size={15} />, run: toggleSplit },
    ...(splitPath ? [
      { id: 'split-swap', label: 'Geteilte Ansicht tauschen', detail: 'Linke und rechte Notiz wechseln die Seite', shortcut: 'Ctrl ⇧ \\', group: 'Ansicht', keywords: 'split tauschen wechseln', icon: <ArrowLeftRight size={15} />, run: () => void swapSplitPanes() },
      { id: 'split-orientation', label: splitLayout.orientation === 'columns' ? 'Untereinander anordnen' : 'Nebeneinander anordnen', group: 'Ansicht', keywords: 'split zeilen spalten anordnung', icon: splitLayout.orientation === 'columns' ? <Rows2 size={15} /> : <Columns2 size={15} />, run: toggleSplitOrientation },
    ] : []),
    { id: 'focus', label: focusMode ? 'Fokusmodus verlassen' : 'Fokusmodus starten', detail: 'Blendet Seitenleisten für ungestörtes Schreiben aus', shortcut: 'Ctrl ⇧ E', group: 'Ansicht', icon: <Maximize2 size={15} />, run: toggleFocusMode },
    { id: 'sidebar', label: 'Dateileiste umschalten', group: 'Ansicht', icon: <PanelLeftClose size={15} />, run: () => setSidebarVisible((value) => !value) },
    { id: 'inspector', label: 'Gliederung umschalten', group: 'Ansicht', icon: <PanelRightClose size={15} />, run: () => setInspectorVisible((value) => !value) },
    { id: 'settings', label: 'Einstellungen öffnen', shortcut: 'Ctrl ,', group: 'FaNotes', icon: <Settings size={15} />, run: () => openSettings() },
    ...(syncApi && syncState.account ? [{ id: 'sync-now', label: 'Jetzt synchronisieren', detail: syncStatusLabel(syncState), group: 'FaNotes', keywords: 'sync synchronisieren cloud server geräte', icon: <Cloud size={15} />, run: () => { void syncEngine.syncNow('manual') } }] : []),
    ...(syncApi ? [{ id: 'sync-settings', label: syncState.account ? 'Sync-Einstellungen' : 'Sync einrichten', detail: syncState.account ? (syncState.account.username || syncState.account.email) : 'Konto erstellen oder anmelden – Notizen auf allen Geräten', group: 'FaNotes', keywords: 'sync konto anmelden cloud geräte account login', icon: <Cloud size={15} />, run: () => openSettings('sync') }] : []),
    { id: 'addon-store', label: 'Add-on-Store', detail: 'Add-ons aus GitHub entdecken, installieren und verwalten', group: 'FaNotes', keywords: 'addon add-on plugin erweiterung store extension', icon: <Puzzle size={15} />, run: () => setAddonStoreOpen(true) },
    ...addonPaletteActions,
    { id: 'reveal', label: isWeb ? 'Notiz herunterladen' : 'Im Dateimanager zeigen', detail: isWeb ? 'Aktuelle Notiz exportieren' : 'Speicherort der geöffneten Notiz öffnen', group: 'Dateien', keywords: 'ordner explorer finder dateimanager download export', icon: isWeb ? <Download size={15} /> : <FolderOpen size={15} />, run: () => { if (activePath) void window.fanotes.revealInFolder(activePath) } },
    ...(workRequestsAllowed ? [{ id: 'work-requests', label: 'Fehler & Wünsche', detail: 'Fehler oder Funktion melden und den Fortschritt verfolgen', shortcut: 'Ctrl ⇧ B', group: 'FaNotes', keywords: 'wunsch funktion anfrage claude fehler bug request', icon: <Lightbulb size={15} />, run: () => setWorkRequestsOpen(true) }] : []),
    { id: 'bug-report', label: 'Fehler melden', detail: 'Kurz beschreiben; die letzten fünf Minuten werden angehängt', group: 'FaNotes', keywords: 'bug report fehler logs support', icon: <Bug size={15} />, run: () => setBugReportOpen(true) },
    { id: 'quit', label: isWeb ? 'Zur FaNotes-Website' : 'FaNotes beenden', shortcut: 'Ctrl Q', group: 'FaNotes', icon: <X size={15} />, run: () => window.fanotes.requestClose() },
  ], [pdfSide.available, pdfSide.shown, pdfSide.toggle, addonPaletteActions, activePath, activeTab, syncApi, syncState, attachBookToSubject, bookOpen, copyWikiLink, createDailyNote, createFolder, createNote, currentBook, drawingOpen, duplicateNote, openExportDialog, focusMode, importOneNote, importPdfNote, insertStamp, isWeb, navigateHistory, openAdjacentDaily, openCalendar, openGlyphenWerk, openHistory, workRequestsAllowed, openHomework, openLmStudio, openOverview, openSettings, openWorksheetImport, reopenClosedTab, saveCurrentWork, settings.dailyNotesFolder, splitLayout.orientation, splitPath, startNoteLinkPlacement, startTextFieldPlacement, swapSplitPanes, toast, toggleBookView, toggleDrawing, toggleFocusMode, toggleSplit, toggleTask, toggleSplitOrientation])

  // ---- Add-ons -------------------------------------------------------------
  // Everything add-ons may touch flows through this bridge. The deps object is
  // rebuilt every render but read through a ref, so the runtime (a module
  // singleton) always sees current state without ever being re-attached.
  const addonsApi = window.fanotes?.addons ?? null
  const addonFetchText = useMemo(() => (addonsApi ? createAddonFetchText(addonsApi) : null), [addonsApi])
  const addonSource = useMemo(() => parseAddonSource(settings.addonSource), [settings.addonSource])
  const paletteActionsRef = useRef(paletteActions)
  paletteActionsRef.current = paletteActions
  const addonNoteChangeTimers = useRef(new Map<string, number>())
  const addonDeps: AppAddonDeps = {
    appVersion: APP_VERSION,
    platform: window.fanotes?.platform ?? 'web',
    web: isWeb,
    language: () => getUiLanguage(),
    tree: () => treeRef.current,
    activePath: () => activePathRef.current,
    activeKind: () => {
      const path = activePathRef.current
      if (!path) return 'none'
      if (isPdfNotePath(path)) return 'pdf'
      return drawingOpen ? 'ink' : 'markdown'
    },
    noteContent: (path) => {
      const pending = pendingWrites.current.get(path)
      if (typeof pending === 'string') return pending
      const tab = tabsRef.current.find((candidate) => candidate.path === path)
      return tab ? tab.content : null
    },
    updateOpenNote: (path, content) => {
      if (!tabsRef.current.some((tab) => tab.path === path)) return false
      updateContentFor(path, content)
      return true
    },
    readFile: (path) => window.fanotes.readFile(path),
    writeFile: async (path, content) => {
      await window.fanotes.writeFile(path, content)
      await refreshTree().catch(() => undefined)
    },
    createNote: async (folder, name) => {
      const created = await window.fanotes.createNote(folder, name)
      await refreshTree().catch(() => undefined)
      addonRuntime.emit('note:created', { path: created.relativePath })
      return created.relativePath
    },
    openNote: (path) => openNote(path),
    search: (query) => window.fanotes.search(query),
    createFolder: async (parent, name) => {
      const created = await window.fanotes.createFolder(parent, name)
      await refreshTree().catch(() => undefined)
      return created.relativePath
    },
    renameEntry: async (path, name) => {
      await renameEntry(path, name)
      const parent = parentPath(path)
      return parent ? `${parent}/${name}` : name
    },
    moveEntry: async (path, folder) => {
      await moveEntry(path, folder)
      return folder ? `${folder}/${fileName(path)}` : fileName(path)
    },
    trashEntry: async (path) => {
      await trashEntry(path)
      addonRuntime.emit('note:deleted', { path })
    },
    refreshTree: () => refreshTree(),
    editor: {
      getText: () => editorRef.current?.getText() ?? (activePathRef.current ? (pendingWrites.current.get(activePathRef.current) ?? tabsRef.current.find((tab) => tab.path === activePathRef.current)?.content ?? null) : null),
      getSelection: () => editorRef.current?.getSelection() ?? null,
      insert: (text, where) => editorRef.current?.insertText(text, where) ?? false,
      replaceSelection: (text) => editorRef.current?.replaceSelection(text) ?? false,
      setText: (text) => editorRef.current?.setText(text) ?? false,
      format: (action) => editorRef.current?.format(action as MarkdownFormatAction) ?? false,
    },
    readInk: async (path) => {
      const document = await window.fanotes.readFamdInk(path)
      if (!document) return null
      try {
        return JSON.parse(document.drawingJson)
      } catch {
        return null
      }
    },
    writeInk: async (path, strokes, mode) => {
      const clean = sanitizeAddonStrokes(strokes)
      if (!clean) return false
      const current = await window.fanotes.readFamdInk(path).catch(() => null)
      const drawingJson = inkDocumentWithStrokes(current?.drawingJson ?? null, clean, mode)
      await window.fanotes.saveDrawing({
        id: current?.id,
        title: current?.title || 'Handschrift',
        drawingJson,
        noteRelativePath: path,
      })
      return true
    },
    runRecognition: async (request) => {
      const language = request.language === 'en' || request.language === 'fr' || request.language === 'de' ? request.language : settingsRef.current.recognitionLanguage
      const text = typeof request.text === 'string' ? request.text : ''
      return { text: polishRecognizedText(text, language), language, source: 'lexicon' }
    },
    readCalendar: async () => {
      try {
        const loaded = loadCalendarMarkdown(await window.fanotes.readFile(CALENDAR_NOTE_PATH))
        if (!loaded.ok) throw new Error('Kalender.md konnte nicht gelesen werden.')
        return loaded.document
      } catch (error) {
        if (isMissingNoteError(error)) return emptyCalendarDocument()
        throw error
      }
    },
    writeCalendar: async (document) => {
      const clean = sanitizeCalendarDocument(document)
      await window.fanotes.writeFile(CALENDAR_NOTE_PATH, serializeCalendarMarkdown(clean))
      return true
    },
    readHomework: async () => {
      try {
        const loaded = loadHomeworkMarkdown(await window.fanotes.readFile(HOMEWORK_NOTE_PATH))
        if (!loaded.ok) throw new Error('Hausaufgaben.md konnte nicht gelesen werden.')
        return loaded.document
      } catch (error) {
        if (isMissingNoteError(error)) return { version: 1 as const, tasks: [] }
        throw error
      }
    },
    writeHomework: async (document) => {
      if (!document || typeof document !== 'object') return false
      const markdown = serializeHomeworkMarkdown(document as HomeworkDocument)
      await window.fanotes.writeFile(HOMEWORK_NOTE_PATH, markdown)
      return true
    },
    pageStats: (path) => {
      const session = pageStatsRef.current.get(path)
      return session ? snapshotPageStats(session) : null
    },
    settings: () => settingsRef.current,
    writeClipboard: (text) => navigator.clipboard.writeText(text),
    fetch: async (url, init) => {
      if (!addonsApi?.netFetch) throw new Error('Netzwerkzugriff für Add-ons ist in der Web-Version nicht verfügbar.')
      return addonsApi.netFetch(url, init)
    },
    toast: (message, kind) => toast(message, kind),
    confirm: (message, options) => requestConfirm(message, options),
    prompt: (message, options) => new Promise<string | null>((resolve) => {
      setAddonPrompt({
        title: options.title ?? 'Add-on',
        message,
        placeholder: options.placeholder,
        value: options.value,
        multiline: options.multiline,
        resolve: (value) => {
          setAddonPrompt(null)
          resolve(value)
        },
      })
    }),
    openExternal: (url) => window.fanotes.openExternal(url),
    paletteActions: () => paletteActionsRef.current,
  }
  const addonDepsRef = useRef(addonDeps)
  addonDepsRef.current = addonDeps

  useEffect(() => {
    if (!addonsApi) return
    const live = new Proxy({} as AppAddonDeps, { get: (_target, key) => addonDepsRef.current[key as keyof AppAddonDeps] })
    addonRuntime.attach(createAppAddonBridge(live), createAddonStoragePort(addonsApi))
    // Add-ons never delay startup: they load after the first idle moment.
    let cancelled = false
    const begin = () => {
      if (cancelled) return
      void addonRuntime.start().then(async () => {
        if (cancelled || !settingsRef.current.addonsAutoUpdate || !addonFetchText) return
        if (!addonRuntime.getState().installed.some((record) => record.origin === 'store')) return
        const index = await addonIndexCache.load(parseAddonSource(settingsRef.current.addonSource), addonFetchText)
        const updates = addonRuntime.updatesFor(index)
        let updated = 0
        for (const update of updates) {
          try {
            await addonRuntime.install(update.entry, addonFetchText)
            updated += 1
          } catch (error) {
            console.warn(`Add-on ${update.record.id} konnte nicht aktualisiert werden:`, error)
          }
        }
        if (updated && !cancelled) toast(updated === 1 ? 'Ein Add-on wurde aktualisiert.' : `${updated} Add-ons wurden aktualisiert.`, 'info')
      })
    }
    const useIdle = typeof window.requestIdleCallback === 'function'
    const idle = useIdle ? window.requestIdleCallback(begin, { timeout: 4000 }) : window.setTimeout(begin, 1500)
    return () => {
      cancelled = true
      if (useIdle) window.cancelIdleCallback(idle)
      else window.clearTimeout(idle)
    }
  }, [addonFetchText, addonsApi, toast])

  useEffect(() => {
    if (!activePath) return
    addonRuntime.emit('note:opened', { path: activePath, title: stripExtension(fileName(activePath)), kind: isPdfNotePath(activePath) ? 'pdf' : 'markdown' })
  }, [activePath])

  useEffect(() => {
    addonRuntime.emit('mode:changed', { mode: drawingOpen ? 'ink' : 'keyboard', path: activePath })
  }, [activePath, drawingOpen])

  useEffect(() => {
    addonRuntime.emit('vault:changed', { notes: collectNotePaths(tree).length })
  }, [tree])

  useEffect(() => {
    addonRuntime.emit('settings:changed', safeSettingsView(settings))
  }, [settings])

  const addonNoteChanged = useCallback((path: string, content: string) => {
    if (!addonRuntime.hasSubscribers('note:changed')) return
    const timers = addonNoteChangeTimers.current
    const existing = timers.get(path)
    if (existing) window.clearTimeout(existing)
    timers.set(path, window.setTimeout(() => {
      timers.delete(path)
      addonRuntime.emit('note:changed', { path, length: content.length })
    }, 400))
  }, [])
  addonNoteChangedRef.current = addonNoteChanged

  const openAddonStore = useCallback(() => setAddonStoreOpen(true), [])

  /** Notes for the quick switcher: the whole vault, most recently visited first. */
  const switcherNotes = useMemo(() => {
    const paths = collectNotePaths(tree).filter((path) => isNoteFileName(fileName(path)) || isPdfNotePath(path))
    const recent = [...noteHistory.entries].reverse()
    return { paths, recent }
  }, [noteHistory.entries, tree])

  const recentClosedNotes = useMemo(() => {
    const existing = new Set(collectNotePaths(tree))
    return recentNotePaths(noteHistory.entries, (path) => existing.has(path), 5, activePath)
      .map((path) => ({ path, title: noteTitleFromPath(path) }))
  }, [activePath, noteHistory.entries, tree])

  const rankNotesForPalette = useCallback((query: string, limit: number) => (
    rankSwitcherNotes(switcherNotes.paths, query, switcherNotes.recent, limit)
  ), [switcherNotes])

  const closePalette = useCallback(() => {
    setPaletteOpen(false)
    setPaletteMode('commands')
  }, [])

  const closeTabMenu = useCallback(() => setTabMenu(null), [])

  // A note dragged from a tab or the tree onto an edge of the editor opens beside the current one.
  const dropNoteIntoSplit = useCallback(async (path: string, zone: SplitDropZone) => {
    const { orientation, first } = splitPlacementForZone(zone)
    const active = activePathRef.current
    const split = splitPathRef.current
    if (!active || /\.story$/iu.test(path)) return
    if (path === active && !split) {
      toast('Ziehe eine andere Notiz an den Rand, um die Ansicht zu teilen.', 'info')
      return
    }
    setSplitLayout((current) => current.orientation === orientation ? current : { ...current, orientation })
    if (path === active || path === split) {
      // A note that is already open moves to the side it was dropped on.
      if ((path === active) !== first) await swapSplitPanes()
      return
    }
    if (!first) {
      await openInSplit(path)
      return
    }
    // Dropped on the left or top edge: the note takes the main pane, the former main pane moves over.
    if (await openNote(path)) setSplitPath(active)
  }, [openInSplit, openNote, swapSplitPanes, toast])

  const noteDragPath = useCallback((transfer: DataTransfer): string | null => {
    const tabPath = transfer.getData(NOTE_TAB_DRAG_TYPE)
    if (tabPath) return tabPath
    const entry = transfer.getData('application/x-fanotes-entry')
    if (!entry) return null
    try {
      const parsed = JSON.parse(entry) as { path?: unknown; kind?: unknown }
      return typeof parsed.path === 'string' && parsed.kind === 'file' ? parsed.path : null
    } catch {
      return null
    }
  }, [])

  const dragIsNote = (transfer: DataTransfer) => transfer.types.includes(NOTE_TAB_DRAG_TYPE) || transfer.types.includes('application/x-fanotes-entry')

  // A sheet wider than its pane would open with its text cut off at the left edge:
  // the second pane starts at a zoom that shows the whole column (unless the note has its own remembered view).
  // A layout effect runs after the pane's own view setup and before the first paint, so the zoom never visibly jumps.
  useLayoutEffect(() => {
    if (!splitPath || !splitTab || splitTab.kind === 'pdf' || isPdfNotePath(splitPath)) return
    const path = splitPath
    const scrollerOf = () => splitContainerRef.current?.querySelector<HTMLElement>('.split-pane .unified-note-view') ?? null
    let interacted = false
    let done = false
    const fit = () => {
      const scroller = scrollerOf()
      if (done || interacted || !scroller || recallPaperViewForWidth(loadPaperViewMemory(), paperViewMemoryKey(`split:${path}`), scroller.clientWidth)) return
      const view = splitPaperViewStore.read()
      if (view.zoom !== 1) { done = true; return }
      const zoom = splitFitZoom(scroller.clientWidth)
      if (zoom < 1) {
        splitPaperViewStore.write({ ...view, zoom })
        done = true
      }
    }
    fit()
    // Fallback only: if the pane was not measurable yet. It never fires after the user touched the pane.
    const scroller = scrollerOf()
    const markInteracted = () => { interacted = true }
    const events = ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const
    events.forEach((name) => scroller?.addEventListener(name, markInteracted, { capture: true, passive: true }))
    const observer = scroller && typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
    if (scroller) observer?.observe(scroller)
    const stop = window.setTimeout(() => { done = true }, 1500)
    return () => {
      done = true
      window.clearTimeout(stop)
      observer?.disconnect()
      events.forEach((name) => scroller?.removeEventListener(name, markInteracted, { capture: true }))
    }
  }, [splitPath, splitPaperViewStore])

  // Divider drag of the split view; pointer capture keeps it smooth over iframes and canvases.
  const beginSplitDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const container = splitContainerRef.current
    if (!container || event.button !== 0) return
    event.preventDefault()
    const divider = event.currentTarget
    divider.setPointerCapture(event.pointerId)
    setSplitDragging(true)
    const orientation = splitLayout.orientation
    // The drag moves the grid track directly, once per frame. React state (and so a
    // re-render of both panes, the tab bar and a storage write) follows once on release.
    let latest = splitLayout.ratio
    let frame = 0
    const apply = () => {
      frame = 0
      const size = orientation === 'columns' ? container.clientWidth : container.clientHeight
      const dpr = window.devicePixelRatio || 1
      const track = snapToDevicePixels(SPLIT_DIVIDER_PX, dpr)
      container.style.setProperty('--split-first', `${splitFirstPaneSize(size, track, latest, dpr)}px`)
      divider.setAttribute('aria-valuenow', String(Math.round(latest * 100)))
    }
    const move = (moveEvent: PointerEvent) => {
      const rect = container.getBoundingClientRect()
      latest = splitRatioFromPointer(rect, { x: moveEvent.clientX, y: moveEvent.clientY }, orientation)
      if (!frame) frame = window.requestAnimationFrame(apply)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      if (frame) window.cancelAnimationFrame(frame)
      apply()
      setSplitLayout((current) => current.ratio === latest ? current : { ...current, ratio: latest })
      setSplitDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [splitLayout.orientation, splitLayout.ratio])

  const splitDividerKey = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const horizontal = splitLayout.orientation === 'columns'
    const shrink = horizontal ? 'ArrowLeft' : 'ArrowUp'
    const grow = horizontal ? 'ArrowRight' : 'ArrowDown'
    if (event.key === shrink || event.key === grow) {
      event.preventDefault()
      setSplitLayout((current) => ({ ...current, ratio: nudgeSplitRatio(current.ratio, event.key === shrink ? -1 : 1) }))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setSplitLayout((current) => ({ ...current, ratio: clampSplitRatio(event.key === 'Home' ? 0 : 1) }))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      setSplitLayout((current) => ({ ...current, ratio: DEFAULT_SPLIT_LAYOUT.ratio }))
    }
  }, [splitLayout.orientation])

  const loadSplitInk = useMemo(() => {
    if (!splitTab || splitTab.kind === 'pdf' || isPdfNotePath(splitTab.path)) return null
    // The saved text carries the ink marker; keystrokes in the pane must not re-read the page.
    const { path, savedContent } = splitTab
    return () => readSplitInk(path, savedContent)
  }, [readSplitInk, splitTab?.path, splitTab?.kind, splitTab?.savedContent])
  const splitInkRead = splitTab ? splitInkReadsRef.current.get(splitTab.path) : undefined
  const splitInkInitial = splitTab && splitInkRead?.content === splitTab.savedContent && Date.now() - splitInkRead.at <= PREPARED_INK_TTL_MS
    ? splitInkRead.document
    : undefined

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key === 'Tab') { event.preventDefault(); cycleTabs(event.shiftKey ? -1 : 1); return }
      if (event.altKey && !mod && !event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const target = event.target as HTMLElement | null
        // Alt+←/→ inside a text field is word navigation on macOS; the history takes it everywhere else.
        if (target?.closest('textarea, input, [contenteditable="true"], .cm-editor') && window.fanotes.platform === 'darwin') return
        event.preventDefault()
        void navigateHistory(event.key === 'ArrowLeft' ? -1 : 1)
        return
      }
      if (mod && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
        event.preventDefault()
        openTabByDigit(Number(event.key))
        return
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        void reopenClosedTab()
        return
      }
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        setPaletteMode('notes')
        setPaletteOpen(true)
        return
      }
      if (mod && (event.key === '\\' || event.code === 'Backslash' || event.code === 'IntlBackslash')) {
        event.preventDefault()
        if (event.shiftKey) void swapSplitPanes()
        else toggleSplit()
        return
      }
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        const active = activePathRef.current
        if (!active) return
        if (tabsRef.current.find((tab) => tab.path === active)?.pinned) {
          toast('Diese Notiz ist angeheftet. Löse sie zuerst über das Tab-Menü.', 'info')
          return
        }
        void closeTab(active)
        return
      }
      if (mod && !event.shiftKey && event.key.toLowerCase() === 's' && !event.defaultPrevented) {
        event.preventDefault()
        void saveCurrentWork()
        return
      }
      if (mod && event.key.toLowerCase() === 'p') { event.preventDefault(); setPaletteMode('commands'); setPaletteOpen(true) }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true) }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'a') { event.preventDefault(); openLmStudio() }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'g') { event.preventDefault(); openGlyphenWerk() }
      if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') { event.preventDefault(); openWorkRequestsOrBugReport() }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'i') { event.preventDefault(); openWorksheetImport() }
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); void createNote() }
      if (mod && event.key === ',') { event.preventDefault(); openSettings() }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'e') { event.preventDefault(); toggleFocusMode() }
      if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd') {
        const target = event.target as HTMLElement | null
        if (target?.closest('textarea, input, [contenteditable="true"]') && !target.closest('.cm-editor, .markdown-editor')) return
        event.preventDefault()
        insertStamp(false)
        return
      }
      if (event.altKey && event.shiftKey && !mod && event.code === 'KeyD') {
        const target = event.target as HTMLElement | null
        if (target?.closest('input, textarea, select')) return
        event.preventDefault()
        const path = activePathRef.current
        if (path) void duplicateNote(path)
        else toast('Öffne zuerst eine Notiz.', 'info')
        return
      }
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'd') { event.preventDefault(); toggleDrawing() }
      if (mod && event.key.toLowerCase() === 'q') { event.preventDefault(); window.fanotes.requestClose() }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedNoteLinkId) {
        const target = event.target as HTMLElement | null
        if (target?.closest('textarea, input, [contenteditable="true"], .cm-editor, .markdown-editor, .worksheet-textbox, .note-text-field')) return
        event.preventDefault()
        void removeSelectedNoteLink()
        return
      }
      if (event.key === 'Escape') {
        if (textFieldPlacing) setTextFieldPlacing(false)
        else if (noteLinkPlacing) setNoteLinkPlacing(false)
        else if (selectedNoteLinkId) setSelectedNoteLinkId(null)
        else if (worksheetImportOpen) setWorksheetImportOpen(false)
        else if (paletteOpen) setPaletteOpen(false)
        else if (searchOpen) setSearchOpen(false)
        else if (settingsOpen) setSettingsOpen(false)
        else if (lmStudioOpen) setLmStudioOpen(false)
        else if (calendarOpen) setCalendarOpen(false)
        else if (homeworkOpen) setHomeworkOpen(false)
        else if (overviewOpen) setOverviewOpen(false)
        else if (glyphenWerkOpen) setGlyphenWerkOpen(false)
        else if (drawingOpenRef.current) closeDrawing()
        else if (toolbarFullscreen) setToolbarFullscreenMode(false)
        else if (focusMode) toggleFocusMode()
      }
    }
    // Mouse back/forward buttons walk the note history like a browser.
    const mouseNav = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return
      event.preventDefault()
      void navigateHistory(event.button === 3 ? -1 : 1)
    }
    window.addEventListener('keydown', handler)
    window.addEventListener('mouseup', mouseNav)
    return () => {
      window.removeEventListener('keydown', handler)
      window.removeEventListener('mouseup', mouseNav)
    }
  }, [calendarOpen, closeDrawing, closeTab, createNote, cycleTabs, duplicateNote, focusMode, toolbarFullscreen, setToolbarFullscreenMode, glyphenWerkOpen, homeworkOpen, insertStamp, lmStudioOpen, navigateHistory, noteLinkPlacing, openGlyphenWerk, openLmStudio, openSettings, openTabByDigit, openWorkRequestsOrBugReport, openWorksheetImport, overviewOpen, paletteOpen, removeSelectedNoteLink, reopenClosedTab, saveCurrentWork, searchOpen, selectedNoteLinkId, settingsOpen, swapSplitPanes, textFieldPlacing, toast, toggleDrawing, toggleFocusMode, toggleSplit, worksheetImportOpen])

  useEffect(() => {
    const placeImage = (data: DataTransfer | null, event: Event, failure: string, at?: { x: number; y: number }) => {
      const file = clipboardImageFile(data)
      if (!file) return
      event.preventDefault()
      event.stopPropagation()
      void importImageBytes(file, at).catch((error) => toast(error instanceof Error ? error.message : failure, 'error'))
    }
    const onPaste = (event: ClipboardEvent) => placeImage(event.clipboardData, event, 'Bild konnte nicht eingefügt werden.')
    const onDrop = (event: DragEvent) => placeImage(event.dataTransfer, event, 'Bild konnte nicht abgelegt werden.', { x: event.clientX, y: event.clientY })
    const onDragOver = (event: DragEvent) => {
      if ([...(event.dataTransfer?.types ?? [])].includes('Files')) event.preventDefault()
    }
    window.addEventListener('paste', onPaste, true)
    window.addEventListener('drop', onDrop, true)
    window.addEventListener('dragover', onDragOver)
    return () => {
      window.removeEventListener('paste', onPaste, true)
      window.removeEventListener('drop', onDrop, true)
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
      '--accent-readable': ensureReadableColor(settings.accent, contrastSurface, 5),
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
      ...(clampPaperSquareMm(settings.paperSquareMm) > 0
        ? { '--paper-square-size': `${paperSquarePx(paperSheetPx(settings.contentWidth, settings.readableLineLength), clampPaperSquareMm(settings.paperSquareMm))}px` }
        : {}),
    } as React.CSSProperties
  }, [settings, sidebarVisible, theme])

  // Remembered for public/boot-theme.js so the next start paints the right background before React mounts.
  useEffect(() => {
    try { localStorage.setItem('fanotes.theme', settings.theme) } catch { /* private mode */ }
  }, [settings.theme])

  // The reduce-motion setting zeroes the shared motion tokens on <html>, which also covers portaled overlays.
  useEffect(() => {
    document.documentElement.classList.toggle('motion-off', settings.reduceMotion)
    return () => document.documentElement.classList.remove('motion-off')
  }, [settings.reduceMotion])

  // Portaled popovers, menus and dialogs render under document.body, outside .app-shell,
  // so mirror the theme class and tokens there to keep them themed.
  useEffect(() => {
    const body = document.body
    const themeClass = `app-theme-${theme}`
    body.classList.add(themeClass)
    const names = Object.keys(cssVars)
    for (const name of names) body.style.setProperty(name, String((cssVars as Record<string, unknown>)[name]))
    const root = document.documentElement
    const scheme = getComputedStyle(body).colorScheme.includes('light') ? 'light' : 'dark'
    root.dataset.theme = scheme
    root.style.colorScheme = scheme
    return () => {
      body.classList.remove(themeClass)
      for (const name of names) body.style.removeProperty(name)
      document.documentElement.style.colorScheme = ''
    }
  }, [theme, cssVars])

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
      {snowLayerActive(theme) ? <SnowLayer reduceMotion={settings.reduceMotion} /> : null}
      {sanitizeCustomCss(settings.customCss) && <style>{sanitizeCustomCss(settings.customCss)}</style>}
      <Suspense fallback={<div className="fatal-screen"><section className="fatal-card"><LoaderCircle className="spin" color="var(--accent)" /><h1>Fächerauswahl wird geladen …</h1></section></div>}>
        <FirstRunOnboarding subjects={bootstrap.starterSubjects} onComplete={completeOnboarding} />
      </Suspense>
    </div>
  )
  const editorToolbarVisible = !calendarOpen && !homeworkOpen && !overviewOpen && !glyphenWerkOpen
  const sideToolbar = editorToolbarVisible && settings.toolbarPosition === 'side'

  return (
    <div className={`app-shell theme-${theme} background-${settings.workspaceBackground} ${focusMode ? 'focus-mode' : ''} ${toolbarFullscreen ? 'toolbar-fullscreen' : ''} ${settings.compactMode ? 'compact' : ''} ${settings.reduceMotion ? 'no-motion' : ''} ${settings.glassEffects ? 'with-glass' : 'no-glass'}`} style={cssVars}>
      {snowLayerActive(theme) ? <SnowLayer reduceMotion={settings.reduceMotion} /> : null}
      {sanitizeCustomCss(settings.customCss) && <style>{sanitizeCustomCss(settings.customCss)}</style>}
      <nav className="ribbon" aria-label="Hauptnavigation">
        <div className="ribbon-brand"><span aria-hidden="true">F</span><strong>FaNotes</strong></div>
        <button type="button" title={sidebarVisible ? 'Seitenleiste einklappen' : 'Seitenleiste einblenden'} aria-label={sidebarVisible ? 'Seitenleiste einklappen' : 'Seitenleiste einblenden'} onClick={() => setSidebarVisible((value) => !value)}>{sidebarVisible ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}</button>
        <button type="button" className={!searchOpen && !overviewOpen && !homeworkOpen && !calendarOpen && !lmStudioOpen && !glyphenWerkOpen ? 'active' : ''} title="Dateien" data-tooltip="Notizen" aria-label="Notizen" onClick={showFiles}><Files size={14} /><span className="ribbon-label">Notizen</span></button>
        <button type="button" className={searchOpen ? 'active' : ''} title="Im Vault suchen (Strg+Umschalt+F)" data-tooltip="Suchen · Strg ⇧ F" aria-label="Im gesamten Vault suchen" onClick={() => { setSearchOpen(true); setSidebarVisible(true) }}><Search size={14} /><span className="ribbon-label">Suchen</span></button>
        {!editorToolbarVisible && <button type="button" className={drawingOpen ? 'active' : ''} title={drawingOpen ? 'Zur Tastatureingabe wechseln' : 'Auf derselben Seite mit Stift schreiben'} data-tooltip={drawingOpen ? 'Zur Tastatur · Strg D' : 'Mit Stift schreiben · Strg D'} aria-label={drawingOpen ? 'Zur Tastatur wechseln' : 'Mit Stift schreiben'} aria-pressed={drawingOpen} onClick={toggleDrawing}><PenLine size={14} /><span className="ribbon-label">Stift</span></button>}
        <button type="button" className={homeworkOpen ? 'active' : ''} title="Hausaufgaben & Termine" data-tooltip="Hausaufgaben" aria-label="Aufgaben: Hausaufgaben und Termine öffnen" onClick={openHomework}><ClipboardList size={14} /><span className="ribbon-label">Aufgaben</span></button>
        <button type="button" className={calendarOpen ? 'active' : ''} title="Kalender" data-tooltip="Kalender" aria-label="Kalender öffnen" onClick={openCalendar}><CalendarDays size={14} /><span className="ribbon-label">Kalender</span></button>
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
          <MoreVertical size={14} /><span className="ribbon-label">Werkzeuge</span>
        </button>
        {sidebarToolsOpen && (
          <div className="ribbon-extras" role="group" aria-label="Weitere Werkzeuge">
            <button type="button" title="Heutige Tagesnotiz" data-tooltip="Tagesnotiz" aria-label="Heutige Tagesnotiz öffnen" onClick={() => void createDailyNote()}><CalendarDays size={14} /><span className="ribbon-label">Tagesnotiz</span></button>
            <button type="button" className={overviewOpen ? 'active' : ''} title="Vault-Übersicht" data-tooltip="Übersicht" aria-label="Vault-Übersicht öffnen" onClick={openOverview}><Network size={14} /><span className="ribbon-label">Übersicht</span></button>
            <button type="button" className={glyphenWerkOpen ? 'active' : ''} title="GlyphenWerk" data-tooltip="GlyphenWerk" aria-label="GlyphenWerk öffnen" onClick={openGlyphenWerk}><Database size={14} /><span className="ribbon-label">GlyphenWerk</span></button>
            <button type="button" title="Befehlspalette (Strg+P)" data-tooltip="Befehle · Strg P" aria-label="Befehle: Befehlspalette öffnen" onClick={() => setPaletteOpen(true)}><Command size={14} /><span className="ribbon-label">Befehle</span></button>
          </div>
        )}
        <div className="ribbon-status">
          {updateState.status === 'downloaded' && <button type="button" className="update-ready-button" title={`FaNotes ${updateState.latestVersion} installieren und neu starten`} onClick={() => void installUpdate()}><ShieldCheck size={12} /> Update bereit</button>}
          {updateState.status === 'downloading' && <span title={updateState.totalBytes > 0 ? `Update ${updateState.latestVersion ?? ''}: ${Math.round(updateState.downloadedBytes / 1048576)} von ${Math.round(updateState.totalBytes / 1048576)} MB` : undefined}><LoaderCircle className="spin" size={12} /> Update {Math.round(updateState.progress * 100)} %</span>}
          {updateState.status === 'error' && updateState.failedPhase === 'download' && <button type="button" className="update-ready-button is-failed" title="Update-Download fehlgeschlagen. Details und erneut versuchen" onClick={() => openSettings('updates')}><CircleAlert size={12} /> Update fehlgeschlagen</button>}
          {addonState.statusItems.map((item) => item.clickable ? <button key={`${item.addonId}/${item.id}`} type="button" className="addon-status-item" title={item.title ?? undefined} data-i18n-ignore onClick={() => addonRuntime.clickStatusItem(item.addonId, item.id)}>{item.text}</button> : <span key={`${item.addonId}/${item.id}`} className="addon-status-item" title={item.title ?? undefined} data-i18n-ignore>{item.text}</span>)}
          {addonState.panels.length > 0 && !addonState.dockOpen && <button type="button" className="addon-status-item addon-status-item--dock" title="Add-on-Panels einblenden" onClick={() => addonRuntime.setDockOpen(true)}><Puzzle size={12} /> {addonState.panels.length}</button>}
          {syncApi && syncState.account && <button type="button" className={`sync-status-item is-${syncState.status}`} title={`Sync · ${syncState.account.email} · ${syncStatusLabel(syncState)}${syncState.error ? ` · ${syncState.error}` : ''}`} aria-live="polite" onClick={() => openSettings(syncState.openConflicts > 0 ? 'conflicts' : 'sync')}>{syncState.status === 'syncing' ? <LoaderCircle className="spin" size={12} /> : syncState.status === 'offline' ? <CloudOff size={12} /> : syncState.status === 'error' ? <CircleAlert size={12} /> : syncState.status === 'paused' ? <Clock size={12} /> : <Cloud size={12} />}{syncState.status === 'syncing' ? 'Sync …' : syncState.status === 'offline' ? 'Offline' : syncState.status === 'error' ? 'Sync-Fehler' : syncState.status === 'paused' ? 'Sync pausiert' : 'Synchron'}{syncState.openConflicts > 0 && <em title={`${syncState.openConflicts} Konflikt(e)`}>{syncState.openConflicts}</em>}{syncState.failed.length > 0 && <em className="sync-failed-badge" title={failedLabel(syncState.failed.length)}>{syncState.failed.length}</em>}</button>}
          {(() => {
            const saveText = shownSaveState === 'saved' ? 'Gespeichert' : shownSaveState === 'saving' ? 'Speichert …' : (activeHeld ? 'Nicht gespeichert' : 'Speicherfehler')
            return (
              <>
                <button type="button" className={`save-status ${shownSaveState === 'saved' ? 'save-ok' : 'save-pending'}`} title="Jetzt speichern (Strg+S)" onClick={() => void saveCurrentWork()}>{shownSaveState === 'saved' ? <CheckCircle2 aria-hidden="true" size={12} /> : shownSaveState === 'saving' ? <LoaderCircle aria-hidden="true" className="spin" size={12} /> : <CircleAlert aria-hidden="true" size={12} />}<span>{saveText}</span></button>
                <span className="sr-only" role="status">{saveText}</span>
              </>
            )
          })()}
        </div>
        <button type="button" title="Einstellungen (Strg+,)" data-tooltip="Einstellungen · Strg ," aria-label="Einstellungen öffnen" onClick={() => openSettings()}><Settings size={14} /><span className="ribbon-label">Einstellungen</span></button>
      </nav>

      <div className="app-body" style={{ gridTemplateColumns: `${sidebarVisible ? 'var(--sidebar-width)' : '0px'} minmax(420px, 1fr) auto` }}>
        <aside aria-label="Seitenleiste" className={`sidebar ${sidebarVisible ? '' : 'is-hidden'} ${glyphenWerkOpen ? 'is-glyphenwerk' : ''}`}>
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
                <button className="icon-button" type="button" title="Neue Notiz" aria-label="Neue Notiz" onClick={() => void createNote(undefined, true)}><FilePlus2 size={16} /></button>
                <button className="icon-button" type="button" title="Neuer Ordner" aria-label="Neuer Ordner" onClick={() => void createFolder(undefined, true)}><FolderPlus size={16} /></button>
                <button className="icon-button pdf-import-button" type="button" title="PDF importieren" aria-label="PDF importieren" onClick={() => void importPdfNote()}>PDF</button>
                <button className="icon-button sidebar-collapse-button" type="button" title="Seitenleiste einklappen" aria-label="Seitenleiste einklappen" onClick={() => setSidebarVisible(false)}><PanelLeftClose size={16} /></button>
              </div>
            </div>
            <div className="sidebar-search" role="search" title="Notizen und Handschrift durchsuchen">
              <Search aria-hidden="true" size={14} />
              <input value={searchQuery} placeholder="Im Vault suchen …" aria-label="Im ganzen Vault suchen" onChange={(event) => { setSearchQuery(event.target.value); setSearchOpen(true) }} onFocus={() => setSearchOpen(true)} />
              {searchQuery ? <button className="search-clear" type="button" aria-label="Suche leeren" title="Suche leeren" onMouseDown={(event) => event.preventDefault()} onClick={() => { setSearchQuery(''); setSearchHits([]); setSearchFailed(false) }}><X size={13} /></button> : null}
              <span className="sidebar-fold-slot" ref={setFoldSlot} />
            </div>
            {knownTags.length > 0 && (
              <div className="tag-filter" aria-label="Nach Schlagwort filtern">
                {knownTags.map((tag) => (
                  <button key={tag} type="button" className={tagFilter === tag ? 'is-active' : ''} onClick={() => setTagFilter((current) => current === tag ? null : tag)}>#{tag}</button>
                ))}
                {tagFilter && <button type="button" className="tag-filter-clear" onClick={() => setTagFilter(null)}>Filter aus</button>}
              </div>
            )}
            <SharedWithMePanel onReveal={setRevealPath} onOpen={(path) => { void openNote(path) }} toast={toast} />
            <div className="file-tree-wrap">
              <FileTree
                entries={visibleTree}
                activePath={activePath}
                splitPath={splitPath}
                newPaths={newMarkedPaths}
                revealPath={revealPath}
                expansionStorageKey={`fanotes.treeExpanded.v1:${bootstrap?.vaultPath || 'default'}`}
                rootLabel="Notizen"
                showHeader={false}
                foldSlot={foldSlot}
                onOpen={openNote}
                onOpenInSplit={openInSplit}
                onCreateNote={(parent) => createNote(parent, true)}
                onCreateFolder={(parent) => createFolder(parent, true)}
                renameRequest={renameRequest}
                onImportPdf={importPdfNote}
                onCreateStory={(parent) => void createStory(parent)}
                onImportStory={window.fanotes?.storyCreate ? (parent) => setStoryImportParent(parent ?? '') : undefined}
                onAttachBook={attachBookToSubject}
                onDetachBook={detachBookFromSubject}
                localOnlyPaths={syncPrefixesFromSetting(settings.syncExcludedFolders)}
                onToggleLocalOnly={(folder) => applySettings({ ...settingsRef.current, syncExcludedFolders: toggleSyncPrefix(settingsRef.current.syncExcludedFolders, folder) })}
                bookFolderPaths={subjectBooks.map((book) => book.subjectPath)}
                onSetFolderColor={setFolderColor}
                onSetFileColor={window.fanotes.setFileColor ? setFileColor : undefined}
                onEditFolderPath={openFolderPath}
                onRename={renameEntry}
                onMove={moveEntry}
                onTrash={trashEntry}
                onDuplicate={(path) => void duplicateNote(path)}
                onDuplicateFolder={window.fanotes.duplicateFolder ? (path) => void duplicateFolder(path) : undefined}
                onCopyWikiLink={copyWikiLink}
                onCopyPath={(path) => { void copyPlainText(path, 'Pfad kopiert.') }}
                onShare={shareVaultEntry}
                onShareWithUser={syncApi && window.fanotes.platform !== 'web' && window.fanotes.platform !== 'browser-preview' ? (path, kind) => setShareWithUser({ path, kind, name: fileName(path) }) : undefined}
                confirmTrash={(message) => requestConfirm(message, { title: 'In den Papierkorb', confirmLabel: 'Verschieben' })}
              />
            </div>
            <div className="sidebar-footer"><span>{counts.files} {counts.files === 1 ? 'Notiz' : 'Notizen'}</span></div>
          </>}
        </aside>

        <main className={`workspace ${sideToolbar ? 'has-side-toolbar' : ''}`}>
          <h1 className="sr-only" data-i18n-ignore>{activeTab ? activeTab.title : 'FaNotes'}</h1>
          <div className="tabs-bar">
            <div className="note-nav" role="group" aria-label="Verlauf">
              <button
                type="button"
                className="note-nav-back"
                title="Zurück (Alt+←)"
                aria-label="Zurück"
                disabled={!canGoBack(noteHistory)}
                onClick={() => void navigateHistory(-1)}
              >
                <ArrowLeft size={14} />
              </button>
              <button
                type="button"
                className="note-nav-forward"
                title="Vorwärts (Alt+→)"
                aria-label="Vorwärts"
                disabled={!canGoForward(noteHistory)}
                onClick={() => void navigateHistory(1)}
              >
                <ArrowRight size={14} />
              </button>
            </div>
            <div
              className="tabs-scroll"
              role="group"
              aria-label="Offene Notizen"
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(NOTE_TAB_DRAG_TYPE)) return
                event.preventDefault()
                if (event.target === event.currentTarget) setTabDrag((current) => current ? { ...current, over: null, side: 'after' } : current)
              }}
              onDrop={(event) => {
                if (!event.dataTransfer.types.includes(NOTE_TAB_DRAG_TYPE) || event.target !== event.currentTarget) return
                event.preventDefault()
                const from = event.dataTransfer.getData(NOTE_TAB_DRAG_TYPE)
                if (from) moveTab(from, null, 'after')
                setTabDrag(null)
              }}
            >
              {tabs.map((tab, index) => (
                <NoteTabButton
                  key={tab.path}
                  active={tab.path === activePath}
                  inSplit={tab.path === splitPath}
                  dirty={tab.content !== tab.savedContent}
                  pinned={Boolean(tab.pinned)}
                  hold={tabHolds[tab.path]?.kind}
                  path={tab.path}
                  title={tab.title}
                  index={index}
                  dropSide={tabDrag && tabDrag.over === tab.path && tabDrag.path !== tab.path ? tabDrag.side : null}
                  onOpen={openNote}
                  onSplit={openInSplit}
                  onClose={closeTab}
                  onContextMenu={(path, x, y) => setTabMenu({ path, x, y })}
                  onDragStart={(path) => setTabDrag({ path, over: null, side: 'after' })}
                  onDragOver={(path, side) => setTabDrag((current) => current && (current.over !== path || current.side !== side) ? { ...current, over: path, side } : current)}
                  onDrop={(path, side) => {
                    if (tabDrag) moveTab(tabDrag.path, path, side)
                    setTabDrag(null)
                  }}
                  onDragEnd={() => setTabDrag(null)}
                />
              ))}
            </div>
            <SharePresence people={sharePeople} />
            <button type="button" className="tabs-menu" title="Neue Notiz (Strg+N)" aria-label="Neue Notiz" onClick={() => void createNote()}><Plus size={14} /></button>
          </div>
          {tabMenu && (() => {
            const menuTab = tabs.find((tab) => tab.path === tabMenu.path)
            if (!menuTab) return null
            return (
              <TabContextMenu
                menu={tabMenu}
                title={menuTab.title}
                pinned={Boolean(menuTab.pinned)}
                inSplit={menuTab.path === splitPath}
                isWeb={isWeb}
                canCloseOthers={tabsToClose(tabs, menuTab.path, 'others').length > 0}
                canCloseRight={tabsToClose(tabs, menuTab.path, 'right').length > 0}
                onClose={closeTabMenu}
                onOpenInSplit={() => void openInSplit(menuTab.path)}
                onTogglePin={() => togglePinTab(menuTab.path)}
                onCloseTab={() => void closeTab(menuTab.path)}
                onCloseOthers={() => void closeTabsOf(menuTab.path, 'others')}
                onCloseRight={() => void closeTabsOf(menuTab.path, 'right')}
                onCopyPath={() => { void copyPlainText(menuTab.path, 'Pfad kopiert.') }}
                onCopyWikiLink={() => copyWikiLink(menuTab.path)}
                onDuplicate={() => void duplicateNote(menuTab.path)}
                onReveal={() => void window.fanotes.revealInFolder(menuTab.path)}
              />
            )
          })()}
          {editorToolbarVisible && <div className={`editor-toolbar ${drawingOpen ? 'is-ink' : 'is-type'} ${sideToolbar ? 'is-vertical' : ''}`}>
            <div className="mode-switch" role="group" aria-label="Eingabemodus">
              <button
                type="button"
                className={!drawingOpen ? 'is-active' : ''}
                aria-pressed={!drawingOpen}
                aria-label="Tastatur"
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
                aria-label="Stift"
                title="Mit dem Stift schreiben (Strg+D)"
                onClick={() => { if (!drawingOpen) toggleDrawing() }}
              >
                <PenLine size={14} />
                <span>Stift</span>
              </button>
            </div>
            <div className="toolbar-context">
              {(() => {
                const selectedTextField = selectedTextFieldId ? noteTextFields.find((field) => field.id === selectedTextFieldId) : undefined
                const slot = penModeToolbarSlot(drawingOpen, isPdfActive)
                // The PDF slot element must outlive every swap (text box selected, pen mode): PdfNoteView portals
                // its bar into it once, and a re-created slot left the bar attached to a detached node (empty top bar).
                const pdfSlot = isPdfActive ? <div key="pdf-slot" id={PDF_TOOLBAR_SLOT_ID} className="pdf-toolbar-slot" hidden={Boolean(selectedTextField) || slot !== 'pdf'} /> : null
                if (selectedTextField) return <>{pdfSlot}<NoteTextFieldToolbar key="field-bar" field={selectedTextField} hideTypeable={Boolean(settings.hideMarkdownKeyButtons)} onStyle={changeTextFieldStyle} onText={changeTextFieldText} onRemove={removePlacedTextField} onLatexError={(message) => toast(message, 'error')} /></>
                if (slot === 'ink') return <>{pdfSlot}<div id={INK_TOOLBAR_SLOT_ID} className="ink-toolbar-slot" /></>
                if (slot === 'pdf') return <>{pdfSlot}</>
                return <>{pdfSlot}<FormattingToolbar hideTypeable={Boolean(settings.hideMarkdownKeyButtons)} disabled={!activeTab || overviewOpen || homeworkOpen || calendarOpen || glyphenWerkOpen || activeEntryMutating || activeHeld} onFormat={formatMarkdown} onInsertLatex={insertSimpleLatex} onLatexError={(message) => toast(message, 'error')} /></>
              })()}
            </div>
            <div className="toolbar-group toolbar-end">
              {liveEnabled && activeTab && <LivePeople people={live.people} status={live.status} />}
              {activeTab && dailyNoteStem(activeTab.path, normalizePath(settings.dailyNotesFolder || translateUiText('Tagesnotizen')), settings.dateFormat || 'YYYY-MM-DD') && (
                <div className="daily-nav" role="group" aria-label="Benachbarte Tagesnotizen">
                  <button type="button" title="Vorherige Tagesnotiz" aria-label="Vorherige Tagesnotiz" onClick={() => void openAdjacentDaily(-1)}><ArrowLeft size={13} /></button>
                  <button type="button" title="Nächste Tagesnotiz" aria-label="Nächste Tagesnotiz" onClick={() => void openAdjacentDaily(1)}><ArrowRight size={13} /></button>
                </div>
              )}
              {activeTab && !isPdfActive && !drawingOpen && (
                <PaperStylePicker
                  value={activePaper}
                  disabled={activeEntryMutating || activeHeld}
                  onChange={(style) => { if (activeTab) void applyNotePaper(activeTab.path, style) }}
                />
              )}
              {activeTab && (
                <div className="note-tags-menu" ref={tagMenuRef}>
                  <button type="button" className={`toolbar-button ${tagMenuOpen ? 'active' : ''}`} aria-expanded={tagMenuOpen} title="Schlagwörter" onClick={() => setTagMenuOpen((open) => !open)}><Tag aria-hidden="true" size={14} /><span className="sr-only">Schlagwörter</span>{activeTags.length > 0 && <span>{activeTags.length}</span>}</button>
                  {tagMenuOpen && (
                    <div className="note-tags-popover" role="dialog" aria-label="Schlagwörter" ref={tagPopoverRef} onKeyDown={onTagMenuKeyDown}>
                      <div className="note-tags">
                        {activeTags.map((tag) => (
                          <button key={tag} type="button" className="note-tag" onClick={() => applyTagsToNote(activeTags.filter((item) => item !== tag))} title="Tag entfernen">#{tag}<X size={10} /></button>
                        ))}
                        <form onSubmit={(event) => { event.preventDefault(); const next = tagDraft.trim(); if (!next) return; applyTagsToNote([...activeTags, next]); setTagDraft('') }}>
                          <input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="Tag hinzufügen" maxLength={40} aria-label="Neues Schlagwort" />
                        </form>
                      </div>
                    </div>
                  )}
                </div>
              )}
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
                    <div ref={backupMenuRef} className="note-backup-menu" role="menu" aria-label="Backup" onKeyDown={onBackupMenuKeyDown} onPointerDown={(event) => event.stopPropagation()}>
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
                      className={`is-${style.id}${noteLinkStyle === style.id ? ' is-active' : ''}`}
                      aria-pressed={noteLinkStyle === style.id}
                      aria-label={style.label}
                      title={style.label}
                      onClick={() => void applyNoteLinkStyle(style.id)}
                    >
                      {style.appearance !== 'text' ? <Link2 size={13} aria-hidden="true" /> : null}
                      {style.appearance !== 'symbol' ? <span aria-hidden="true">Aa</span> : null}
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
              <button
                type="button"
                className={`toolbar-button ${textFieldPlacing ? 'active' : ''}`}
                title="Textfeld einfügen"
                aria-label="Textfeld einfügen"
                aria-pressed={textFieldPlacing}
                disabled={!activeTab}
                onClick={startTextFieldPlacement}
              >
                <Type size={14} /><span>Textfeld</span>
              </button>
              {!isPdfActive && <button type="button" className="toolbar-button" title="Bild oder PDF als Arbeitsblatt importieren" aria-label="Arbeitsblatt importieren" onClick={openWorksheetImport}><FileUp size={14} /><span>Blatt</span></button>}
              {hasConnectedAiProvider(settings) && (
                <button type="button" className={`toolbar-button ai ${lmStudioOpen ? 'active' : ''}`} title="Mit einem AI-Anbieter bearbeiten" aria-label="AI-Assistent öffnen" onClick={openLmStudio}><Bot size={14} /><span>AI</span></button>
              )}
              {window.fanotes?.setFullscreen && (
                <button type="button" className={`toolbar-button ${toolbarFullscreen ? 'active' : ''}`} title={toolbarFullscreen ? 'Vollbild beenden (Esc)' : 'Vollbild: nur Werkzeugleiste und Dokument'} aria-label={toolbarFullscreen ? 'Vollbild beenden' : 'Vollbild'} aria-pressed={toolbarFullscreen} onClick={() => setToolbarFullscreenMode(!toolbarFullscreen)}>
                  {toolbarFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
                </button>
              )}
              <div className="editor-more">
                <button type="button" className={`toolbar-button menu-trigger ${editorMenuOpen ? 'active' : ''}`} title="Weitere Notizaktionen" aria-label="Weitere Notizaktionen" aria-haspopup="menu" aria-expanded={editorMenuOpen} onClick={(event) => { event.stopPropagation(); setEditorMenuOpen((open) => !open) }}><MoreHorizontal size={16} /></button>
                {editorMenuOpen && <div ref={editorMenuRef} className="editor-more-menu" role="menu" aria-label="Weitere Notizaktionen" onKeyDown={onEditorMenuKeyDown} onPointerDown={(event) => event.stopPropagation()}>
                  <span className="editor-menu-label">Ansicht</span>
                  <button type="button" role="menuitemcheckbox" aria-checked={focusMode} onClick={() => { setEditorMenuOpen(false); toggleFocusMode() }}><span><Maximize2 size={15} /></span><span><strong>{focusMode ? 'Fokusmodus verlassen' : 'Fokusmodus'}</strong><small>Seitenleisten ausblenden</small></span><kbd>⌃⇧E</kbd></button>
                  <button type="button" role="menuitemcheckbox" aria-checked={inspectorVisible} onClick={() => { setEditorMenuOpen(false); setInspectorVisible((value) => !value) }}><span>{inspectorVisible ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}</span><span><strong>{inspectorVisible ? 'Gliederung ausblenden' : 'Gliederung anzeigen'}</strong><small>Überschriften und Dokumentinfo</small></span><i className={inspectorVisible ? 'is-on' : ''} /></button>
                  <span className="editor-menu-separator" role="separator" />
                  <span className="editor-menu-label">Schreiben</span>
                  <button type="button" role="menuitem" disabled={!activeTab || isPdfActive} onClick={() => { setEditorMenuOpen(false); insertStamp(false) }}><span><CalendarDays size={15} /></span><span><strong>Datum einfügen</strong><small>Setzt das Datumsformat an der Schreibmarke ein</small></span><kbd>⌃⇧D</kbd></button>
                  <button type="button" role="menuitem" disabled={!activeTab || isPdfActive} onClick={() => { setEditorMenuOpen(false); insertStamp(true) }}><span><Clock size={15} /></span><span><strong>Datum und Uhrzeit einfügen</strong><small>Datum plus Stunde und Minute</small></span></button>
                  <button type="button" role="menuitem" disabled={!activeTab || isPdfActive} onClick={() => { setEditorMenuOpen(false); toggleTask() }}><span><ListChecks size={15} /></span><span><strong>Aufgabe umschalten</strong><small>Erledigt oder offen</small></span><kbd>⌃↵</kbd></button>
                  <span className="editor-menu-separator" role="separator" />
                  <span className="editor-menu-label">Datei</span>
                  <button type="button" role="menuitem" disabled={!activePath || isPdfActive} onClick={() => { setEditorMenuOpen(false); if (activePath) void duplicateNote(activePath) }}><span><Files size={15} /></span><span><strong>Notiz duplizieren</strong><small>Text, Handschrift, Verlinkungen und Textfelder als neue Notiz</small></span><kbd>⌥⇧D</kbd></button>
                  <button type="button" role="menuitem" disabled={!activePath} onClick={() => { setEditorMenuOpen(false); if (activePath) copyWikiLink(activePath) }}><span><Link2 size={15} /></span><span><strong>Wiki-Link kopieren</strong><small>[[Titel]] in die Zwischenablage</small></span></button>
                  <EditorExportControls disabled={!activeTab} onExport={() => { setEditorMenuOpen(false); openExportDialog() }} />
                  <button type="button" role="menuitem" disabled={!activePath} onClick={() => { setEditorMenuOpen(false); void openHistory() }}><span><History size={15} /></span><span><strong>Versionsverlauf</strong><small>Frühere Stände wiederherstellen</small></span></button>
                  <button type="button" role="menuitem" onClick={() => { setEditorMenuOpen(false); toggleSplit() }}><span><Columns2 size={15} /></span><span><strong>{splitPath ? 'Teilung schließen' : 'Geteilte Ansicht'}</strong><small>Zwei Notizen nebeneinander oder untereinander</small></span></button>
                  <button type="button" role="menuitem" disabled={!activePath} onClick={() => { setEditorMenuOpen(false); if (activePath) void window.fanotes.revealInFolder(activePath) }}><span>{isWeb ? <Download size={15} /> : <FolderOpen size={15} />}</span><span><strong>{isWeb ? (isPdfActive ? 'PDF herunterladen' : 'Markdown herunterladen') : 'Im Dateimanager zeigen'}</strong><small>{isWeb ? 'Aktuelle Notiz exportieren' : 'Speicherort der Notiz öffnen'}</small></span></button>
                </div>}
              </div>
            </div>
          </div>}
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
            {!(glyphenWerkOpen || calendarOpen || homeworkOpen || studyOpen || overviewOpen) && [activeTab, splitTab].map((tab, position) => {
              const hold = tab ? tabHolds[tab.path] : undefined
              if (!tab || !hold || (position === 1 && tab.path === activeTab?.path)) return null
              return (
                <ExternalChangeBanner
                  key={tab.path}
                  kind={hold.kind}
                  title={tab.title}
                  canRestore={!isPdfNotePath(tab.path)}
                  busy={externalTabs.busyPath === tab.path}
                  onRestore={() => void externalTabs.restoreTab(tab.path)}
                  onSaveAs={(name) => void externalTabs.saveTabAs(tab.path, name)}
                  onKeepMine={() => void externalTabs.keepMine(tab.path)}
                  onLoadExternal={() => void externalTabs.loadExternal(tab.path)}
                  onCloseTab={() => void closeTab(tab.path)}
                />
              )
            })}
            <Suspense fallback={<div className="editor-module-loading"><LoaderCircle className="spin" size={20} /><span>Ansicht wird geladen …</span></div>}>
              {glyphenWerkOpen ? (
              <SafeBoundary name="GlyphenWerk" fallbackTitle="GlyphenWerk ist abgestürzt">
                <GlyphenWerkWorkspace appearance={{ theme, reduceMotion: settings.reduceMotion }} activeView={glyphenWerkView} onViewChange={setGlyphenWerkView} onClose={() => setGlyphenWerkOpen(false)} onTrainingChanged={handleGlyphenWerkTrainingChanged} onImportTraining={importTrainingFromSettings} />
              </SafeBoundary>
            ) : calendarOpen ? (
              <SafeBoundary name="Kalender" fallbackTitle="Der Kalender ist abgestürzt">
                <CalendarView
                  onClose={() => setCalendarOpen(false)}
                  onOpenNote={(path) => openNote(path)}
                  onOpenDaily={(date) => createDailyNote(date)}
                />
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
            ) : studyOpen ? (
              <SafeBoundary name="Lernzeit" fallbackTitle="Die Lernzeit ist abgestürzt">
                <StudyOverview entries={tree} onClose={() => setStudyOpen(false)} />
              </SafeBoundary>
            ) : overviewOpen ? (
              <VaultOverview entries={tree} openTabs={tabs} onOpen={(path) => { setOverviewOpen(false); return openNote(path) }} onCreateNote={() => createNote()} onClose={() => setOverviewOpen(false)} />
            ) : activeTab ? (
              <>
              <div
                ref={splitContainerRef}
                className={`editor-split ${splitTab ? 'is-split' : ''} ${splitTab ? `is-${splitLayout.orientation}` : ''} ${splitDragging ? 'is-resizing' : ''} ${splitTab ? `focus-${focusedPane}` : ''}`}
                onDragOverCapture={(event) => {
                  if (!dragIsNote(event.dataTransfer)) return
                  const zone = splitDropZone(event.currentTarget.getBoundingClientRect(), { x: event.clientX, y: event.clientY })
                  setSplitDrop((current) => current === zone ? current : zone)
                  if (!zone) return
                  event.preventDefault()
                  event.stopPropagation()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSplitDrop(null)
                }}
                onDropCapture={(event) => {
                  if (!dragIsNote(event.dataTransfer)) return
                  const zone = splitDropZone(event.currentTarget.getBoundingClientRect(), { x: event.clientX, y: event.clientY })
                  setSplitDrop(null)
                  if (!zone) return
                  event.preventDefault()
                  event.stopPropagation()
                  const path = noteDragPath(event.dataTransfer)
                  if (path) void dropNoteIntoSplit(path, zone)
                }}
                style={splitTab ? { '--split-ratio': splitLayout.ratio, ...(splitTracks ? { '--split-first': `${splitTracks.first}px`, '--split-divider': `${splitTracks.divider}px` } : {}) } as React.CSSProperties : undefined}
              >
              {splitDrop && (
                <div className={`split-drop-overlay is-${splitDrop}`} aria-hidden="true">
                  <span>{splitDrop === 'left' ? 'Links öffnen' : splitDrop === 'right' ? 'Rechts öffnen' : splitDrop === 'top' ? 'Oben öffnen' : 'Unten öffnen'}</span>
                </div>
              )}
              <PaperView
                className={`unified-note-view ${splitTab ? 'is-main-pane' : ''} paper-${isPdfActive ? 'blank' : activePaper} ${drawingOpen ? 'is-inking' : ''} ${isPdfActive ? 'is-pdf-note' : ''}`}
                viewKey={activeTab.path}
                showHud={!drawingOpen}
                globalShortcuts={!splitTab || focusedPane === 'main'}
                onEdgeSwipe={(direction) => void navigateHistory(direction === 'back' ? -1 : 1)}
                onPointerDownCapture={() => setFocusedPane('main')}
                onFocusCapture={() => setFocusedPane('main')}
              >
                <article ref={unifiedPaperRef} className={`unified-paper ${worksheetSession.documents.length ? 'has-worksheet' : ''} ${isPdfActive ? 'is-pdf-note' : ''}`} aria-label={`${activeTab.title} · ${isPdfActive ? 'PDF-Notiz mit Handschrift' : 'gemeinsame Tastatur- und Handschriftseite'}`}>
                  {isPdfActive ? (
                    <Suspense fallback={<div className="pdf-note-status"><LoaderCircle className="spin" size={20} /> PDF wird geladen …</div>}>
                      <SafeBoundary name="PDF-Notiz" fallbackTitle="Der PDF-Viewer ist abgestürzt">
                        <PdfNoteView
                          path={activeTab.path}
                          title={activeTab.title}
                          inputDisabled={drawingOpen || activeEntryMutating || activeHeld}
                          quotes={readPdfMarks(activeTab.content)}
                          onMarkSelection={(quote, page) => {
                            const marks = addPdfMark(readPdfMarks(activeTab.content), { page, quote, kind: 'highlight' })
                            updateContentFor(activeTab.path, writePdfMarks(activeTab.content, marks))
                          }}
                          onUnmarkSpans={(hit) => {
                            const content = latestNoteContent(activeTab.path)
                            const result = content === null ? null : unmarkPdfNote(content, [hit])
                            if (result) updateContentFor(activeTab.path, result.content)
                          }}
                          sidePages={pdfSide.shown}
                          onToggleSidePages={pdfSide.available ? () => { void pdfSide.toggle() } : undefined}
                          onSideLayout={pdfSide.onSideLayout}
                          beforeSideRelayout={pdfSide.beforeSideRelayout}
                          sidePaper={activePaper}
                          sidePaperMm={clampPaperSquareMm(settings.paperSquareMm)}
                        />
                      </SafeBoundary>
                    </Suspense>
                  ) : (
                  <div className="editor-pane">
                    <SafeBoundary name="Editor" fallbackTitle="Der Editor ist abgestürzt">
                      <MarkdownEditor ref={editorRef} key={activeTab.path} content={activeTab.content} onChange={(content) => updateContentFor(activeTab.path, content)} onSave={async (content) => { await saveContent(activeTab.path, content) }} settings={settings} focusToken={focusToken} readOnly={activeEntryMutating || activeHeld || (drawingOpen && focusedPane === 'main') || live.connecting || (live.note !== null && !live.note.canWrite)} paperMode onEditActivity={(activity) => recordEditActivityFor(activeTab.path, activity)} foldKey={headingFoldKey(headingFoldScopeRef.current, activeTab.path)} liveNote={live.note} notePath={activeTab.path} />
                    </SafeBoundary>
                  </div>
                  )}
                  {!isPdfActive && worksheetSession.documents.map((document) => <Suspense key={document.id} fallback={<div className="worksheet-skeleton" aria-busy="true" aria-label="Arbeitsblatt wird geladen" />}>
                    <SafeBoundary name={`Arbeitsblatt ${document.title}`} fallbackTitle="Das Arbeitsblatt ist abgestürzt">
                      <StableWorksheetLayer
                        ref={worksheetLayerRefFor(document.id)}
                        document={document}
                        inputDisabled={drawingOpen || activeEntryMutating}
                        onSave={saveWorksheetDocument}
                        onDirtyChange={worksheetDirtyCallbackFor(document.id)}
                        onRemove={() => void removeWorksheetFromNote(document.id)}
                        onReplace={(file) => replaceWorksheetImage(document.id, file)}
                        onNotify={toast}
                      />
                    </SafeBoundary>
                  </Suspense>)}
                  {inkBoard.key > 0 && <Suspense fallback={drawingOpen ? <div className="inline-ink-loading"><LoaderCircle className="spin" size={18} /> Stiftebene wird geladen …</div> : null}>
                    <SafeBoundary
                      key={`stiftebene:${activeTab.path}:${inkBoard.key}`}
                      name="Handschrift"
                      fallbackTitle={INK_OVERLAY_CRASH_TITLE}
                    >
                      <InkBoardComponent
                        ref={drawingBoardRef}
                        key={inkBoard.key}
                        settings={settings}
                        drawingId={inkBoard.document?.id}
                        initialDrawingJson={inkBoard.document?.drawingJson}
                        packedInk={inkBoard.document?.packedInk}
                        title={`Handschrift · ${activeTab.title}`}
                        inline
                        inputActive={drawingOpen}
                        onClose={closeDrawing}
                        onSaveDrawing={pdfSide.board ? pdfSide.onSaveDrawing : saveDrawingAsset}
                        onInsertMarkdown={insertIntoNote}
                        pagePaperStyle={activePaper}
                        sectionsEnabled={!isPdfActive}
                        onPagePaperChange={(style) => { if (activeTab) void applyNotePaper(activeTab.path, style) }}
                        onSettingsChange={handleDrawingSettingsChange}
                        onDirtyChange={handleDrawingDirtyChange}
                        noteLinks={noteLinks}
                        onNoteLinksExtent={remapPlacedNoteLinks}
                        textFields={noteTextFields}
                        onTextFieldsExtent={remapPlacedTextFields}
                        onInkActivity={handleInkActivity}
                        onTrainingChanged={handleTrainingChanged}
                        foreignErase={isPdfActive ? pdfMarkEraseHost : undefined}
                        liveNote={live.note}
                        onOpenGlyphenWerk={openGlyphenWerk}
                        onSectionFold={(index, collapsed) => {
                          const line = headingLineForSection(activeTab.content, index)
                          if (line) editorRef.current?.foldHeading(line, collapsed)
                        }}
                        confirmDestructive={(message) => requestConfirm(message, { title: 'Training löschen', confirmLabel: 'Löschen' })}
                      />
                    </SafeBoundary>
                  </Suspense>}
                  {drawingOpen && inkBoard.key === 0 && <div className="inline-ink-loading"><LoaderCircle className="spin" size={18} /> Gespeicherte Stiftebene wird geladen …</div>}
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
                  <NoteTextFieldLayer
                    fields={noteTextFields}
                    placing={textFieldPlacing}
                    pdf={isPdfActive}
                    focusId={textFieldFocusId}
                    onPlace={placeTextFieldAt}
                    onText={changeTextFieldText}
                    onGeometry={changeTextFieldGeometry}
                    onStyle={changeTextFieldStyle}
                    onFinish={finishTextFieldEdit}
                    onRemove={removePlacedTextField}
                    onFocusHandled={clearTextFieldFocus}
                    onRemap={remapPlacedTextFields}
                    onSelectedChange={setSelectedTextFieldId}
                  />
                  <StudyAnnotationLayer
                    path={activeTab.path}
                    pdf={isPdfActive}
                    open={false}
                    onClose={() => undefined}
                  />
                </article>
              </PaperView>
              {splitTab && (
                <div
                  className="split-divider"
                  role="separator"
                  aria-label="Teilung anpassen"
                  aria-orientation={splitLayout.orientation === 'columns' ? 'vertical' : 'horizontal'}
                  aria-valuenow={Math.round(splitLayout.ratio * 100)}
                  aria-valuemin={20}
                  aria-valuemax={80}
                  tabIndex={0}
                  title="Ziehen zum Anpassen · Doppelklick für 50/50"
                  onPointerDown={beginSplitDrag}
                  onDoubleClick={() => setSplitLayout((current) => ({ ...current, ratio: DEFAULT_SPLIT_LAYOUT.ratio }))}
                  onKeyDown={splitDividerKey}
                >
                  <span className="split-divider__grip" aria-hidden="true" />
                </div>
              )}
              {splitTab && (
                <section
                  className="split-pane is-split-pane"
                  aria-label={`${splitTab.title} · zweite Notiz`}
                  onPointerDownCapture={() => setFocusedPane('split')}
                  onFocusCapture={() => setFocusedPane('split')}
                >
                <header className="split-pane-head">
                  {splitTab.kind === 'pdf' || isPdfNotePath(splitTab.path) ? <File aria-hidden="true" size={13} /> : <Files aria-hidden="true" size={13} />}
                  <strong title={splitTab.path}>{splitTab.title}</strong>
                  {splitTab.content !== splitTab.savedContent && <i className="dirty-dot" title={uiText('Noch nicht gespeichert', 'Not saved yet')} />}
                  <button type="button" title="Notizen tauschen (Strg+Umschalt+\)" aria-label="Notizen tauschen" onClick={() => void swapSplitPanes()}><ArrowLeftRight size={14} /></button>
                  <button type="button" title={splitLayout.orientation === 'columns' ? 'Untereinander anordnen' : 'Nebeneinander anordnen'} aria-label={splitLayout.orientation === 'columns' ? 'Untereinander anordnen' : 'Nebeneinander anordnen'} onClick={toggleSplitOrientation}>{splitLayout.orientation === 'columns' ? <Rows2 size={14} /> : <Columns2 size={14} />}</button>
                  <button type="button" title="Als einzige Notiz öffnen" aria-label="Als einzige Notiz öffnen" onClick={() => { const target = splitTab.path; splitEditorRef.current?.flushChanges(); setSplitPath(null); void openNote(target) }}><Maximize2 size={14} /></button>
                  <button type="button" aria-label="Teilung schließen" title="Teilung schließen (Strg+\)" onClick={() => { splitEditorRef.current?.flushChanges(); setSplitPath(null) }}><X size={14} /></button>
                </header>
                {(splitTab.kind === 'pdf' || isPdfNotePath(splitTab.path)) && <div id={SPLIT_PDF_TOOLBAR_SLOT_ID} className="split-pdf-toolbar subject-book-pdf-toolbar" />}
                <PaperView
                  className={`unified-note-view paper-${splitTab.kind === 'pdf' || isPdfNotePath(splitTab.path) ? 'blank' : normalizePaperStyle(notePaperByPath[splitTab.path] ?? settings.paperStyle)} ${splitTab.kind === 'pdf' || isPdfNotePath(splitTab.path) ? 'is-pdf-note' : ''}`}
                  viewKey={`split:${splitTab.path}`}
                  showHud={false}
                  store={splitPaperViewStore}
                  globalShortcuts={focusedPane === 'split'}
                  onEdgeSwipe={(direction) => void navigateHistory(direction === 'back' ? -1 : 1)}
                  openZoom={splitTab.kind === 'pdf' || isPdfNotePath(splitTab.path) ? undefined : splitFitZoom}
                >
                  <article className={`unified-paper ${splitTab.kind === 'pdf' || isPdfNotePath(splitTab.path) ? 'is-pdf-note' : ''}`} aria-label={`${splitTab.title} · zweite Spalte`}>
                    {splitTab.kind === 'pdf' || isPdfNotePath(splitTab.path) ? (
                      <Suspense fallback={<div className="pdf-note-status"><LoaderCircle className="spin" size={18} /> PDF wird geladen …</div>}>
                        <SafeBoundary name="Zweite PDF-Notiz" fallbackTitle="Der PDF-Viewer ist abgestürzt">
                          <PdfNoteView
                            path={splitTab.path}
                            title={splitTab.title}
                            inputDisabled={Boolean(tabHolds[splitTab.path])}
                            toolbarSlotId={SPLIT_PDF_TOOLBAR_SLOT_ID}
                            autoFit={false}
                            quotes={readPdfMarks(splitTab.content)}
                            onMarkSelection={(quote, page) => {
                              const marks = addPdfMark(readPdfMarks(splitTab.content), { page, quote, kind: 'highlight' })
                              updateContentFor(splitTab.path, writePdfMarks(splitTab.content, marks))
                            }}
                            onUnmarkSpans={(hit) => {
                              const content = latestNoteContent(splitTab.path)
                              const result = content === null ? null : unmarkPdfNote(content, [hit])
                              if (result) updateContentFor(splitTab.path, result.content)
                            }}
                          />
                        </SafeBoundary>
                      </Suspense>
                    ) : (
                    <div className="editor-pane">
                      <SafeBoundary name="Zweite Notiz" fallbackTitle="Die zweite Notiz ist abgestürzt">
                        <MarkdownEditor
                          ref={splitEditorRef}
                          key={`split-${splitTab.path}`}
                          content={splitTab.content}
                          onChange={(content) => updateContentFor(splitTab.path, content)}
                          onSave={async (content) => { await saveContent(splitTab.path, content) }}
                          onEditActivity={(activity) => recordEditActivityFor(splitTab.path, activity)}
                          foldKey={headingFoldKey(headingFoldScopeRef.current, splitTab.path)}
                          notePath={splitTab.path}
                          settings={settings}
                          paperMode
                          readOnly={(drawingOpen && focusedPane === 'split') || Boolean(tabHolds[splitTab.path])}
                        />
                      </SafeBoundary>
                    </div>
                    )}
                    {drawingOpen && focusedPane === 'split' && loadSplitInk ? (
                      <SafeBoundary name="Handschrift (zweite Spalte)" fallbackTitle="Die zweite Stiftebene ist abgestürzt">
                        <SplitInkEditor path={splitTab.path} title={splitTab.title} load={loadSplitInk} settings={settings} paper={normalizePaperStyle(notePaperByPath[splitTab.path] ?? settings.paperStyle)} onSaveDrawing={saveDrawingAsset} />
                      </SafeBoundary>
                    ) : loadSplitInk && (
                      <SafeBoundary name="Handschrift (zweite Spalte)" fallbackTitle="Die Handschrift-Vorschau ist abgestürzt">
                        <InkPreviewLayer load={loadSplitInk} key={splitTab.path} initial={splitInkInitial} smoothing={settings.smoothing} reloadKey={drawingSession.key} />
                      </SafeBoundary>
                    )}
                  </article>
                </PaperView>
                </section>
              )}
              </div>
              </>
            ) : (
              <div className={`editor-placeholder ${recentClosedNotes.length ? 'has-recent' : ''}`}>
                <div className="placeholder-glyph"><BookOpen size={28} /></div>
                <span className="eyebrow">Bereit für deine nächste Idee</span>
                <h2>Dein Wissen, in deiner Hand</h2>
                <p>Schreibe mit Tastatur und Stift auf derselben Seite, importiere ein PDF als eigene Notiz oder starte mit einem Arbeitsblatt.</p>
                <div className="placeholder-actions">
                  <button className="primary-button" type="button" onClick={() => void createNote()}><FilePlus2 size={14} /> Neue Notiz</button>
                  <button className="secondary-button" type="button" onClick={() => void importPdfNote()}><FileText size={14} /> PDF</button>
                  <button className="secondary-button" type="button" onClick={openWorksheetImport}><FileUp size={14} /> Arbeitsblatt</button>
                </div>
                {recentClosedNotes.length > 0 && (
                  <div className="placeholder-recent">
                    <h3>Zuletzt geöffnete Notizen</h3>
                    {recentClosedNotes.map((note) => (
                      <button key={note.path} type="button" onClick={() => void openNote(note.path)}>
                        <FileText aria-hidden="true" size={14} />
                        <span>{note.title}</span>
                      </button>
                    ))}
                  </div>
                )}
                <button className="placeholder-command" type="button" onClick={() => setPaletteOpen(true)}><Command size={13} /> Alle Aktionen mit <kbd>Strg P</kbd></button>
              </div>
              )}
            </Suspense>
            </div>
          </div>
        </main>

        {inspectorVisible && settings.showOutline && !overviewOpen && !studyOpen && !homeworkOpen && !calendarOpen && !glyphenWerkOpen && !(inspectorTab && (inspectorTab.kind === 'pdf' || isPdfNotePath(inspectorTab.path))) && <Suspense fallback={null}><RightInspector content={inspectorTab?.content ?? ''} path={inspectorTab?.path} notes={inspectorNotes} history={historySnapshots} onShowHistory={() => { void openHistory() }} onRestoreHistory={(id) => { void restoreHistory(id) }} onJumpToLine={(line) => { commandEditor()?.revealLine(line) }} onOpenNote={(path) => { void openNote(path) }} /></Suspense>}
        {addonState.dockOpen && addonState.panels.length > 0 && !glyphenWerkOpen && <Suspense fallback={null}><SafeBoundary name="Add-on-Dock" fallbackTitle="Das Add-on-Dock ist abgestürzt"><AddonPanelDock panels={addonState.panels} activeKey={addonState.activePanel} runtime={addonRuntime} onClose={() => addonRuntime.setDockOpen(false)} /></SafeBoundary></Suspense>}
        {searchOpen && <Suspense fallback={null}><SearchPanel query={searchQuery} hits={searchHits} loading={searchLoading} failed={searchFailed} onQueryChange={setSearchQuery} onOpen={(hit) => { void openSearchHit(hit) }} onClose={() => setSearchOpen(false)} /></Suspense>}
      </div>

      {exportDialog && <Suspense fallback={null}><NoteExportDialog title={exportDialog.title} kind={exportDialog.kind} onExport={runNoteExport} onClose={() => setExportDialog(null)} /></Suspense>}

      {folderPathTarget && (
        <FolderPathDialog
          folderName={folderPathTarget.split('/').pop() || folderPathTarget}
          folderPath={folderPathTarget}
          initialPaths={folderPathInitial}
          folderChoices={[...folderPaths(tree)].filter((path) => path !== folderPathTarget && !path.startsWith(`${folderPathTarget}/`) && !folderPathTarget.startsWith(`${path}/`)).sort((left, right) => left.localeCompare(right, 'de'))}
          usesVaultFolders={window.fanotes.platform === 'web' || window.fanotes.platform === 'browser-preview'}
          busy={folderPathBusy}
          error={folderPathError}
          moved={folderPathMoved}
          conflicts={folderPathConflicts}
          onBrowse={() => window.fanotes.pickFolderLocation()}
          onClose={() => { if (!folderPathBusy) setFolderPathTarget(null) }}
          onSave={(paths, moveContents) => { void saveFolderPath(paths, moveContents) }}
        />
      )}
      {cardsOpen && activeTab && <Suspense fallback={null}><FlashcardReview markdown={activeTab.content} title={activeTab.title} onSave={(markdown) => updateContentFor(activeTab.path, markdown)} onClose={() => setCardsOpen(false)} /></Suspense>}
      {historyOpen && (
        <DialogFrame icon={<History size={18} />} eyebrow="Lokaler Verlauf" title="Frühere Versionen" titleId="history-title" onClose={() => setHistoryOpen(false)} size="md" className="history-dialog">
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
        </DialogFrame>
      )}
      {paletteOpen && <Suspense fallback={null}><SafeBoundary name="Befehlspalette"><CommandPalette actions={paletteActions} mode={paletteMode} rankNotes={rankNotesForPalette} activePath={activePath} onOpenNote={(path) => void openNote(path)} onOpenNoteInSplit={(path) => void openInSplit(path)} onClose={closePalette} /></SafeBoundary></Suspense>}
      <ProfileOverviewPublisher settings={settings} />
      {storyImportParent !== undefined && <Suspense fallback={null}><SafeBoundary name="Import" fallbackTitle="Der Import ist abgestürzt"><StoryImportDialog onImport={(story) => importStoryFile(story)} onClose={() => setStoryImportParent(undefined)} /></SafeBoundary></Suspense>}
      {writingPath && (
        <Suspense fallback={<div className="editor-module-loading"><LoaderCircle className="spin" size={20} /><span>Schreibmodus wird geladen …</span></div>}>
          <SafeBoundary name="Schreiben" fallbackTitle="Der Schreibmodus ist abgestürzt">
            <WritingMode
              key={writingPath}
              path={writingPath}
              onClose={() => { setWritingPath(null); void refreshTree(); syncEngine.notifyLocalChange() }}
              onSaved={() => { syncEngine.notifyLocalChange(); void import('./lib/docSearch/service').then(({ docSearch }) => docSearch.notifyStoryChanged(writingPath)) }}
            />
          </SafeBoundary>
        </Suspense>
      )}
      {oneNoteDialogOpen && <Suspense fallback={null}><SafeBoundary name="OneNote-Import" fallbackTitle="Der OneNote-Import ist abgestürzt"><OneNoteImportDialog folders={oneNoteFolders} onClose={() => setOneNoteDialogOpen(false)} onImported={finishOneNoteImport} /></SafeBoundary></Suspense>}
      {settingsOpen && <Suspense fallback={null}><SafeBoundary name="Einstellungen" fallbackTitle="Die Einstellungen sind abgestürzt"><SettingsModal syncEngine={syncApi ? syncEngine : undefined} syncState={syncState} initialSection={settingsSection} platform={window.fanotes.platform} settings={settings} vaultPath={bootstrap.vaultPath} updateState={updateState} onChange={applySettings} onClose={() => { setSettingsOpen(false); setSettingsSection(undefined) }} onSelectVault={() => void selectVault()} onOpenGlyphenWerk={() => { setSettingsOpen(false); openGlyphenWerk() }} onOpenAddonStore={() => { setSettingsOpen(false); openAddonStore() }} addonSummary={{ installed: addonState.installed.length, running: addonState.installed.filter((record) => addonState.statuses[record.id]?.state === 'running').length }} onImportTraining={importTrainingFromSettings} onImportOneNote={importOneNote} onCheckUpdate={checkForUpdates} onDownloadUpdate={downloadUpdate} onInstallUpdate={installUpdate} onInstallUpdateOnQuit={installUpdateOnQuit} onResetSettings={resetSettings} onResetAppData={resetAppData} onOpenBugReport={() => { setSettingsOpen(false); setBugReportOpen(true) }} onConvertNotes={convertAllNotesToCurrentStandard} onConvertFamd={convertAllFamdNotes} remoteSupportSession={remoteSupportSession} onRemoteSupportStart={startRemoteSupport} onRemoteSupportStop={stopRemoteSupport} /></SafeBoundary></Suspense>}
      {addonStoreOpen && <Suspense fallback={null}><SafeBoundary name="Add-on-Store" fallbackTitle="Der Add-on-Store ist abgestürzt"><AddonStoreModal open onClose={() => setAddonStoreOpen(false)} runtime={addonRuntime} runtimeState={addonState} source={addonSource} fetchText={addonFetchText} onOpenExternal={(url) => { void window.fanotes.openExternal(url).catch(() => toast('Der Link konnte nicht geöffnet werden.', 'error')) }} toast={toast} sourceText={settings.addonSource} onChangeSource={(value) => { addonIndexCache.reset(); applySettings({ ...settingsRef.current, addonSource: value }) }} autoUpdate={settings.addonsAutoUpdate} onChangeAutoUpdate={(value) => applySettings({ ...settingsRef.current, addonsAutoUpdate: value })} /></SafeBoundary></Suspense>}
      {addonPrompt && <Suspense fallback={null}><SafeBoundary name="Add-on-Eingabe" fallbackTitle="Der Add-on-Dialog ist abgestürzt"><AddonPromptDialog request={addonPrompt} /></SafeBoundary></Suspense>}
      {shareJoin && (
        <div className="modal-backdrop confirm-backdrop" role="presentation">
          <section ref={shareJoinDialogRef} className="confirm-dialog share-link-dialog" role="dialog" aria-modal="true" aria-labelledby="fanotes-share-join-title">
            <header className="confirm-dialog-header">
              <span className="confirm-dialog-icon"><FolderOpen size={16} /></span>
              <div><h3 id="fanotes-share-join-title">{shareJoin.step === 'folder' ? 'In welchem Ordner soll die geteilte Datei liegen?' : 'Konto anlegen oder nur einen Namen eintragen?'}</h3></div>
            </header>
            <div className="confirm-dialog-body">
              {shareJoin.step === 'folder' && shareJoin.folders.map((folder) => (
                <button
                  key={folder || 'root'}
                  type="button"
                  className="secondary-button"
                  onClick={() => setShareJoin(chooseShareFolder(shareJoin, folder))}
                >
                  {folder || 'Vault-Wurzel'}
                </button>
              ))}
              {shareJoin.step === 'identity' && (
                <>
                  <input aria-label="Name für diese Freigabe" value={shareNameDraft} onChange={(event) => setShareNameDraft(event.target.value)} />
                  <div className="confirm-dialog-actions">
                    <button type="button" className="secondary-button" onClick={() => { void finishShareIdentity('account') }}>Konto anlegen</button>
                    <button type="button" className="primary-button" onClick={() => { void finishShareIdentity('name') }}>Nur einen Namen eintragen</button>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      )}
      {shareWithUser && (
        <ShareWithUserDialog
          target={shareWithUser}
          signedIn={Boolean(syncState.account)}
          onClose={() => setShareWithUser(null)}
          onOpenAccountSettings={() => { setShareWithUser(null); openSettings('sync') }}
          toast={toast}
        />
      )}
      {shareLinkDialog && (
        <div className="modal-backdrop confirm-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) setShareLinkDialog(null) }}>
          <section ref={shareLinkDialogRef} className="confirm-dialog share-link-dialog" role="dialog" aria-modal="true" aria-labelledby="fanotes-share-link-title" onPointerDown={(event) => event.stopPropagation()}>
            <header className="confirm-dialog-header">
              <span className="confirm-dialog-icon"><Link2 size={16} /></span>
              <div><h3 id="fanotes-share-link-title">Die Freigabe wurde erstellt.</h3></div>
            </header>
            <div className="confirm-dialog-body">
              <small>{shareLinkDialog.mode === 'live' ? 'Live' : shareLinkDialog.mode === 'edit' ? 'Gemeinsam' : 'Kopie'}</small>
              <input ref={shareLinkInputRef} data-i18n-ignore readOnly value={shareLinkDialog.link} aria-label="Freigabe-Link" onFocus={(event) => event.currentTarget.select()} />
            </div>
            <div className="confirm-dialog-actions">
              <button type="button" className="secondary-button" onClick={() => setShareLinkDialog(null)}>Schließen</button>
              <button type="button" className="primary-button" onClick={() => { void copyPlainText(shareLinkDialog.link, 'Die Freigabe wurde erstellt.') }}>Kopieren</button>
            </div>
          </section>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(confirmRequest)}
        title={confirmRequest?.title}
        message={confirmRequest?.message ?? ''}
        confirmLabel={confirmRequest?.confirmLabel}
        onCancel={() => {
          confirmRequest?.resolve(false)
          setConfirmRequest(null)
        }}
        onConfirm={() => {
          confirmRequest?.resolve(true)
          setConfirmRequest(null)
        }}
      />
      {workRequestsOpen && <Suspense fallback={null}><SafeBoundary name="Fehler & Wünsche"><WorkRequestsPanel client={workRequestsClient} version={updateState.currentVersion} platform={window.fanotes.platform} onClose={() => setWorkRequestsOpen(false)} onSent={() => toast('Anfrage wurde gesendet.', 'success')} /></SafeBoundary></Suspense>}
      {bugReportOpen && <Suspense fallback={null}><SafeBoundary name="Fehlerbericht"><BugReportModal version={updateState.currentVersion} platform={window.fanotes.platform} onClose={() => setBugReportOpen(false)} onSent={() => toast('Fehlerbericht wurde an fanotes.fasrv.ch gesendet.', 'success')} /></SafeBoundary></Suspense>}
      {lmStudioOpen && <Suspense fallback={null}><AiPanel settings={settings} note={lmStudioNote} vaultNotes={vaultNoteReferences} pdfPath={isPdfActive && activeTab ? activeTab.path : null} onSettingsChange={(changes) => applySettings({ ...settingsRef.current, ...changes })} onApply={applyLmStudioResult} onApplyMarks={(found) => {
        if (!activeTab || !isPdfActive) return
        if (activeEntryMutating) { toast('Diese Notiz ist während der Dateiaktion schreibgeschützt.', 'error'); return }
        const current = pendingWrites.current.get(activeTab.path) ?? activeTab.content
        updateContentFor(activeTab.path, highlightPdfImportantMarks(current, found))
        toast('Wichtige Stellen wurden mit dem Textmarker markiert.', 'success')
      }} onClose={() => setLmStudioOpen(false)} /></Suspense>}
      {worksheetImportOpen && <div className="modal-backdrop worksheet-import-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) setWorksheetImportOpen(false) }}>
        <section ref={worksheetDialogRef} className="worksheet-import-dialog" role="dialog" aria-modal="true" aria-labelledby="worksheet-import-title">
          <header><div><span><FileUp size={19} /></span><div><small>Bild oder PDF</small><h2 id="worksheet-import-title">Arbeitsblatt importieren</h2></div></div><button type="button" aria-label="Schließen" onClick={() => setWorksheetImportOpen(false)}><X size={17} /></button></header>
          <p>Das Arbeitsblatt bleibt Teil deines Vaults. Anschließend kannst du direkt darauf Textfelder platzieren oder mit dem Grafiktablett schreiben.</p>
          <div className="worksheet-import-options">
            <button type="button" disabled={!activeTab || worksheetImportBusy} onClick={() => void importWorksheet('current')}><span><Files size={22} /></span><strong>In aktuelle Notiz</strong><small>{activeTab ? activeTab.title : 'Keine Notiz geöffnet'}</small></button>
            <button type="button" disabled={worksheetImportBusy} onClick={() => void importWorksheet('new')}><span><FilePlus2 size={22} /></span><strong>Als neue Notiz</strong><small>Dateiname wird zum Notiztitel</small></button>
            <button type="button" className="onenote-import-option" disabled={isWeb} onClick={() => void importOneNote().catch((error) => toast(error instanceof Error ? error.message : 'OneNote-Import fehlgeschlagen.', 'error'))}><span><NotebookTabs size={22} /></span><strong>Microsoft OneNote</strong><small>{isWeb ? 'In der Linux- oder Windows-App' : 'Seiten und Zielordner wählen, Handschrift wird .famd-Ink'}</small></button>
          </div>
          <footer><small>PDF · Bilder · ONE · ONETOC2 · ONEPKG · ZIP</small><button type="button" className="secondary-button" onClick={() => setWorksheetImportOpen(false)}>Abbrechen</button></footer>
        </section>
      </div>}
      {Boolean(window.fanotes.diagnostics) && settings.diagnosticsEnabled && !settings.diagnosticsNoticeSeen && !settingsOpen && (
        <SendDataNotice
          onDismiss={() => applySettings({ ...settingsRef.current, diagnosticsNoticeSeen: true })}
          onTurnOff={() => applySettings({ ...settingsRef.current, diagnosticsEnabled: false, diagnosticsNoticeSeen: true })}
          onOpenSettings={() => { applySettings({ ...settingsRef.current, diagnosticsNoticeSeen: true }); openSettings('senddata') }}
        />
      )}
      <div className="toast-stack" aria-live="polite" aria-relevant="additions">{toasts.map((item) => <div className={`toast ${item.kind}`} role={item.kind === 'error' ? 'alert' : 'status'} key={item.id}>{item.kind === 'success' ? <CheckCircle2 size={16} /> : item.kind === 'error' ? <CircleAlert size={16} /> : <Info size={16} />}<span>{item.message}</span>{item.action && <button type="button" className="toast-action" onClick={() => { const run = item.action?.run; dismissToast(item.id); run?.() }}>{item.action.label}</button>}<button type="button" aria-label="Meldung schließen" onClick={() => dismissToast(item.id)}><X size={13} /></button></div>)}</div>
    </div>
  )
}
