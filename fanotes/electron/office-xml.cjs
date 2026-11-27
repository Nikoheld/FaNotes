'use strict'

// Tiny tolerant XML reader for OOXML parts. No DTDs/entities beyond the five
// predefined ones and numeric references (so no entity expansion attacks), with
// caps on depth and node count.
const MAX_NODES = 400_000
const MAX_DEPTH = 120

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function decode(text) {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

function parseAttributes(source) {
  const attrs = {}
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu
  let match
  while ((match = pattern.exec(source))) attrs[match[1]] = decode(match[2] ?? match[3] ?? '')
  return attrs
}

/** Returns { name, attrs, children, text } where text holds the direct character data. */
function parseXml(source) {
  const root = { name: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  let nodes = 0
  const pattern = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>!?]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/giu
  let match
  while ((match = pattern.exec(source))) {
    const top = stack[stack.length - 1]
    if (match[1] !== undefined) { top.text += match[1]; continue }
    if (match[6] !== undefined) { top.text += decode(match[6]); continue }
    if (match[3] === undefined) continue
    if (match[2] === '/') {
      if (stack.length > 1) stack.pop()
      continue
    }
    nodes += 1
    if (nodes > MAX_NODES) throw new Error('Das Dokument ist zu komplex.')
    const node = { name: match[3], attrs: parseAttributes(match[4]), children: [], text: '' }
    top.children.push(node)
    if (match[5] !== '/') {
      if (stack.length > MAX_DEPTH) throw new Error('Das Dokument ist zu tief verschachtelt.')
      stack.push(node)
    }
  }
  return root.children[0] ?? root
}

const child = (node, name) => node?.children.find((item) => item.name === name) ?? null
const childrenNamed = (node, name) => node ? node.children.filter((item) => item.name === name) : []
function descendants(node, name, output = []) {
  if (!node) return output
  for (const item of node.children) {
    if (item.name === name) output.push(item)
    descendants(item, name, output)
  }
  return output
}
const attr = (node, name) => node?.attrs[name]

module.exports = { parseXml, child, childrenNamed, descendants, attr, decodeXmlText: decode }
