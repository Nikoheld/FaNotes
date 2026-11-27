'use strict'

// Conversion engines for Office -> PDF, best first:
//   1. Microsoft Word / PowerPoint through COM (Windows, hidden PowerShell)
//   2. LibreOffice headless (soffice)
//   3. the built-in renderer (always available; done by the caller with Chromium)
// Everything here that builds commands is pure so it can be unit tested without
// Office. Paths never appear inside script text: they travel in environment
// variables, which sidesteps quoting for spaces, quotes and umlauts.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const OFFICE_KINDS = Object.freeze({
  '.docx': { kind: 'word', label: 'Word', nameSuffix: 'Word' },
  '.pptx': { kind: 'powerpoint', label: 'PowerPoint', nameSuffix: 'PowerPoint' },
})
const ENGINE_TIMEOUT_MS = 120_000
const SRC_VAR = 'FANOTES_OFFICE_SRC'
const DST_VAR = 'FANOTES_OFFICE_DST'
/** Exit code the scripts use for "this Office application is not installed". */
const NOT_INSTALLED = 3

function officeKindOf(fileName) {
  return OFFICE_KINDS[path.extname(String(fileName)).toLocaleLowerCase('en-US')] ?? null
}

/** `~$Name.docx` owner files, `.~lock.*` and hidden files are not documents. */
function isOfficeTempName(fileName) {
  const name = path.basename(String(fileName))
  return name.startsWith('~$') || name.startsWith('.') || name.startsWith('~WRL') || /^\.~lock\./u.test(name)
}

function wordScript() {
  return `$ErrorActionPreference = 'Stop'
$src = $env:${SRC_VAR}
$dst = $env:${DST_VAR}
if (-not (Test-Path 'Registry::HKEY_CLASSES_ROOT\\Word.Application')) { exit ${NOT_INSTALLED} }
$app = $null
$doc = $null
try {
  $app = New-Object -ComObject Word.Application
  $app.Visible = $false
  $app.DisplayAlerts = 0
  # msoAutomationSecurityForceDisable: macros never run.
  $app.AutomationSecurity = 3
  # FileName, ConfirmConversions=false, ReadOnly=true, AddToRecentFiles=false
  $doc = $app.Documents.Open($src, $false, $true, $false)
  # wdExportFormatPDF = 17
  $doc.ExportAsFixedFormat($dst, 17)
} finally {
  if ($doc) { try { $doc.Close(0) } catch {} }
  if ($app) {
    try { if ($app.Documents.Count -eq 0) { $app.Quit(0) } } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
  }
}
`
}

function powerPointScript() {
  return `$ErrorActionPreference = 'Stop'
$src = $env:${SRC_VAR}
$dst = $env:${DST_VAR}
if (-not (Test-Path 'Registry::HKEY_CLASSES_ROOT\\PowerPoint.Application')) { exit ${NOT_INSTALLED} }
$app = $null
$presentation = $null
try {
  $app = New-Object -ComObject PowerPoint.Application
  # msoAutomationSecurityForceDisable: macros never run.
  $app.AutomationSecurity = 3
  # FileName, ReadOnly=msoTrue, Untitled=msoFalse, WithWindow=msoFalse
  $presentation = $app.Presentations.Open($src, -1, 0, 0)
  # ppSaveAsPDF = 32
  $presentation.SaveAs($dst, 32)
} finally {
  if ($presentation) { try { $presentation.Close() } catch {} }
  if ($app) {
    try { if ($app.Presentations.Count -eq 0) { $app.Quit() } } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
  }
}
`
}

/** PowerShell invocation for a COM engine. The script travels as -EncodedCommand (UTF-16LE base64). */
function buildComCommand(kind, sourcePath, outputPath, { powershell = 'powershell.exe' } = {}) {
  const script = kind === 'word' ? wordScript() : kind === 'powerpoint' ? powerPointScript() : null
  if (!script) throw new Error(`Unknown Office kind: ${kind}`)
  return {
    command: powershell,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    env: { [SRC_VAR]: sourcePath, [DST_VAR]: outputPath },
    script,
  }
}

function buildSofficeCommand(soffice, sourcePath, outDir, profileDir) {
  return {
    command: soffice,
    args: [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--headless', '--invisible', '--norestore', '--nolockcheck', '--nodefault', '--nologo', '--nofirststartwizard',
      '--convert-to', 'pdf', '--outdir', outDir, sourcePath,
    ],
  }
}

function sofficeCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean)
    return roots.map((root) => path.win32.join(root, 'LibreOffice', 'program', 'soffice.exe'))
  }
  return ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/usr/lib64/libreoffice/program/soffice', '/opt/libreoffice/program/soffice', '/snap/bin/libreoffice', '/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice']
}

/** First existing LibreOffice binary: explicit override, PATH, then the usual install folders. */
function findSoffice({ platform = process.platform, env = process.env, exists = (file) => { try { return fs.statSync(file).isFile() } catch { return false } } } = {}) {
  if (env.FANOTES_SOFFICE && exists(env.FANOTES_SOFFICE)) return env.FANOTES_SOFFICE
  const names = platform === 'win32' ? ['soffice.exe'] : ['soffice', 'libreoffice']
  const separator = platform === 'win32' ? ';' : ':'
  for (const directory of String(env.PATH ?? env.Path ?? '').split(separator).filter(Boolean)) {
    for (const name of names) {
      const candidate = (platform === 'win32' ? path.win32 : path.posix).join(directory, name)
      if (exists(candidate)) return candidate
    }
  }
  return sofficeCandidates({ platform, env }).find(exists) ?? null
}

/**
 * Ordered engine list for one document kind. `FANOTES_OFFICE_ENGINE` (builtin,
 * libreoffice, com) narrows it, which is how tests pin an engine.
 */
function planEngines({ kind, platform = process.platform, soffice = null, env = process.env, disabled = new Set() } = {}) {
  const forced = String(env.FANOTES_OFFICE_ENGINE ?? '').toLowerCase()
  const plan = []
  if (platform === 'win32' && (kind === 'word' || kind === 'powerpoint') && (!forced || forced === 'com') && !disabled.has('com')) plan.push('com')
  if (soffice && (!forced || forced === 'libreoffice') && !disabled.has('libreoffice')) plan.push('libreoffice')
  if (!forced || forced === 'builtin' || plan.length === 0) plan.push('builtin')
  return plan
}

function runProcess({ command, args, env = {}, timeoutMs = ENGINE_TIMEOUT_MS, cwd, platform = process.platform }) {
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    let child
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ output: output.slice(-2000), ...result })
    }
    try {
      child = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, output: '', error })
      return
    }
    const timer = setTimeout(() => {
      try {
        if (platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
        else child.kill('SIGKILL')
      } catch { /* already gone */ }
      finish({ code: -1, timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', (error) => finish({ code: -1, error }))
    child.on('close', (code) => finish({ code }))
  })
}

module.exports = {
  OFFICE_KINDS, ENGINE_TIMEOUT_MS, SRC_VAR, DST_VAR, NOT_INSTALLED,
  officeKindOf, isOfficeTempName, buildComCommand, buildSofficeCommand, sofficeCandidates, findSoffice, planEngines, runProcess,
}
