// Note -> standalone, script-free HTML for printing to PDF. It uses the same Markdown pipeline as the
// note preview (GFM, math with KaTeX, sanitized raw HTML), with every picture and the KaTeX fonts
// inlined as data URLs so the page needs no file or network access.
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { markdownSanitizeSchema } from '../markdownSanitizeSchema'
import { imageDataUrl, prepareNoteMarkdown, resolveNoteImages } from './prepare'
import { collectImageSources, parseNoteMarkdown } from './ast'
import { MARGINS_MM, PAGE_SIZES_MM, type NoteExportInput, type NoteExportOptions } from './types'

const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, (char) => (
  char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&#39;'
))

const safeHref = (value: string) => /^(?:https?:|mailto:)/iu.test(value.trim()) ? value.trim() : ''

/** The print stylesheet. Light colours only, whatever the app theme is. */
export const PRINT_CSS = `
* { box-sizing: border-box }
html { background: #fff; color: #111 }
body { margin: 0; font: 11pt/1.55 "Segoe UI", "Noto Sans", "DejaVu Sans", "Helvetica Neue", Arial, "Noto Sans CJK JP", "Noto Color Emoji", sans-serif; color: #111; background: #fff; overflow-wrap: anywhere; -webkit-print-color-adjust: exact; print-color-adjust: exact }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 .45em; break-after: avoid; page-break-after: avoid; color: #111 }
h1 { font-size: 22pt } h2 { font-size: 17pt } h3 { font-size: 14pt } h4 { font-size: 12pt } h5, h6 { font-size: 11pt }
h1.note-title { margin-top: 0; padding-bottom: .25em; border-bottom: 1px solid #ccc }
h6 { color: #555 }
p { margin: 0 0 .7em; orphans: 3; widows: 3 }
a { color: #0b57d0; text-decoration: underline }
ul, ol { margin: 0 0 .7em; padding-left: 1.6em }
li { margin: .15em 0 }
li > p { margin-bottom: .3em }
ul.contains-task-list, ul:has(> li.task-list-item) { list-style: none; padding-left: .4em }
li.task-list-item input { margin: 0 .5em 0 0; vertical-align: middle }
blockquote { margin: 0 0 .8em; padding: .2em 0 .2em 1em; border-left: 3px solid #b8b8b8; color: #444; break-inside: avoid }
hr { border: 0; border-top: 1px solid #bbb; margin: 1.2em 0 }
code, pre { font-family: "JetBrains Mono", "DejaVu Sans Mono", "Cascadia Mono", Consolas, "Liberation Mono", monospace }
code { font-size: .9em; background: #f0f0f0; padding: .05em .3em; border-radius: 3px }
pre { font-size: 9.5pt; line-height: 1.4; background: #f5f5f5; border: 1px solid #ddd; border-radius: 4px; padding: .6em .8em; margin: 0 0 .8em; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid }
pre code { background: none; padding: 0; font-size: inherit }
pre.long { break-inside: auto }
table { border-collapse: collapse; margin: 0 0 .9em; max-width: 100%; break-inside: avoid }
table.long { break-inside: auto }
thead { display: table-header-group }
tr { break-inside: avoid }
th, td { border: 1px solid #aaa; padding: .3em .6em; vertical-align: top }
th { background: #eee; font-weight: 700 }
img { max-width: 100%; height: auto; break-inside: avoid; display: block; margin: .4em 0 .8em }
.katex-display { margin: .8em 0; break-inside: avoid; overflow: hidden }
details > summary { font-weight: 600 }
del { color: #666 }
.missing-image { color: #777; font-style: italic }
`

let katexCssPromise: Promise<string> | null = null

/** The KaTeX stylesheet with its fonts inlined as data URLs (cached after the first use). */
async function katexCss(): Promise<string> {
  katexCssPromise ??= (async () => {
    const { default: css } = await import('katex/dist/katex.min.css?inline')
    const urls = [...new Set([...css.matchAll(/url\(([^)]+)\)/gu)].map((match) => match[1].replace(/^["']|["']$/gu, '')))]
    const inlined = new Map<string, string>()
    await Promise.all(urls.map(async (url) => {
      if (url.startsWith('data:')) { inlined.set(url, url); return }
      if (!/\.woff2(?:$|\?)/iu.test(url)) return
      try {
        const response = await fetch(typeof document !== 'undefined' ? new URL(url, document.baseURI).href : url)
        if (!response.ok) return
        const { bytesToBase64 } = await import('./prepare')
        inlined.set(url, `data:font/woff2;base64,${bytesToBase64(new Uint8Array(await response.arrayBuffer()))}`)
      } catch {
        // A font that cannot be read falls back to the next source or a system font.
      }
    }))
    // Keep a single woff2 source per face; drop the woff/ttf fallbacks (they would need extra files).
    return css.replace(/src:\s*([^;}]+)/gu, (_all, list: string) => {
      const sources = list.split(/,(?![^(]*\))/u).map((item) => item.trim())
      const kept = sources.map((item) => {
        const url = /url\(([^)]+)\)/u.exec(item)?.[1]?.replace(/^["']|["']$/gu, '')
        const data = url ? inlined.get(url) : undefined
        return data ? `url(${data}) format("woff2")` : null
      }).filter(Boolean)
      return kept.length ? `src:${kept.join(',')}` : 'src:local("serif")'
    })
  })()
  return katexCssPromise
}

export type NoteHtml = { html: string; hasMath: boolean }

/** Renders the Markdown body (no document shell). Pictures are replaced by their data URLs. */
export function renderMarkdownBody(markdown: string, images: Map<string, string>): string {
  const components = {
    img: ({ src, alt }: { src?: string; alt?: string }): ReactNode => {
      const url = src ? images.get(src) : undefined
      return url
        ? createElement('img', { src: url, alt: alt ?? '' })
        : createElement('span', { className: 'missing-image' }, alt ? `[${alt}]` : '[Bild]')
    },
    a: ({ href, children }: { href?: string; children?: ReactNode }): ReactNode => {
      const target = href ? safeHref(href) : ''
      return target ? createElement('a', { href: target }, children) : createElement('span', null, children)
    },
    pre: ({ children, node }: { children?: ReactNode; node?: { children?: Array<{ children?: Array<{ value?: string }> }> } }): ReactNode => {
      const text = node?.children?.[0]?.children?.map((child) => child.value ?? '').join('') ?? ''
      return createElement('pre', { className: text.split('\n').length > 38 ? 'long' : undefined }, children)
    },
    table: ({ children, node }: { children?: ReactNode; node?: { children?: unknown[] } }): ReactNode => {
      const rows = JSON.stringify(node ?? {}).split('"tagName":"tr"').length - 1
      return createElement('table', { className: rows > 22 ? 'long' : undefined }, children)
    },
  }
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkMath],
    rehypePlugins: [
      rehypeRaw,
      [rehypeSanitize, markdownSanitizeSchema],
      [rehypeKatex, { output: 'html', strict: false, trust: false, maxExpand: 1000, throwOnError: false }],
    ],
    // Local image paths stay as written: they are looked up in the resolved map above.
    urlTransform: (value: string) => value,
    components,
  } as never, markdown))
}

/** A complete HTML document of the note, ready for `printToPDF`. */
export async function renderNoteHtml(input: NoteExportInput, options: NoteExportOptions): Promise<NoteHtml> {
  const markdown = prepareNoteMarkdown(input.markdown)
  const tree = parseNoteMarkdown(markdown)
  const resolved = await resolveNoteImages(collectImageSources(tree), input.resolveImage, input.signal)
  const images = new Map([...resolved].map(([source, data]) => [source, imageDataUrl(data)]))
  const body = renderMarkdownBody(markdown, images)
  const hasMath = body.includes('class="katex')
  const css = hasMath ? await katexCss() : ''
  const title = input.title.trim() || 'FaNotes'
  const heading = options.includeTitle ? `<h1 class="note-title">${escapeHtml(title)}</h1>` : ''
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">`
    + `<title>${escapeHtml(title)}</title><style>${css}${PRINT_CSS}</style></head><body>${heading}<article>${body}</article></body></html>`
  return { html, hasMath }
}

/** Electron `printToPDF` settings for the chosen options (margins in inches). */
export function printSettings(options: NoteExportOptions) {
  const inches = (mm: number) => mm / 25.4
  const margin = inches(MARGINS_MM[options.margins])
  const size = PAGE_SIZES_MM[options.pageSize]
  return {
    pageSize: options.pageSize === 'letter' ? 'Letter' as const : 'A4' as const,
    widthMm: size.width,
    heightMm: size.height,
    margins: {
      top: margin,
      left: margin,
      right: margin,
      // A page number needs room in the bottom margin.
      bottom: options.pageNumbers ? Math.max(margin, 0.6) : margin,
    },
    pageNumbers: options.pageNumbers,
  }
}
