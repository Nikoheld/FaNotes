'use strict'

// Built-in PowerPoint renderer: each slide becomes an absolutely positioned
// page at the real slide size (EMU -> CSS px), printed one PDF page per slide.
// Handles text boxes (alignment, bullets, size, bold/italic/underline, color),
// pictures with cropping, simple shapes with fills and outlines, lines, tables,
// groups, slide/layout/master backgrounds and inherited placeholder geometry.
// Charts, SmartArt, embedded objects and animations are not drawn.
const path = require('node:path')
const { parseXml, child, childrenNamed, descendants } = require('./office-xml.cjs')
const { esc, hexColor, num, round, fontFamily, imageDataUrl, readRelationships, documentShell } = require('./office-html-common.cjs')

const EMU_PER_PX = 9525
const MAX_SLIDES = 600
const EMPTY_SHAPE = { name: 'p:sp', attrs: {}, children: [], text: '' }
const px = (emu) => round(num(emu) / EMU_PER_PX)
const ptToPx = (points) => round(points * 96 / 72)

const SCHEME_FALLBACK = { dk1: '000000', lt1: 'ffffff', dk2: '44546a', lt2: 'e7e6e6', accent1: '4472c4', accent2: 'ed7d31', accent3: 'a5a5a5', accent4: 'ffc000', accent5: '5b9bd5', accent6: '70ad47', hlink: '0563c1', folHlink: '954f72' }
const PRESET_COLORS = { black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', gray: '808080', grey: '808080', orange: 'ffa500' }

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}
function hslToRgb([h, s, l]) {
  if (s === 0) return [l, l, l].map((value) => Math.round(value * 255))
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((value) => Math.round(value * 255))
}
const hexToRgb = (hex) => [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16))
const rgbToHex = (rgb) => rgb.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')

function pptxToHtml(zip, { title = 'Präsentation' } = {}) {
  const presentationXml = zip.readText('ppt/presentation.xml')
  if (!presentationXml) throw new Error('Die Präsentation enthält keine Folien (ppt/presentation.xml fehlt).')
  const presentation = parseXml(presentationXml)
  const sizeNode = child(presentation, 'p:sldSz')
  let slideWidth = num(sizeNode?.attrs.cx, 12192000)
  let slideHeight = num(sizeNode?.attrs.cy, 6858000)
  if (slideWidth < 914400 || slideHeight < 914400 || slideWidth > 914400 * 60 || slideHeight > 914400 * 60) { slideWidth = 12192000; slideHeight = 6858000 }
  const widthPx = Math.round(slideWidth / EMU_PER_PX)
  const heightPx = Math.round(slideHeight / EMU_PER_PX)
  const presentationRels = readRelationships(zip, parseXml, 'ppt/presentation.xml')
  const slideIds = childrenNamed(child(presentation, 'p:sldIdLst'), 'p:sldId')
  let slideParts = slideIds.map((node) => presentationRels.get(node.attrs['r:id'])?.target).filter((target) => target && zip.has(target))
  if (!slideParts.length) {
    slideParts = zip.names().filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).sort((a, b) => Number(/\d+/u.exec(a)[0]) - Number(/\d+/u.exec(b)[0]))
  }
  if (!slideParts.length) throw new Error('Die Präsentation enthält keine Folien.')
  slideParts = slideParts.slice(0, MAX_SLIDES)

  const parsed = new Map()
  const partXml = (name) => {
    if (!name || !zip.has(name)) return null
    if (!parsed.has(name)) parsed.set(name, parseXml(zip.readText(name)))
    return parsed.get(name)
  }
  const relsCache = new Map()
  const relsOf = (name) => {
    if (!relsCache.has(name)) relsCache.set(name, readRelationships(zip, parseXml, name))
    return relsCache.get(name)
  }
  const imageCache = new Map()
  const themeCache = new Map()
  const themeFor = (masterPart) => {
    if (themeCache.has(masterPart)) return themeCache.get(masterPart)
    const themePart = [...relsOf(masterPart).values()].find((rel) => rel.type === 'theme')?.target
    const colors = { ...SCHEME_FALLBACK }
    let fonts = { major: null, minor: null }
    const theme = partXml(themePart)
    const scheme = descendants(theme, 'a:clrScheme')[0]
    for (const entry of scheme?.children ?? []) {
      const inner = entry.children[0]
      const hex = inner?.name === 'a:srgbClr' ? hexColor(inner.attrs.val) : inner?.name === 'a:sysClr' ? hexColor(inner.attrs.lastClr) : null
      if (hex) colors[entry.name.replace(/^a:/u, '')] = hex.slice(1)
    }
    const fontScheme = descendants(theme, 'a:fontScheme')[0]
    fonts = { major: child(child(fontScheme, 'a:majorFont'), 'a:latin')?.attrs.typeface ?? null, minor: child(child(fontScheme, 'a:minorFont'), 'a:latin')?.attrs.typeface ?? null }
    const result = { colors, fonts }
    themeCache.set(masterPart, result)
    return result
  }

  /** Context of one slide: slide, layout and master parts, theme, color map. */
  const contextFor = (slidePart) => {
    const slideRels = relsOf(slidePart)
    const layoutPart = [...slideRels.values()].find((rel) => rel.type === 'slideLayout')?.target ?? null
    const masterPart = layoutPart ? ([...relsOf(layoutPart).values()].find((rel) => rel.type === 'slideMaster')?.target ?? null) : null
    const master = partXml(masterPart)
    const colorMap = child(master, 'p:clrMap')?.attrs ?? { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }
    return { slidePart, layoutPart, masterPart, slide: partXml(slidePart), layout: partXml(layoutPart), master, theme: masterPart ? themeFor(masterPart) : { colors: SCHEME_FALLBACK, fonts: {} }, colorMap }
  }

  const resolveColor = (node, context) => {
    if (!node) return null
    let hex = null
    if (node.name === 'a:srgbClr') hex = hexColor(node.attrs.val)?.slice(1) ?? null
    else if (node.name === 'a:schemeClr') {
      const key = context.colorMap[node.attrs.val] ?? node.attrs.val
      hex = context.theme.colors[key] ?? (node.attrs.val === 'phClr' ? null : null)
    } else if (node.name === 'a:sysClr') hex = hexColor(node.attrs.lastClr)?.slice(1) ?? (node.attrs.val === 'window' ? 'ffffff' : '000000')
    else if (node.name === 'a:prstClr') hex = PRESET_COLORS[node.attrs.val] ?? '000000'
    if (!hex) return null
    let rgb = hexToRgb(hex)
    let alpha = 1
    for (const mod of node.children) {
      const amount = num(mod.attrs.val) / 100000
      if (mod.name === 'a:lumMod' || mod.name === 'a:lumOff') {
        const hsl = rgbToHsl(rgb)
        hsl[2] = mod.name === 'a:lumMod' ? Math.min(1, hsl[2] * amount) : Math.min(1, hsl[2] + amount)
        rgb = hslToRgb(hsl)
      } else if (mod.name === 'a:tint') rgb = rgb.map((value) => value + (255 - value) * (1 - amount))
      else if (mod.name === 'a:shade') rgb = rgb.map((value) => value * amount)
      else if (mod.name === 'a:alpha') alpha = amount
    }
    const out = rgbToHex(rgb)
    return alpha < 0.999 ? `rgba(${hexToRgb(out).join(',')},${round(alpha)})` : `#${out}`
  }

  /** CSS background value for a fill container (spPr, bgPr, ...), or null for "nothing set" and 'none' for noFill. */
  const fillOf = (container, context, rels) => {
    if (!container) return null
    for (const node of container.children) {
      if (node.name === 'a:noFill') return 'none'
      if (node.name === 'a:solidFill') return resolveColor(node.children[0], context)
      if (node.name === 'a:gradFill') {
        const stops = childrenNamed(child(node, 'a:gsLst'), 'a:gs').map((stop) => resolveColor(stop.children[0], context)).filter(Boolean)
        if (!stops.length) return null
        const angle = num(child(node, 'a:lin')?.attrs.ang, 5400000) / 60000
        return stops.length === 1 ? stops[0] : `linear-gradient(${round(angle + 90)}deg,${stops.join(',')})`
      }
      if (node.name === 'a:pattFill') return resolveColor(child(node, 'a:fgClr')?.children[0], context)
      if (node.name === 'a:blipFill') {
        const target = rels.get(child(node, 'a:blip')?.attrs['r:embed'])?.target
        const url = target ? imageDataUrl(zip, target, imageCache) : null
        return url ? `url(${url}) center/cover no-repeat` : null
      }
    }
    return null
  }

  const backgroundOf = (context) => {
    for (const [root, part] of [[context.slide, context.slidePart], [context.layout, context.layoutPart], [context.master, context.masterPart]]) {
      const bg = child(child(root, 'p:cSld'), 'p:bg')
      if (!bg) continue
      const rels = part ? relsOf(part) : new Map()
      const fill = fillOf(child(bg, 'p:bgPr'), context, rels)
      if (fill && fill !== 'none') return fill
      const ref = child(bg, 'p:bgRef')
      const color = ref ? resolveColor(ref.children[0], context) : null
      if (color) return color
    }
    return '#ffffff'
  }

  // ---- inheritance of placeholder geometry and text defaults ----
  const placeholderOf = (shape) => child(child(child(shape, 'p:nvSpPr') ?? child(shape, 'p:nvPicPr') ?? child(shape, 'p:nvGraphicFramePr'), 'p:nvPr'), 'p:ph')
  const shapesOf = (root) => child(child(root, 'p:cSld'), 'p:spTree')?.children.filter((node) => ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp', 'p:cxnSp'].includes(node.name)) ?? []
  const findPlaceholder = (root, ph) => {
    if (!root || !ph) return null
    const candidates = shapesOf(root).filter((shape) => placeholderOf(shape))
    const sameIdx = ph.attrs.idx === undefined ? null : candidates.find((shape) => placeholderOf(shape).attrs.idx === ph.attrs.idx)
    if (sameIdx) return sameIdx
    const type = ph.attrs.type ?? 'body'
    const norm = (value) => (value === 'ctrTitle' ? 'title' : value === 'subTitle' ? 'body' : value ?? 'body')
    return candidates.find((shape) => norm(placeholderOf(shape).attrs.type) === norm(type)) ?? null
  }
  const xfrmOf = (shape) => {
    const xfrm = child(child(shape, 'p:spPr'), 'a:xfrm') ?? child(shape, 'p:xfrm') ?? child(child(shape, 'p:grpSpPr'), 'a:xfrm')
    if (!xfrm) return null
    const off = child(xfrm, 'a:off')
    const ext = child(xfrm, 'a:ext')
    if (!off || !ext) return null
    return { x: num(off.attrs.x), y: num(off.attrs.y), w: num(ext.attrs.cx), h: num(ext.attrs.cy), rot: num(xfrm.attrs.rot) / 60000, flipH: xfrm.attrs.flipH === '1', flipV: xfrm.attrs.flipV === '1', chX: num(child(xfrm, 'a:chOff')?.attrs.x), chY: num(child(xfrm, 'a:chOff')?.attrs.y), chW: num(child(xfrm, 'a:chExt')?.attrs.cx), chH: num(child(xfrm, 'a:chExt')?.attrs.cy) }
  }

  const textStyleName = (ph) => (!ph ? 'otherStyle' : ['title', 'ctrTitle'].includes(ph.attrs.type) ? 'titleStyle' : ['body', 'subTitle', 'obj', undefined].includes(ph.attrs.type) ? 'bodyStyle' : 'otherStyle')

  /** Paragraph-level defaults for one list level, lowest priority first. */
  const levelSources = (shape, context, level) => {
    const ph = placeholderOf(shape)
    const name = `a:lvl${level + 1}pPr`
    const list = []
    const masterStyle = child(child(context.master, 'p:txStyles'), `p:${textStyleName(ph)}`)
    list.push(child(masterStyle, name))
    if (ph) {
      list.push(child(child(child(findPlaceholder(context.master, ph), 'p:txBody'), 'a:lstStyle'), name))
      list.push(child(child(child(findPlaceholder(context.layout, ph), 'p:txBody'), 'a:lstStyle'), name))
    }
    list.push(child(child(child(shape, 'p:txBody'), 'a:lstStyle'), name))
    return list.filter(Boolean)
  }

  let autoNumberState = null
  const renderParagraph = (paragraph, shape, context, rels, fontScale) => {
    const pPr = child(paragraph, 'a:pPr')
    const level = Math.min(8, Math.max(0, num(pPr?.attrs.lvl)))
    const sources = [...levelSources(shape, context, level), pPr].filter(Boolean)
    const merged = { marL: 0, indent: 0, algn: 'l', sz: null, b: false, i: false, u: false, colorNode: null, bullet: null, font: null, lnSpc: null, spcBef: 0, spcAft: 0 }
    for (const source of sources) {
      if (source.attrs.marL !== undefined) merged.marL = num(source.attrs.marL)
      if (source.attrs.indent !== undefined) merged.indent = num(source.attrs.indent)
      if (source.attrs.algn) merged.algn = source.attrs.algn
      const def = child(source, 'a:defRPr')
      if (def) {
        if (def.attrs.sz) merged.sz = num(def.attrs.sz) / 100
        if (def.attrs.b !== undefined) merged.b = def.attrs.b === '1'
        if (def.attrs.i !== undefined) merged.i = def.attrs.i === '1'
        if (def.attrs.u !== undefined) merged.u = def.attrs.u !== 'none'
        const fill = child(def, 'a:solidFill')
        if (fill) merged.colorNode = fill.children[0]
        const latin = child(def, 'a:latin')?.attrs.typeface
        if (latin) merged.font = latin
      }
      for (const node of source.children) {
        if (node.name === 'a:buNone') merged.bullet = null
        else if (node.name === 'a:buChar') merged.bullet = { char: node.attrs.char || '•' }
        else if (node.name === 'a:buAutoNum') merged.bullet = { auto: node.attrs.type || 'arabicPeriod', start: num(node.attrs.startAt, 1) }
        else if (node.name === 'a:lnSpc') {
          const pct = child(node, 'a:spcPct')
          if (pct) merged.lnSpc = num(pct.attrs.val) / 100000
        } else if (node.name === 'a:spcBef' || node.name === 'a:spcAft') {
          const pts = child(node, 'a:spcPts')
          const pct = child(node, 'a:spcPct')
          const value = pts ? ptToPx(num(pts.attrs.val) / 100) : pct ? (num(pct.attrs.val) / 100000) * 20 : 0
          if (node.name === 'a:spcBef') merged.spcBef = value
          else merged.spcAft = value
        }
      }
    }
    const runs = []
    const textRuns = paragraph.children.filter((node) => ['a:r', 'a:br', 'a:fld'].includes(node.name))
    for (const run of textRuns) {
      if (run.name === 'a:br') { runs.push('<br>'); continue }
      const rPr = child(run, 'a:rPr')
      const text = child(run, 'a:t')?.text ?? ''
      if (!text) continue
      const css = []
      const size = (rPr?.attrs.sz ? num(rPr.attrs.sz) / 100 : merged.sz ?? 18) * fontScale
      css.push(`font-size:${ptToPx(size)}px`)
      const bold = rPr?.attrs.b !== undefined ? rPr.attrs.b === '1' : merged.b
      const italic = rPr?.attrs.i !== undefined ? rPr.attrs.i === '1' : merged.i
      const underline = rPr?.attrs.u !== undefined ? rPr.attrs.u !== 'none' : merged.u
      if (bold) css.push('font-weight:700')
      if (italic) css.push('font-style:italic')
      const decorations = [underline ? 'underline' : '', rPr?.attrs.strike && rPr.attrs.strike !== 'noStrike' ? 'line-through' : ''].filter(Boolean)
      if (decorations.length) css.push(`text-decoration:${decorations.join(' ')}`)
      const color = resolveColor(child(rPr, 'a:solidFill')?.children[0], context) ?? resolveColor(merged.colorNode, context) ?? resolveColor({ name: 'a:schemeClr', attrs: { val: 'tx1' }, children: [] }, context)
      if (color) css.push(`color:${color}`)
      const highlight = resolveColor(child(child(rPr, 'a:highlight'), 'a:srgbClr') ?? child(rPr, 'a:highlight')?.children[0], context)
      if (highlight) css.push(`background:${highlight}`)
      const baseline = num(rPr?.attrs.baseline)
      if (baseline > 0) css.push('vertical-align:super;font-size:0.7em')
      else if (baseline < 0) css.push('vertical-align:sub;font-size:0.7em')
      const typeface = child(rPr, 'a:latin')?.attrs.typeface ?? merged.font
      const resolved = typeface === '+mj-lt' ? context.theme.fonts.major : typeface === '+mn-lt' ? context.theme.fonts.minor : typeface
      const family = fontFamily(resolved ?? context.theme.fonts.minor)
      if (family) css.push(`font-family:${family}`)
      runs.push(`<span style="${css.join(';')}">${esc(text)}</span>`)
    }
    const leftPx = px(merged.marL)
    const indentPx = px(merged.indent)
    let marker = ''
    const hasText = runs.length > 0
    if (merged.bullet && hasText) {
      let text = merged.bullet.char
      if (merged.bullet.auto) {
        autoNumberState ??= []
        autoNumberState.length = level + 1
        autoNumberState[level] = (autoNumberState[level] ?? merged.bullet.start - 1) + 1
        text = `${autoNumberState[level]}.`
      }
      const width = Math.max(indentPx < 0 ? -indentPx : 14, 10)
      marker = `<span style="display:inline-block;width:${width}px;text-indent:0">${esc(text)}</span>`
    } else if (!merged.bullet) {
      if (autoNumberState) autoNumberState.length = Math.min(autoNumberState.length, level)
    }
    const css = [`margin:${round(merged.spcBef)}px 0 ${round(merged.spcAft)}px 0`, `padding-left:${Math.max(0, merged.bullet ? leftPx : leftPx + Math.max(0, indentPx))}px`, `text-indent:${merged.bullet ? Math.min(0, indentPx) : 0}px`, `text-align:${({ l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' })[merged.algn] ?? 'left'}`]
    css.push(`line-height:${round((merged.lnSpc ?? 1) * 1.2)}`)
    const emptySize = (merged.sz ?? 18) * fontScale
    return `<div style="${css.join(';')}">${marker}${runs.join('') || `<span style="font-size:${ptToPx(emptySize)}px">&nbsp;</span>`}</div>`
  }

  const renderTextBody = (shape, context, rels) => {
    const body = child(shape, 'p:txBody')
    if (!body) return ''
    const bodyPr = child(body, 'a:bodyPr') ?? {}
    const ph = placeholderOf(shape)
    const inherited = [child(findPlaceholder(context.master, ph), 'p:txBody'), child(findPlaceholder(context.layout, ph), 'p:txBody')].map((node) => child(node, 'a:bodyPr')).filter(Boolean)
    const attrOf = (name) => [bodyPr, ...inherited].map((node) => node.attrs?.[name]).find((value) => value !== undefined)
    const insets = ['lIns', 'tIns', 'rIns', 'bIns'].map((name, index) => px(attrOf(name) ?? [91440, 45720, 91440, 45720][index]))
    const anchor = attrOf('anchor') ?? 't'
    const autofit = child(bodyPr, 'a:normAutofit') ?? inherited.map((node) => child(node, 'a:normAutofit')).find(Boolean)
    const fontScale = autofit?.attrs.fontScale ? num(autofit.attrs.fontScale) / 100000 : 1
    autoNumberState = null
    const paragraphs = childrenNamed(body, 'a:p').map((paragraph) => renderParagraph(paragraph, shape, context, rels, fontScale)).join('')
    const justify = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start'
    const wrap = attrOf('wrap') === 'none' ? 'white-space:nowrap;' : 'overflow-wrap:break-word;'
    return `<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:${justify};padding:${insets[1]}px ${insets[2]}px ${insets[3]}px ${insets[0]}px;box-sizing:border-box;${wrap}">${paragraphs}</div>`
  }

  const outlineCss = (spPr, context) => {
    const line = child(spPr, 'a:ln')
    if (!line || child(line, 'a:noFill')) return null
    const color = resolveColor(child(line, 'a:solidFill')?.children[0], context)
    if (!color) return null
    const width = Math.max(1, px(num(line.attrs.w, 12700)))
    const dash = child(line, 'a:prstDash')?.attrs.val
    return { color, width, style: dash && dash !== 'solid' ? 'dashed' : 'solid' }
  }

  const applyTransform = (box, group) => {
    if (!group) return box
    return { ...box, x: group.ox + (box.x - group.cx) * group.sx, y: group.oy + (box.y - group.cy) * group.sy, w: box.w * group.sx, h: box.h * group.sy }
  }

  const geometryCss = (preset, box) => {
    switch (preset) {
      case 'ellipse': return 'border-radius:50%;'
      case 'roundRect': case 'round2SameRect': case 'snipRoundRect': return `border-radius:${round(Math.min(box.w, box.h) * 0.1667)}px;`
      case 'triangle': return 'clip-path:polygon(50% 0,100% 100%,0 100%);'
      case 'rtTriangle': return 'clip-path:polygon(0 0,100% 100%,0 100%);'
      case 'diamond': return 'clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%);'
      case 'hexagon': return 'clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);'
      case 'rightArrow': return 'clip-path:polygon(0 25%,60% 25%,60% 0,100% 50%,60% 100%,60% 75%,0 75%);'
      case 'leftArrow': return 'clip-path:polygon(100% 25%,40% 25%,40% 0,0 50%,40% 100%,40% 75%,100% 75%);'
      default: return ''
    }
  }

  const boxCss = (box) => {
    const transforms = []
    if (box.rot) transforms.push(`rotate(${round(box.rot)}deg)`)
    if (box.flipH) transforms.push('scaleX(-1)')
    if (box.flipV) transforms.push('scaleY(-1)')
    return `position:absolute;left:${px(box.x)}px;top:${px(box.y)}px;width:${Math.max(0, px(box.w))}px;height:${Math.max(0, px(box.h))}px;box-sizing:border-box;${transforms.length ? `transform:${transforms.join(' ')};` : ''}`
  }

  const renderTable = (frame, box, context) => {
    const table = descendants(frame, 'a:tbl')[0]
    if (!table) return ''
    const columns = childrenNamed(child(table, 'a:tblGrid'), 'a:gridCol').map((col) => px(col.attrs.w))
    let html = `<div style="${boxCss(box)}overflow:hidden"><table style="border-collapse:collapse;table-layout:fixed;width:${columns.reduce((sum, width) => sum + width, 0)}px">`
    html += `<colgroup>${columns.map((width) => `<col style="width:${width}px">`).join('')}</colgroup>`
    for (const row of childrenNamed(table, 'a:tr')) {
      html += `<tr style="height:${px(row.attrs.h)}px">`
      for (const cell of childrenNamed(row, 'a:tc')) {
        if (cell.attrs.hMerge === '1' || cell.attrs.vMerge === '1') continue
        const tcPr = child(cell, 'a:tcPr')
        const fill = fillOf(tcPr, context, new Map())
        const text = childrenNamed(child(cell, 'a:txBody'), 'a:p').map((paragraph) => renderParagraph(paragraph, EMPTY_SHAPE, context, new Map(), 1)).join('')
        const span = num(cell.attrs.gridSpan, 1)
        const rowSpan = num(cell.attrs.rowSpan, 1)
        html += `<td${span > 1 ? ` colspan="${span}"` : ''}${rowSpan > 1 ? ` rowspan="${rowSpan}"` : ''} style="border:1px solid #bbb;padding:3px 6px;vertical-align:top;${fill && fill !== 'none' ? `background:${fill};` : ''}">${text}</td>`
      }
      html += '</tr>'
    }
    return `${html}</table></div>`
  }

  const renderShape = (shape, context, rels, group, ownerRoot) => {
    const ph = placeholderOf(shape)
    if (shape.name === 'p:grpSp') {
      const own = xfrmOf(shape)
      const outer = own ? applyTransform(own, group) : null
      const next = outer && own.chW > 0 && own.chH > 0
        ? { ox: outer.x, oy: outer.y, cx: own.chX, cy: own.chY, sx: outer.w / own.chW, sy: outer.h / own.chH }
        : group
      return shape.children.filter((node) => ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp', 'p:cxnSp'].includes(node.name)).map((node) => renderShape(node, context, rels, next, ownerRoot)).join('')
    }
    let box = xfrmOf(shape)
    if (!box && ph) {
      box = xfrmOf(findPlaceholder(context.layout, ph)) ?? xfrmOf(findPlaceholder(context.master, ph))
    }
    if (!box) return ''
    box = applyTransform(box, group)
    if (shape.name === 'p:pic') {
      const embed = child(child(shape, 'p:blipFill'), 'a:blip')?.attrs['r:embed']
      const target = embed ? rels.get(embed)?.target : null
      const url = target ? imageDataUrl(zip, target, imageCache) : null
      if (!url) return ''
      const crop = child(child(shape, 'p:blipFill'), 'a:srcRect')
      const left = num(crop?.attrs.l) / 100000
      const right = num(crop?.attrs.r) / 100000
      const top = num(crop?.attrs.t) / 100000
      const bottom = num(crop?.attrs.b) / 100000
      const w = px(box.w)
      const h = px(box.h)
      const imgW = left + right < 0.95 ? w / (1 - left - right) : w
      const imgH = top + bottom < 0.95 ? h / (1 - top - bottom) : h
      const border = outlineCss(child(shape, 'p:spPr'), context)
      return `<div style="${boxCss(box)}overflow:hidden;${border ? `border:${border.width}px ${border.style} ${border.color};` : ''}"><img src="${url}" alt="" style="position:absolute;left:${round(-left * imgW)}px;top:${round(-top * imgH)}px;width:${round(imgW)}px;height:${round(imgH)}px;max-width:none"></div>`
    }
    if (shape.name === 'p:graphicFrame') return renderTable(shape, box, context)
    const spPr = child(shape, 'p:spPr')
    const geometry = child(spPr, 'a:prstGeom')?.attrs.prst ?? (child(spPr, 'a:custGeom') ? 'custom' : ph ? 'rect' : 'rect')
    if (shape.name === 'p:cxnSp' || ['line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'curvedConnector2', 'curvedConnector3'].includes(geometry)) {
      const outline = outlineCss(spPr, context) ?? { color: '#000000', width: 1, style: 'solid' }
      const w = Math.max(1, px(box.w))
      const h = Math.max(1, px(box.h))
      const flipped = { ...box, flipH: false, flipV: false }
      const x1 = box.flipH ? w : 0
      const x2 = box.flipH ? 0 : w
      const y1 = box.flipV ? h : 0
      const y2 = box.flipV ? 0 : h
      return `<svg style="${boxCss(flipped)}overflow:visible" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${esc(outline.color)}" stroke-width="${outline.width}"${outline.style === 'dashed' ? ' stroke-dasharray="6 4"' : ''}/></svg>`
    }
    // Style references (p:style) supply theme fills/lines for shapes without their own.
    const style = child(shape, 'p:style')
    let fill = fillOf(spPr, context, rels)
    if (fill === null && style) fill = resolveColor(child(child(style, 'a:fillRef'), 'a:srgbClr') ?? child(child(style, 'a:fillRef'), 'a:schemeClr'), context)
    let outline = outlineCss(spPr, context)
    if (!outline && style && !child(child(spPr, 'a:ln'), 'a:noFill')) {
      const ref = child(style, 'a:lnRef')
      const color = ref && num(ref.attrs.idx) > 0 ? resolveColor(ref.children[0], context) : null
      if (color) outline = { color, width: 1, style: 'solid' }
    }
    const hasText = child(shape, 'p:txBody') && childrenNamed(child(shape, 'p:txBody'), 'a:p').some((paragraph) => descendants(paragraph, 'a:t').length)
    if (!hasText && (!fill || fill === 'none') && !outline) return ''
    const css = [boxCss(box), geometryCss(geometry, box)]
    if (fill && fill !== 'none') css.push(`background:${fill};`)
    if (outline) css.push(`border:${outline.width}px ${outline.style} ${outline.color};`)
    return `<div style="${css.join('')}">${hasText ? renderTextBody(shape, context, rels) : ''}</div>`
  }

  const renderDecor = (root, part, context) => {
    if (!root) return ''
    const rels = relsOf(part)
    return shapesOf(root).filter((shape) => !placeholderOf(shape)).map((shape) => renderShape(shape, context, rels, null, root)).join('')
  }

  const warnings = []
  const slides = slideParts.map((slidePart, index) => {
    const context = contextFor(slidePart)
    const rels = relsOf(slidePart)
    const background = backgroundOf(context)
    const showMaster = context.layout?.attrs.showMasterSp !== '0' && context.slide?.attrs.showMasterSp !== '0'
    let content = ''
    if (showMaster) content += renderDecor(context.master, context.masterPart, context)
    content += renderDecor(context.layout, context.layoutPart, context)
    for (const shape of shapesOf(context.slide)) {
      try {
        content += renderShape(shape, context, rels, null, context.slide)
      } catch (error) {
        warnings.push(`Folie ${index + 1}: ${error?.message ?? error}`)
      }
    }
    const last = index === slideParts.length - 1
    return `<section class="slide" style="width:${widthPx}px;height:${heightPx}px;background:${background};${last ? '' : 'break-after:page;'}">${content}</section>`
  })

  const css = `@page{size:${widthPx}px ${heightPx}px;margin:0}
html,body{margin:0;padding:0;background:#fff}
body{font-family:Carlito,Calibri,"Liberation Sans",Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.slide{position:relative;overflow:hidden;box-sizing:border-box;break-inside:avoid}
img{display:block}`
  return { html: documentShell({ title, css, body: slides.join('\n') }), slides: slideParts.length, slideSize: { widthPx, heightPx }, warnings }
}

module.exports = { pptxToHtml }
