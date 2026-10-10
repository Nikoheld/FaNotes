'use strict'

/** Leave room for the rest of a bug report, whose body cap is 256 KB. */
const MAX_CAPTURE_BYTES = 180 * 1024
const MAX_CAPTURE_EDGE = 1280

const resizeImage = (image, width, height) => {
  if (typeof image.resize !== 'function') throw new Error('Das Fensterbild ist ungültig.')
  return image.resize({
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    quality: 'good',
  })
}

/**
 * Shrink a window capture until the JPEG fits the bug-report budget.
 * `image` is an Electron NativeImage, or a test double with getSize/resize/toJPEG.
 */
function encodeWindowCapture(image) {
  if (!image || typeof image.getSize !== 'function' || typeof image.toJPEG !== 'function') {
    throw new Error('Das Fensterbild ist ungültig.')
  }
  let current = image
  const initial = current.getSize()
  const width = Number(initial?.width)
  const height = Number(initial?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('Das Fensterbild ist leer.')
  }
  const longest = Math.max(width, height)
  if (longest > MAX_CAPTURE_EDGE) {
    const scale = MAX_CAPTURE_EDGE / longest
    current = resizeImage(current, width * scale, height * scale)
  }
  let quality = 55
  let jpeg = Buffer.from(current.toJPEG(quality))
  while (jpeg.length > MAX_CAPTURE_BYTES && quality > 25) {
    quality -= 10
    jpeg = Buffer.from(current.toJPEG(quality))
  }
  for (let guard = 0; jpeg.length > MAX_CAPTURE_BYTES && guard < 6; guard += 1) {
    const size = current.getSize()
    const nextScale = Math.sqrt(MAX_CAPTURE_BYTES / jpeg.length) * 0.85
    if (!(nextScale > 0) || !(nextScale < 1)) break
    current = resizeImage(current, Number(size.width) * nextScale, Number(size.height) * nextScale)
    jpeg = Buffer.from(current.toJPEG(Math.max(25, quality)))
  }
  if (!jpeg.length || jpeg.length > MAX_CAPTURE_BYTES) {
    throw new Error('Das Fensterbild ist zu groß für den Fehlerbericht.')
  }
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`
}

module.exports = { MAX_CAPTURE_BYTES, MAX_CAPTURE_EDGE, encodeWindowCapture }
