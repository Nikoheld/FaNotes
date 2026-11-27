// Uploading files into a vault folder: safe names, numbering on a clash, the size cap, and one summary.
// The rules mirror the Android app (android/core vault/UploadFiles.kt) so both name a file the same way.
import type { VaultBackend } from './backend'
import { VaultError } from './client'

/** One uploaded file is at most this large (96 MB). */
export const UPLOAD_MAX_BYTES = 96 * 1024 * 1024
const MAX_NAME_BYTES = 255
const NOT_LISTED = new Set(['thumbs.db', 'desktop.ini', '.ds_store'])
const NOTE_FAMILY = ['md', 'markdown', 'pdf', 'famd']

const utf8 = new TextEncoder()
const byteLength = (text: string) => utf8.encode(text).length
const cutBytes = (text: string, max: number) => {
  let out = ''
  for (const char of text) {
    if (byteLength(out + char) > max) break
    out += char
  }
  return out.trim()
}

/** A real user file the library may list: no editor lock, temporary or operating-system index file (dot-files are hidden elsewhere). */
export const isListedUserFile = (path: string): boolean => {
  const leaf = path.slice(path.lastIndexOf('/') + 1)
  if (!leaf || leaf.startsWith('.') || leaf.startsWith('~$')) return false
  return !NOT_LISTED.has(leaf.toLowerCase()) && !leaf.toLowerCase().endsWith('.tmp')
}

/** A picked file name as a safe stem and extension (with its dot, or ''). Fits the 255-byte limit with room for " 12". */
export const uploadNameParts = (fileName: string): { stem: string; ext: string } => {
  const base = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  const rawExt = dot > 0 ? base.slice(dot + 1).replace(/[^A-Za-z0-9]/gu, '').slice(0, 12) : ''
  const rawStem = dot > 0 ? base.slice(0, dot) : base
  const ext = rawExt ? `.${rawExt}` : ''
  const clean = rawStem.replace(/[\\/:*?"<>|\u0000-\u001F]/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/^\.+|\.+$/gu, '').trim()
  const stem = cutBytes(Array.from(clean).slice(0, 120).join(''), MAX_NAME_BYTES - ext.length - 8) || 'File'
  return { stem, ext }
}

/**
 * The vault path an upload gets: its own name made safe, "name 2.ext" when taken. A name is taken when any
 * path of the vault equals it ignoring case, or (for note extensions) when it would join another note's family.
 */
export const uniqueUploadPath = (folder: string, fileName: string, existing: Iterable<string>): string => {
  const { stem, ext } = uploadNameParts(fileName)
  const taken = new Set<string>()
  for (const path of existing) taken.add(path.toLowerCase())
  const prefix = folder ? `${folder}/` : ''
  const family = NOTE_FAMILY.includes(ext.slice(1).toLowerCase())
  const clash = (name: string) => {
    const path = `${prefix}${name}${ext}`
    if (taken.has(path.toLowerCase())) return true
    return family && NOTE_FAMILY.some((other) => taken.has(`${prefix}${name}.${other}`.toLowerCase()))
  }
  let name = stem
  for (let index = 2; clash(name); index += 1) name = `${stem} ${index}`
  return `${prefix}${name}${ext}`
}

export interface UploadSummary { uploaded: number; tooLarge: string[]; failed: string[] }

/**
 * Stores each file in `folder`; one failing file never stops the others. `existing` is a fresh `backend.list()`
 * path list; names given out here count as taken for the files that follow.
 */
export const uploadFiles = async (
  backend: VaultBackend, files: File[], folder: string, existing: string[], onProgress: (done: number, total: number) => void = () => {},
): Promise<UploadSummary> => {
  const summary: UploadSummary = { uploaded: 0, tooLarge: [], failed: [] }
  const used = [...existing]
  for (const [index, file] of files.entries()) {
    onProgress(index, files.length)
    if (file.size > UPLOAD_MAX_BYTES) { summary.tooLarge.push(file.name); continue }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      for (let attempt = 0; ; attempt += 1) {
        const path = uniqueUploadPath(folder, file.name, used)
        try {
          await backend.create(path, bytes)
          used.push(path)
          break
        } catch (error) {
          // Another device took the name meanwhile: number again.
          const clash = (error instanceof VaultError && error.code === 'conflict') || (error instanceof Error && error.message === 'exists')
          if (!clash || attempt >= 5) throw error
          used.push(path)
        }
      }
      summary.uploaded += 1
    } catch { summary.failed.push(file.name) }
  }
  onProgress(files.length, files.length)
  return summary
}

export interface UploadTexts {
  uploadDone: (count: number) => string
  uploadLargeOne: (name: string) => string
  uploadPartDone: (count: number) => string
  uploadPartLarge: (count: number, names: string) => string
  uploadPartFailed: (count: number) => string
}

/** One line for the whole batch: "3 files uploaded", or "2 uploaded, 1 too large (...)". */
export const uploadMessage = (summary: UploadSummary, t: UploadTexts): string => {
  const { uploaded, tooLarge, failed } = summary
  if (!tooLarge.length && !failed.length) return t.uploadDone(uploaded)
  if (!uploaded && !failed.length && tooLarge.length === 1) return t.uploadLargeOne(tooLarge[0])
  const parts: string[] = []
  if (uploaded) parts.push(t.uploadPartDone(uploaded))
  if (tooLarge.length) parts.push(t.uploadPartLarge(tooLarge.length, tooLarge.slice(0, 3).join(', ')))
  if (failed.length) parts.push(t.uploadPartFailed(failed.length))
  return parts.join(', ')
}
