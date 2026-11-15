// DOCX import: paragraph styles and outline levels ("Heading 1",
// "Überschrift 1", FaNotes' own FN styles) become parts, chapters and
// scenes; runs keep bold, italic, underline, strike, small caps, super/sub,
// colour, highlight, font, size, links and language; footnotes, endnotes and
// comments come along; page breaks and scene-break markers are kept.
import JSZip from 'jszip'
import { FONT_FILES } from '../layout/measure'
import { PAGE_SIZES } from '../model/defaults'
import type { Align, FontFamilyId, Marks, PageSetup, ParagraphStyle, Run, StoryLanguage, StoryManifest } from '../model/types'
import { PART_STYLE, SCENE_TITLE_STYLE, storyStyleId } from '../export/docx'
import { CHAPTER_HEADING, PART_HEADING, SCENE_BREAK, StoryBuilder, normalizeLanguage } from './build'
import { child, childrenNamed, descendants, elements, parseXml, textOf, type XmlNode } from './xml'

type WordStyle = { id: string; name: string; basedOn?: string; type: string; pPr: XmlNode | null; rPr: XmlNode | null; outline?: number }

const mm = (twips: string | undefined) => (twips === undefined ? undefined : Math.round(Number(twips) * 25.4 / 1440 * 10) / 10)
const on = (node: XmlNode | null) => Boolean(node) && !['0', 'false', 'off', 'none'].includes(node!.attrs['w:val'] ?? 'true')
const HIGHLIGHT: Record<string, string> = { yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000' }
const ALIGN: Record<string, Align> = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }

const familyOf = (name: string | undefined): FontFamilyId | undefined => {
  if (!name) return undefined
  const lower = name.toLowerCase()
  for (const [id, entry] of Object.entries(FONT_FILES)) if (lower.includes(entry.name.toLowerCase().split(' ')[0].toLowerCase()) || lower === entry.name.toLowerCase()) return id as FontFamilyId
  if (lower.includes('garamond')) return 'garamond'
  if (lower.includes('courier')) return 'courier'
  return undefined
}

const headingLevel = (name: string) => {
  const match = /^(?:heading|überschrift|titre|título|titolo|kop|nagłówek)\s*(\d)$/iu.exec(name.trim())
  return match ? Number(match[1]) : 0
}

const marksOf = (rPr: XmlNode | null, base: { size: number; color?: string }): Marks => {
  const marks: Marks = {}
  if (!rPr) return marks
  if (on(child(rPr, 'w:b'))) marks.b = true
  if (on(child(rPr, 'w:i'))) marks.i = true
  const underline = child(rPr, 'w:u')
  if (underline && underline.attrs['w:val'] !== 'none') marks.u = true
  if (on(child(rPr, 'w:strike')) || on(child(rPr, 'w:dstrike'))) marks.s = true
  if (on(child(rPr, 'w:smallCaps'))) marks.sc = true
  const vert = child(rPr, 'w:vertAlign')?.attrs['w:val']
  if (vert === 'superscript') marks.sup = true
  if (vert === 'subscript') marks.sub = true
  const rStyle = child(rPr, 'w:rStyle')?.attrs['w:val'] ?? ''
  if (/^(strong|fett)/iu.test(rStyle)) marks.b = true
  if (/^(emphasis|hervorhebung|betont)/iu.test(rStyle)) marks.i = true
  const font = familyOf(child(rPr, 'w:rFonts')?.attrs['w:ascii'] ?? child(rPr, 'w:rFonts')?.attrs['w:hAnsi'])
  if (font) marks.font = font
  const size = child(rPr, 'w:sz')?.attrs['w:val']
  if (size && Number(size) / 2 !== base.size && Number(size) >= 8 && Number(size) <= 288) marks.size = Number(size) / 2
  const color = child(rPr, 'w:color')?.attrs['w:val']
  if (color && /^[0-9a-f]{6}$/iu.test(color) && `#${color.toLowerCase()}` !== base.color?.toLowerCase() && !(color === '000000' && !base.color)) marks.color = `#${color.toLowerCase()}`
  const fill = child(rPr, 'w:shd')?.attrs['w:fill']
  if (fill && /^[0-9a-f]{6}$/iu.test(fill)) marks.hl = `#${fill.toLowerCase()}`
  const highlight = child(rPr, 'w:highlight')?.attrs['w:val']
  if (highlight && HIGHLIGHT[highlight]) marks.hl = HIGHLIGHT[highlight]
  const lang = normalizeLanguage(child(rPr, 'w:lang')?.attrs['w:val'])
  if (lang) marks.lang = lang
  return marks
}

/** A story style from a Word style's properties, on top of the story's own default for that id. */
const styleFrom = (word: WordStyle, base: ParagraphStyle, id: string): ParagraphStyle => {
  const style: ParagraphStyle = { ...base, id }
  const rPr = word.rPr
  const pPr = word.pPr
  const family = familyOf(child(rPr, 'w:rFonts')?.attrs['w:ascii'])
  if (family) style.font = family
  const size = child(rPr, 'w:sz')?.attrs['w:val']
  if (size) style.size = Number(size) / 2
  for (const [tag, key] of [['w:b', 'bold'], ['w:i', 'italic'], ['w:caps', 'uppercase'], ['w:smallCaps', 'smallCaps']] as const) {
    const node = child(rPr, tag)
    if (node) {
      if (on(node)) style[key] = true
      else delete style[key]
    }
  }
  const color = child(rPr, 'w:color')?.attrs['w:val']
  if (color && /^[0-9a-f]{6}$/iu.test(color)) style.color = `#${color.toLowerCase()}`
  const spacing = child(pPr, 'w:spacing')
  if (spacing?.attrs['w:before'] !== undefined) style.spaceBefore = Number(spacing.attrs['w:before']) / 20
  if (spacing?.attrs['w:after'] !== undefined) style.spaceAfter = Number(spacing.attrs['w:after']) / 20
  if (spacing?.attrs['w:line'] && spacing.attrs['w:lineRule'] === 'atLeast') style.lineHeight = Math.round(Number(spacing.attrs['w:line']) / 20 / style.size * 100) / 100
  else if (spacing?.attrs['w:line'] && (spacing.attrs['w:lineRule'] ?? 'auto') === 'auto') style.lineHeight = Math.round(Number(spacing.attrs['w:line']) / 240 * 1.2 * 100) / 100
  const ind = child(pPr, 'w:ind')
  if (ind) {
    style.indentLeft = mm(ind.attrs['w:left'] ?? ind.attrs['w:start']) ?? style.indentLeft
    style.indentRight = mm(ind.attrs['w:right'] ?? ind.attrs['w:end']) ?? style.indentRight
    if (ind.attrs['w:hanging'] !== undefined) style.indentFirst = -(mm(ind.attrs['w:hanging']) ?? 0)
    else if (ind.attrs['w:firstLine'] !== undefined) style.indentFirst = mm(ind.attrs['w:firstLine']) ?? 0
  }
  const jc = child(pPr, 'w:jc')?.attrs['w:val']
  if (jc && ALIGN[jc]) style.align = ALIGN[jc]
  if (child(pPr, 'w:keepNext')) { if (on(child(pPr, 'w:keepNext'))) style.keepWithNext = true; else delete style.keepWithNext }
  if (child(pPr, 'w:pageBreakBefore')) { if (on(child(pPr, 'w:pageBreakBefore'))) style.pageBreakBefore = true; else delete style.pageBreakBefore }
  return style
}

const pageSetupFrom = (sectPr: XmlNode | null, settings: XmlNode | null, odd: boolean, base: PageSetup): PageSetup => {
  if (!sectPr) return base
  const size = child(sectPr, 'w:pgSz')
  const margins = child(sectPr, 'w:pgMar')
  const width = mm(size?.attrs['w:w']) ?? base.width
  const height = mm(size?.attrs['w:h']) ?? base.height
  const named = Object.entries(PAGE_SIZES).find(([, format]) => Math.abs(format.width - width) < 1 && Math.abs(format.height - height) < 1)?.[0] as PageSetup['size'] | undefined
  const start = child(sectPr, 'w:pgNumType')?.attrs['w:start']
  return {
    ...base,
    size: named === 'manuscript' ? 'A4' : named ?? 'custom',
    width,
    height,
    margins: {
      top: Math.abs(mm(margins?.attrs['w:top']) ?? base.margins.top),
      bottom: Math.abs(mm(margins?.attrs['w:bottom']) ?? base.margins.bottom),
      inner: mm(margins?.attrs['w:left']) ?? base.margins.inner,
      outer: mm(margins?.attrs['w:right']) ?? base.margins.outer,
    },
    headerOffset: mm(margins?.attrs['w:header']) ?? base.headerOffset,
    footerOffset: mm(margins?.attrs['w:footer']) ?? base.footerOffset,
    mirror: Boolean(child(settings, 'w:mirrorMargins')) && on(child(settings, 'w:mirrorMargins')),
    hyphenate: on(child(settings, 'w:autoHyphenation')),
    hideOnChapterStart: Boolean(child(sectPr, 'w:titlePg')) || base.hideOnChapterStart,
    chapterStartsRight: odd,
    pageNumberStart: start !== undefined && Number.isFinite(Number(start)) ? Math.max(0, Math.round(Number(start))) : base.pageNumberStart,
  }
}

export const importDocx = async (bytes: Uint8Array, builder: StoryBuilder) => {
  const zip = await JSZip.loadAsync(bytes)
  const read = async (path: string) => {
    const file = zip.file(path)
    return file ? parseXml(await file.async('string')) : null
  }
  const document = await read('word/document.xml')
  if (!document) throw new Error('word/document.xml is missing: not a Word document.')
  const [stylesXml, footnotesXml, endnotesXml, commentsXml, relsXml, coreXml, settingsXml] = await Promise.all(['word/styles.xml', 'word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml', 'word/settings.xml'].map(read))
  const settings = settingsXml ? child(settingsXml, 'w:settings') : null

  // Styles, with outline levels and names resolved through basedOn.
  const styles = new Map<string, WordStyle>()
  for (const node of stylesXml ? descendants(stylesXml, 'w:style') : []) {
    const id = node.attrs['w:styleId']
    if (!id) continue
    const pPr = child(node, 'w:pPr')
    const outline = child(pPr, 'w:outlineLvl')?.attrs['w:val']
    styles.set(id, { id, type: node.attrs['w:type'] ?? 'paragraph', name: child(node, 'w:name')?.attrs['w:val'] ?? id, basedOn: child(node, 'w:basedOn')?.attrs['w:val'], pPr, rPr: child(node, 'w:rPr'), ...(outline !== undefined ? { outline: Number(outline) } : {}) })
  }
  const resolve = <T>(id: string | undefined, pick: (style: WordStyle) => T | undefined): T | undefined => {
    for (let depth = 0, current = id ? styles.get(id) : undefined; current && depth < 12; depth += 1, current = current.basedOn ? styles.get(current.basedOn) : undefined) {
      const value = pick(current)
      if (value !== undefined) return value
    }
    return undefined
  }
  const defaults = stylesXml ? child(child(child(child(stylesXml, 'w:styles'), 'w:docDefaults'), 'w:rPrDefault'), 'w:rPr') : null
  const docLanguage = normalizeLanguage(child(defaults, 'w:lang')?.attrs['w:val'])
  const relations = new Map<string, string>()
  for (const rel of relsXml ? descendants(relsXml, 'Relationship') : []) relations.set(rel.attrs.Id, rel.attrs.Target)
  if (coreXml) {
    const core = elements(coreXml)[0]
    const value = (name: string) => { const node = core ? child(core, name) : null; return node ? textOf(node).trim() : '' }
    builder.title = value('dc:title')
    builder.author = value('dc:creator')
    builder.subtitle = value('dc:subject')
    builder.language = normalizeLanguage(value('dc:language')) ?? docLanguage
  } else builder.language = docLanguage

  // Our own styles: restore their properties into the manifest.
  const ownStyles = [...styles.values()].filter((style) => style.type === 'paragraph' && storyStyleId(style.id))
  const own = ownStyles.length > 0
  builder.firstStyle = !own
  const ownSize = (styleId: string | undefined) => resolve(styleId, (style) => { const size = child(style.rPr, 'w:sz')?.attrs['w:val']; return size ? Number(size) / 2 : undefined })
  const ownColor = (styleId: string | undefined) => resolve(styleId, (style) => { const color = child(style.rPr, 'w:color')?.attrs['w:val']; return color && /^[0-9a-f]{6}$/iu.test(color) ? `#${color.toLowerCase()}` : undefined })
  const defaultSize = Number(child(defaults, 'w:sz')?.attrs['w:val'] ?? 22) / 2

  const notesById = new Map<string, XmlNode>()
  for (const node of [...(footnotesXml ? descendants(footnotesXml, 'w:footnote') : []), ...(endnotesXml ? descendants(endnotesXml, 'w:endnote') : [])]) if (!node.attrs['w:type'] || node.attrs['w:type'] === 'normal') notesById.set(`${node.name}:${node.attrs['w:id']}`, node)
  const commentsById = new Map<string, XmlNode>()
  for (const node of commentsXml ? descendants(commentsXml, 'w:comment') : []) commentsById.set(node.attrs['w:id'], node)
  const commentIds = new Map<string, string>()
  const patchStyles = new Map<string, WordStyle>()
  const dropCapLines = new Map<string, number>()

  type Collected = { runs: Run[]; breaks: number[] }
  const activeComments: string[] = []
  /** Runs of a paragraph-like node; page breaks are recorded as offsets. */
  const collect = (node: XmlNode, base: { size: number; color?: string }, out: Collected, link: string | null, inNote: boolean, field: { state: 'none' | 'instr' | 'result'; link: string | null }) => {
    for (const entry of elements(node)) {
      const name = entry.name
      if (name === 'w:r') {
        const rPr = child(entry, 'w:rPr')
        const marks = marksOf(rPr, base)
        if (/^(hyperlink|internetlink|internet link)/iu.test(child(rPr, 'w:rStyle')?.attrs['w:val'] ?? '') && (link || field.link)) { delete marks.u; delete marks.color }
        const activeLink = link ?? (field.state === 'result' ? field.link : null)
        if (activeLink) marks.link = activeLink
        if (!inNote && activeComments.length) marks.cm = activeComments[activeComments.length - 1]
        let text = ''
        const flush = () => {
          if (text) out.runs.push({ text, ...(Object.keys(marks).length ? { m: { ...marks } } : {}) })
          text = ''
        }
        for (const part of elements(entry)) {
          if (part.name === 'w:fldChar') {
            const type = part.attrs['w:fldCharType']
            flush()
            field.state = type === 'begin' ? 'instr' : type === 'separate' ? 'result' : 'none'
            if (type === 'begin') field.link = null
            if (type === 'end') field.link = null
          } else if (part.name === 'w:instrText') {
            const match = /HYPERLINK\s+"([^"]+)"/u.exec(textOf(part))
            if (match && /^(https?:|mailto:)/iu.test(match[1])) field.link = match[1]
          } else if (field.state === 'instr') continue
          else if (part.name === 'w:t') text += textOf(part)
          else if (part.name === 'w:tab') text += '\t'
          else if (part.name === 'w:br' || part.name === 'w:cr') {
            if (part.attrs['w:type'] === 'page') {
              flush()
              out.breaks.push(out.runs.reduce((sum, run) => sum + run.text.length, 0))
            } else if (part.attrs['w:type'] !== 'column') text += '\n'
          } else if (part.name === 'w:softHyphen') text += '­'
          else if (part.name === 'w:noBreakHyphen') text += '‑'
          else if ((part.name === 'w:footnoteReference' || part.name === 'w:endnoteReference') && !inNote) {
            flush()
            const note = notesById.get(`${part.name === 'w:footnoteReference' ? 'w:footnote' : 'w:endnote'}:${part.attrs['w:id']}`)
            if (note) {
              const noteRuns: Collected = { runs: [], breaks: [] }
              childrenNamed(note, 'w:p').forEach((paragraph, index) => {
                if (index > 0) noteRuns.runs.push({ text: '\n' })
                collect(paragraph, { size: defaultSize }, noteRuns, null, true, { state: 'none', link: null })
              })
              const first = noteRuns.runs[0]
              if (first) first.text = first.text.replace(/^\s+/u, '')
              const id = builder.footnote(noteRuns.runs.map((run) => (run.m?.sup ? { text: run.text, m: { ...run.m } } : run)).filter((run) => run.text))
              out.runs.push({ text: '', m: { fn: id } })
            }
          }
        }
        flush()
      } else if (name === 'w:hyperlink') {
        const target = entry.attrs['r:id'] ? relations.get(entry.attrs['r:id']) : undefined
        collect(entry, base, out, target && /^(https?:|mailto:)/iu.test(target) ? target : link, inNote, field)
      } else if (name === 'w:commentRangeStart' && !inNote) {
        const wordId = entry.attrs['w:id']
        const comment = commentsById.get(wordId)
        if (comment) {
          let id = commentIds.get(wordId)
          if (!id) {
            id = builder.comment({ author: comment.attrs['w:author'] ?? '', at: comment.attrs['w:date'] ?? '', text: childrenNamed(comment, 'w:p').map((paragraph) => descendants(paragraph, 'w:t').map(textOf).join('')).join('\n') })
            commentIds.set(wordId, id)
          }
          activeComments.push(id)
        }
      } else if (name === 'w:commentRangeEnd' && !inNote) {
        const id = commentIds.get(entry.attrs['w:id'])
        const at = id ? activeComments.lastIndexOf(id) : -1
        if (at >= 0) activeComments.splice(at, 1)
      } else if (name === 'w:ins' || name === 'w:smartTag' || name === 'w:sdt' || name === 'w:sdtContent' || name === 'w:fldSimple' || name === 'w:customXml') {
        collect(entry, base, out, link, inNote, field)
      }
    }
  }

  const body = child(child(document, 'w:document'), 'w:body')
  const paragraphs = body ? [...descendants(body, 'w:p')] : []
  const sections = body ? descendants(body, 'w:sectPr') : []
  const finalSection = body ? child(body, 'w:sectPr') : null
  const oddSections = sections.some((section) => child(section, 'w:type')?.attrs['w:val'] === 'oddPage')
  // Without any heading, plain-text chapter titles ("Kapitel 3") are used.
  const anyHeading = paragraphs.some((paragraph) => {
    const styleId = child(child(paragraph, 'w:pPr'), 'w:pStyle')?.attrs['w:val']
    const name = styleId ? styles.get(styleId)?.name ?? styleId : ''
    return headingLevel(name) > 0 || resolve(styleId, (style) => style.outline) !== undefined || child(child(paragraph, 'w:pPr'), 'w:outlineLvl')
  })

  let pendingBreak = false
  let dropCap: Run[] = []
  for (const paragraph of paragraphs) {
    const pPr = child(paragraph, 'w:pPr')
    const styleId = child(pPr, 'w:pStyle')?.attrs['w:val']
    const styleName = styleId ? styles.get(styleId)?.name ?? styleId : ''
    const story = styleId ? storyStyleId(styleId) : null
    const size = ownSize(styleId) ?? defaultSize
    const collected: Collected = { runs: [], breaks: [] }
    collect(paragraph, { size, color: ownColor(styleId) }, collected, null, false, { state: 'none', link: null })
    const frame = child(pPr, 'w:framePr')
    if (frame?.attrs['w:dropCap'] && frame.attrs['w:dropCap'] !== 'none') {
      dropCap = collected.runs.map((run) => ({ text: run.text }))
      if (story) dropCapLines.set(story, Math.max(2, Math.min(6, Number(frame.attrs['w:lines'] ?? 3))))
      continue
    }
    let runs = [...dropCap, ...collected.runs]
    dropCap = []
    const text = runs.map((run) => run.text).join('').trim()
    const outline = child(pPr, 'w:outlineLvl')?.attrs['w:val'] ?? resolve(styleId, (style) => style.outline)
    const level = headingLevel(styleName) || (outline !== undefined && Number(outline) < 9 ? Number(outline) + 1 : 0)
    const breakHere = pendingBreak || on(child(pPr, 'w:pageBreakBefore')) && !(story && styles.get(styleId!) && child(styles.get(styleId!)!.pPr, 'w:pageBreakBefore'))
    pendingBreak = false
    if (child(pPr, 'w:sectPr')) pendingBreak = true

    // Structure.
    if (styleId === PART_STYLE) { builder.addPart(text); continue }
    if (styleId === SCENE_TITLE_STYLE) { builder.addScene(text); continue }
    if (story === 'chapter') { builder.addChapter(text); continue }
    if (story === 'scenebreak' || (!story && SCENE_BREAK.test(text) && text)) { builder.sceneBreak(); continue }
    if (/^(title|titel)$/iu.test(styleName) && !builder.title) { builder.title = text; continue }
    if (/^(subtitle|untertitel)$/iu.test(styleName)) { builder.subtitle = builder.subtitle || text; continue }
    if (!story && text && (level === 1 || (!anyHeading && text.length <= 80 && CHAPTER_HEADING.test(text)))) {
      if (PART_HEADING.test(text) && !anyHeading) builder.addPart(text)
      else builder.addChapter(text)
      continue
    }
    if (!story && level === 2 && text) { builder.addScene(text); continue }

    const style = story ?? (level === 3 ? 'heading' : level >= 4 ? 'subheading' : /quote|zitat|citation/iu.test(styleName) ? 'quote' : child(pPr, 'w:numPr') || /list|aufzählung|liste/iu.test(styleName) ? 'list' : 'body')
    if (story && !patchStyles.has(story)) {
      const word = styles.get(styleId!)
      if (word) patchStyles.set(story, word)
    }
    const jc = child(pPr, 'w:jc')?.attrs['w:val']
    const styleJc = resolve(styleId, (entry) => child(entry.pPr, 'w:jc')?.attrs['w:val'])
    const align = jc && jc !== styleJc && ALIGN[jc] ? ALIGN[jc] : undefined
    // One language for the whole paragraph moves to the paragraph.
    const langs = new Set(runs.filter((run) => run.text.trim()).map((run) => run.m?.lang ?? builder.language ?? null))
    const paragraphLang = normalizeLanguage(child(child(pPr, 'w:rPr'), 'w:lang')?.attrs['w:val']) ?? (langs.size === 1 ? [...langs][0] : null)
    let lang: StoryLanguage | undefined
    if (paragraphLang && paragraphLang !== builder.language) {
      lang = paragraphLang
      runs = runs.map((run) => (run.m?.lang === paragraphLang ? { text: run.text, ...(Object.keys(run.m).length > 1 ? { m: (({ lang: _lang, ...rest }) => rest)(run.m) } : {}) } : run))
    } else runs = runs.map((run) => (run.m?.lang && run.m.lang === builder.language ? { text: run.text, ...(Object.keys(run.m).length > 1 ? { m: (({ lang: _lang, ...rest }) => rest)(run.m) } : {}) } : run))
    // Page breaks inside the paragraph split it.
    const pieces: Run[][] = []
    let rest = runs
    let consumed = 0
    for (const at of collected.breaks) {
      const local = at + dropCapLength(runs, collected.runs) - consumed
      const [head, tail] = splitRuns(rest, local)
      pieces.push(head)
      rest = tail
      consumed += local
    }
    pieces.push(rest)
    pieces.forEach((part, index) => {
      if (index > 0 || breakHere) builder.pageBreak()
      if (pieces.length > 1 && !part.some((run) => run.text || run.m?.fn)) return
      builder.paragraph({ style, runs: part, ...(align ? { align } : {}), ...(lang ? { lang } : {}) })
    })
  }

  const base = builder.patchManifest
  builder.patchManifest = (manifest: StoryManifest) => {
    const next = base(manifest)
    const stylesOut = { ...next.styles }
    for (const [id, word] of patchStyles) stylesOut[id] = styleFrom(word, stylesOut[id] ?? { ...stylesOut.body, name: { de: word.name, en: word.name } }, id)
    for (const [id, lines] of dropCapLines) if (stylesOut[id]) stylesOut[id] = { ...stylesOut[id], dropCap: lines }
    if (styles.get('FNchapter')) stylesOut.chapter = styleFrom(styles.get('FNchapter')!, stylesOut.chapter, 'chapter')
    const part = styles.get(PART_STYLE)
    if (part && child(part.rPr, 'w:sz')) stylesOut.part = styleFrom(part, { ...stylesOut.chapter, name: { de: 'Teiltitel', en: 'Part title' } }, 'part')
    return { ...next, styles: stylesOut, page: own || finalSection ? pageSetupFrom(finalSection, settings, oddSections, next.page) : next.page }
  }
}

const dropCapLength = (all: Run[], collected: Run[]) => all.reduce((sum, run) => sum + run.text.length, 0) - collected.reduce((sum, run) => sum + run.text.length, 0)

const splitRuns = (runs: Run[], at: number): [Run[], Run[]] => {
  const head: Run[] = []
  const tail: Run[] = []
  let position = 0
  for (const run of runs) {
    const end = position + run.text.length
    if (end <= at) head.push(run)
    else if (position >= at) tail.push(run)
    else {
      head.push({ ...run, text: run.text.slice(0, at - position) })
      tail.push({ ...run, text: run.text.slice(at - position) })
    }
    position = end
  }
  return [head, tail]
}
