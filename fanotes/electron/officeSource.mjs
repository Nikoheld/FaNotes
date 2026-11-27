// The Office file (.docx/.pptx) a PDF note was converted from, stored in the
// note's `.famd`. Older versions drop the key on save; the PDF then simply
// loses its link to the original and opens as an ordinary PDF note.
const ENGINES = new Set(['word', 'powerpoint', 'libreoffice', 'builtin'])

export function parseOfficeSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = typeof value.path === 'string' ? value.path.trim() : ''
  if (!source || source.length > 1024 || /[\0]/u.test(source) || !/\.(docx|pptx)$/iu.test(source)) return null
  const size = Number(value.size)
  const mtimeMs = Number(value.mtimeMs)
  if (!Number.isFinite(size) || size < 0 || !Number.isFinite(mtimeMs) || mtimeMs < 0) return null
  const engine = typeof value.engine === 'string' && ENGINES.has(value.engine) ? value.engine : 'builtin'
  const convertedAt = typeof value.convertedAt === 'string' && Number.isFinite(Date.parse(value.convertedAt)) ? new Date(value.convertedAt).toISOString() : undefined
  return { path: source, size: Math.round(size), mtimeMs: Math.round(mtimeMs), engine, ...(convertedAt ? { convertedAt } : {}) }
}
