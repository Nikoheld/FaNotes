'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const CHANNELS = Object.freeze({
  bootstrap: 'lernwerk:bootstrap',
  rendererReady: 'lernwerk:renderer-ready',
  completeOnboarding: 'lernwerk:complete-onboarding',
  getCachedTree: 'lernwerk:get-cached-tree',
  getFastTree: 'lernwerk:get-fast-tree',
  selectVault: 'lernwerk:select-vault',
  getTree: 'lernwerk:get-tree',
  readFile: 'lernwerk:read-file',
  writeFile: 'lernwerk:write-file',
  createNote: 'lernwerk:create-note',
  createFolder: 'lernwerk:create-folder',
  setFolderColor: 'lernwerk:set-folder-color',
  renameEntry: 'lernwerk:rename-entry',
  trashEntry: 'lernwerk:trash-entry',
  search: 'lernwerk:search',
  saveDrawing: 'lernwerk:save-drawing',
  listDrawings: 'lernwerk:list-drawings',
  readDrawing: 'lernwerk:read-drawing',
  importWorksheet: 'lernwerk:import-worksheet',
  importOneNote: 'fanotes:import-onenote',
  readWorksheet: 'lernwerk:read-worksheet',
  saveWorksheet: 'lernwerk:save-worksheet',
  readAssetDataUrl: 'lernwerk:read-asset-data-url',
  loadSpellingResources: 'fanotes:load-spelling-resources',
  loadSpellingWordCandidates: 'fanotes:load-spelling-word-candidates',
  loadHandwritingRecognitionResources: 'fanotes:load-handwriting-recognition-resources',
  recognizeNativeHandwritingLine: 'fanotes:recognize-native-handwriting-line',
  lmStudioListModels: 'lernwerk:lm-studio-list-models',
  lmStudioTransform: 'lernwerk:lm-studio-transform',
  aiListModels: 'fanotes:ai-list-models',
  aiTransform: 'fanotes:ai-transform',
  loadSecureSettings: 'fanotes:load-secure-settings',
  saveSettings: 'lernwerk:save-settings',
  resetAppData: 'lernwerk:reset-app-data',
  updateGetState: 'lernwerk:update-get-state',
  updateCheck: 'lernwerk:update-check',
  updateDownload: 'lernwerk:update-download',
  updateInstall: 'lernwerk:update-install',
  updateState: 'lernwerk:update-state',
  revealInFolder: 'lernwerk:reveal-in-folder',
  openExternal: 'lernwerk:open-external',
  beforeClose: 'lernwerk:before-close',
  confirmClose: 'lernwerk:confirm-close',
  cancelClose: 'lernwerk:cancel-close',
  requestClose: 'lernwerk:request-close',
})

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

const api = Object.freeze({
  bootstrap: () => invoke(CHANNELS.bootstrap),
  reportRendererReady: () => ipcRenderer.send(CHANNELS.rendererReady),
  completeOnboarding: (subjects) => invoke(CHANNELS.completeOnboarding, subjects),
  selectVault: () => invoke(CHANNELS.selectVault),
  getCachedTree: () => invoke(CHANNELS.getCachedTree),
  getFastTree: () => invoke(CHANNELS.getFastTree),
  getTree: () => invoke(CHANNELS.getTree),
  readFile: (relativePath) => invoke(CHANNELS.readFile, relativePath),
  writeFile: (relativePath, content) => invoke(CHANNELS.writeFile, relativePath, content),
  createNote: (parentPath, preferredName) => invoke(CHANNELS.createNote, parentPath, preferredName),
  createFolder: (parentPath, preferredName) => invoke(CHANNELS.createFolder, parentPath, preferredName),
  setFolderColor: (relativePath, color) => invoke(CHANNELS.setFolderColor, relativePath, color),
  renameEntry: (relativePath, nextName) => invoke(CHANNELS.renameEntry, relativePath, nextName),
  trashEntry: (relativePath) => invoke(CHANNELS.trashEntry, relativePath),
  search: (query) => invoke(CHANNELS.search, query),
  saveDrawing: (payload) => invoke(CHANNELS.saveDrawing, payload),
  listDrawings: () => invoke(CHANNELS.listDrawings),
  readDrawing: (id) => invoke(CHANNELS.readDrawing, id),
  importWorksheet: () => invoke(CHANNELS.importWorksheet),
  importOneNote: () => invoke(CHANNELS.importOneNote),
  readWorksheet: (id) => invoke(CHANNELS.readWorksheet, id),
  saveWorksheet: (document) => invoke(CHANNELS.saveWorksheet, document),
  readAssetDataUrl: (relativePath) => invoke(CHANNELS.readAssetDataUrl, relativePath),
  loadSpellingResources: () => invoke(CHANNELS.loadSpellingResources),
  loadSpellingWordCandidates: (language) => invoke(CHANNELS.loadSpellingWordCandidates, language),
  loadHandwritingRecognitionResources: () => invoke(CHANNELS.loadHandwritingRecognitionResources),
  recognizeNativeHandwritingLine: (request) => invoke(CHANNELS.recognizeNativeHandwritingLine, request),
  lmStudioListModels: (baseUrl, apiToken) => invoke(CHANNELS.lmStudioListModels, baseUrl, apiToken),
  lmStudioTransform: (payload) => invoke(CHANNELS.lmStudioTransform, payload),
  aiListModels: (connection) => invoke(CHANNELS.aiListModels, connection),
  aiTransform: (payload) => invoke(CHANNELS.aiTransform, payload),
  loadSecureSettings: () => invoke(CHANNELS.loadSecureSettings),
  saveSettings: (settings, options) => invoke(CHANNELS.saveSettings, settings, options),
  resetAppData: () => invoke(CHANNELS.resetAppData),
  getUpdateState: () => invoke(CHANNELS.updateGetState),
  checkForUpdates: () => invoke(CHANNELS.updateCheck),
  downloadUpdate: () => invoke(CHANNELS.updateDownload),
  installUpdate: () => invoke(CHANNELS.updateInstall),
  onUpdateState: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, state) => callback(state)
    ipcRenderer.on(CHANNELS.updateState, listener)
    return () => ipcRenderer.removeListener(CHANNELS.updateState, listener)
  },
  revealInFolder: (relativePath) => invoke(CHANNELS.revealInFolder, relativePath),
  openExternal: (url) => invoke(CHANNELS.openExternal, url),
  onBeforeClose: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = () => callback()
    ipcRenderer.on(CHANNELS.beforeClose, listener)
    return () => ipcRenderer.removeListener(CHANNELS.beforeClose, listener)
  },
  confirmClose: () => ipcRenderer.send(CHANNELS.confirmClose),
  cancelClose: () => ipcRenderer.send(CHANNELS.cancelClose),
  requestClose: () => ipcRenderer.send(CHANNELS.requestClose),
  platform: process.platform,
})

contextBridge.exposeInMainWorld('lernwerk', api)
