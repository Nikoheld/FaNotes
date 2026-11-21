/**
 * A new note starts with `# <file name>` ("# Untitled note" / "# Unbenannte Notiz", numbered when the
 * name was taken). Renaming the note in the tree keeps that heading in step, but only while the first
 * line still is the untouched generated heading: a title the user wrote themselves is never rewritten.
 */
export function retitleGeneratedHeading(content: string, oldStem: string, newStem: string): string | null {
  const title = newStem.trim()
  if (!title || oldStem === newStem) return null
  const lineEnd = content.indexOf('\n')
  const first = lineEnd === -1 ? content : content.slice(0, lineEnd)
  if (first.replace(/\r$/u, '').trim() !== `# ${oldStem}`.trim()) return null
  return `# ${title}${first.endsWith('\r') ? '\r' : ''}${lineEnd === -1 ? '' : content.slice(lineEnd)}`
}
