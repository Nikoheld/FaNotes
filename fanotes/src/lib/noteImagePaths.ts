/**
 * Vault paths a Markdown image reference can mean, best guess first.
 * `img.png` and `../x/img.png` are relative to the note's folder (standard Markdown); `/Assets/img.png`
 * is vault-root absolute. Plain relative paths also fall back to the vault root, which is how
 * older FaNotes notes wrote them. Nothing leaves the vault: a path that climbs above the root is dropped.
 */
export function imageCandidates(source: string, notePath: string): string[] {
  const normalize = (parts: string[]): string | null => {
    const stack: string[] = []
    for (const part of parts) {
      if (!part || part === '.') continue
      if (part === '..') { if (!stack.length) return null; stack.pop(); continue }
      stack.push(part)
    }
    return stack.length ? stack.join('/') : null
  }
  const cleaned = source.replaceAll('\\', '/')
  const result: string[] = []
  const add = (value: string | null) => { if (value && !result.includes(value)) result.push(value) }
  if (cleaned.startsWith('/')) {
    add(normalize(cleaned.split('/')))
    return result
  }
  const folder = notePath.replaceAll('\\', '/').split('/').slice(0, -1)
  add(normalize([...folder, ...cleaned.split('/')]))
  add(normalize(cleaned.split('/')))
  return result
}

/** True for a local image reference (no URL scheme, no UNC/drive path) with a supported extension. */
export const isLocalImageSource = (source: string) => (
  !/^[a-z][a-z0-9+.-]*:/iu.test(source) && !source.startsWith('//') && /\.(?:png|jpe?g|gif|webp)$/iu.test(source)
)
