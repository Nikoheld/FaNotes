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
export type PaperStyle = 'blank' | 'dots' | 'grid' | 'lines'
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
  showWordCount: boolean
  showOutline: boolean
  defaultFolder: string
  dailyNotesFolder: string
  dateFormat: string
  paperStyle: PaperStyle
  penColor: string
  penWidth: number
  pressureEnabled: boolean
  smoothing: number
  scribbleEraseSensitivity: number
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

export type NoteTab = {
  path: string
  title: string
  content: string
  savedContent: string
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
  loadSpellingResources: () => Promise<SpellingResources>
  loadSpellingWordCandidates: (language: SpellingLanguage) => Promise<SpellingWordCandidatesResource>
  loadHandwritingRecognitionResources: () => Promise<HandwritingRecognitionResources>
  recognizeNativeHandwritingLine?: (request: {
    input: Float32Array
    width: number
    height: number
    threads: number
  }) => Promise<{ probabilities: Float32Array; dims: number[]; characters: string[]; engine: 'onnxruntime-node-cpu' }>
  writeFile: (relativePath: string, content: string) => Promise<{ modifiedAt: string }>
  createNote: (parentPath?: string, preferredName?: string) => Promise<CreateResult>
  createFolder: (parentPath?: string, preferredName?: string) => Promise<CreateResult>
  setFolderColor: (relativePath: string, color: string | null) => Promise<{ color: string | null }>
  renameEntry: (relativePath: string, nextName: string) => Promise<string>
  trashEntry: (relativePath: string) => Promise<void>
  search: (query: string) => Promise<SearchHit[]>
  saveDrawing: (payload: { id?: string; title: string; imageData?: string; drawingJson: string }) => Promise<DrawingAsset>
  listDrawings: () => Promise<DrawingLibraryItem[]>
  readDrawing: (id: string) => Promise<DrawingLibraryDocument>
  importWorksheet: () => Promise<WorksheetDocument | null>
  importOneNote: () => Promise<OneNoteImportResult | null>
  readWorksheet: (id: string) => Promise<WorksheetDocument>
  saveWorksheet: (document: WorksheetDocument) => Promise<WorksheetDocument>
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
  platform: string
}

declare global {
  interface Window {
    fanotes: FaNotesApi
  }
}
