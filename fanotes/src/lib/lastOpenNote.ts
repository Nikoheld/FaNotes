export const collectNotePaths = (
  entries: Array<{ kind?: string; relativePath?: string; children?: unknown[] }> | null | undefined,
): string[] => {
  const paths: string[] = []
  const walk = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      const record = node as { kind?: unknown; relativePath?: unknown; children?: unknown }
      if (record.kind === 'file' && typeof record.relativePath === 'string' && record.relativePath) {
        paths.push(record.relativePath)
      }
      if (Array.isArray(record.children)) walk(record.children)
    }
  }
  walk(entries)
  return paths
}

/** Prefer the last opened path when it still exists; otherwise the fallback or first tree file. */
export const chooseRestoredNote = (
  savedPath: string | null | undefined,
  treePaths: string[] | null | undefined,
  fallback?: string | null,
) => {
  const paths = Array.isArray(treePaths) ? treePaths.filter((path) => typeof path === 'string' && path) : []
  const saved = typeof savedPath === 'string' ? savedPath : ''
  if (saved && paths.includes(saved)) return saved
  const next = typeof fallback === 'string' ? fallback : ''
  if (next && paths.includes(next)) return next
  return paths[0] ?? null
}
