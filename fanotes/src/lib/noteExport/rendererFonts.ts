import type { FontFileLoader } from './pdfFonts'

/** Fonts from the app's own files: `writing/fonts/` and the pdf.js standard fonts. Works in the renderer. */
export const rendererFontLoader: FontFileLoader = async (key) => {
  const slash = key.indexOf('/')
  const group = key.slice(0, slash)
  const file = key.slice(slash + 1)
  const path = group === 'writing' ? `writing/fonts/${file}` : `pdfjs/standard_fonts/${file}`
  const response = await fetch(new URL(path, document.baseURI).toString())
  if (!response.ok) throw new Error(`Font ${key}: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}
