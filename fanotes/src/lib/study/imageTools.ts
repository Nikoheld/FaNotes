/** Browser-only helpers: shrink pictures for study blocks and turn SVG diagrams into PNG files. */

import { IMAGE_DATA_LIMIT, isVaultImageRef } from './blocks'

const loadImage = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = () => reject(new Error('Bild konnte nicht gelesen werden.'))
  image.src = url
})

const drawScaled = async (file: Blob, maxEdge: number): Promise<HTMLCanvasElement> => {
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url)
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight, 1))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Bild konnte nicht verkleinert werden.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** A picture file as a small data URL (fallback when the vault cannot store files). */
export const fileToSmallDataUrl = async (file: Blob, maxEdge = 420): Promise<string> => {
  let edge = maxEdge
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const data = (await drawScaled(file, edge)).toDataURL('image/jpeg', 0.8)
    if (data.length <= IMAGE_DATA_LIMIT) return data
    edge = Math.round(edge * 0.75)
  }
  throw new Error('Das Bild ist zu gross für die Notiz.')
}

/**
 * Stores a picture as a file in the vault (the same `.fanotes/worksheets/` folder the sheet import uses)
 * and returns its vault-relative path. Without file support it falls back to a small data URL.
 */
export const storeStudyImage = async (file: Blob, maxEdge = 900): Promise<string> => {
  const api = typeof window !== 'undefined' ? window.fanotes : undefined
  if (!api?.importWorksheetFromData) return fileToSmallDataUrl(file)
  const canvas = await drawScaled(file, maxEdge)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('Bild konnte nicht gespeichert werden.'))), 'image/jpeg', 0.84))
  const document = await api.importWorksheetFromData({ name: 'Bild.jpg', mimeType: 'image/jpeg', bytes: new Uint8Array(await blob.arrayBuffer()) })
  if (!isVaultImageRef(document.sourceRelativePath)) throw new Error('Bild konnte nicht gespeichert werden.')
  return document.sourceRelativePath
}

/** A displayable URL for a stored picture reference (vault path or data URL). */
export const resolveStudyImage = async (ref: string): Promise<string> => (
  isVaultImageRef(ref) ? window.fanotes.readAssetDataUrl(ref) : ref
)

/** Fills `<img data-vault-src>` elements that rendered HTML left empty. */
export const hydrateVaultImages = (root: ParentNode) => {
  for (const image of root.querySelectorAll<HTMLImageElement>('img[data-vault-src]')) {
    const ref = image.dataset.vaultSrc ?? ''
    if (!isVaultImageRef(ref) || image.getAttribute('src')) continue
    void resolveStudyImage(ref).then((url) => { if (image.isConnected) image.src = url }).catch(() => { image.alt = 'Bild nicht gefunden' })
  }
}

export const svgToPngBlob = async (svg: string, width: number, height: number, scale = 2): Promise<Blob> => {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Bild konnte nicht erzeugt werden.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Bild konnte nicht erzeugt werden.'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

export const downloadBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** Events between the study editors and the app shell. */
export const STUDY_EVENT = {
  insert: 'fanotes:study-insert',
  edit: 'fanotes:study-edit',
  placeImage: 'fanotes:study-place-image',
  openCards: 'fanotes:study-open-cards',
  openPanel: 'fanotes:study-open-panel',
} as const

export const studyModalOpen = () => typeof document !== 'undefined' && Boolean(document.querySelector('[data-lw-modal]'))
