// A small non-validating XML parser for OOXML parts. No DOM needed, so the
// import runs the same in the browser, Electron, the Android WebView and Node.
export type XmlNode = { name: string; attrs: Record<string, string>; children: Array<XmlNode | string> }

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
export const decodeEntities = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name: string) => {
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  }
  return ENTITIES[name] ?? whole
})

export const parseXml = (source: string): XmlNode => {
  const root: XmlNode = { name: '#document', attrs: {}, children: [] }
  const stack: XmlNode[] = [root]
  let index = 0
  const length = source.length
  while (index < length) {
    const lt = source.indexOf('<', index)
    if (lt < 0) {
      stack[stack.length - 1].children.push(decodeEntities(source.slice(index)))
      break
    }
    if (lt > index) stack[stack.length - 1].children.push(decodeEntities(source.slice(index, lt)))
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      index = end < 0 ? length : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9)
      stack[stack.length - 1].children.push(source.slice(lt + 9, end < 0 ? length : end))
      index = end < 0 ? length : end + 3
      continue
    }
    if (source[lt + 1] === '?' || source[lt + 1] === '!') {
      const end = source.indexOf('>', lt)
      index = end < 0 ? length : end + 1
      continue
    }
    const gt = source.indexOf('>', lt)
    if (gt < 0) break
    if (source[lt + 1] === '/') {
      const name = source.slice(lt + 2, gt).trim()
      // Close up to the matching element (tolerates stray end tags).
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].name === name) {
          stack.length = depth
          break
        }
      }
      index = gt + 1
      continue
    }
    // Attribute values may contain '>': find the real end of the tag.
    let end = lt + 1
    let quote = ''
    while (end < length) {
      const char = source[end]
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
      end += 1
    }
    const selfClosing = source[end - 1] === '/'
    const inner = source.slice(lt + 1, selfClosing ? end - 1 : end)
    const nameMatch = /^[^\s/>]+/u.exec(inner)
    const node: XmlNode = { name: nameMatch?.[0] ?? '', attrs: {}, children: [] }
    const attrPattern = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/gu
    let match: RegExpExecArray | null
    while ((match = attrPattern.exec(inner.slice(node.name.length)))) node.attrs[match[1]] = decodeEntities(match[3] ?? match[4] ?? '')
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
    index = end + 1
  }
  return root
}

export const elements = (node: XmlNode) => node.children.filter((child): child is XmlNode => typeof child !== 'string')
export const child = (node: XmlNode | null | undefined, name: string) => (node ? elements(node).find((entry) => entry.name === name) ?? null : null)
export const childrenNamed = (node: XmlNode | null | undefined, name: string) => (node ? elements(node).filter((entry) => entry.name === name) : [])
export const descendants = (node: XmlNode, name: string, out: XmlNode[] = []) => {
  for (const entry of elements(node)) {
    if (entry.name === name) out.push(entry)
    else descendants(entry, name, out)
  }
  return out
}
export const textOf = (node: XmlNode): string => node.children.map((entry) => (typeof entry === 'string' ? entry : textOf(entry))).join('')
