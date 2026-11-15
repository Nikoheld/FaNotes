// DOCX export (OOXML written by hand, zipped with JSZip). Every paragraph
// style becomes a Word paragraph style (`FN<id>`), runs keep their marks,
// footnotes go to footnotes.xml (or endnotes.xml), comments to comments.xml.
// Each chapter is a section, so it starts on a new page (an odd page when
// chapters start on the right), and headers/footers use PAGE, NUMPAGES and
// STYLEREF fields. Element order follows the OOXML schema, which Word checks.
import JSZip from 'jszip'
import { FONT_FILES } from '../layout/measure'
import type { FlowBlock } from '../model/flow'
import type { Marks, PageSetup, ParagraphStyle, Run, StoryLanguage } from '../model/types'
import { sceneStarts, titleKind, xmlEscape as esc, type NotesPlacement, type Prepared } from './prepare'

export type DocxInput = {
  prepared: Prepared
  notes?: NotesPlacement
  /** Scene titles from the binder as headings (style FNscenetitle) instead of scene-break markers. */
  sceneTitles?: boolean
  comments?: boolean
  now?: Date
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const twips = (mm: number) => Math.round(mm * 1440 / 25.4)
const half = (pt: number) => Math.round(pt * 2)
const twentieths = (pt: number) => Math.round(pt * 20)
const hex = (color: string) => color.replace('#', '').toUpperCase()

/** Word style id of a story style id (ids are [a-z0-9-]; '-' becomes '_', so it maps back). */
export const docxStyleId = (id: string) => `FN${id.replace(/-/gu, '_')}`
export const storyStyleId = (styleId: string) => (/^FN[a-z0-9_]+$/u.test(styleId) ? styleId.slice(2).replace(/_/gu, '-') : null)
export const PART_STYLE = 'FNpart'
export const SCENE_TITLE_STYLE = 'FNscenetitle'

const BUILT_IN_NAMES = new Set(['normal', 'title', 'subtitle', 'quote', 'list', 'heading', 'body text', 'header', 'footer', 'caption', 'emphasis', 'strong', 'block text', 'list bullet', 'list paragraph', 'intense quote', 'footnote text', 'endnote text', 'comment text', 'no spacing', 'signature', 'salutation', 'closing', 'date', 'note heading', 'plain text', 'toc heading', 'hyperlink'])
const styleDisplayName = (style: ParagraphStyle, english: boolean) => {
  const name = english ? style.name.en : style.name.de
  return BUILT_IN_NAMES.has(name.toLocaleLowerCase('en-US')) ? `${name} (FaNotes)` : name
}

const alignValue = { left: 'left', center: 'center', right: 'right', justify: 'both' } as const

const fontXml = (family: keyof typeof FONT_FILES) => {
  const name = esc(FONT_FILES[family].name)
  return `<w:rFonts w:ascii="${name}" w:hAnsi="${name}" w:cs="${name}" w:eastAsia="${name}"/>`
}

const styleRunProps = (style: ParagraphStyle) => [
  fontXml(style.font),
  `<w:b w:val="${style.bold ? 1 : 0}"/><w:bCs w:val="${style.bold ? 1 : 0}"/>`,
  `<w:i w:val="${style.italic ? 1 : 0}"/><w:iCs w:val="${style.italic ? 1 : 0}"/>`,
  `<w:caps w:val="${style.uppercase ? 1 : 0}"/>`,
  `<w:smallCaps w:val="${style.smallCaps ? 1 : 0}"/>`,
  style.color ? `<w:color w:val="${hex(style.color)}"/>` : '',
  `<w:sz w:val="${half(style.size)}"/><w:szCs w:val="${half(style.size)}"/>`,
].join('')

const indentXml = (style: ParagraphStyle, firstLine?: number) => {
  const first = firstLine ?? style.indentFirst
  const lead = first < 0 ? `w:hanging="${twips(-first)}"` : `w:firstLine="${twips(first)}"`
  return `<w:ind w:left="${twips(style.indentLeft)}" w:right="${twips(style.indentRight)}" ${lead}/>`
}

const stylePara = (style: ParagraphStyle, options: { chapterStart: boolean; outline: number | null; list: boolean }) => [
  style.keepWithNext ? '<w:keepNext/>' : '',
  // A chapter title starts a section (a new page already); a page break as well would leave a blank page.
  style.pageBreakBefore && !options.chapterStart ? '<w:pageBreakBefore/>' : '',
  options.list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : '',
  `<w:spacing w:before="${twentieths(style.spaceBefore)}" w:after="${twentieths(style.spaceAfter)}" w:line="${twentieths(style.size * style.lineHeight)}" w:lineRule="atLeast"/>`,
  indentXml(style),
  `<w:jc w:val="${alignValue[style.align]}"/>`,
  options.outline !== null ? `<w:outlineLvl w:val="${options.outline}"/>` : '',
].join('')

type Ctx = {
  prepared: Prepared
  english: boolean
  language: StoryLanguage
  endnotes: boolean
  /** Footnote id → Word note id (assigned in reading order). */
  noteIds: Map<string, number>
  comments: boolean
  /** Comment id → Word comment id. */
  commentIds: Map<string, number>
  /** Comment id → [block index, run index] of its first and last run. */
  commentSpan: Map<string, { first: string; last: string }>
  relationships: Array<{ id: string; type: string; target: string; external?: boolean }>
  links: Map<string, string>
}

const textXml = (text: string) => {
  let out = ''
  let buffer = ''
  const flush = () => {
    if (buffer) out += `<w:t xml:space="preserve">${esc(buffer)}</w:t>`
    buffer = ''
  }
  for (const char of text) {
    if (char === '\n') { flush(); out += '<w:br/>' } else if (char === '\t') { flush(); out += '<w:tab/>' } else if (char === '­') { flush(); out += '<w:softHyphen/>' } else if (char === '‑') { flush(); out += '<w:noBreakHyphen/>' } else buffer += char
  }
  flush()
  return out
}

const runProps = (marks: Marks | undefined, lang: StoryLanguage | undefined, defaultLang: StoryLanguage, rStyle?: string) => {
  const parts = [
    rStyle ? `<w:rStyle w:val="${rStyle}"/>` : '',
    marks?.font ? fontXml(marks.font) : '',
    marks?.b ? '<w:b/><w:bCs/>' : '',
    marks?.i ? '<w:i/><w:iCs/>' : '',
    marks?.sc ? '<w:smallCaps/>' : '',
    marks?.s ? '<w:strike/>' : '',
    marks?.color ? `<w:color w:val="${hex(marks.color)}"/>` : '',
    marks?.size ? `<w:sz w:val="${half(marks.size)}"/><w:szCs w:val="${half(marks.size)}"/>` : '',
    marks?.u ? '<w:u w:val="single"/>' : '',
    marks?.hl ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(marks.hl)}"/>` : '',
    marks?.sup ? '<w:vertAlign w:val="superscript"/>' : marks?.sub ? '<w:vertAlign w:val="subscript"/>' : '',
    lang && lang !== defaultLang ? `<w:lang w:val="${lang}"/>` : '',
  ].join('')
  return parts ? `<w:rPr>${parts}</w:rPr>` : ''
}

const runsXml = (ctx: Ctx, runs: Run[], blockIndex: number, lang: StoryLanguage | undefined, inNote = false) => {
  let out = ''
  let openLink: string | null = null
  const closeLink = () => {
    if (openLink) out += '</w:hyperlink>'
    openLink = null
  }
  runs.forEach((run, runIndex) => {
    const marks = run.m
    const position = `${blockIndex}:${runIndex}`
    // Notes are separate parts with their own relationships: links in them stay plain text.
    const link = inNote ? null : marks?.link ?? null
    if (link !== openLink) {
      closeLink()
      if (link) {
        let id = ctx.links.get(link)
        if (!id) {
          id = `rIdL${ctx.links.size + 1}`
          ctx.links.set(link, id)
          ctx.relationships.push({ id, type: `${REL}/hyperlink`, target: link, external: true })
        }
        out += `<w:hyperlink r:id="${id}" w:history="1">`
        openLink = link
      }
    }
    const comment = ctx.comments && !inNote && marks?.cm ? ctx.commentSpan.get(marks.cm) : undefined
    const commentId = marks?.cm ? ctx.commentIds.get(marks.cm) : undefined
    if (comment && commentId !== undefined && comment.first === position) out += `<w:commentRangeStart w:id="${commentId}"/>`
    const runLang = marks?.lang ?? lang
    const { fn: _fn, cm: _cm, link: _link, lang: _lang, ...visible } = marks ?? {}
    if (run.text) out += `<w:r>${runProps(visible, runLang, ctx.language, link ? 'Hyperlink' : undefined)}${textXml(run.text)}</w:r>`
    if (marks?.fn && !inNote) {
      let id = ctx.noteIds.get(marks.fn)
      if (id === undefined) {
        id = ctx.noteIds.size + 1
        ctx.noteIds.set(marks.fn, id)
      }
      const kind = ctx.endnotes ? 'endnote' : 'footnote'
      out += `<w:r><w:rPr><w:rStyle w:val="${ctx.endnotes ? 'EndnoteReference' : 'FootnoteReference'}"/></w:rPr><w:${kind}Reference w:id="${id}"/></w:r>`
    }
    if (comment && commentId !== undefined && comment.last === position) {
      closeLink()
      out += `<w:commentRangeEnd w:id="${commentId}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${commentId}"/></w:r>`
    }
  })
  closeLink()
  return out
}

type Part = { left: string; center: string; right: string }

const fieldXml = (instr: string, fallback: string) => `<w:fldSimple w:instr=" ${esc(instr)} "><w:r><w:t xml:space="preserve">${esc(fallback)}</w:t></w:r></w:fldSimple>`

const templateXml = (template: string, values: Record<string, string>, chapterStyleName: string) => {
  let out = ''
  let rest = template
  const pattern = /\{(title|chapter|page|pages|author|subtitle)\}/u
  while (rest) {
    const match = pattern.exec(rest)
    const text = match ? rest.slice(0, match.index) : rest
    if (text) out += `<w:r>${textXml(text)}</w:r>`
    if (!match) break
    const name = match[1]
    if (name === 'page') out += fieldXml('PAGE', '1')
    else if (name === 'pages') out += fieldXml('NUMPAGES', '1')
    else if (name === 'chapter') out += fieldXml(`STYLEREF "${chapterStyleName.replace(/"/gu, '')}"`, '')
    else if (values[name]) out += `<w:r>${textXml(values[name])}</w:r>`
    rest = rest.slice(match.index + match[0].length)
  }
  return out
}

const headerFooterXml = (kind: 'hdr' | 'ftr', part: Part, values: Record<string, string>, chapterStyleName: string, contentTwips: number) => {
  const style = kind === 'hdr' ? 'Header' : 'Footer'
  const body = [
    templateXml(part.left, values, chapterStyleName),
    '<w:r><w:tab/></w:r>',
    templateXml(part.center, values, chapterStyleName),
    '<w:r><w:tab/></w:r>',
    templateXml(part.right, values, chapterStyleName),
  ].join('')
  const empty = !part.left && !part.center && !part.right
  return `${XML_HEAD}<w:${kind} xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:p><w:pPr><w:pStyle w:val="${style}"/><w:tabs><w:tab w:val="center" w:pos="${Math.round(contentTwips / 2)}"/><w:tab w:val="right" w:pos="${contentTwips}"/></w:tabs></w:pPr>${empty ? '' : body}</w:p></w:${kind}>`
}

export const writeDocx = async (input: DocxInput): Promise<Uint8Array> => {
  const { prepared } = input
  const manifest = prepared.manifest
  const setup: PageSetup = manifest.page
  const english = manifest.language.startsWith('en')
  const flow = prepared.flow
  const notes = input.notes ?? 'footnotes'
  const endnotes = notes !== 'footnotes'
  const ctx: Ctx = {
    prepared,
    english,
    language: manifest.language,
    endnotes,
    noteIds: new Map(),
    comments: input.comments ?? true,
    commentIds: new Map(),
    commentSpan: new Map(),
    relationships: [],
    links: new Map(),
  }
  flow.forEach((block, blockIndex) => block.runs.forEach((run, runIndex) => {
    const id = run.m?.cm
    if (!id || !prepared.comments.has(id)) return
    const position = `${blockIndex}:${runIndex}`
    const span = ctx.commentSpan.get(id)
    if (span) span.last = position
    else {
      ctx.commentSpan.set(id, { first: position, last: position })
      ctx.commentIds.set(id, ctx.commentIds.size)
    }
  }))

  const styles = manifest.styles
  const body = styles.body
  const chapterStyle = styles.chapter ?? body
  const usedStyles = new Set(flow.map((block) => block.style))
  const listStyles = new Set(Object.values(styles).filter((style) => style.listMarker).map((style) => style.id))
  const listMarker = Object.values(styles).find((style) => style.listMarker)?.listMarker ?? '•'
  const partOffset = prepared.hasParts ? 1 : 0
  const chapterStartStyles = new Set(flow.filter((block) => block.chapterStart).map((block) => block.style))
  const outlineFor = (style: ParagraphStyle) => (style.outlineLevel ? style.outlineLevel - 1 + partOffset + (style.outlineLevel > 1 && input.sceneTitles ? 1 : 0) : null)

  // ── styles.xml ─────────────────────────────────────────────────────────
  const styleXml: string[] = []
  for (const style of Object.values(styles)) {
    styleXml.push(`<w:style w:type="paragraph" w:customStyle="1" w:styleId="${docxStyleId(style.id)}"><w:name w:val="${esc(styleDisplayName(style, english))}"/><w:basedOn w:val="Normal"/>${style.next && styles[style.next] ? `<w:next w:val="${docxStyleId(style.next)}"/>` : ''}${usedStyles.has(style.id) ? '<w:qFormat/>' : ''}<w:pPr>${stylePara(style, { chapterStart: chapterStartStyles.has(style.id), outline: outlineFor(style), list: listStyles.has(style.id) })}</w:pPr><w:rPr>${styleRunProps(style)}</w:rPr></w:style>`)
  }
  // Part titles: the part style if the story has one, else the chapter style one outline level up.
  if (styles.part) {
    styleXml.push(`<w:style w:type="paragraph" w:customStyle="1" w:styleId="${PART_STYLE}"><w:name w:val="${esc(english ? 'Part title' : 'Teiltitel')}"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>${stylePara(styles.part, { chapterStart: true, outline: 0, list: false })}</w:pPr><w:rPr>${styleRunProps(styles.part)}</w:rPr></w:style>`)
  } else {
    styleXml.push(`<w:style w:type="paragraph" w:customStyle="1" w:styleId="${PART_STYLE}"><w:name w:val="${esc(english ? 'Part title' : 'Teiltitel')}"/><w:basedOn w:val="${docxStyleId(chapterStyle.id)}"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>`)
  }
  const heading = styles.heading ?? body
  styleXml.push(`<w:style w:type="paragraph" w:customStyle="1" w:styleId="${SCENE_TITLE_STYLE}"><w:name w:val="${esc(english ? 'Scene title' : 'Szenentitel')}"/><w:basedOn w:val="${docxStyleId(heading.id)}"/><w:next w:val="${docxStyleId(styles.first ? 'first' : body.id)}"/><w:pPr><w:outlineLvl w:val="${1 + partOffset}"/></w:pPr></w:style>`)
  const noteStyle = styles.footnote ?? { ...body, size: Math.max(7, body.size - 2), lineHeight: 1.3, indentFirst: 0, spaceBefore: 0, spaceAfter: 2, align: 'left' as const }
  const notePara = `<w:pPr><w:spacing w:before="0" w:after="${twentieths(noteStyle.spaceAfter)}" w:line="${twentieths(noteStyle.size * noteStyle.lineHeight)}" w:lineRule="atLeast"/><w:ind w:left="0" w:right="0" w:firstLine="0"/><w:jc w:val="${alignValue[noteStyle.align]}"/></w:pPr><w:rPr>${fontXml(noteStyle.font)}<w:sz w:val="${half(noteStyle.size)}"/><w:szCs w:val="${half(noteStyle.size)}"/></w:rPr>`
  const stylesXml = `${XML_HEAD}<w:styles xmlns:w="${W_NS}" xmlns:r="${R_NS}">`
    + `<w:docDefaults><w:rPrDefault><w:rPr>${fontXml(body.font)}<w:sz w:val="${half(body.size)}"/><w:szCs w:val="${half(body.size)}"/><w:lang w:val="${manifest.language}" w:eastAsia="${manifest.language}" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl/></w:pPr></w:style>'
    + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
    + styleXml.join('')
    + `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/>${notePara}</w:style>`
    + '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
    + `<w:style w:type="paragraph" w:styleId="EndnoteText"><w:name w:val="endnote text"/><w:basedOn w:val="Normal"/>${notePara}</w:style>`
    + '<w:style w:type="character" w:styleId="EndnoteReference"><w:name w:val="endnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
    + `<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="left"/></w:pPr><w:rPr>${fontXml('literata')}<w:color w:val="73716E"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="left"/></w:pPr><w:rPr>${fontXml('literata')}<w:color w:val="73716E"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>`
    + '</w:styles>'

  // ── document.xml ───────────────────────────────────────────────────────
  const contentTwips = twips(setup.width - setup.margins.inner - setup.margins.outer)
  const headerParts = { default: 'rIdH1', even: 'rIdH2', first: 'rIdH3' }
  const footerParts = { default: 'rIdF1', even: 'rIdF2', first: 'rIdF3' }
  const sectPr = (index: number, oddStart: boolean) => [
    '<w:sectPr>',
    `<w:headerReference w:type="default" r:id="${headerParts.default}"/>`,
    setup.mirror ? `<w:headerReference w:type="even" r:id="${headerParts.even}"/>` : '',
    setup.hideOnChapterStart ? `<w:headerReference w:type="first" r:id="${headerParts.first}"/>` : '',
    `<w:footerReference w:type="default" r:id="${footerParts.default}"/>`,
    setup.mirror ? `<w:footerReference w:type="even" r:id="${footerParts.even}"/>` : '',
    setup.hideOnChapterStart ? `<w:footerReference w:type="first" r:id="${footerParts.first}"/>` : '',
    notes === 'endnotes-chapter' ? '<w:endnotePr><w:pos w:val="sectEnd"/><w:numRestart w:val="eachSect"/></w:endnotePr>' : '',
    `<w:type w:val="${oddStart ? 'oddPage' : 'nextPage'}"/>`,
    `<w:pgSz w:w="${twips(setup.width)}" w:h="${twips(setup.height)}"${setup.width > setup.height ? ' w:orient="landscape"' : ''}/>`,
    `<w:pgMar w:top="${twips(setup.margins.top)}" w:right="${twips(setup.margins.outer)}" w:bottom="${twips(setup.margins.bottom)}" w:left="${twips(setup.margins.inner)}" w:header="${twips(setup.headerOffset)}" w:footer="${twips(setup.footerOffset)}" w:gutter="0"/>`,
    index === 0 ? `<w:pgNumType w:start="${setup.pageNumberStart}"/>` : '',
    setup.hideOnChapterStart ? '<w:titlePg/>' : '',
    '</w:sectPr>',
  ].join('')

  const starts = input.sceneTitles ? sceneStarts(prepared) : new Map()
  const paragraphs: string[] = []
  let section = 0
  let sectionHasContent = false
  let sectionOdd = false
  const paragraphXml = (block: FlowBlock, blockIndex: number, styleId: string, extraPPr = '') => {
    const style = styles[block.style] ?? body
    const lang = block.lang
    const pPr = [
      `<w:pStyle w:val="${styleId}"/>`,
      block.breakBefore === 'page' && !block.chapterStart ? '<w:pageBreakBefore/>' : '',
      block.afterBreak && style.indentFirst > 0 ? indentXml(style, 0) : '',
      block.align ? `<w:jc w:val="${alignValue[block.align]}"/>` : '',
      extraPPr,
      lang && lang !== manifest.language ? `<w:rPr><w:lang w:val="${lang}"/></w:rPr>` : '',
    ].join('')
    // A drop cap is a Word drop-cap frame holding the first letter, then the paragraph without it.
    const plainText = block.runs.map((run) => run.text).join('')
    const cap = block.afterBreak && (style.dropCap ?? 0) > 1 && !block.runs[0]?.m ? /^[„“"«‹‚'(]*[\p{L}\p{N}]/u.exec(plainText)?.[0] : undefined
    if (cap && block.runs[0].text.length >= cap.length) {
      const lines = style.dropCap!
      const capSize = half(style.size * style.lineHeight * lines * 0.8)
      const frame = `<w:p><w:pPr><w:pStyle w:val="${styleId}"/><w:keepNext/><w:framePr w:dropCap="drop" w:lines="${lines}" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/><w:spacing w:before="0" w:after="0" w:line="${twentieths(style.size * style.lineHeight * lines)}" w:lineRule="exact"/><w:ind w:left="0" w:right="0" w:firstLine="0"/><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:b w:val="0"/><w:bCs w:val="0"/><w:sz w:val="${capSize}"/><w:szCs w:val="${capSize}"/></w:rPr>${textXml(cap)}</w:r></w:p>`
      const rest = [{ ...block.runs[0], text: block.runs[0].text.slice(cap.length) }, ...block.runs.slice(1)]
      return `${frame}<w:p><w:pPr>${pPr}</w:pPr>${runsXml(ctx, rest, blockIndex, lang)}</w:p>`
    }
    return `<w:p><w:pPr>${pPr}</w:pPr>${runsXml(ctx, block.runs, blockIndex, lang)}</w:p>`
  }
  flow.forEach((block, blockIndex) => {
    if (block.chapterStart && sectionHasContent) {
      // The section ends with the paragraph before this one: its sectPr goes into that paragraph.
      const last = paragraphs.pop()!
      paragraphs.push(last.replace(/<\/w:pPr>/u, `${sectPr(section, sectionOdd)}</w:pPr>`))
      section += 1
      sectionOdd = setup.chapterStartsRight
      sectionHasContent = false
    }
    const scene = starts.get(blockIndex)
    if (scene && input.sceneTitles) {
      paragraphs.push(`<w:p><w:pPr><w:pStyle w:val="${SCENE_TITLE_STYLE}"/></w:pPr><w:r>${textXml(scene.title)}</w:r></w:p>`)
      sectionHasContent = true
      if (block.ref.kind === 'break') return
    }
    const kind = titleKind(prepared, block)
    const styleId = kind === 'part' ? PART_STYLE : docxStyleId(styles[block.style] ? block.style : body.id)
    paragraphs.push(paragraphXml(block, blockIndex, styleId))
    sectionHasContent = true
  })
  if (!paragraphs.length) paragraphs.push('<w:p/>')
  const documentXml = `${XML_HEAD}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${paragraphs.join('')}${sectPr(section, sectionOdd)}</w:body></w:document>`

  // ── notes and comments ─────────────────────────────────────────────────
  const noteKind = endnotes ? 'endnote' : 'footnote'
  const separators = `<w:${noteKind} w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:${noteKind}><w:${noteKind} w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:${noteKind}>`
  const noteEntries = [...ctx.noteIds.entries()].map(([id, wordId]) => {
    const runs = prepared.footnotes.get(id)?.runs ?? []
    const refStyle = endnotes ? 'EndnoteReference' : 'FootnoteReference'
    return `<w:${noteKind} w:id="${wordId}"><w:p><w:pPr><w:pStyle w:val="${endnotes ? 'EndnoteText' : 'FootnoteText'}"/></w:pPr><w:r><w:rPr><w:rStyle w:val="${refStyle}"/></w:rPr><w:${noteKind}Ref/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>${runsXml(ctx, runs, -1, undefined, true)}</w:p></w:${noteKind}>`
  })
  const notesXml = `${XML_HEAD}<w:${noteKind}s xmlns:w="${W_NS}" xmlns:r="${R_NS}">${separators}${noteEntries.join('')}</w:${noteKind}s>`
  const commentEntries = ctx.comments ? [...ctx.commentIds.entries()].map(([id, wordId]) => {
    const comment = prepared.comments.get(id)!
    const author = comment.author || 'FaNotes'
    const initials = author.split(/\s+/u).map((word) => word[0] ?? '').join('').slice(0, 4)
    const date = /^\d{4}-\d{2}-\d{2}T/u.test(comment.at) ? ` w:date="${esc(comment.at.replace(/\.\d+Z$/u, 'Z'))}"` : ''
    const paragraphsXml = comment.text.split('\n').map((line, index) => `<w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>${index === 0 ? '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' : ''}<w:r>${textXml(line)}</w:r></w:p>`).join('')
    return `<w:comment w:id="${wordId}" w:author="${esc(author)}"${date} w:initials="${esc(initials)}">${paragraphsXml}</w:comment>`
  }) : []

  // ── headers and footers ───────────────────────────────────────────────
  const values = { title: manifest.title, subtitle: manifest.subtitle ?? '', author: manifest.author ?? '' }
  const chapterName = styleDisplayName(chapterStyle, english)
  const mirrored = (part: Part): Part => ({ left: part.right, center: part.center, right: part.left })
  const empty: Part = { left: '', center: '', right: '' }
  const zip = new JSZip()
  const parts: Array<[string, string, string]> = [] // path, content type, relationship id
  const addPart = (path: string, content: string, type: string, relType: string, id: string) => {
    zip.file(`word/${path}`, content)
    parts.push([path, type, id])
    ctx.relationships.push({ id, type: `${REL}/${relType}`, target: path })
  }
  const HDR = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'
  const FTR = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml'
  addPart('header1.xml', headerFooterXml('hdr', setup.header, values, chapterName, contentTwips), HDR, 'header', headerParts.default)
  addPart('footer1.xml', headerFooterXml('ftr', setup.footer, values, chapterName, contentTwips), FTR, 'footer', footerParts.default)
  if (setup.mirror) {
    addPart('header2.xml', headerFooterXml('hdr', mirrored(setup.header), values, chapterName, contentTwips), HDR, 'header', headerParts.even)
    addPart('footer2.xml', headerFooterXml('ftr', mirrored(setup.footer), values, chapterName, contentTwips), FTR, 'footer', footerParts.even)
  }
  if (setup.hideOnChapterStart) {
    addPart('header3.xml', headerFooterXml('hdr', empty, values, chapterName, contentTwips), HDR, 'header', headerParts.first)
    addPart('footer3.xml', headerFooterXml('ftr', { ...empty, center: setup.footer.center }, values, chapterName, contentTwips), FTR, 'footer', footerParts.first)
  }
  addPart('styles.xml', stylesXml, 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml', 'styles', 'rIdStyles')
  const settingsXml = `${XML_HEAD}<w:settings xmlns:w="${W_NS}" xmlns:r="${R_NS}">`
    + (setup.mirror ? '<w:mirrorMargins/>' : '')
    + '<w:defaultTabStop w:val="709"/>'
    + (setup.hyphenate ? '<w:autoHyphenation/><w:consecutiveHyphenLimit w:val="3"/><w:hyphenationZone w:val="425"/>' : '<w:autoHyphenation w:val="0"/>')
    + (setup.mirror ? '<w:evenAndOddHeaders/>' : '')
    + '<w:characterSpacingControl w:val="doNotCompress"/>'
    + (endnotes ? '' : '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>')
    + (endnotes ? `<w:endnotePr><w:pos w:val="${notes === 'endnotes-chapter' ? 'sectEnd' : 'docEnd'}"/><w:numFmt w:val="decimal"/>${notes === 'endnotes-chapter' ? '<w:numRestart w:val="eachSect"/>' : ''}<w:endnote w:id="-1"/><w:endnote w:id="0"/></w:endnotePr>` : '')
    + '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>'
    + `<w:themeFontLang w:val="${manifest.language}"/>`
    + '</w:settings>'
  addPart('settings.xml', settingsXml, 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml', 'settings', 'rIdSettings')
  const numberingXml = `${XML_HEAD}<w:numbering xmlns:w="${W_NS}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${esc(listMarker)}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${twips(styles.list?.indentLeft ?? 6)}" w:hanging="${twips(Math.abs(styles.list?.indentFirst ?? 4))}"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`
  addPart('numbering.xml', numberingXml, 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml', 'numbering', 'rIdNumbering')
  addPart(`${noteKind}s.xml`, notesXml, `application/vnd.openxmlformats-officedocument.wordprocessingml.${noteKind}s+xml`, `${noteKind}s`, 'rIdNotes')
  if (commentEntries.length) addPart('comments.xml', `${XML_HEAD}<w:comments xmlns:w="${W_NS}" xmlns:r="${R_NS}">${commentEntries.join('')}</w:comments>`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml', 'comments', 'rIdComments')
  const fontTable = [...new Set([body.font, ...Object.values(styles).map((style) => style.font), 'literata' as const])].map((family) => `<w:font w:name="${esc(FONT_FILES[family].name)}"><w:charset w:val="00"/><w:family w:val="${family === 'courier' ? 'modern' : family === 'atkinson' ? 'swiss' : 'roman'}"/><w:pitch w:val="${family === 'courier' ? 'fixed' : 'variable'}"/></w:font>`).join('')
  addPart('fontTable.xml', `${XML_HEAD}<w:fonts xmlns:w="${W_NS}">${fontTable}</w:fonts>`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml', 'fontTable', 'rIdFonts')

  zip.file('word/document.xml', documentXml)
  zip.file('word/_rels/document.xml.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ctx.relationships.map((rel) => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${esc(rel.target)}"${rel.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`)
  const now = (input.now ?? new Date()).toISOString().replace(/\.\d+Z$/u, 'Z')
  zip.file('docProps/core.xml', `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(manifest.title)}</dc:title>${manifest.subtitle ? `<dc:subject>${esc(manifest.subtitle)}</dc:subject>` : ''}${manifest.author ? `<dc:creator>${esc(manifest.author)}</dc:creator>` : ''}<dc:language>${manifest.language}</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`)
  zip.file('docProps/app.xml', `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>FaNotes</Application></Properties>`)
  zip.file('_rels/.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`)
  zip.file('[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${parts.map(([path, type]) => `<Override PartName="/word/${path}" ContentType="${type}"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
}
