// Sync host for the web build: presents the IndexedDB vault (notes, assets,
// drawing library, worksheets, folder colours, subject books) as the same flat
// file tree the desktop app keeps on disk, so a browser and a desktop signed
// into one account converge on identical paths:
//
//   files      →  <path>                       (markdown / .famd, UTF-8)
//   assets     →  <path>                       (PDF, images; binary)
//   drawings   →  .fanotes/assets/<id>.json    (the drawing document)
//   worksheets →  .fanotes/worksheets/<id>.json
//   folders    →  .fanotes/folder-colors.json  { version: 1, colors: { path: colour } }
//   meta       →  .fanotes/subject-books.json  { version: 1, books: [...] }
import type { DrawingLibraryDocument, SyncHostApi, SyncScanEntry, WorksheetDocument } from '../../types'
import { parseSubjectBooks, type SubjectBookRecord } from '../subjectBook'

export type BrowserSyncVault = {
  files: Map<string, { path: string; content: string; modifiedAt: string }>
  folders: Map<string, { path: string; color?: string }>
  assets: Map<string, Blob>
  drawings: Map<string, DrawingLibraryDocument>
  worksheets: Map<string, WorksheetDocument>
  getSubjectBooks: () => SubjectBookRecord[]
  setSubjectBooks: (books: SubjectBookRecord[]) => Promise<void>
  putFile: (record: { path: string; content: string; modifiedAt: string }) => Promise<void>
  deleteFile: (path: string) => Promise<void>
  putAsset: (path: string, blob: Blob) => Promise<void>
  deleteAsset: (path: string) => Promise<void>
  putDrawing: (document: DrawingLibraryDocument) => Promise<void>
  deleteDrawing: (id: string) => Promise<void>
  putWorksheet: (document: WorksheetDocument) => Promise<void>
  deleteWorksheet: (id: string) => Promise<void>
  putFolders: (folders: Array<{ path: string; color?: string }>) => Promise<void>
  readMeta: (key: string) => Promise<unknown>
  writeMeta: (key: string, value: unknown) => Promise<void>
  invalidateTree: () => void
}

const FOLDER_COLORS_PATH = '.fanotes/folder-colors.json'
const SUBJECT_BOOKS_PATH = '.fanotes/subject-books.json'
const DRAWING_PREFIX = '.fanotes/assets/'
const WORKSHEET_PREFIX = '.fanotes/worksheets/'
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,80}$/iu

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const mimeForPath = (path: string) => {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return extension === 'pdf' ? 'application/pdf'
    : extension === 'png' ? 'image/png'
      : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
        : extension === 'webp' ? 'image/webp'
          : extension === 'gif' ? 'image/gif'
            : extension === 'svg' ? 'image/svg+xml'
              : extension === 'html' ? 'text/html'
                : 'application/octet-stream'
}

const isTextNotePath = (path: string) => /\.(?:md|markdown|famd)$/iu.test(path)

const stableJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

export const createBrowserSyncHost = (vault: BrowserSyncVault): SyncHostApi => {
  // Assets carry no modification time in IndexedDB; the first scan stamps them so the engine does not re-hash every PDF each cycle.
  let assetTimes: Record<string, number> | null = null
  const loadAssetTimes = async () => {
    if (assetTimes) return assetTimes
    const stored = await vault.readMeta('syncAssetTimes')
    assetTimes = stored && typeof stored === 'object' ? { ...(stored as Record<string, number>) } : {}
    return assetTimes
  }
  const stampAsset = async (path: string, mtimeMs: number) => {
    const times = await loadAssetTimes()
    times[path] = mtimeMs
    await vault.writeMeta('syncAssetTimes', times)
  }

  const drawingPath = (id: string) => `${DRAWING_PREFIX}${id}.json`
  const worksheetPath = (id: string) => `${WORKSHEET_PREFIX}${id}.json`
  const drawingIdFor = (path: string) => {
    const match = /^\.fanotes\/assets\/([^/]+)\.json$/u.exec(path)
    return match && ID_PATTERN.test(match[1]) ? match[1] : null
  }
  const worksheetIdFor = (path: string) => {
    const match = /^\.fanotes\/worksheets\/([^/]+)\.json$/u.exec(path)
    return match && ID_PATTERN.test(match[1]) ? match[1] : null
  }

  const folderColorsJson = () => {
    const pairs: Array<[string, string]> = [...vault.folders.values()].flatMap((folder) => folder.color ? [[folder.path, folder.color] as [string, string]] : [])
    const colors = Object.fromEntries(pairs.sort(([left], [right]) => left.localeCompare(right, 'de')))
    return stableJson({ version: 1, colors })
  }
  const subjectBooksJson = () => stableJson({ version: 1, books: vault.getSubjectBooks() })

  const scan = async (): Promise<SyncScanEntry[]> => {
    const out: SyncScanEntry[] = []
    for (const record of vault.files.values()) {
      const size = encoder.encode(record.content).byteLength
      out.push({ path: record.path, size, mtimeMs: Math.round(Date.parse(record.modifiedAt) || 0) })
    }
    const times = await loadAssetTimes()
    let stamped = false
    for (const [path, blob] of vault.assets) {
      if (!times[path]) {
        times[path] = Date.now()
        stamped = true
      }
      out.push({ path, size: blob.size, mtimeMs: times[path] })
    }
    if (stamped) await vault.writeMeta('syncAssetTimes', times)
    for (const document of vault.drawings.values()) {
      const content = typeof document.drawingJson === 'string' ? document.drawingJson : JSON.stringify(document)
      out.push({ path: drawingPath(document.id), size: encoder.encode(content).byteLength, mtimeMs: Math.round(Date.parse(document.updatedAt) || 0) })
    }
    for (const document of vault.worksheets.values()) {
      out.push({ path: worksheetPath(document.id), size: encoder.encode(stableJson(document)).byteLength, mtimeMs: Math.round(Date.parse(document.updatedAt) || 0) })
    }
    if ([...vault.folders.values()].some((folder) => folder.color)) out.push({ path: FOLDER_COLORS_PATH, size: encoder.encode(folderColorsJson()).byteLength, mtimeMs: 0 })
    if (vault.getSubjectBooks().length) out.push({ path: SUBJECT_BOOKS_PATH, size: encoder.encode(subjectBooksJson()).byteLength, mtimeMs: 0 })
    return out
  }

  const read = async (path: string): Promise<Uint8Array> => {
    const file = vault.files.get(path)
    if (file) return encoder.encode(file.content)
    const asset = vault.assets.get(path)
    if (asset) return new Uint8Array(await asset.arrayBuffer())
    const drawingId = drawingIdFor(path)
    if (drawingId && vault.drawings.has(drawingId)) {
      const document = vault.drawings.get(drawingId)!
      return encoder.encode(typeof document.drawingJson === 'string' ? document.drawingJson : JSON.stringify(document))
    }
    const worksheetId = worksheetIdFor(path)
    if (worksheetId && vault.worksheets.has(worksheetId)) return encoder.encode(stableJson(vault.worksheets.get(worksheetId)))
    if (path === FOLDER_COLORS_PATH) return encoder.encode(folderColorsJson())
    if (path === SUBJECT_BOOKS_PATH) return encoder.encode(subjectBooksJson())
    throw new Error(`„${path}“ gibt es im Browser-Vault nicht.`)
  }

  const write = async (path: string, bytes: Uint8Array, mtimeMs: number): Promise<SyncScanEntry> => {
    const when = new Date(mtimeMs > 0 ? mtimeMs : Date.now()).toISOString()
    if (path === FOLDER_COLORS_PATH) {
      const parsed = JSON.parse(decoder.decode(bytes)) as { colors?: Record<string, unknown> }
      const colors = parsed && typeof parsed.colors === 'object' && parsed.colors ? parsed.colors : {}
      const next = new Map(vault.folders)
      for (const folder of next.values()) if (!(folder.path in colors)) next.set(folder.path, { path: folder.path })
      for (const [folderPath, color] of Object.entries(colors)) {
        if (typeof color === 'string' && /^#[0-9a-f]{6}$/iu.test(color)) next.set(folderPath, { path: folderPath, color })
      }
      await vault.putFolders([...next.values()])
      vault.invalidateTree()
      return { path, size: bytes.byteLength, mtimeMs: 0 }
    }
    if (path === SUBJECT_BOOKS_PATH) {
      const parsed = JSON.parse(decoder.decode(bytes)) as { books?: unknown }
      await vault.setSubjectBooks(parseSubjectBooks(parsed?.books ?? parsed))
      return { path, size: bytes.byteLength, mtimeMs: 0 }
    }
    const drawingId = drawingIdFor(path)
    if (drawingId) {
      const drawingJson = decoder.decode(bytes)
      let title = drawingId
      try {
        const parsed = JSON.parse(drawingJson) as { title?: unknown }
        if (typeof parsed.title === 'string' && parsed.title.trim()) title = parsed.title.trim().slice(0, 120)
      } catch { /* the document is stored verbatim either way */ }
      const previous = vault.drawings.get(drawingId)
      const document: DrawingLibraryDocument = {
        id: drawingId,
        title: previous?.title ?? title,
        updatedAt: when,
        imageRelativePath: previous?.imageRelativePath ?? `${DRAWING_PREFIX}${drawingId}.png`,
        dataRelativePath: path,
        drawingJson,
      }
      await vault.putDrawing(document)
      return { path, size: bytes.byteLength, mtimeMs: Math.round(Date.parse(when)) }
    }
    const worksheetId = worksheetIdFor(path)
    if (worksheetId) {
      const parsed = JSON.parse(decoder.decode(bytes)) as WorksheetDocument
      if (!parsed || parsed.id !== worksheetId || parsed.schemaVersion !== 1) throw new Error('Das Arbeitsblatt-Dokument ist ungültig.')
      await vault.putWorksheet({ ...parsed, updatedAt: when })
      return { path, size: bytes.byteLength, mtimeMs: Math.round(Date.parse(when)) }
    }
    if (isTextNotePath(path)) {
      const record = { path, content: decoder.decode(bytes), modifiedAt: when }
      await vault.putFile(record)
      vault.invalidateTree()
      return { path, size: bytes.byteLength, mtimeMs: Math.round(Date.parse(when)) }
    }
    const blob = new Blob([bytes as BlobPart], { type: mimeForPath(path) })
    await vault.putAsset(path, blob)
    const stamp = mtimeMs > 0 ? Math.round(mtimeMs) : Date.now()
    await stampAsset(path, stamp)
    vault.invalidateTree()
    return { path, size: blob.size, mtimeMs: stamp }
  }

  const remove = async (path: string) => {
    if (vault.files.has(path)) {
      await vault.deleteFile(path)
      vault.invalidateTree()
      return
    }
    if (vault.assets.has(path)) {
      await vault.deleteAsset(path)
      const times = await loadAssetTimes()
      delete times[path]
      await vault.writeMeta('syncAssetTimes', times)
      vault.invalidateTree()
      return
    }
    const drawingId = drawingIdFor(path)
    if (drawingId && vault.drawings.has(drawingId)) {
      await vault.deleteDrawing(drawingId)
      return
    }
    const worksheetId = worksheetIdFor(path)
    if (worksheetId && vault.worksheets.has(worksheetId)) {
      await vault.deleteWorksheet(worksheetId)
      return
    }
    if (path === FOLDER_COLORS_PATH) {
      await vault.putFolders([...vault.folders.values()].map((folder) => ({ path: folder.path })))
      vault.invalidateTree()
      return
    }
    if (path === SUBJECT_BOOKS_PATH) await vault.setSubjectBooks([])
  }

  return {
    vaultId: async () => 'browser-vault',
    scan,
    read,
    write,
    remove,
    readState: async (vaultId) => {
      const value = await vault.readMeta(`syncState:${vaultId}`)
      return typeof value === 'string' ? value : null
    },
    writeState: (vaultId, json) => vault.writeMeta(`syncState:${vaultId}`, json),
    readSecrets: async () => {
      const value = await vault.readMeta('syncSecrets')
      return typeof value === 'string' ? value : null
    },
    writeSecrets: (json) => vault.writeMeta('syncSecrets', json),
  }
}
