import { maskMarkdownCode } from './markdownCode'

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu

export type Backlink = {
  path: string
  title: string
  excerpt: string
}

const NOTE_EXT = /\.(md|markdown|pdf)$/iu

const titleFromPath = (path: string) => path.split('/').pop()?.replace(NOTE_EXT, '') ?? path

const slashPath = (value: string) => value.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')

/**
 * A wiki target names this note by title (`[[Algebra]]`, `[[Algebra.md]]`)
 * or by vault path (`[[Mathe/Algebra]]`). A path does not match a different
 * folder that happens to use the same title.
 */
export const wikiTargetMatchesNote = (target: string, path: string) => {
  const link = slashPath(target.trim())
  const note = slashPath(path.trim())
  if (!link || !note) return false
  const linkBare = link.replace(NOTE_EXT, '').toLocaleLowerCase('de-DE')
  const noteBare = note.replace(NOTE_EXT, '').toLocaleLowerCase('de-DE')
  if (link.includes('/')) return linkBare === noteBare
  return linkBare === titleFromPath(note).toLocaleLowerCase('de-DE')
}

/** Titles a note points at with wiki links such as `[[Mechanik]]`. Examples in code do not count. */
export const wikilinkTargets = (markdown: string) => {
  const found = new Set<string>()
  for (const match of maskMarkdownCode(markdown).matchAll(WIKILINK)) {
    const target = match[1]?.trim()
    if (target) found.add(target)
  }
  return [...found]
}

const excerptAround = (markdown: string, needle: string) => {
  const visible = maskMarkdownCode(markdown)
  const index = visible.toLocaleLowerCase('de-DE').indexOf(needle.toLocaleLowerCase('de-DE'))
  if (index < 0) return ''
  return markdown.slice(Math.max(0, index - 48), Math.min(markdown.length, index + needle.length + 72)).replace(/\s+/gu, ' ').trim()
}

/** Incoming wiki links. `notes` is the vault text the caller already has. */
export const backlinksFor = (
  path: string,
  notes: readonly { path: string; content: string }[],
): Backlink[] => {
    return notes.flatMap((note) => {
      if (note.path === path) return []
      const targets = wikilinkTargets(note.content)
      const hit = targets.find((target) => wikiTargetMatchesNote(target, path))
    if (!hit) return []
    return [{
      path: note.path,
      title: titleFromPath(note.path),
      excerpt: excerptAround(note.content, `[[${hit}`),
    }]
  })
}
