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

/** Index in `text` of a `de-DE` case match. `İ` lowercases to two units, so the folded index is not the original one. */
const localeIndex = (text: string, needle: string) => {
  const needleFold = needle.toLocaleLowerCase('de-DE')
  if (!needleFold) return -1
  const origin: number[] = []
  let folded = ''
  for (let index = 0; index < text.length; index += 1) {
    const piece = text[index].toLocaleLowerCase('de-DE')
    for (let unit = 0; unit < piece.length; unit += 1) origin.push(index)
    folded += piece
  }
  const found = folded.indexOf(needleFold)
  return found < 0 ? -1 : origin[found] ?? -1
}

const excerptAround = (markdown: string, needle: string) => {
  const index = localeIndex(maskMarkdownCode(markdown), needle)
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
