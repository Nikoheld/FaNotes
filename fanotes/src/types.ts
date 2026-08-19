import type { NoteBackupSnapshot } from './lib/noteBackup'
import type { NoteLinkRecord } from './lib/noteLink'

export type VaultEntry = {
  name: string
  relativePath: string
  kind: 'file' | 'folder'
  extension?: string
  modifiedAt?: string
  size?: number
  color?: string
  children?: VaultEntry[]
}

export type ThemeMode = 'dark' | 'light' | 'system' | 'midnight' | 'forest' | 'aurora' | 'sepia'
export type WorkspaceBackground = 'clean' | 'gradient' | 'mesh' | 'paper'
export type PaperStyle = 'blank' | 'dots' | 'squares' | 'grid' | 'lines' | 'millimeter'
export type UiLanguagePreference = 'system' | 'de' | 'en'

export type SpellingLanguage = 'de' | 'en'
export type DetectedTextLanguage = SpellingLanguage | 'mixed' | 'unknown'

export type SpellingFilterManifest = {
  format: 'fanotes-spelling-bloom-v2'
  bitsPerWord: number
  hashes: number
  languages: Record<SpellingLanguage, {
    file: string
    bitCount: number
    wordCount: number
    sha256: string
    candidates: {
      file: string
      size: number
      wordCount: number
      sha256: string
    }
  }>
}

export type SpellingResources = {
  manifest: SpellingFilterManifest
  de: Uint8Array
  en: Uint8Array
}

export type SpellingWordCandidatesResource = {
  language: SpellingLanguage
  descriptor: SpellingFilterManifest['languages'][SpellingLanguage]['candidates']
  bytes: Uint8Array
}

export type HandwritingRecognitionManifest = {
  format: 'fanotes-neural-handwriting-v3'
  models: {
    desktop: { name: 'PyLaia_IAM_CTC'; precision: 'fp32'; file: string; size: number; sha256: string }
    web: { name: 'PyLaia_IAM_CTC'; precision: 'q8-dynamic'; file: string; size: number; sha256: string }
  }
  runtime: { name: 'onnxruntime-web'; version: '1.22.0'; file: string; size: number; sha256: string }
  characters: { file: string; count: number; size: number; sha256: string }
}

export type HandwritingRecognitionResources = {
  manifest: HandwritingRecognitionManifest
  model: Uint8Array
  wasm: Uint8Array
  characters: string[]
}

export type AppSettings = {
  uiLanguage: UiLanguagePreference
  theme: ThemeMode
  workspaceBackground: WorkspaceBackground
  accent: string
  accentSecondary: string
  uiFont: string
  editorFont: string
  editorFontSize: number
  previewFontSize: number
  lineHeight: number
  readableLineLength: boolean
  contentWidth: number
  showLineNumbers: boolean
  spellcheck: boolean
  vimMode: boolean
  autosaveDelay: number
  sidebarWidth: number
  rightPanelWidth: number
  compactMode: boolean
  glassEffects: boolean
  reduceMotion: boolean
  /** 1 = langsam, 5 = normal, 10 = schnell. Steuert Mausrad- und Trackpad-Zoom. */
  viewZoomSpeed: number
  /** Oberes Zoom-Limit in Prozent (50–600). Standard 325. */
  viewZoomMax: number
  showWordCount: boolean
  showOutline: boolean
  defaultFolder: string
  dailyNotesFolder: string
  dateFormat: string
  paperStyle: PaperStyle
  penColor: string
  penWidth: number
  pressureEnabled: boolean
  /** When true, only pointerType "pen" can ink; touch/mouse (hand/palm) are ignored. */
  penOnly: boolean
  smoothing: number
  scribbleEraseSensitivity: number
  /** 0 = nur sehr klare Figuren, 50 = normal, 100 = früher und großzügiger glätten. */
  shapeSnapSensitivity: number
  recognitionMode: 'auto' | 'math' | 'text'
  lastRecognitionMode: 'math' | 'text'
  recognitionLanguage: 'de' | 'en'
  autoOpenConversion: boolean
  keepDrawingAfterInsert: boolean
  autoCheckUpdates: boolean
  autoDownloadUpdates: boolean
  installUpdatesOnQuit: boolean
  updateChannel: 'stable' | 'beta'
  /** 0 keeps Chromium/V8's normal renderer heap budget. */
  memoryBudgetMb: number
  /** 0 selects a conservative hardware-adaptive TrOCR thread count. */
  ocrThreadLimit: number
  /** Desktop can add the larger contextual model to the native compact model. */
  desktopOcrModel: 'compact' | 'extended'
  /** Optional native 2-D handwritten-formula sequence recognizer. */
  enhancedMathRecognition: boolean
  /** Records explicit acceptance of the separately downloaded model license. */
  enhancedMathLicenseAccepted: boolean
  /** Optional Qwen3-VL vision recognizer (Intel NPU only, OpenVINO INT4). */
  qwenVisionRecognition: boolean
  /** Records explicit acceptance of the Qwen3-VL / OpenVINO model license. */
  qwenVisionLicenseAccepted: boolean
  /**
   * Experimental: convert handwriting to text (page/region convert, search
   * transcript, math solver/corrector). Off by default — missing saved values
   * stay off so existing vaults remain off after an update.
   */
  experimentalHandwritingToText: boolean
  /** App version that last applied the experimental H2T default. */
  experimentalHandwritingToTextSeenVersion: string
  /** Experimental: publish the homework list to fanotes.fasrv.ch. Off by default. */
  experimentalHomeworkApi: boolean
  /** Experimental: opt-in Remote Support session. Off by default; no session until Start. */
  experimentalRemoteSupport: boolean
  /** Experimental: explicit Backup of the current note in the top bar. Off by default. */
  experimentalNoteBackup: boolean
  /** Last opened note path. Restored on launch when the file still exists. */
  lastOpenNotePath: string
  /** Public channel id (32 hex) used in the homework query URL. */
  homeworkApiChannelId: string
  /** Local-only homework API secret. Never sent to backups. */
  homeworkApiSecret: string
  /** Seconds to retain the large TrOCR worker after the last conversion. */
  ocrModelKeepAliveSeconds: number
  /** 0 uses the normal desktop I/O scheduler; otherwise caps parallel work. */
  backgroundTaskLimit: number
  lmStudioBaseUrl: string
  lmStudioModel: string
  lmStudioApiToken: string
  aiProvider: AiProviderId
  ollamaBaseUrl: string
  ollamaModel: string
  ollamaApiToken: string
  openAiModel: string
  openAiApiKey: string
  geminiModel: string
  geminiApiKey: string
  anthropicModel: string
  anthropicApiKey: string
  openCodeBaseUrl: string
  openCodeModel: string
  openCodeUsername: string
  openCodePassword: string
  customCss: string
}

export type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'

export type UpdateState = {
  status: UpdateStatus
  supported: boolean
  currentVersion: string
  latestVersion: string | null
  publishedAt: string | null
  releaseNotes: string[]
  downloadedBytes: number
  totalBytes: number
  progress: number
  error: string | null
  checkedAt: string | null
  installationKind: 'appimage' | 'managed-appimage' | 'windows-installer' | 'differential-appimage' | 'differential-windows'
  autoCheckUpdates: boolean
  autoDownloadUpdates: boolean
  installUpdatesOnQuit: boolean
  updateChannel: 'stable' | 'beta'
}

export type EnhancedMathRecognitionState = {
  supported: boolean
  installed: boolean
  downloading: boolean
  modelId: 'posformer-crohme-q4-k'
  size: number
  license: 'CC-BY-NC-SA-3.0'
  homepage: string
}

export type QwenVisionState = {
  supported: boolean
  installed: boolean
  downloading: boolean
  /** True while FaNotes auto-installs OpenVINO packages into its isolated venv. */
  runtimeInstalling?: boolean
  /** True when the isolated OpenVINO venv imports cleanly. */
  runtimeReady?: boolean
  runtimePhase?: 'idle' | 'preparing' | 'installing' | 'ready' | 'error' | string
  runtimeMessage?: string | null
  npu: boolean
  genai: boolean
  devices: string[]
  npuDevice?: string | null
  host?: { driverPaths?: string[]; hints?: string[] } | null
  openvinoVersion: string | null
  modelId: 'qwen3-vl-2b-int4-npu'
  label: string
  recommended?: boolean
  precision: 'int4'
  device: 'NPU'
  license: 'Apache-2.0'
  homepage: string
  repo: string
  error: string | null
  /** Optional pip/install command (legacy fallback; runtime auto-install is preferred). */
  installHint?: string | null
}

export type BootstrapData = {
  vaultPath: string
  vaultName: string
  settings: AppSettings
  onboardingRequired: boolean
  starterSubjects: StarterSubject[]
}

export type StarterSubject = {
  name: string
  color: string
}

export type NoteKind = 'markdown' | 'pdf'

export type NoteTab = {
  path: string
  title: string
  content: string
  savedContent: string
  kind?: NoteKind
  pinned?: boolean
}

export type CreateResult = {
  relativePath: string
  entry: VaultEntry
}

export type SearchHit = {
  relativePath: string
  title: string
  excerpt: string
  matches: number
  kind?: 'note' | 'drawing'
  drawingId?: string
}

export type DrawingAsset = {
  id: string
  imageRelativePath: string
  dataRelativePath: string
  title?: string
  updatedAt?: string
}

export type DrawingLibraryItem = {
  id: string
  title: string
  updatedAt: string
  imageRelativePath: string
  dataRelativePath: string
}

export type DrawingLibraryDocument = DrawingLibraryItem & {
  drawingJson: string
}

export type WorksheetTextBox = {
  id: string
  page: number
  x: number
  y: number
  width: number
  text: string
  fontSize: number
}

export type WorksheetHighlight = {
  id: string
  page: number
  x: number
  y: number
  width: number
  height: number
  color: string
}

export type WorksheetDocument = {
  schemaVersion: 1
  id: string
  title: string
  kind: 'image' | 'pdf' | 'html'
  mimeType: string
  sourceRelativePath: string
  dataRelativePath: string
  createdAt: string
  updatedAt: string
  pageWidth?: number
  pageHeight?: number
  textBoxes: WorksheetTextBox[]
  highlights?: WorksheetHighlight[]
}

export type NoteHistorySnapshot = {
  id: string
  createdAt: string
  bytes: number
}

export type OneNoteImportResult = {
  rootFolder: string
  pageCount: number
  attachmentCount: number
  importedNotes: string[]
  warnings: string[]
}

export type LmStudioAction =
  | 'instruction'
  | 'spelling'
  | 'links'
  | 'facts'
  | 'style'
  | 'structure'
  | 'expand'
  | 'summary'
  | 'study'

export type LmStudioModel = {
  key: string
  displayName: string
  publisher: string
  quantization: string | null
  params: string | null
  loaded: boolean
  maxContextLength: number | null
  description?: string | null
}

export type LmStudioTransformResult = {
  markdown: string
  model: string
  stats: {
    inputTokens?: number
    outputTokens?: number
    tokensPerSecond?: number
  }
}

export type AiProviderId = 'lmstudio' | 'ollama' | 'openai' | 'gemini' | 'anthropic' | 'opencode'

export type AiConnection = {
  provider: AiProviderId
  baseUrl: string
  apiKey: string
  username?: string
  model: string
}

export type AiModel = LmStudioModel & {
  provider: AiProviderId
}

export type AiTransformResult = LmStudioTransformResult & {
  provider: AiProviderId
}

export type ServerBackupState = {
  supported: boolean
  enabled: boolean
  status: 'disabled' | 'ready' | 'syncing' | 'error'
  lastBackupAt: string | null
  sizeBytes: number
  recoveryCode: string | null
  automatic: boolean
  error: string | null
}

export type FaNotesApi = {
  bootstrap: () => Promise<BootstrapData>
  reportRendererReady: () => void
  completeOnboarding: (subjects: string[]) => Promise<BootstrapData>
  selectVault: () => Promise<BootstrapData | null>
  getCachedTree: () => Promise<VaultEntry[] | null>
  getFastTree: () => Promise<VaultEntry[]>
  getTree: () => Promise<VaultEntry[]>
  readFile: (relativePath: string) => Promise<string>
  readAssetDataUrl: (relativePath: string) => Promise<string>
  readAssetBytes: (relativePath: string) => Promise<Uint8Array>
  loadSpellingResources: () => Promise<SpellingResources>
  loadSpellingWordCandidates: (language: SpellingLanguage) => Promise<SpellingWordCandidatesResource>
  loadHandwritingRecognitionResources: () => Promise<HandwritingRecognitionResources>
  recognizeNativeHandwritingLine?: (request: {
    input: Float32Array
    width: number
    height: number
    threads: number
  }) => Promise<{ probabilities: Float32Array; dims: number[]; characters: string[]; engine: 'onnxruntime-node-cpu' }>
  getEnhancedMathRecognitionState?: () => Promise<EnhancedMathRecognitionState>
  installEnhancedMathRecognitionModel?: (request: { acceptLicense: true }) => Promise<EnhancedMathRecognitionState>
  recognizeEnhancedMath?: (request: {
    pixels: Uint8Array
    width: number
    height: number
  }) => Promise<{
    latex: string
    engine: 'posformer-crohme-q4-k'
    durationMs: number
    /** True only when the sequence contains a genuine 2-D construct. */
    structured: boolean
    /** Conservative holdout-calibrated decision to prefer it over the fallback. */
    recommended: boolean
    /** Mean top-1/top-2 decoder-logit margin; deliberately not a probability. */
    meanTokenMargin: number
    weakTokenRatio: number
    decodedTokens: number
  }>
  getQwenVisionState?: () => Promise<QwenVisionState>
  installQwenVisionModel?: (request: { acceptLicense: true }) => Promise<QwenVisionState>
  recognizeQwenVision?: (request: {
    pixels: Uint8Array
    width: number
    height: number
    maxNewTokens?: number
    language?: 'de' | 'en'
    lineCount?: number
    hasGlyphLegend?: boolean
  }) => Promise<{
    text: string
    device: 'NPU'
    precision: 'int4'
    modelId: 'qwen3-vl-2b-int4-npu'
    confidence: number
  }>
  writeFile: (relativePath: string, content: string) => Promise<{ modifiedAt: string }>
  createNote: (parentPath?: string, preferredName?: string) => Promise<CreateResult>
  createFolder: (parentPath?: string, preferredName?: string) => Promise<CreateResult>
  setFolderColor: (relativePath: string, color: string | null) => Promise<{ color: string | null }>
  renameEntry: (relativePath: string, nextName: string) => Promise<string>
  moveEntry: (relativePath: string, destFolder?: string | null) => Promise<string>
  trashEntry: (relativePath: string) => Promise<void>
  search: (query: string) => Promise<SearchHit[]>
  saveDrawing: (payload: { id?: string; title: string; imageData?: string; drawingJson: string; noteRelativePath?: string }) => Promise<DrawingAsset>
  listDrawings: () => Promise<DrawingLibraryItem[]>
  readDrawing: (id: string) => Promise<DrawingLibraryDocument>
  readFamdInk: (relativePath: string) => Promise<DrawingLibraryDocument | null>
  readNotePaperStyle?: (relativePath: string) => Promise<PaperStyle | null>
  setNotePaperStyle?: (relativePath: string, paperStyle: PaperStyle) => Promise<PaperStyle>
  readNoteLinks?: (relativePath: string) => Promise<NoteLinkRecord[]>
  writeNoteLinks?: (relativePath: string, links: NoteLinkRecord[]) => Promise<NoteLinkRecord[]>
  readNoteBackups?: (relativePath: string) => Promise<NoteBackupSnapshot[]>
  writeNoteBackups?: (relativePath: string, backups: NoteBackupSnapshot[]) => Promise<NoteBackupSnapshot[]>
  importWorksheet: () => Promise<WorksheetDocument | null>
  importWorksheetFromData?: (payload: { name: string; mimeType: string; bytes: Uint8Array }) => Promise<WorksheetDocument>
  importPdfNote: (parentPath?: string) => Promise<CreateResult | null>
  importOneNote: () => Promise<OneNoteImportResult | null>
  readWorksheet: (id: string) => Promise<WorksheetDocument>
  saveWorksheet: (document: WorksheetDocument) => Promise<WorksheetDocument>
  deleteWorksheet: (id: string) => Promise<{ id: string }>
  listNoteHistory?: (relativePath: string) => Promise<NoteHistorySnapshot[]>
  readNoteHistory?: (relativePath: string, snapshotId: string) => Promise<{ id: string; createdAt: string; content: string }>
  exportNotePdf?: () => Promise<{ filePath: string } | null>
  lmStudioListModels: (baseUrl: string, apiToken?: string) => Promise<LmStudioModel[]>
  lmStudioTransform: (payload: {
    baseUrl: string
    apiToken?: string
    model: string
    title: string
    relativePath: string
    markdown: string
    actions: LmStudioAction[]
    instruction: string
    vaultNotes: Array<{ title: string; relativePath: string }>
  }) => Promise<LmStudioTransformResult>
  aiListModels: (connection: AiConnection) => Promise<AiModel[]>
  aiTransform: (payload: {
    connection: AiConnection
    title: string
    relativePath: string
    markdown: string
    actions: LmStudioAction[]
    instruction: string
    vaultNotes: Array<{ title: string; relativePath: string }>
  }) => Promise<AiTransformResult>
  loadSecureSettings?: () => Promise<Partial<AppSettings>>
  saveSettings: (settings: AppSettings, options?: { clearProtectedSecrets?: boolean }) => Promise<AppSettings>
  getServerBackupState?: () => Promise<ServerBackupState>
  enableServerBackup?: (enrollmentCode: string) => Promise<ServerBackupState>
  connectServerBackup?: (recoveryCode: string) => Promise<ServerBackupState>
  syncServerBackup?: () => Promise<ServerBackupState>
  restoreServerBackup?: () => Promise<ServerBackupState>
  deleteServerBackup?: () => Promise<ServerBackupState>
  resetAppData: () => Promise<{ restarting: boolean }>
  getUpdateState: () => Promise<UpdateState>
  checkForUpdates: () => Promise<UpdateState>
  downloadUpdate: () => Promise<UpdateState>
  installUpdate: () => Promise<UpdateState>
  onUpdateState: (callback: (state: UpdateState) => void) => () => void
  revealInFolder: (relativePath: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  onBeforeClose: (callback: () => void) => () => void
  confirmClose: () => void
  cancelClose: () => void
  requestClose: () => void
  onSheetZoom?: (callback: (direction: 'in' | 'out') => void) => () => void
  captureWindow?: () => Promise<string>
  platform: string
}

declare global {
  interface Window {
    fanotes: FaNotesApi
  }
}
