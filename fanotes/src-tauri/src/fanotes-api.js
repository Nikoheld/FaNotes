// Installed by the Tauri host before the React bundle runs. The bundle itself
// still talks to window.fanotes and is not rebuilt for this host.

// `Buffer.from` / `Uint8Array.from` for a real list. A bare number or a plain
// object with `length` must not allocate a buffer of that size.
function listedBytes(value, message) {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value)) return Uint8Array.from(value)
  throw new Error(message)
}

if (typeof window !== 'undefined') {
(() => {
  const internals = window.__TAURI_INTERNALS__
  if (!internals || typeof internals.invoke !== 'function') return
  const decodeByteFields = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const next = { ...value }
    for (const key of ['de', 'en', 'bytes', 'model', 'wasm']) {
      if (typeof next[key] === 'string') next[key] = bytesFromBase64(next[key])
    }
    return next
  }
  const bytesFromBase64 = (value) => {
    if (typeof value !== 'string') throw new Error('Die Datei konnte nicht gelesen werden.')
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  const bytesToBase64 = (bytes) => {
    if (!(bytes instanceof Uint8Array)) throw new Error('Der Sync-Inhalt muss binär sein.')
    let binary = ''
    const chunk = 0x2000
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
    }
    return btoa(binary)
  }
  const invoke = (channel, ...args) => internals.invoke(channel, { args })
  const listen = (channel, callback) => {
    if (typeof callback !== 'function') return () => {}
    let stop = () => {}
    const attach = () => {
      const events = window.__TAURI__ && window.__TAURI__.event
      if (!events || typeof events.listen !== 'function') return false
      events.listen(channel, (event) => callback(event.payload)).then((unlisten) => { stop = unlisten })
      return true
    }
    if (!attach()) {
      const timer = window.setInterval(() => { if (attach()) window.clearInterval(timer) }, 50)
    }
    return () => stop()
  }
  const platform = navigator.userAgent.includes('Windows') ? 'win32' : navigator.userAgent.includes('Mac') ? 'darwin' : 'linux'
  window.fanotes = Object.freeze({
    bootstrap: () => invoke('fanotes:bootstrap'),
    reportRendererReady: () => invoke('fanotes:renderer-ready'),
    completeOnboarding: (subjects) => invoke('fanotes:complete-onboarding', subjects),
    selectVault: () => invoke('fanotes:select-vault'),
    getCachedTree: () => invoke('fanotes:get-cached-tree'),
    getFastTree: () => invoke('fanotes:get-fast-tree'),
    getTree: () => invoke('fanotes:get-tree'),
    readFile: (relativePath) => invoke('fanotes:read-file', relativePath),
    writeFile: (relativePath, content) => invoke('fanotes:write-file', relativePath, content),
    readRecognitionModel: () => invoke('fanotes:read-recognition-model'),
    writeRecognitionModel: (content) => invoke('fanotes:write-recognition-model', content),
    createNote: (parentPath, preferredName) => invoke('fanotes:create-note', parentPath, preferredName),
    createFolder: (parentPath, preferredName) => invoke('fanotes:create-folder', parentPath, preferredName),
    setFolderColor: (relativePath, color) => invoke('fanotes:set-folder-color', relativePath, color),
    getFolderLocations: (relativePath) => invoke('fanotes:get-folder-locations', relativePath),
    pickFolderLocation: () => invoke('fanotes:pick-folder-location'),
    setFolderLocations: (relativePath, paths, moveContents) => invoke('fanotes:set-folder-locations', relativePath, paths, moveContents),
    renameEntry: (relativePath, nextName) => invoke('fanotes:rename-entry', relativePath, nextName),
    moveEntry: (relativePath, destFolder) => invoke('fanotes:move-entry', relativePath, destFolder),
    trashEntry: (relativePath) => invoke('fanotes:trash-entry', relativePath),
    search: (query) => invoke('fanotes:search', query),
    saveDrawing: (payload) => invoke('fanotes:save-drawing', payload),
    listDrawings: () => invoke('fanotes:list-drawings'),
    readDrawing: (id) => invoke('fanotes:read-drawing', id),
    readFamdInk: (relativePath) => invoke('fanotes:read-famd-ink', relativePath),
    readNotePageStats: (relativePath) => invoke('fanotes:read-note-page-stats', relativePath),
    readNotePaperStyle: (relativePath) => invoke('fanotes:read-note-paper-style', relativePath),
    setNotePaperStyle: (relativePath, paperStyle) => invoke('fanotes:set-note-paper-style', relativePath, paperStyle),
    readNoteLinks: (relativePath) => invoke('fanotes:read-note-links', relativePath),
    writeNoteLinks: (relativePath, links) => invoke('fanotes:write-note-links', relativePath, links),
    readNoteBackups: (relativePath) => invoke('fanotes:read-note-backups', relativePath),
    writeNoteBackups: (relativePath, backups) => invoke('fanotes:write-note-backups', relativePath, backups),
    readNoteCompanion: (relativePath) => invoke('fanotes:read-note-companion', relativePath),
    readSubjectBooks: () => invoke('fanotes:read-subject-books'),
    writeSubjectBooks: (books) => invoke('fanotes:write-subject-books', books),
    importSubjectBook: (subjectPath) => invoke('fanotes:import-subject-book', subjectPath),
    openSubjectBookPopout: (relativePath) => invoke('fanotes:open-subject-book-popout', relativePath),
    closeSubjectBookPopout: () => invoke('fanotes:close-subject-book-popout'),
    onSubjectBookPopoutClosed: (callback) => listen('fanotes:subject-book-popout-closed', callback),
    importWorksheet: () => invoke('fanotes:import-worksheet'),
    importWorksheetFromData: (payload) => {
      const bytes = listedBytes(payload && payload.bytes, 'Das Bild ist leer oder zu groß.')
      if (bytes.byteLength <= 0) throw new Error('Das Bild ist leer oder zu groß.')
      return invoke('fanotes:import-worksheet-from-data', {
        name: payload && payload.name,
        mimeType: payload && payload.mimeType,
        bytesBase64: bytesToBase64(bytes),
      })
    },
    importPdfNote: (parentPath) => invoke('fanotes:import-pdf-note', parentPath),
    importOneNote: () => invoke('fanotes:import-onenote'),
    readWorksheet: (id) => invoke('fanotes:read-worksheet', id),
    saveWorksheet: (document) => invoke('fanotes:save-worksheet', document),
    deleteWorksheet: (id) => invoke('fanotes:delete-worksheet', id),
    listNoteHistory: (relativePath) => invoke('fanotes:list-note-history', relativePath),
    readNoteHistory: (relativePath, snapshotId) => invoke('fanotes:read-note-history', relativePath, snapshotId),
    exportNotePdf: () => invoke('fanotes:export-note-pdf'),
    readAssetDataUrl: (relativePath) => invoke('fanotes:read-asset-data-url', relativePath),
    readAssetBytes: async (relativePath) => bytesFromBase64(await invoke('fanotes:read-asset-bytes', relativePath)),
    loadSpellingResources: async () => decodeByteFields(await invoke('fanotes:load-spelling-resources')),
    loadSpellingWordCandidates: async (language) => decodeByteFields(await invoke('fanotes:load-spelling-word-candidates', language)),
    loadHandwritingRecognitionResources: async () => decodeByteFields(await invoke('fanotes:load-handwriting-recognition-resources')),
    recognizeNativeHandwritingLine: async (request) => {
      const input = request && request.input instanceof Float32Array
        ? request.input
        : new Float32Array((request && request.input) || [])
      const view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      const tight = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view : view.slice()
      const result = await invoke('fanotes:recognize-native-handwriting-line', {
        width: request.width,
        height: request.height,
        threads: request.threads,
        inputBase64: bytesToBase64(tight),
      })
      const raw = bytesFromBase64(result.probabilitiesBase64 || '')
      const probabilities = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
      return {
        engine: result.engine,
        dims: result.dims,
        characters: result.characters,
        probabilities,
      }
    },
    getEnhancedMathRecognitionState: () => invoke('fanotes:enhanced-math-get-state'),
    installEnhancedMathRecognitionModel: (request) => invoke('fanotes:enhanced-math-install', request),
    recognizeEnhancedMath: (request) => invoke('fanotes:enhanced-math-recognize', request),
    getQwenVisionState: () => invoke('fanotes:qwen-vision-get-state'),
    installQwenVisionModel: (request) => invoke('fanotes:qwen-vision-install', request),
    recognizeQwenVision: (request) => invoke('fanotes:qwen-vision-recognize', request),
    lmStudioListModels: (baseUrl, apiToken) => invoke('fanotes:lm-studio-list-models', baseUrl, apiToken),
    lmStudioTransform: (payload) => invoke('fanotes:lm-studio-transform', payload),
    aiListModels: (connection) => invoke('fanotes:ai-list-models', connection),
    aiTransform: (payload) => invoke('fanotes:ai-transform', payload),
    loadSecureSettings: () => invoke('fanotes:load-secure-settings'),
    saveSettings: (settings, options) => invoke('fanotes:save-settings', settings, options),
    resetAppData: () => invoke('fanotes:reset-app-data'),
    getUpdateState: () => invoke('fanotes:update-get-state'),
    checkForUpdates: () => invoke('fanotes:update-check'),
    downloadUpdate: () => invoke('fanotes:update-download'),
    installUpdate: () => invoke('fanotes:update-install'),
    onUpdateState: (callback) => listen('fanotes:update-state', callback),
    revealInFolder: (relativePath) => invoke('fanotes:reveal-in-folder', relativePath),
    openExternal: (url) => invoke('fanotes:open-external', url),
    onBeforeClose: (callback) => listen('fanotes:before-close', callback),
    confirmClose: () => invoke('fanotes:confirm-close'),
    cancelClose: () => invoke('fanotes:cancel-close'),
    requestClose: () => invoke('fanotes:request-close'),
    onSheetZoom: (callback) => listen('fanotes:sheet-zoom', (direction) => callback(direction)),
    captureWindow: () => invoke('fanotes:capture-window'),
    renderPdfPage: (request) => invoke('fanotes:render-pdf-page', request),
    addons: {
      fetchText: (url) => invoke('fanotes:addons-fetch', url),
      list: () => invoke('fanotes:addons-list'),
      save: (record) => invoke('fanotes:addons-save', record),
      remove: (id) => invoke('fanotes:addons-remove', id),
      readFile: (id, name) => invoke('fanotes:addons-read-file', id, name),
      writeFiles: (id, files) => invoke('fanotes:addons-write-files', id, files),
      readData: (id) => invoke('fanotes:addons-read-data', id),
      writeData: (id, value) => invoke('fanotes:addons-write-data', id, value),
      netFetch: (url, init) => invoke('fanotes:addons-net-fetch', url, init),
    },
    sync: {
      vaultId: () => invoke('fanotes:sync-vault-id'),
      scan: () => invoke('fanotes:sync-scan'),
      read: async (relativePath) => bytesFromBase64(await invoke('fanotes:sync-read', relativePath)),
      write: (relativePath, bytes, mtimeMs) => invoke('fanotes:sync-write', relativePath, bytesToBase64(listedBytes(bytes, 'Der Sync-Inhalt muss binär sein.')), mtimeMs),
      remove: (relativePath) => invoke('fanotes:sync-remove', relativePath),
      readState: (vaultId) => invoke('fanotes:sync-read-state', vaultId),
      writeState: (vaultId, json) => invoke('fanotes:sync-write-state', vaultId, json),
      readSecrets: () => invoke('fanotes:sync-read-secrets'),
      writeSecrets: (json) => invoke('fanotes:sync-write-secrets', json),
    },
    platform,
  })
})()
}

if (typeof module === 'object' && module.exports) {
  module.exports = { listedBytes }
}
