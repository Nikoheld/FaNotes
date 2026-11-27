'use strict'

// Office (.docx/.pptx) -> PDF bytes. Untrusted input: the package is validated
// (size, entry count, zip bomb) before any engine sees it, and every engine
// works on a private copy in a temp folder (never on the vault file).
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { readZip } = require('./office-zip.cjs')
const { docxToHtml } = require('./office-docx-html.cjs')
const { pptxToHtml } = require('./office-pptx-html.cjs')
const engines = require('./office-engines.cjs')

const MAX_OFFICE_BYTES = 96 * 1024 * 1024
const MAX_PDF_BYTES = 96 * 1024 * 1024
const MAIN_PART = { word: 'word/document.xml', powerpoint: 'ppt/presentation.xml' }

/** Engines that turned out to be missing stay off for the rest of the session. */
const unavailable = new Set()

class OfficeConvertError extends Error {}

function looksLikePdf(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length > 64 && bytes.toString('latin1', 0, 5) === '%PDF-'
}

/** Throws OfficeConvertError for anything that is not a sane docx/pptx package; returns the opened zip. */
function validateOfficePackage(bytes, kind) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new OfficeConvertError('Die Datei ist leer.')
  if (bytes.length > MAX_OFFICE_BYTES) throw new OfficeConvertError('Die Datei ist zu groß (maximal 96 MB).')
  let zip
  try {
    zip = readZip(bytes)
  } catch (error) {
    throw new OfficeConvertError(error?.message || 'Die Datei ist kein gültiges Office-Dokument.')
  }
  if (!zip.has(MAIN_PART[kind])) {
    throw new OfficeConvertError(kind === 'word' ? 'Die Datei ist kein gültiges Word-Dokument (.docx).' : 'Die Datei ist keine gültige PowerPoint-Präsentation (.pptx).')
  }
  return zip
}

async function convertOfficeToPdf({ bytes, kind, title = 'Dokument', scratchDir, printHtmlToPdf, platform = process.platform, env = process.env, soffice, timeoutMs, onEngineFailure = () => {} }) {
  const zip = validateOfficePackage(bytes, kind)
  const extension = kind === 'word' ? '.docx' : '.pptx'
  const plan = engines.planEngines({
    kind,
    platform,
    env,
    soffice: soffice === undefined ? engines.findSoffice({ platform, env }) : soffice,
    disabled: unavailable,
  })
  const workDir = await fsp.mkdtemp(path.join(scratchDir, 'office-'))
  try {
    const input = path.join(workDir, `input${extension}`)
    await fsp.writeFile(input, bytes, { mode: 0o600 })
    for (const engine of plan) {
      try {
        if (engine === 'com') {
          const output = path.join(workDir, 'com-output.pdf')
          const command = engines.buildComCommand(kind, input, output)
          const result = await engines.runProcess({ ...command, timeoutMs: timeoutMs ?? engines.ENGINE_TIMEOUT_MS, platform })
          if (result.code === engines.NOT_INSTALLED) { unavailable.add('com'); continue }
          if (result.code !== 0) throw new Error(result.timedOut ? 'Zeitüberschreitung' : result.output || result.error?.message || `Exit ${result.code}`)
          const pdf = await fsp.readFile(output)
          if (!looksLikePdf(pdf) || pdf.length > MAX_PDF_BYTES) throw new Error('Office lieferte kein gültiges PDF.')
          return { pdf, engine: kind, fallback: false }
        }
        if (engine === 'libreoffice') {
          const sofficePath = soffice === undefined ? engines.findSoffice({ platform, env }) : soffice
          const outDir = path.join(workDir, 'lo-out')
          const profile = path.join(workDir, 'lo-profile')
          await fsp.mkdir(outDir, { recursive: true })
          await fsp.mkdir(profile, { recursive: true })
          const command = engines.buildSofficeCommand(sofficePath, input, outDir, profile)
          const result = await engines.runProcess({ ...command, cwd: workDir, timeoutMs: timeoutMs ?? engines.ENGINE_TIMEOUT_MS, platform })
          if (result.code !== 0) throw new Error(result.timedOut ? 'Zeitüberschreitung' : result.output || result.error?.message || `Exit ${result.code}`)
          const pdf = await fsp.readFile(path.join(outDir, 'input.pdf'))
          if (!looksLikePdf(pdf) || pdf.length > MAX_PDF_BYTES) throw new Error('LibreOffice lieferte kein gültiges PDF.')
          return { pdf, engine: 'libreoffice', fallback: false }
        }
        const rendered = kind === 'word' ? docxToHtml(zip, { title }) : pptxToHtml(zip, { title })
        const pdf = await printHtmlToPdf(rendered.html, { kind, ...(rendered.pageSize ? { pageSize: rendered.pageSize } : {}), ...(rendered.slideSize ? { slideSize: rendered.slideSize } : {}) })
        if (!looksLikePdf(pdf) || pdf.length > MAX_PDF_BYTES) throw new Error('Die eingebaute Umwandlung lieferte kein gültiges PDF.')
        return { pdf, engine: 'builtin', fallback: true, warnings: rendered.warnings ?? [] }
      } catch (error) {
        onEngineFailure(engine, error)
        if (engine === 'builtin') throw new OfficeConvertError('Das Dokument konnte nicht umgewandelt werden.')
      }
    }
    throw new OfficeConvertError('Es steht keine Umwandlung zur Verfügung.')
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

module.exports = { convertOfficeToPdf, validateOfficePackage, OfficeConvertError, MAX_OFFICE_BYTES, resetUnavailableEngines: () => unavailable.clear() }
