/** Browser-only helpers: shrink pictures for study blocks and turn SVG diagrams into PNG files. */

import { IMAGE_DATA_LIMIT } from './blocks'

const loadImage = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = () => reject(new Error('Bild konnte nicht gelesen werden.'))
  image.src = url
})

/** A picture file as a small JPEG/PNG data URL that fits in a note. */
export const fileToSmallDataUrl = async (file: Blob, maxEdge = 420): Promise<string> => {
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url)
    let edge = maxEdge
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight, 1))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Bild konnte nicht verkleinert werden.')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const data = canvas.toDataURL('image/jpeg', 0.8)
      if (data.length <= IMAGE_DATA_LIMIT) return data
      edge = Math.round(edge * 0.75)
    }
    throw new Error('Das Bild ist zu gross für die Notiz.')
  } finally {
    URL.revokeObjectURL(url)
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

export const studyModalOpen = () => typeof document !== 'undefined' && Boolean(document.querySelector('[data-study-modal]'))
