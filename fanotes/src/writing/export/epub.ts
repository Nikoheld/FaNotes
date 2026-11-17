// EPUB 3 export: a title page, one XHTML file per part and chapter, nav.xhtml
// and toc.ncx (for EPUB 2 readers), CSS made from the paragraph styles, notes
// as linked footnotes or endnotes, and optionally the bundled fonts.
import JSZip from 'jszip'
import { numberFootnotes } from '../layout/endnotes'
import { FONT_FILES, fontFileFor } from '../layout/measure'
import type { FlowBlock } from '../model/flow'
import type { FontFamilyId, Marks, ParagraphStyle, Run } from '../model/types'
import type { FontFiles } from './fonts'
import { notesLabel, sceneStarts, titleKind, xmlEscape as esc, type NotesPlacement, type Prepared } from './prepare'

export type EpubInput = {
  prepared: Prepared
  notes?: NotesPlacement
  sceneTitles?: boolean
  /** Embed the bundled fonts (needs `files`). */
  embedFonts?: boolean
  files?: FontFiles
  now?: Date
}

type Chapter = {
  file: string
  title: string
  kind: 'part' | 'chapter' | 'front'
  blocks: Array<{ block: FlowBlock; index: number }>
  notes: string[]
}

const em = (value: number) => `${Math.round(value * 1000) / 1000}em`
const mmToPt = (mm: number) => mm * 72 / 25.4
const fontStack = (family: FontFamilyId) => `"${FONT_FILES[family].name}", ${family === 'courier' ? 'monospace' : family === 'atkinson' ? 'sans-serif' : 'serif'}`
const cssId = (id: string) => `s-${id}`
const sceneAnchor = (id: string) => `scene-${id}`
const noteAnchor = (id: string) => `fn-${id}`
const refAnchor = (id: string) => `fnref-${id}`

export const styleCss = (style: ParagraphStyle, base: ParagraphStyle, hyphenate: boolean) => {
  const rules = [
    `font-family: ${fontStack(style.font)}`,
    `font-size: ${em(style.size / base.size)}`,
    `line-height: ${Math.round(style.lineHeight * 1000) / 1000}`,
    `margin: ${em(style.spaceBefore / style.size)} ${em(mmToPt(style.indentRight) / style.size)} ${em(style.spaceAfter / style.size)} ${em(mmToPt(style.indentLeft) / style.size)}`,
    `text-indent: ${em(mmToPt(style.listMarker ? 0 : style.indentFirst) / style.size)}`,
    `text-align: ${style.align}`,
    `font-weight: ${style.bold ? 'bold' : 'normal'}`,
    `font-style: ${style.italic ? 'italic' : 'normal'}`,
    style.smallCaps ? 'font-variant: small-caps' : '',
    style.uppercase ? 'text-transform: uppercase' : '',
    style.color ? `color: ${style.color}` : '',
    style.keepWithNext ? 'page-break-after: avoid; break-after: avoid' : '',
    hyphenate && style.align === 'justify' ? '-webkit-hyphens: auto; -epub-hyphens: auto; hyphens: auto' : '',
  ].filter(Boolean)
  return `.${cssId(style.id)} { ${rules.join('; ')}; }`
}

const inlineHtml = (runs: Run[], note: (id: string) => string, lang: string | undefined) => {
  let out = ''
  let link: string | null = null
  const close = () => {
    if (link) out += '</a>'
    link = null
  }
  for (const run of runs) {
    const marks: Marks = run.m ?? {}
    if ((marks.link ?? null) !== link) {
      close()
      if (marks.link) {
        out += `<a href="${esc(marks.link)}">`
        link = marks.link
      }
    }
    if (run.text) {
      let html = esc(run.text).replace(/\n/gu, '<br/>')
      const styles = [marks.font ? `font-family: ${fontStack(marks.font)}` : '', marks.color ? `color: ${marks.color}` : '', marks.hl ? `background-color: ${marks.hl}` : ''].filter(Boolean)
      if (marks.sc) html = `<span class="sc">${html}</span>`
      if (marks.u) html = `<span class="u">${html}</span>`
      if (marks.s) html = `<s>${html}</s>`
      if (marks.i) html = `<em>${html}</em>`
      if (marks.b) html = `<strong>${html}</strong>`
      if (marks.sup) html = `<sup>${html}</sup>`
      if (marks.sub) html = `<sub>${html}</sub>`
      if (styles.length || marks.size) html = `<span style="${esc([...styles, marks.size ? `font-size: ${marks.size}pt` : ''].filter(Boolean).join('; '))}">${html}</span>`
      if (marks.lang && marks.lang !== lang) html = `<span lang="${esc(marks.lang)}" xml:lang="${esc(marks.lang)}">${html}</span>`
      out += html
    }
    if (marks.fn) out += note(marks.fn)
  }
  close()
  return out
}

const xhtml = (language: string, title: string, body: string, bodyType = 'bodymatter') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${esc(language)}" xml:lang="${esc(language)}">
<head>
<meta charset="UTF-8"/>
<title>${esc(title)}</title>
<link rel="stylesheet" type="text/css" href="../styles/book.css"/>
</head>
<body epub:type="${bodyType}">
${body}
</body>
</html>
`

export const writeEpub = async (input: EpubInput): Promise<Uint8Array> => {
  const { prepared } = input
  const manifest = prepared.manifest
  const styles = manifest.styles
  const base = styles.body
  const language = manifest.language
  const notes = input.notes ?? 'footnotes'
  const numbers = numberFootnotes(prepared.flow, notes === 'endnotes-chapter')
  const starts = sceneStarts(prepared)
  const label = notesLabel(language)

  // Split into files at every part and chapter title.
  const chapters: Chapter[] = []
  let current: Chapter | null = null
  prepared.flow.forEach((block, index) => {
    const kind = titleKind(prepared, block)
    if (kind || !current) {
      current = { file: `text/${kind ? `c${String(chapters.length + 1).padStart(3, '0')}` : 'front'}.xhtml`, title: kind ? block.chapterTitle : manifest.title, kind: kind ?? 'front', blocks: [], notes: [] }
      chapters.push(current)
    }
    current.blocks.push({ block, index })
    for (const run of block.runs) if (run.m?.fn && prepared.footnotes.has(run.m.fn) && !current.notes.includes(run.m.fn)) current.notes.push(run.m.fn)
  })

  const noteHref = (chapter: Chapter, id: string) => (notes === 'endnotes-book' ? `notes.xhtml#${noteAnchor(id)}` : `#${noteAnchor(id)}`)
  const noteBody = (id: string, back: string) => {
    const runs = prepared.footnotes.get(id)?.runs ?? []
    return `<p><a class="fn-back" href="${back}">${esc(numbers.get(id) ?? '*')}</a> ${inlineHtml(runs.filter((run) => !run.m?.fn), () => '', language)}</p>`
  }
  const headingLevel = (style: ParagraphStyle) => (style.outlineLevel && style.outlineLevel > 1 ? Math.min(6, style.outlineLevel + (input.sceneTitles ? 1 : 0)) : 0)

  const files: Array<{ path: string; content: string; id: string; title: string }> = []
  for (const chapter of chapters) {
    const ref = (id: string) => `<a epub:type="noteref" role="doc-noteref" class="noteref" id="${refAnchor(id)}" href="${noteHref(chapter, id)}"><sup>${esc(numbers.get(id) ?? '*')}</sup></a>`
    const parts: string[] = []
    for (const { block, index } of chapter.blocks) {
      const scene = starts.get(index)
      if (scene) {
        if (input.sceneTitles) {
          parts.push(`<h2 class="scene-title" id="${sceneAnchor(scene.id)}">${esc(scene.title)}</h2>`)
          if (block.ref.kind === 'break') continue
        } else parts.push(`<span id="${sceneAnchor(scene.id)}"></span>`)
      }
      const style = styles[block.style] ?? base
      const lang = block.lang && block.lang !== language ? block.lang : undefined
      const attrs: string[] = []
      const classes = [cssId(style.id)]
      if (block.afterBreak) classes.push('after-break')
      if (block.afterBreak && (style.dropCap ?? 0) > 1) classes.push(`dropcap dropcap-${style.dropCap}`)
      const inline = [block.align ? `text-align: ${block.align}` : '', block.breakBefore === 'page' ? 'page-break-before: always; break-before: page' : ''].filter(Boolean)
      if (inline.length) attrs.push(`style="${inline.join('; ')}"`)
      if (lang) attrs.push(`lang="${esc(lang)}" xml:lang="${esc(lang)}"`)
      const kind = titleKind(prepared, block)
      if (kind) classes.push(kind)
      const content = inlineHtml(block.runs, (id) => (prepared.footnotes.has(id) ? ref(id) : ''), lang ?? language)
      const tag = kind ? 'h1' : headingLevel(style) ? `h${headingLevel(style)}` : 'p'
      const marker = style.listMarker && !kind ? `<span class="list-marker" aria-hidden="true">${esc(style.listMarker)}</span>` : ''
      parts.push(`<${tag} class="${classes.join(' ')}"${attrs.length ? ` ${attrs.join(' ')}` : ''}${block.ref.kind === 'break' ? ' role="separator"' : ''}>${marker}${content}</${tag}>`)
    }
    if (chapter.notes.length && notes === 'footnotes') {
      for (const id of chapter.notes) parts.push(`<aside epub:type="footnote" role="doc-footnote" class="footnote" id="${noteAnchor(id)}">${noteBody(id, `#${refAnchor(id)}`)}</aside>`)
    } else if (chapter.notes.length && notes === 'endnotes-chapter') {
      parts.push(`<section class="endnotes" epub:type="endnotes" role="doc-endnotes"><h2 class="${cssId(styles.heading ? 'heading' : base.id)}">${esc(label)}</h2>${chapter.notes.map((id) => `<div class="endnote" epub:type="endnote" role="doc-endnote" id="${noteAnchor(id)}">${noteBody(id, `#${refAnchor(id)}`)}</div>`).join('')}</section>`)
    }
    const type = chapter.kind === 'part' ? 'part' : chapter.kind === 'chapter' ? 'chapter' : 'frontmatter'
    files.push({ path: chapter.file, id: chapter.file.slice(5, -6), title: chapter.title || manifest.title, content: xhtml(language, chapter.title || manifest.title, `<section epub:type="${type}" id="${chapter.file.slice(5, -6)}">\n${parts.join('\n')}\n</section>`) })
  }
  const withNotes = chapters.filter((chapter) => chapter.notes.length)
  if (notes === 'endnotes-book' && withNotes.length) {
    const body = withNotes.map((chapter) => `${withNotes.length > 1 ? `<h2>${esc(chapter.title)}</h2>` : ''}${chapter.notes.map((id) => `<div class="endnote" epub:type="endnote" role="doc-endnote" id="${noteAnchor(id)}">${noteBody(id, `${chapter.file.slice(5)}#${refAnchor(id)}`)}</div>`).join('')}`).join('\n')
    files.push({ path: 'text/notes.xhtml', id: 'notes', title: label, content: xhtml(language, label, `<section epub:type="endnotes" role="doc-endnotes" id="notes">\n<h1 class="${cssId(styles.chapter ? 'chapter' : base.id)}">${esc(label)}</h1>\n${body}\n</section>`, 'backmatter') })
  }
  const titlePage = xhtml(language, manifest.title, `<section epub:type="titlepage" class="titlepage" id="titlepage">\n<h1 class="book-title">${esc(manifest.title)}</h1>${manifest.subtitle ? `\n<p class="book-subtitle">${esc(manifest.subtitle)}</p>` : ''}${manifest.author ? `\n<p class="book-author">${esc(manifest.author)}</p>` : ''}\n</section>`, 'frontmatter')

  // ── CSS and fonts ──────────────────────────────────────────────────────
  const fontFiles: Array<{ path: string; bytes: Uint8Array; family: FontFamilyId }> = []
  const css: string[] = []
  if (input.embedFonts && input.files) {
    const families = new Set<FontFamilyId>(Object.values(styles).map((style) => style.font))
    for (const block of prepared.flow) for (const run of block.runs) if (run.m?.font) families.add(run.m.font)
    for (const family of families) {
      for (const [bold, italic] of [[false, false], [false, true], [true, false], [true, true]]) {
        const file = fontFileFor({ family, bold, italic })
        fontFiles.push({ path: `fonts/${file}`, bytes: await input.files.load(file), family })
        css.push(`@font-face { font-family: "${FONT_FILES[family].name}"; font-weight: ${bold ? 'bold' : 'normal'}; font-style: ${italic ? 'italic' : 'normal'}; src: url("../fonts/${file}"); }`)
      }
    }
  }
  const hyphenate = manifest.page.hyphenate
  css.push(
    `body { margin: 0; padding: 0; font-family: ${fontStack(base.font)}; }`,
    'h1, h2, h3, h4, h5, h6, p { margin: 0; padding: 0; }',
    ...Object.values(styles).map((style) => styleCss(style, base, hyphenate)),
    '.after-break { text-indent: 0; }',
    '.dropcap::first-letter { float: left; line-height: 1; padding: 0.05em 0.08em 0 0; }',
    ...[2, 3, 4, 5, 6].map((lines) => `.dropcap-${lines}::first-letter { font-size: ${em(lines * (base.lineHeight) * 0.92)}; }`),
    '.list-marker { display: inline-block; width: 1.2em; margin-left: -1.2em; }',
    '.sc { font-variant: small-caps; }',
    '.u { text-decoration: underline; }',
    'a.noteref { text-decoration: none; }',
    '.footnote, .endnote { font-size: 0.85em; margin: 0.4em 0; }',
    '.endnotes { margin-top: 2em; }',
    '.titlepage { text-align: center; margin-top: 30%; }',
    '.book-title { font-size: 2em; margin-bottom: 0.5em; }',
    '.book-subtitle { font-size: 1.2em; font-style: italic; margin-bottom: 2em; }',
    '.book-author { font-size: 1.1em; }',
    `.scene-title { font-family: ${fontStack(base.font)}; font-size: 1.1em; font-weight: bold; margin: 1.2em 0 0.6em; }`,
  )

  // ── navigation ────────────────────────────────────────────────────────
  type NavItem = { title: string; href: string; children: NavItem[] }
  const nav: NavItem[] = []
  let part: NavItem | null = null
  for (const chapter of chapters) {
    if (chapter.kind === 'front') {
      nav.push({ title: chapter.title, href: chapter.file, children: [] })
      continue
    }
    const item: NavItem = { title: chapter.title || '…', href: chapter.file, children: [] }
    if (chapter.kind === 'part') {
      nav.push(item)
      part = item
    } else ((part as NavItem | null)?.children ?? nav).push(item)
    if (input.sceneTitles) {
      for (const { index } of chapter.blocks) {
        const scene = starts.get(index)
        if (scene?.title) item.children.push({ title: scene.title, href: `${chapter.file}#${sceneAnchor(scene.id)}`, children: [] })
      }
    }
  }
  if (notes === 'endnotes-book' && withNotes.length) nav.push({ title: label, href: 'text/notes.xhtml', children: [] })
  const navList = (items: NavItem[]): string => `<ol>${items.map((item) => `<li><a href="${esc(item.href)}">${esc(item.title)}</a>${item.children.length ? navList(item.children) : ''}</li>`).join('')}</ol>`
  const firstBody = files.find((file) => file.path !== 'text/front.xhtml')?.path ?? files[0]?.path ?? 'text/title.xhtml'
  const tocTitle = language.startsWith('en') ? 'Contents' : 'Inhalt'
  const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${esc(language)}" xml:lang="${esc(language)}">
<head>
<meta charset="UTF-8"/>
<title>${esc(tocTitle)}</title>
<link rel="stylesheet" type="text/css" href="styles/book.css"/>
</head>
<body>
<nav epub:type="toc" id="toc" role="doc-toc">
<h1>${esc(tocTitle)}</h1>
${navList(nav)}
</nav>
<nav epub:type="landmarks" id="landmarks" hidden="hidden">
<ol><li><a epub:type="titlepage" href="text/title.xhtml">${esc(manifest.title)}</a></li><li><a epub:type="bodymatter" href="${firstBody}">${esc(language.startsWith('en') ? 'Start' : 'Beginn')}</a></li></ol>
</nav>
</body>
</html>
`
  let playOrder = 0
  const depthOf = (items: NavItem[]): number => (items.length ? 1 + Math.max(...items.map((item) => depthOf(item.children))) : 0)
  const navPoints = (items: NavItem[]): string => items.map((item) => {
    playOrder += 1
    return `<navPoint id="nav${playOrder}" playOrder="${playOrder}"><navLabel><text>${esc(item.title)}</text></navLabel><content src="${esc(item.href)}"/>${navPoints(item.children)}</navPoint>`
  }).join('')
  const identifier = `urn:fanotes:story:${manifest.id}`
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${esc(language)}">
<head><meta name="dtb:uid" content="${esc(identifier)}"/><meta name="dtb:depth" content="${Math.max(1, depthOf(nav))}"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>${esc(manifest.title)}</text></docTitle>
${manifest.author ? `<docAuthor><text>${esc(manifest.author)}</text></docAuthor>\n` : ''}<navMap>${navPoints(nav)}</navMap>
</ncx>
`
  const modified = (input.now ?? new Date()).toISOString().replace(/\.\d+Z$/u, 'Z')
  const items = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="styles/book.css" media-type="text/css"/>',
    '<item id="title" href="text/title.xhtml" media-type="application/xhtml+xml"/>',
    ...files.map((file) => `<item id="x-${file.id}" href="${file.path}" media-type="application/xhtml+xml"/>`),
    ...fontFiles.map((font, index) => `<item id="font${index + 1}" href="${font.path}" media-type="font/ttf"/>`),
  ]
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${esc(language)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${esc(identifier)}</dc:identifier>
<dc:title>${esc(manifest.title)}</dc:title>
${manifest.author ? `<dc:creator id="author">${esc(manifest.author)}</dc:creator>\n` : ''}<dc:language>${esc(language)}</dc:language>
${manifest.subtitle ? `<dc:description>${esc(manifest.subtitle)}</dc:description>\n` : ''}<meta property="dcterms:modified">${modified}</meta>
<meta name="generator" content="FaNotes"/>
</metadata>
<manifest>
${items.join('\n')}
</manifest>
<spine toc="ncx">
<itemref idref="title"/>
${files.map((file) => `<itemref idref="x-${file.id}"/>`).join('\n')}
</spine>
</package>
`
  const zip = new JSZip()
  // The mimetype comes first and uncompressed, as the OCF spec requires.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n')
  zip.file('OEBPS/content.opf', opf)
  zip.file('OEBPS/nav.xhtml', navXhtml)
  zip.file('OEBPS/toc.ncx', ncx)
  zip.file('OEBPS/styles/book.css', `${css.join('\n')}\n`)
  zip.file('OEBPS/text/title.xhtml', titlePage)
  for (const file of files) zip.file(`OEBPS/${file.path}`, file.content)
  for (const font of fontFiles) zip.file(`OEBPS/${font.path}`, font.bytes, { compression: 'STORE' })
  if (fontFiles.length) {
    for (const family of new Set(fontFiles.map((font) => font.family))) {
      const license = `OFL-${FONT_FILES[family].files.regular.split('-')[0].toLowerCase()}.txt`
      try {
        zip.file(`OEBPS/fonts/${license}`, await input.files!.load(license))
      } catch {
        // The licence file is optional for reading; the fonts are OFL either way.
      }
    }
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/epub+zip' })
}
