'use strict'

// Converts one page of one2html output into what FaNotes stores: clean Markdown plus
// ink strokes in the famd ink model. Pure functions, no file access: the importer
// resolves the images (resolveImage) and writes the files.
//
// Sources: the only OneNote source the importer reads is a binary notebook (.one,
// .onetoc2, .onepkg, OneDrive ZIP) converted by one2html, whose HTML carries ink as
// inline SVG (strokes without pressure). There is no Graph API or InkML/ISF source.

const MAX_STROKES = 6000
const MAX_POINTS_PER_STROKE = 4000
const MIN_PAGE_WIDTH = 900
const MIN_PAGE_HEIGHT = 1273
const MAX_PAGE_WIDTH = 18000
const MAX_PAGE_HEIGHT = 50920

let parseDocument = null
function parseHtml(html) {
  if (!parseDocument) parseDocument = require('./onenote-sanitizer.bundle.cjs').parseOneNoteDocument
  return parseDocument(html)
}

// parse5 keeps the camelCase of SVG attributes (viewBox), so names are compared case-insensitively.
const attr = (node, name) => node.attrs?.find((entry) => entry.name === name || entry.name.toLowerCase() === name)?.value
const children = (node) => node.childNodes ?? []
const isElement = (node) => typeof node.tagName === 'string'
const isText = (node) => node.nodeName === '#text'
const tag = (node) => (isElement(node) ? node.tagName.toLowerCase() : '')
const hasClass = (node, name) => (attr(node, 'class') ?? '').split(/\s+/u).includes(name)

function parseStyle(text) {
  const style = {}
  for (const part of String(text ?? '').split(';')) {
    const colon = part.indexOf(':')
    if (colon > 0) style[part.slice(0, colon).trim().toLowerCase()] = part.slice(colon + 1).trim()
  }
  return style
}
const styleOf = (node) => parseStyle(attr(node, 'style'))
const px = (value) => {
  const match = /^(-?[0-9.]+)\s*(px|pt)?$/iu.exec(String(value ?? '').trim())
  if (!match) return null
  const number = Number(match[1])
  if (!Number.isFinite(number)) return null
  return match[2]?.toLowerCase() === 'pt' ? number * (96 / 72) : number
}

function textOf(node) {
  if (isText(node)) return node.value
  return children(node).map(textOf).join('')
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const NAMED_COLORS = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080' }
const hex2 = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')

/** CSS colour to `{ color: '#rrggbb', alpha }`, or null for none/unknown. */
function parseColor(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text || text === 'none' || text === 'transparent') return null
  if (NAMED_COLORS[text]) return { color: NAMED_COLORS[text], alpha: 1 }
  let match = /^#([0-9a-f]{3})$/u.exec(text)
  if (match) return { color: `#${[...match[1]].map((digit) => digit + digit).join('')}`, alpha: 1 }
  match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/u.exec(text)
  if (match) return { color: `#${match[1]}`, alpha: match[2] ? parseInt(match[2], 16) / 255 : 1 }
  match = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)(?:[\s,/]+([0-9.]+%?))?\s*\)$/u.exec(text)
  if (match) {
    const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? Number.parseFloat(match[4]) / 100 : Number(match[4])
    return { color: `#${hex2(Number(match[1]))}${hex2(Number(match[2]))}${hex2(Number(match[3]))}`, alpha: Number.isFinite(alpha) ? alpha : 1 }
  }
  // One2html writes Windows system colours (`WindowText`) for the default pen: ink black.
  return { color: '#000000', alpha: 1 }
}

// ---------------------------------------------------------------------------
// Ink: inline SVG written by one2html -> strokes in page pixels
// ---------------------------------------------------------------------------

const IDENTITY = [1, 0, 0, 1, 0, 0]
const multiply = (left, right) => [
  left[0] * right[0] + left[2] * right[1], left[1] * right[0] + left[3] * right[1],
  left[0] * right[2] + left[2] * right[3], left[1] * right[2] + left[3] * right[3],
  left[0] * right[4] + left[2] * right[5] + left[4], left[1] * right[4] + left[3] * right[5] + left[5],
]
const apply = (matrix, x, y) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]

function parseTransform(value) {
  let matrix = IDENTITY
  for (const match of String(value ?? '').matchAll(/(translate|scale|matrix)\(([^)]*)\)/gu)) {
    const numbers = match[2].split(/[\s,]+/u).filter(Boolean).map(Number)
    if (numbers.some((number) => !Number.isFinite(number))) continue
    let next = IDENTITY
    if (match[1] === 'translate') next = [1, 0, 0, 1, numbers[0] ?? 0, numbers[1] ?? 0]
    else if (match[1] === 'scale') next = [numbers[0] ?? 1, 0, 0, numbers[1] ?? numbers[0] ?? 1, 0, 0]
    else if (numbers.length === 6) next = numbers
    matrix = multiply(matrix, next)
  }
  return matrix
}

/** SVG path data to polylines (curves are flattened). */
function flattenPath(data) {
  const tokens = [...String(data ?? '').matchAll(/([a-zA-Z])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/giu)].map((match) => (match[1] ? match[1] : Number(match[2])))
  const subpaths = []
  let current = null
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let lastControl = null
  let command = ''
  let index = 0
  const number = () => (typeof tokens[index] === 'number' ? tokens[index++] : Number.NaN)
  const begin = (px0, py0) => {
    current = [[px0, py0]]
    subpaths.push(current)
  }
  const lineTo = (nx, ny) => {
    if (!current) begin(x, y)
    current.push([nx, ny])
    x = nx
    y = ny
  }
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    const fromX = x
    const fromY = y
    for (let step = 1; step <= 8; step += 1) {
      const t = step / 8
      const u = 1 - t
      lineTo(
        u * u * u * fromX + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * fromY + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      )
    }
    lastControl = [x2, y2, 'c']
  }
  const quad = (x1, y1, x2, y2) => {
    const fromX = x
    const fromY = y
    for (let step = 1; step <= 8; step += 1) {
      const t = step / 8
      const u = 1 - t
      lineTo(u * u * fromX + 2 * u * t * x1 + t * t * x2, u * u * fromY + 2 * u * t * y1 + t * t * y2)
    }
    lastControl = [x1, y1, 'q']
  }
  let guard = 0
  while (index < tokens.length && guard++ < 400_000) {
    if (typeof tokens[index] === 'string') command = tokens[index++]
    else if (!command) break
    const relative = command === command.toLowerCase()
    const ox = relative ? x : 0
    const oy = relative ? y : 0
    const upper = command.toUpperCase()
    if (upper === 'Z') {
      if (current) lineTo(startX, startY)
      current = null
      x = startX
      y = startY
      lastControl = null
      continue
    }
    const keepControl = lastControl
    lastControl = null
    if (upper === 'M') {
      const nx = number() + ox
      const ny = number() + oy
      if (!Number.isFinite(nx + ny)) break
      x = nx
      y = ny
      startX = nx
      startY = ny
      begin(nx, ny)
      command = relative ? 'l' : 'L'
    } else if (upper === 'L') {
      const nx = number() + ox
      const ny = number() + oy
      if (!Number.isFinite(nx + ny)) break
      lineTo(nx, ny)
    } else if (upper === 'H') {
      const nx = number() + ox
      if (!Number.isFinite(nx)) break
      lineTo(nx, y)
    } else if (upper === 'V') {
      const ny = number() + oy
      if (!Number.isFinite(ny)) break
      lineTo(x, ny)
    } else if (upper === 'C') {
      const values = [number() + ox, number() + oy, number() + ox, number() + oy, number() + ox, number() + oy]
      if (values.some((value) => !Number.isFinite(value))) break
      cubic(...values)
    } else if (upper === 'S') {
      const values = [number() + ox, number() + oy, number() + ox, number() + oy]
      if (values.some((value) => !Number.isFinite(value))) break
      const first = keepControl?.[2] === 'c' ? [2 * x - keepControl[0], 2 * y - keepControl[1]] : [x, y]
      cubic(first[0], first[1], ...values)
    } else if (upper === 'Q') {
      const values = [number() + ox, number() + oy, number() + ox, number() + oy]
      if (values.some((value) => !Number.isFinite(value))) break
      quad(...values)
    } else if (upper === 'T') {
      const values = [number() + ox, number() + oy]
      if (values.some((value) => !Number.isFinite(value))) break
      const first = keepControl?.[2] === 'q' ? [2 * x - keepControl[0], 2 * y - keepControl[1]] : [x, y]
      quad(first[0], first[1], ...values)
    } else if (upper === 'A') {
      const values = [number(), number(), number(), number(), number(), number() + ox, number() + oy]
      if (values.some((value) => !Number.isFinite(value))) break
      lineTo(values[5], values[6])
    } else {
      break
    }
  }
  return subpaths.filter((subpath) => subpath.length >= 1)
}

const pointsAttribute = (value) => {
  const numbers = String(value ?? '').split(/[\s,]+/u).filter(Boolean).map(Number)
  const points = []
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    if (Number.isFinite(numbers[index]) && Number.isFinite(numbers[index + 1])) points.push([numbers[index], numbers[index + 1]])
  }
  return points
}

function isInkSvg(node) {
  let found = false
  const visit = (current) => {
    if (found) return
    if (isElement(current) && ['path', 'polyline', 'polygon', 'line'].includes(tag(current))) {
      const style = styleOf(current)
      const stroke = attr(current, 'stroke') ?? style.stroke
      if (stroke && stroke !== 'none') found = true
    }
    for (const child of children(current)) visit(child)
  }
  visit(node)
  return found
}

/**
 * The strokes of one `<svg>`, in page pixels. `origin` is where the element sits on the page.
 * Pressure is not part of the one2html SVG, so strokes carry a constant width.
 */
function inkStrokesOfSvg(svg, origin) {
  const style = styleOf(svg)
  const left = origin.x + (px(style.left) ?? 0)
  const top = origin.y + (px(style.top) ?? 0)
  const width = px(attr(svg, 'width') ?? style.width)
  const height = px(attr(svg, 'height') ?? style.height)
  const box = String(attr(svg, 'viewbox') ?? '').split(/[\s,]+/u).map(Number)
  const hasBox = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0
  const scaleX = hasBox && width ? width / box[2] : 1
  const scaleY = hasBox && height ? height / box[3] : scaleX
  const base = multiply([scaleX, 0, 0, scaleY, left - (hasBox ? box[0] * scaleX : 0), top - (hasBox ? box[1] * scaleY : 0)], IDENTITY)
  const strokes = []
  const visit = (node, matrix, inherited) => {
    if (!isElement(node)) return
    const name = tag(node)
    const nodeStyle = styleOf(node)
    const local = multiply(matrix, parseTransform(attr(node, 'transform')))
    const paint = {
      stroke: attr(node, 'stroke') ?? nodeStyle.stroke ?? inherited.stroke,
      fill: attr(node, 'fill') ?? nodeStyle.fill ?? inherited.fill,
      width: attr(node, 'stroke-width') ?? nodeStyle['stroke-width'] ?? inherited.width,
      opacity: Number(attr(node, 'stroke-opacity') ?? nodeStyle['stroke-opacity'] ?? attr(node, 'opacity') ?? nodeStyle.opacity ?? inherited.opacity ?? 1),
    }
    let shapes = null
    if (name === 'path') shapes = flattenPath(attr(node, 'd'))
    else if (name === 'polyline' || name === 'polygon') shapes = [pointsAttribute(attr(node, 'points'))]
    else if (name === 'line') {
      const line = [[Number(attr(node, 'x1') ?? 0), Number(attr(node, 'y1') ?? 0)], [Number(attr(node, 'x2') ?? 0), Number(attr(node, 'y2') ?? 0)]]
      shapes = line.flat().every(Number.isFinite) ? [line] : []
    }
    if (shapes) {
      const stroke = parseColor(paint.stroke)
      const fillOnly = !stroke
      const paintColor = stroke ?? parseColor(paint.fill)
      if (paintColor) {
        const matrixScale = Math.sqrt(Math.abs(local[0] * local[3] - local[1] * local[2])) || 1
        const widthValue = fillOnly ? 1.2 : (Number(String(paint.width ?? '').replace(/px$/iu, '')) || 1) * matrixScale
        const opacity = Math.max(0.08, Math.min(1, (Number.isFinite(paint.opacity) ? paint.opacity : 1) * paintColor.alpha))
        for (const shape of shapes) {
          if (!shape.length) continue
          const points = shape.slice(0, MAX_POINTS_PER_STROKE).map(([sx, sy]) => apply(local, sx, sy))
          if (points.some(([sx, sy]) => !Number.isFinite(sx) || !Number.isFinite(sy))) continue
          if (points.length === 1) points.push([points[0][0] + 0.01, points[0][1]])
          strokes.push({ points, color: paintColor.color, width: Math.max(0.5, Math.min(48, widthValue)), opacity })
        }
      }
    }
    for (const child of children(node)) visit(child, local, paint)
  }
  for (const child of children(svg)) visit(child, base, { stroke: attr(svg, 'stroke') ?? style.stroke, fill: attr(svg, 'fill') ?? style.fill, width: attr(svg, 'stroke-width'), opacity: 1 })
  return strokes
}

/**
 * Famd ink document (schemaVersion 1, packed later by the famd writer) from strokes in
 * page pixels. Points become fractions of sourceWidth/sourceHeight.
 */
function buildInkDocument(strokes, { title, createdAt, minWidth = MIN_PAGE_WIDTH, minHeight = MIN_PAGE_HEIGHT, extent = null } = {}) {
  if (!strokes.length) return null
  let maxX = extent?.x ?? 0
  let maxY = extent?.y ?? 0
  for (const stroke of strokes) {
    for (const [x, y] of stroke.points) {
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  const sourceWidth = Math.min(MAX_PAGE_WIDTH, Math.max(minWidth, Math.ceil(maxX + 108)))
  const sourceHeight = Math.min(MAX_PAGE_HEIGHT, Math.max(minHeight, Math.ceil(maxY + 144)))
  const clamp = (value) => Math.max(0, Math.min(1, value))
  const now = createdAt || new Date().toISOString()
  return {
    schemaVersion: 1,
    title: title || 'Handschrift',
    sourceWidth,
    sourceHeight,
    createdAt: now,
    updatedAt: now,
    strokes: strokes.map((stroke, index) => ({
      id: `on-${index + 1}`,
      points: stroke.points.map(([x, y], pointIndex) => ({
        x: Math.round(clamp(x / sourceWidth) * 1e6) / 1e6,
        y: Math.round(clamp(y / sourceHeight) * 1e6) / 1e6,
        t: pointIndex * 8,
        pressure: 0.5,
        pointerType: 'pen',
      })),
      baseWidth: Math.round(stroke.width * 100) / 100,
      pressureEnabled: false,
      color: stroke.color,
      ...(stroke.opacity < 0.95
        ? { purpose: 'art', brush: 'highlighter', opacity: Math.round(stroke.opacity * 100) / 100, colorEffect: 'solid', textureSeed: index + 1 }
        : { purpose: 'handwriting', colorEffect: 'solid', textureSeed: index + 1 }),
    })),
  }
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const MONOSPACE = /(?:consolas|courier|monospace|menlo|monaco|lucida console)/iu

function normalizeMath(text) {
  return text.normalize('NFKC')
}

/** MathML to LaTeX for the common cases; anything else falls back to its text. */
function mathToLatex(node) {
  if (isText(node)) return normalizeMath(node.value.trim())
  if (!isElement(node)) return ''
  const parts = children(node).filter((child) => isElement(child) || (isText(child) && child.value.trim()))
  const sub = (child) => mathToLatex(child)
  switch (tag(node)) {
    case 'mfrac': return `\\frac{${sub(parts[0] ?? { nodeName: '#text', value: '' })}}{${sub(parts[1] ?? { nodeName: '#text', value: '' })}}`
    case 'msqrt': return `\\sqrt{${parts.map(sub).join('')}}`
    case 'mroot': return `\\sqrt[${sub(parts[1])}]{${sub(parts[0])}}`
    case 'msup': return `{${sub(parts[0])}}^{${sub(parts[1])}}`
    case 'msub': return `{${sub(parts[0])}}_{${sub(parts[1])}}`
    case 'msubsup': return `{${sub(parts[0])}}_{${sub(parts[1])}}^{${sub(parts[2])}}`
    case 'mover': return `\\overset{${sub(parts[1])}}{${sub(parts[0])}}`
    case 'munder': return `\\underset{${sub(parts[1])}}{${sub(parts[0])}}`
    case 'mtext': return `\\text{${normalizeMath(textOf(node))}}`
    case 'mo': {
      const symbol = normalizeMath(textOf(node).trim())
      return ({ '×': '\\times ', '·': '\\cdot ', '≤': '\\le ', '≥': '\\ge ', '≠': '\\ne ', '∞': '\\infty ', '±': '\\pm ', '÷': '\\div ', '≈': '\\approx ', '→': '\\to ', '−': '-' })[symbol] ?? symbol
    }
    default: return parts.map(sub).join('')
  }
}

// Text runs carry sentinels instead of raw Markdown characters; restoreMarks() decides per paragraph
// which of them could pair up into accidental formatting (those get a backslash, the rest stay plain).
const SENTINELS = { '*': '\uE001', _: '\uE002', $: '\uE003', '[': '\uE004', ']': '\uE005' }
const markText = (text) => text
  .replace(/[*_$[\]]/gu, (char) => SENTINELS[char])
  .replace(/<!--/gu, '<\\!--')

function restoreMarks(text) {
  let value = text
  for (const mark of ['*', '_', '$']) {
    const count = value.split(SENTINELS[mark]).length - 1
    value = value.replaceAll(SENTINELS[mark], count >= 2 ? `\\${mark}` : mark)
  }
  const bracket = value.includes(`${SENTINELS[']']}(`)
  return value.replaceAll(SENTINELS['['], bracket ? '\\[' : '[').replaceAll(SENTINELS[']'], bracket ? '\\]' : ']')
}

const escapeLineStart = (line) => line
  .replace(/^(\s*)(#{1,6})(\s)/u, '$1\\$2$3')
  .replace(/^(\s*)([-+*>])(\s)/u, '$1\\$2$3')
  .replace(/^(\s*)(\d+)([.)])(\s)/u, '$1$2\\$3$4')

function safeHref(href) {
  const value = String(href ?? '').trim()
  return /^(?:https?:|mailto:)/iu.test(value) && !/[\s()<>]/u.test(value) ? value : null
}

// ---------------------------------------------------------------------------
// Free-form layout (pages with ink): every outline block becomes a positioned text field
// ---------------------------------------------------------------------------

const BODY_FONT = 15
const IMAGE_LINE = /^!\[([^\]\n]*)\]\(([^)\s]+)\)$/u
const MAX_FIELD_CHARS = 7500
const MAX_FIELDS = 190

/** Rendered height of Markdown text in a box of `width` px at `fontSize`, estimated from its lines. */
function estimateHeight(text, width, fontSize) {
  const charsPerLine = Math.max(8, Math.floor(width / (fontSize * 0.52)))
  let lines = 0
  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s/u.exec(line)
    const size = heading ? fontSize * (1.7 - heading[1].length * 0.12) : fontSize
    const visible = line.replace(/[*~`>|#-]/gu, '').length
    lines += Math.max(1, Math.ceil((visible * size) / fontSize / charsPerLine)) * (size / fontSize)
  }
  return Math.ceil(lines * fontSize * 1.4)
}

function buildLayout(rootBlocks, imageInfo) {
  const fields = []
  const images = []
  const flowImages = []
  let extentX = 0
  let extentY = 0
  const note = (x, y, w, h) => {
    extentX = Math.max(extentX, x + w)
    extentY = Math.max(extentY, y + h)
  }
  const addField = (x, y, width, text, fontSize, bold) => {
    const trimmed = text.trim()
    if (!trimmed || fields.length >= MAX_FIELDS) return 0
    const height = estimateHeight(trimmed, width, fontSize)
    fields.push({ x, y, width, text: trimmed.slice(0, MAX_FIELD_CHARS), fontSize, ...(bold ? { bold: true } : {}), height })
    note(x, y, width, height)
    return height + 8
  }
  for (const root of rootBlocks) {
    let y = root.top
    if (root.title) {
      const [heading, ...rest] = root.blocks
      y += addField(root.left, y, root.width, String(heading ?? '').replace(/^#\s+/u, ''), 27, true) + 4
      addField(root.left, y, root.width, rest.map((line) => line.replace(/^\*|\*$/gu, '')).join('\n\n'), 14, false)
      continue
    }
    let segment = []
    const flush = () => {
      const text = segment.join('\n\n')
      segment = []
      if (!text.trim()) return
      for (let start = 0; start < text.length; start += MAX_FIELD_CHARS) y += addField(root.left, y, root.width, text.slice(start, start + MAX_FIELD_CHARS), BODY_FONT, false)
    }
    for (const block of root.blocks) {
      for (const part of block.split(/\n{2,}/u)) {
        const trimmed = part.trim()
        const image = IMAGE_LINE.exec(trimmed)
        if (!image) { if (trimmed) segment.push(trimmed); continue }
        flush()
        const info = imageInfo(image[2])
        if (!info) { flowImages.push(trimmed); continue }
        const width = Math.max(24, Math.min(info.width, 600, info.maxWidth ?? 600))
        const height = Math.round(width * (info.height / info.width))
        images.push({ ref: image[2], alt: image[1], x: root.left, y, width, height })
        note(root.left, y, width, height)
        y += height + 8
      }
    }
    flush()
  }
  return { fields, images, flowImages, extentX, extentY }
}

/**
 * Converts one page. `resolveImage(src, alt)` returns the markdown path of a stored image, or null
 * when the image could not be stored. Returns { title, markdown, strokes, pageKeyHint, ... }.
 */
function convertOneNotePage(html, { resolveImage = () => null, imageInfo = () => null, fallbackTitle = 'OneNote-Seite' } = {}) {
  const document = parseHtml(html)
  const find = (node, test) => {
    for (const child of children(node)) {
      if (test(child)) return child
      const inner = find(child, test)
      if (inner) return inner
    }
    return null
  }
  const head = find(document, (node) => tag(node) === 'head')
  const body = find(document, (node) => tag(node) === 'body')
  const metaValue = (name) => {
    const meta = head && find(head, (node) => tag(node) === 'meta' && attr(node, 'name') === name)
    return meta ? attr(meta, 'content') : undefined
  }
  const titleNode = head && find(head, (node) => tag(node) === 'title')
  const title = (titleNode ? textOf(titleNode) : '').replace(/\s+/gu, ' ').trim() || fallbackTitle
  const createdSeconds = Number(metaValue('X-Created-Time'))
  const stats = { images: 0, missingImages: 0, tables: 0, checkboxes: 0, links: 0, math: 0, headings: 0 }
  const strokes = []
  const warnings = new Set()
  const imageSources = []

  // Inline content of an element as one Markdown string (no block children expected).
  const inline = (node, state, origin) => {
    let out = ''
    for (const child of children(node)) {
      if (isText(child)) {
        out += markText(child.value.replace(/[\u00a0\s]+/gu, ' '))
        continue
      }
      if (!isElement(child)) continue
      const name = tag(child)
      const style = styleOf(child)
      if (name === 'br') { out += '  \n'; continue }
      if (name === 'svg') {
        if (hasClass(child.parentNode ?? {}, 'note-tag-icon') || !isInkSvg(child)) continue
        strokes.push(...inkStrokesOfSvg(child, origin))
        continue
      }
      if (name === 'math') {
        stats.math += 1
        const latex = mathToLatex(child).trim()
        if (latex) out += attr(child, 'display') === 'block' ? `\n\n$$${latex}$$\n\n` : `$${latex}$`
        continue
      }
      if (name === 'img') {
        const resolved = resolveImage(attr(child, 'src') ?? '', attr(child, 'alt') ?? '')
        imageSources.push(attr(child, 'src') ?? '')
        const alt = (attr(child, 'alt') ?? '').replace(/[\[\]\n]+/gu, ' ').trim()
        if (resolved) { stats.images += 1; out += `\n\n![${alt}](${resolved})\n\n` } else { stats.missingImages += 1; warnings.add('image') }
        continue
      }
      if (hasClass(child, 'note-tag-icon')) {
        if (attr(child, 'role') === 'checkbox') state.checkbox = attr(child, 'aria-checked') === 'true' ? 'x' : ' '
        continue
      }
      if (name === 'ul' || name === 'ol' || name === 'table' || name === 'p' || name === 'div') {
        out += inline(child, state, origin)
        continue
      }
      let inner = inline(child, state, offsetOf(child, origin))
      if (!inner.trim()) { out += inner; continue }
      const bold = name === 'strong' || name === 'b' || /^(?:bold|[6-9]00)$/iu.test(style['font-weight'] ?? '')
      const italic = name === 'em' || name === 'i' || /italic/iu.test(style['font-style'] ?? '')
      const strike = name === 's' || name === 'del' || /line-through/iu.test(style['text-decoration'] ?? '')
      const mono = name === 'code' || MONOSPACE.test(style['font-family'] ?? '')
      const wrap = (marker, text) => {
        const lead = /^\s*/u.exec(text)[0]
        const trail = /\s*$/u.exec(text)[0]
        const core = text.trim()
        return core ? `${lead}${marker}${core}${marker}${trail}` : text
      }
      if (name === 'a') {
        const href = safeHref(attr(child, 'href'))
        if (href && inner.trim()) { stats.links += 1; inner = `[${inner.trim().replace(/[\uE004\uE005]/gu, '')}](${href})` }
      }
      if (mono && !inner.includes('`')) inner = wrap('`', inner)
      if (strike) inner = wrap('~~', inner)
      if (bold && italic) inner = wrap('***', inner)
      else if (bold) inner = wrap('**', inner)
      else if (italic) inner = wrap('*', inner)
      out += inner
    }
    return out
  }

  const offsetOf = (node, origin) => {
    const style = styleOf(node)
    const left = px(style.left)
    const top = px(style.top)
    if (/^(?:absolute|relative)$/iu.test(style.position ?? '') && (left !== null || top !== null)) {
      return { x: origin.x + (left ?? 0), y: origin.y + (top ?? 0) }
    }
    const padding = px(style['padding-left'])
    return padding ? { x: origin.x + padding, y: origin.y } : origin
  }

  const cleanLine = (text) => escapeLineStart(text.replace(/[ \t]+/gu, ' ').trim())
  const paragraphText = (raw) => restoreMarks(raw
    .split('\n')
    .map((line) => cleanLine(line.replace(/ {2,}$/u, '')) + (/ {2,}$/u.test(line) ? '  ' : ''))
    .join('\n')
    .replace(/^\n+|\n+$/gu, ''))

  // Block conversion; returns an array of Markdown blocks.
  const blocks = (node, origin, listDepth) => {
    const out = []
    const push = (text) => { if (text && text.trim()) out.push(text.replace(/\s+$/u, '')) }
    for (const child of children(node)) {
      if (isText(child)) {
        if (child.value.trim()) push(paragraphText(markText(child.value)))
        continue
      }
      if (!isElement(child)) continue
      const name = tag(child)
      const here = offsetOf(child, origin)
      if (name === 'script' || name === 'style' || name === 'nav') continue
      if (/^h[1-6]$/u.test(name)) {
        const level = Math.min(6, Number(name[1]) + 1)
        const text = paragraphText(inline(child, {}, here)).replace(/\s*\n\s*/gu, ' ')
        if (text) { stats.headings += 1; push(`${'#'.repeat(level)} ${text}`) }
        continue
      }
      if (name === 'ul' || name === 'ol') { push(listBlock(child, here, listDepth, '')); continue }
      if (name === 'table') { push(tableBlock(child, here)); continue }
      if (name === 'img' || name === 'svg' || name === 'math') {
        push(paragraphText(inline({ childNodes: [child] }, {}, origin)))
        continue
      }
      if (name === 'p' || name === 'span' || name === 'a' || name === 'strong' || name === 'em' || name === 'b' || name === 'i') {
        const hasBlock = children(child).some((inner) => ['ul', 'ol', 'table', 'div', 'p'].includes(tag(inner)))
        if (hasBlock) { out.push(...blocks(child, here, listDepth)); continue }
        const state = {}
        const text = paragraphText(inline(name === 'p' ? child : { childNodes: [child] }, state, here))
        const monoOnly = children(child).length > 0 && children(child).every((inner) => isText(inner) ? !inner.value.trim() : MONOSPACE.test(styleOf(inner)['font-family'] ?? '') || tag(inner) === 'code')
        if (state.checkbox) { stats.checkboxes += 1; push(`- [${state.checkbox}] ${text}`) } else if (monoOnly && text && !text.includes('\n')) push(`\`\`\`\n${text.replace(/^`+|`+$/gu, '')}\n\`\`\``)
        else push(text)
        continue
      }
      out.push(...blocks(child, here, listDepth))
    }
    return out
  }

  function listBlock(list, origin, depth, indent = '') {
    const ordered = tag(list) === 'ol'
    const lines = []
    let number = 0
    for (const item of children(list)) {
      if (tag(item) !== 'li') continue
      number += 1
      const here = offsetOf(item, origin)
      const state = {}
      let text = ''
      const nested = []
      for (const part of children(item)) {
        if (tag(part) === 'ul' || tag(part) === 'ol') nested.push(listBlock(part, offsetOf(part, here), depth + 1, `${indent}${ordered ? '   ' : '  '}`))
        else if (tag(part) === 'div' || tag(part) === 'p') {
          const inner = blocks({ childNodes: [part] }, here, depth + 1).join('\n')
          text += `${text ? ' ' : ''}${inner}`
        } else text += isText(part) ? markText(part.value.replace(/[\u00a0\s]+/gu, ' ')) : inline({ childNodes: [part] }, state, offsetOf(part, here))
      }
      const body = paragraphText(text).replace(/\s*\n\s*/gu, ' ').trim()
      const marker = state.checkbox ? `- [${state.checkbox}]` : ordered ? `${number}.` : '-'
      if (state.checkbox) stats.checkboxes += 1
      if (body || nested.length) lines.push(`${indent}${marker} ${body}`.trimEnd())
      for (const block of nested) if (block) lines.push(block)
    }
    return lines.join('\n')
  }

  function tableBlock(table, origin) {
    const rows = []
    const collect = (node) => {
      for (const child of children(node)) {
        if (tag(child) === 'tr') rows.push(children(child).filter((cell) => tag(cell) === 'td' || tag(cell) === 'th'))
        else if (isElement(child)) collect(child)
      }
    }
    collect(table)
    const cellText = (cell) => blocks(cell, offsetOf(cell, origin), 0).join('<br>').replace(/\n+/gu, '<br>').replace(/\|/gu, '\\|').trim()
    const grid = rows.map((cells) => cells.map(cellText)).filter((cells) => cells.some(Boolean))
    if (!grid.length) return ''
    const width = Math.max(...grid.map((cells) => cells.length))
    if (width === 0) return ''
    stats.tables += 1
    const pad = (cells) => [...cells, ...Array.from({ length: width - cells.length }, () => '')]
    const line = (cells) => `| ${pad(cells).map((cell) => cell || ' ').join(' | ')} |`
    return [line(grid[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...grid.slice(1).map(line)].join('\n')
  }

  const top = { x: 0, y: 0 }
  const roots = []
  if (body) {
    const gather = (node, origin) => {
      for (const child of children(node)) {
        if (!isElement(child)) continue
        const here = offsetOf(child, origin)
        const style = styleOf(child)
        const isContainer = hasClass(child, 'container-outline') || hasClass(child, 'title')
        if (isContainer) roots.push({ node: child, origin: here, top: px(style.top) ?? 0, left: px(style.left) ?? 0, title: hasClass(child, 'title') })
        else if (tag(child) === 'div' && children(child).some((inner) => hasClass(inner, 'container-outline') || hasClass(inner, 'title'))) gather(child, here)
        else roots.push({ node: child, origin, top: px(style.top) ?? 0, left: px(style.left) ?? 0, title: false })
      }
    }
    gather(body, top)
  }
  // One2html positions every outline on the page; reading order is top-to-bottom, then left-to-right.
  roots.sort((left, right) => (left.title === right.title ? 0 : left.title ? -1 : 1) || left.top - right.top || left.left - right.left)

  const sections = []
  const rootBlocks = []
  let subtitle = []
  for (const root of roots) {
    const container = root.node
    if (root.title) {
      // The title container holds the page title and its date lines; the title becomes the H1.
      const lines = blocks(hasClass(container, 'title') ? container : { childNodes: [container] }, root.origin, 0)
      rootBlocks.push({ title: true, left: root.left, top: root.top, width: px(styleOf(container)['max-width']) ?? 576, blocks: [...lines] })
      const first = lines.shift()
      void first
      subtitle = subtitle.concat(lines.filter((line) => line.trim()))
      continue
    }
    const isContainerNode = hasClass(container, 'container-outline')
    const produced = blocks(isContainerNode ? container : { childNodes: [container] }, root.origin, 0)
    sections.push(...produced)
    if (isContainerNode) rootBlocks.push({ title: false, left: root.left, top: root.top, width: px(styleOf(container)['max-width']) ?? 576, blocks: produced })
  }

  const lead = [`# ${paragraphText(markText(title)).replace(/\n/gu, ' ')}`]
  if (subtitle.length) lead.push(subtitle.map((line) => `*${line.replace(/\*/gu, '')}*`).join('  \n'))
  const markdown = `${[...lead, ...sections].join('\n\n').replace(/\n{3,}/gu, '\n\n').trim()}\n`

  let extentX = 0
  let extentY = 0
  for (const root of roots) {
    extentX = Math.max(extentX, root.left + 720)
    extentY = Math.max(extentY, root.top)
  }

  return {
    title,
    markdown,
    layout: buildLayout(rootBlocks, imageInfo),
    strokes: strokes.slice(0, MAX_STROKES),
    strokesDropped: Math.max(0, strokes.length - MAX_STROKES),
    pageId: metaValue('X-Original-Page-Id') ?? null,
    createdAt: Number.isFinite(createdSeconds) && createdSeconds > 0 ? new Date(createdSeconds * 1000).toISOString() : null,
    updatedAt: Number.isFinite(Number(metaValue('X-Updated-Time'))) && Number(metaValue('X-Updated-Time')) > 0 ? new Date(Number(metaValue('X-Updated-Time')) * 1000).toISOString() : null,
    imageSources,
    stats,
    warnings: [...warnings],
    layoutWidth: extentX,
    layoutHeight: extentY,
  }
}

module.exports = {
  buildInkDocument,
  convertOneNotePage,
  flattenPath,
  inkStrokesOfSvg,
  parseColor,
  parseHtml,
}
