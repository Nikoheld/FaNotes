const TAG_MARKER = /<!--\s*fanotes-tags:\s*([^\n]*?)\s*-->/iu
const HASHTAG = /(?:^|[\s([{'"])#([\p{L}\p{N}_-]{1,40})/gu

export const normalizeTag = (value: string) => value
  .trim()
  .replace(/^#/u, '')
  .replace(/\s+/gu, '-')
  .slice(0, 40)
  .toLocaleLowerCase('de-CH')

export const parseDeclaredTags = (content: string): string[] => {
  const match = TAG_MARKER.exec(content)
  if (!match) return []
  return uniqueTags(match[1].split(/[,;]+/u))
}

export const parseHashtags = (content: string): string[] => {
  const body = content.replace(TAG_MARKER, '')
  return uniqueTags([...body.matchAll(HASHTAG)].map((match) => match[1]))
}

export const parseNoteTags = (content: string): string[] => uniqueTags([
  ...parseDeclaredTags(content),
  ...parseHashtags(content),
])

export const applyNoteTags = (content: string, tags: string[]): string => {
  const next = uniqueTags(tags)
  const marker = next.length ? `<!-- fanotes-tags: ${next.join(', ')} -->\n` : ''
  if (TAG_MARKER.test(content)) {
    const replaced = content.replace(TAG_MARKER, next.length ? `<!-- fanotes-tags: ${next.join(', ')} -->` : '')
    return replaced.replace(/^\n+/u, '')
  }
  return marker ? `${marker}${content.replace(/^\uFEFF/u, '')}` : content
}

export const collectVaultTags = (notes: Array<{ content: string }>): string[] => uniqueTags(
  notes.flatMap((note) => parseNoteTags(note.content)),
)

export const filterTreeByTag = <T extends { kind: 'file' | 'folder'; relativePath: string; children?: T[] }>(
  entries: T[],
  tag: string | null,
  index: Map<string, string[]>,
): T[] => {
  if (!tag) return entries
  const wanted = normalizeTag(tag)
  const keep = (entry: T): T | null => {
    if (entry.kind === 'file') {
      return (index.get(entry.relativePath) ?? []).includes(wanted) ? entry : null
    }
    const children = (entry.children ?? []).map(keep).filter((item): item is T => Boolean(item))
    return children.length ? { ...entry, children } : null
  }
  return entries.map(keep).filter((item): item is T => Boolean(item))
}

const uniqueTags = (values: string[]) => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of values) {
    const tag = normalizeTag(raw)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
  }
  return result
}
