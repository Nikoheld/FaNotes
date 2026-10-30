'use strict'

// No Electron import: the profile check calls this same save sanitizer.

const path = require('node:path')
const { sanitizeTabletButtonMap } = require('./tablet-buttons.cjs')

const DANGEROUS_CUSTOM_CSS = /(?:@import|@charset|@namespace|@font-face|expression\s*\(|url\s*\(|-moz-binding|behavior\s*:|javascript\s*:|vbscript\s*:|<\/)/iu

const SETTINGS_SCHEMA = Object.freeze({
  uiLanguage: { type: 'enum', values: ['system', 'de', 'en'] },
  theme: { type: 'enum', values: ['dark', 'light', 'system', 'midnight', 'forest', 'aurora', 'sepia'] },
  workspaceBackground: { type: 'enum', values: ['clean', 'gradient', 'mesh', 'paper'] },
  accent: { type: 'color' },
  accentSecondary: { type: 'color' },
  uiFont: { type: 'string', max: 240 },
  editorFont: { type: 'string', max: 240 },
  editorFontSize: { type: 'number', min: 10, max: 40 },
  previewFontSize: { type: 'number', min: 10, max: 48 },
  lineHeight: { type: 'number', min: 1, max: 3 },
  readableLineLength: { type: 'boolean' },
  contentWidth: { type: 'number', min: 420, max: 1800 },
  showLineNumbers: { type: 'boolean' },
  spellcheck: { type: 'boolean' },
  autocorrect: { type: 'boolean' },
  vimMode: { type: 'boolean' },
  autosaveDelay: { type: 'number', min: 100, max: 10000 },
  sidebarWidth: { type: 'number', min: 180, max: 620 },
  rightPanelWidth: { type: 'number', min: 220, max: 720 },
  compactMode: { type: 'boolean' },
  glassEffects: { type: 'boolean' },
  reduceMotion: { type: 'boolean' },
  viewZoomSpeed: { type: 'number', min: 1, max: 10 },
  viewZoomMax: { type: 'number', min: 50, max: 600 },
  addonSource: { type: 'string', max: 400 },
  addonsAutoUpdate: { type: 'boolean' },
  syncAutomatic: { type: 'boolean' },
  syncDeviceName: { type: 'string', max: 80 },
  syncExcludedFolders: { type: 'string', max: 4000 },
  syncHandwritingModel: { type: 'boolean' },
  syncNoteHistory: { type: 'boolean' },
  profileOwnerId: { type: 'string', max: 32 },
  profileUsername: { type: 'string', max: 24 },
  profilePublic: { type: 'boolean' },
  marginTranscript: { type: 'boolean' },
  showWordCount: { type: 'boolean' },
  showOutline: { type: 'boolean' },
  defaultFolder: { type: 'relative', max: 480 },
  dailyNotesFolder: { type: 'relative', max: 480 },
  dateFormat: { type: 'string', max: 80 },
  paperStyle: { type: 'enum', values: ['blank', 'dots', 'squares', 'grid', 'lines', 'millimeter'] },
  paperSquareMm: { type: 'number', min: 0, max: 20 },
  penColor: { type: 'color' },
  penWidth: { type: 'number', min: 0.5, max: 40 },
  pressureEnabled: { type: 'boolean' },
  penOnly: { type: 'boolean' },
  tabletButtons: { type: 'tablet-buttons' },
  smoothing: { type: 'number', min: 0, max: 1 },
  scribbleEraseSensitivity: { type: 'number', min: 0, max: 100 },
  shapeSnapSensitivity: { type: 'number', min: 0, max: 100 },
  recognitionMode: { type: 'enum', values: ['auto', 'math', 'text'] },
  lastRecognitionMode: { type: 'enum', values: ['math', 'text'] },
  recognitionLanguage: { type: 'enum', values: ['de', 'en', 'fr'] },
  autoOpenConversion: { type: 'boolean' },
  keepDrawingAfterInsert: { type: 'boolean' },
  autoCheckUpdates: { type: 'boolean' },
  autoDownloadUpdates: { type: 'boolean' },
  installUpdatesOnQuit: { type: 'boolean' },
  updateChannel: { type: 'enum', values: ['stable', 'beta', 'nightly'] },
  memoryBudgetMb: { type: 'enum', values: [0, 1536, 2048, 3072, 4096, 6144, 8192] },
  ocrThreadLimit: { type: 'enum', values: [0, 1, 2, 3, 4] },
  desktopOcrModel: { type: 'enum', values: ['compact', 'extended'] },
  enhancedMathRecognition: { type: 'boolean' },
  enhancedMathLicenseAccepted: { type: 'boolean' },
  qwenVisionRecognition: { type: 'boolean' },
  qwenVisionLicenseAccepted: { type: 'boolean' },
  experimentalHandwritingToText: { type: 'boolean' },
  experimentalHandwritingToTextSeenVersion: { type: 'string', max: 40 },
  experimentalHomeworkApi: { type: 'boolean' },
  experimentalRemoteSupport: { type: 'boolean' },
  experimentalNoteBackup: { type: 'boolean' },
  experimentalSendData: { type: 'boolean' },
  lastOpenNotePath: { type: 'string', max: 1024 },
  dashboardLayout: { type: 'string', max: 100000 },
  homeworkApiChannelId: { type: 'string', max: 32 },
  homeworkApiSecret: { type: 'string', max: 256 },
  ocrModelKeepAliveSeconds: { type: 'enum', values: [0, 30, 120, 300, 600] },
  backgroundTaskLimit: { type: 'enum', values: [0, 1, 2, 4, 8, 16, 24] },
  lmStudioBaseUrl: { type: 'string', max: 2048 },
  lmStudioModel: { type: 'string', max: 500 },
  lmStudioApiToken: { type: 'string', max: 4096 },
  aiProvider: { type: 'enum', values: ['lmstudio', 'ollama', 'openai', 'gemini', 'anthropic', 'grok', 'opencode'] },
  ollamaBaseUrl: { type: 'string', max: 2048 },
  ollamaModel: { type: 'string', max: 500 },
  ollamaApiToken: { type: 'string', max: 4096 },
  openAiModel: { type: 'string', max: 500 },
  openAiApiKey: { type: 'string', max: 4096 },
  geminiModel: { type: 'string', max: 500 },
  geminiApiKey: { type: 'string', max: 4096 },
  anthropicModel: { type: 'string', max: 500 },
  anthropicApiKey: { type: 'string', max: 4096 },
  grokModel: { type: 'string', max: 500 },
  grokApiKey: { type: 'string', max: 4096 },
  grokUsage: { type: 'enum', values: ['api', 'build'] },
  grokBuildAccessToken: { type: 'string', max: 8192 },
  grokBuildRefreshToken: { type: 'string', max: 8192 },
  grokBuildExpiresAt: { type: 'number', min: 0, max: 4000000000000 },
  openCodeBaseUrl: { type: 'string', max: 2048 },
  openCodeModel: { type: 'string', max: 500 },
  openCodeUsername: { type: 'string', max: 200 },
  openCodePassword: { type: 'string', max: 4096 },
  customCss: { type: 'string', max: 100000 },
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeCustomCss(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const normalized = value.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\\[0-9a-f]{1,6}\s?/giu, '').replace(/\\/gu, '')
  if (DANGEROUS_CUSTOM_CSS.test(normalized)) return ''
  return value.length > 100000 ? value.slice(0, 100000) : value
}

function cleanRelativeSetting(value, max) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return null
  const normalized = value.trim().replaceAll('\\', '/')
  if (!normalized) return ''
  if (normalized.startsWith('/') || path.posix.isAbsolute(normalized)) return null
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

function sanitizeSettings(candidate, base = {}, defaults = {}) {
  const safeDefaults = isPlainObject(defaults) ? defaults : {}
  const result = { ...safeDefaults, ...(isPlainObject(base) ? base : {}) }
  if (!isPlainObject(candidate)) return result

  for (const [key, rule] of Object.entries(SETTINGS_SCHEMA)) {
    const value = candidate[key]
    if (value === undefined) continue

    if (rule.type === 'boolean' && typeof value === 'boolean') result[key] = value
    if (rule.type === 'enum' && rule.values.includes(value)) result[key] = value
    if (
      rule.type === 'number' &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= rule.min &&
      value <= rule.max
    ) {
      result[key] = value
    }
    if (rule.type === 'string' && typeof value === 'string' && value.length <= rule.max && !value.includes('\0')) {
      result[key] = value
    }
    if (rule.type === 'color' && typeof value === 'string' && /^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) {
      result[key] = value
    }
    if (rule.type === 'relative') {
      const cleaned = cleanRelativeSetting(value, rule.max)
      if (cleaned !== null) result[key] = cleaned
    }
    if (rule.type === 'tablet-buttons') {
      result[key] = sanitizeTabletButtonMap(value)
    }
  }
  if (typeof result.customCss === 'string') result.customCss = sanitizeCustomCss(result.customCss)

  return result
}

module.exports = {
  SETTINGS_SCHEMA,
  sanitizeSettings,
}
