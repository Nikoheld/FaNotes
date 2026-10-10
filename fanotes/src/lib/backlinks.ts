const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu

export type Backlink = {
  path: string
  title: string
  excerpt: string
}

const titleFromPath = (path: string) => path.split('/').pop()?.replace(/\.(md|markdown|pdf)$/iu, '') ?? path

/** Titles a note points at with wiki links such as `[[Mechanik]]`. */
export const wikilinkTargets = (markdown: string) => {
  const found = new Set<string>()
  for (const match of markdown.matchAll(WIKILINK)) {
    const target = match[1]?.trim()
    if (target) found.add(target)
  }
  return [...found]
}

const excerptAround = (markdown: string, needle: string) => {
  const index = markdown.toLocaleLowerCase('de-DE').indexOf(needle.toLocaleLowerCase('de-DE'))
  if (index < 0) return ''
  return markdown.slice(Math.max(0, index - 48), Math.min(markdown.length, index + needle.length + 72)).replace(/\s+/gu, ' ').trim()
}

/** Incoming wiki links. `notes` is the vault text the caller already has. */
export const backlinksFor = (
  path: string,
  notes: readonly { path: string; content: string }[],
): Backlink[] => {
  const title = titleFromPath(path)
  const stem = title.toLocaleLowerCase('de-DE')
  return notes.flatMap((note) => {
    if (note.path === path) return []
    const targets = wikilinkTargets(note.content)
    const hit = targets.find((target) => target.toLocaleLowerCase('de-DE') === stem || target === path)
    if (!hit) return []
    return [{
      path: note.path,
      title: titleFromPath(note.path),
      excerpt: excerptAround(note.content, `[[${hit}`),
    }]
  })
}
