// Pure helpers shared by the PDF and DOCX paths: cleaning the note text, finding its pictures,
// reading picture sizes and encoding data URLs.
import { stripFamdPayload } from '../famd'
import { imageCandidates, isLocalImageSource } from '../noteImagePaths'
import type { NoteImageData, NoteImageResolver } from './types'

/** The note as readable Markdown: no .famd payload, no FaNotes marker comments, wiki links as plain text. */
export function prepareNoteMarkdown(markdown: string): string {
  const stripped = stripFamdPayload(String(markdown ?? ''))
  let fence: string | null = null
  return stripped.split('\n').map((line) => {
    const marker = /^\s*(```+|~~~+)/u.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker[0]
      else if (marker[0] === fence) fence = null
      return line
    }
    if (fence) return line
    if (/^\s*<!--\s*fanotes-[a-z0-9:_-]+\b.*-->\s*$/iu.test(line)) return ''
    return line.replace(/\[\[([^[\]]+?)\]\]/gu, (_all, raw: string) => {
      const [target, alias] = raw.split('|', 2)
      return (alias?.trim() || target.split('#')[0].trim() || target.trim())
    })
  }).join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

const mimeOf = (bytes: Uint8Array): string | null => {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  return null
}

/** Pixel size of a PNG, JPEG, GIF or WebP file read from its header; null if it cannot be read. */
export function readImageInfo(bytes: Uint8Array): { mime: string; width: number; height: number } | null {
  const mime = mimeOf(bytes)
  if (!mime) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/png') return bytes.length >= 24 ? { mime, width: view.getUint32(16), height: view.getUint32(20) } : null
  if (mime === 'image/gif') return { mime, width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (mime === 'image/webp') {
    const kind = String.fromCharCode(...bytes.subarray(12, 16))
    if (kind === 'VP8X') return { mime, width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) }
    if (kind === 'VP8L') {
      const bits = view.getUint32(21, true)
      return { mime, width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (kind === 'VP8 ') return { mime, width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    return null
  }
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue }
    const length = view.getUint16(offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mime, height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
    }
    offset += 2 + length
  }
  return null
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export const imageDataUrl = (image: NoteImageData) => `data:${image.mime};base64,${bytesToBase64(image.bytes)}`

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/iu

export function decodeDataImage(source: string): NoteImageData | null {
  const match = DATA_IMAGE.exec(source)
  if (!match) return null
  try {
    const binary = atob(match[1].replace(/\s+/gu, ''))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const info = readImageInfo(bytes)
    return info ? { bytes, ...info } : null
  } catch {
    return null
  }
}

/** The app's resolver: a vault image next to the note (or at the vault root), read as bytes. */
export function createVaultImageResolver(notePath: string, readBytes: (relativePath: string) => Promise<Uint8Array>): NoteImageResolver {
  return async (source) => {
    const inline = decodeDataImage(source)
    if (inline) return inline
    let decoded = source
    try { decoded = decodeURIComponent(source) } catch { /* keep the raw path */ }
    if (!isLocalImageSource(decoded)) return null
    for (const candidate of imageCandidates(decoded, notePath)) {
      try {
        const raw = await readBytes(candidate)
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>)
        const info = readImageInfo(bytes)
        if (info) return { bytes, ...info }
      } catch {
        // The next candidate.
      }
    }
    return null
  }
}

/** Resolves every picture of the note once. */
export async function resolveNoteImages(sources: Iterable<string>, resolve: NoteImageResolver | undefined, signal?: AbortSignal): Promise<Map<string, NoteImageData>> {
  const result = new Map<string, NoteImageData>()
  if (!resolve) return result
  for (const source of sources) {
    if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError')
    const image = await resolve(source).catch(() => null)
    if (image) result.set(source, image)
  }
  return result
}
