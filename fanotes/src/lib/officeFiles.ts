/** Word and PowerPoint files that the desktop app lists in the tree and converts to a PDF note on open. */
export type OfficeKind = 'word' | 'powerpoint'

export const officeKindOfPath = (path: string): OfficeKind | null => {
  const lower = path.toLocaleLowerCase('en-US')
  if (lower.endsWith('.docx')) return 'word'
  if (lower.endsWith('.pptx')) return 'powerpoint'
  return null
}

export const officeEngineLabel = (engine: string) => (
  engine === 'word' ? 'Microsoft Word' : engine === 'powerpoint' ? 'Microsoft PowerPoint' : engine === 'libreoffice' ? 'LibreOffice' : 'der eingebauten Umwandlung'
)
