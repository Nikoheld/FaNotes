(() => {
  'use strict'

  const FAMD_SCHEMA = 'fanotes-famd-v1'
  const FAMD_HEADER = /(?:^|\n)<!--\s*fanotes-famd:v1\s+chars=(\d+)\s*-->\n/u
  const MAX_BYTES = 16 * 1024 * 1024
  const SOURCE_WIDTH = 900
  const SOURCE_HEIGHT = 1273

  const fileInput = document.querySelector('#file')
  const dropScreen = document.querySelector('[data-drop]')
  const noteScreen = document.querySelector('[data-note]')
  const errorBox = document.querySelector('[data-error]')
  const zone = document.querySelector('[data-zone]')
  const markdownRoot = document.querySelector('[data-markdown]')
  const inkWrap = document.querySelector('[data-ink-wrap]')
  const inkSvg = document.querySelector('[data-ink]')
  const inkPage = document.querySelector('.ink-page')

  const show = (element, visible) => {
    if (element) element.hidden = !visible
  }

  const text = (selector, value) => {
    const node = document.querySelector(selector)
    if (node) node.textContent = value
  }

  const escapeHtml = (value) => String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')

  const stripFamdPayload = (source) => {
    if (typeof source !== 'string' || !source) return ''
    const match = [...source.matchAll(new RegExp(FAMD_HEADER.source, 'gu'))].at(-1)
    if (!match || match.index === undefined) return source.replace(/\s+$/u, '')
    return source.slice(0, match.index).replace(/\s+$/u, '')
  }

  const parseFamd = (source) => {
    const markdown = stripFamdPayload(source)
    if (typeof source !== 'string' || !source) return { markdown: '', payload: null }
    const match = [...source.matchAll(new RegExp(FAMD_HEADER.source, 'gu'))].at(-1)
    if (!match || match.index === undefined) return { markdown, payload: null }
    const length = Number(match[1])
    if (!Number.isSafeInteger(length) || length < 2 || length > 32 * 1024 * 1024) {
      return { markdown, payload: null }
    }
    const json = source.slice(match.index + match[0].length, match.index + match[0].length + length)
    if (json.length !== length) return { markdown, payload: null }
    try {
      const parsed = JSON.parse(json)
      if (!parsed || parsed.schema !== FAMD_SCHEMA || typeof parsed !== 'object') {
        return { markdown, payload: null }
      }
      const worksheets = Array.isArray(parsed.worksheets)
        ? parsed.worksheets.filter((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,96}$/u.test(id))
        : []
      const ink = parsed.ink && typeof parsed.ink === 'object' && !Array.isArray(parsed.ink) ? parsed.ink : null
      const updatedAt = typeof parsed.updatedAt === 'string' && Number.isFinite(Date.parse(parsed.updatedAt))
        ? new Date(parsed.updatedAt).toISOString()
        : ''
      return { markdown, payload: { schema: FAMD_SCHEMA, updatedAt, ink, worksheets } }
    } catch {
      return { markdown, payload: null }
    }
  }

  const safeUrl = (raw, imageOnly = false) => {
    try {
      const url = new URL(raw, 'https://fanotes.invalid/')
      if (imageOnly) {
        if (url.protocol === 'data:') return /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/iu.test(raw) ? raw : ''
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : ''
      }
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : ''
    } catch {
      return ''
    }
  }

  const renderInline = (value) => {
    const escaped = escapeHtml(value)
    return escaped
      .replace(/`([^`]+)`/gu, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
      .replace(/(^|[^\*])\*([^*\n]+)\*/gu, '$1<em>$2</em>')
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/gu, (_all, alt, href) => {
        const url = safeUrl(href, true)
        return url ? `<img alt="${alt}" src="${escapeHtml(url)}" />` : escapeHtml(alt)
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (_all, label, href) => {
        const url = safeUrl(href)
        return url
          ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank">${label}</a>`
          : label
      })
      .replace(/\[\[([^\]]+)\]\]/gu, '<span class="md-wiki">$1</span>')
  }

  const renderMarkdown = (source) => {
    const lines = String(source || '').replace(/\r\n/gu, '\n').split('\n')
    const html = []
    let paragraph = []
    let list = null
    let fence = null

    const flushParagraph = () => {
      if (!paragraph.length) return
      html.push(`<p>${renderInline(paragraph.join(' '))}</p>`)
      paragraph = []
    }
    const flushList = () => {
      if (!list) return
      html.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`)
      list = null
    }

    for (const line of lines) {
      const fenceMatch = /^```(.*)$/u.exec(line)
      if (fence) {
        if (fenceMatch) {
          html.push(`<pre><code>${escapeHtml(fence.body.join('\n'))}</code></pre>`)
          fence = null
        } else fence.body.push(line)
        continue
      }
      if (fenceMatch) {
        flushParagraph()
        flushList()
        fence = { body: [] }
        continue
      }
      if (/^\s*$/u.test(line)) {
        flushParagraph()
        flushList()
        continue
      }
      const heading = /^(#{1,4})\s+(.+)$/u.exec(line)
      if (heading) {
        flushParagraph()
        flushList()
        const level = heading[1].length
        html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
        continue
      }
      if (/^(-{3,}|\*{3,})$/u.test(line.trim())) {
        flushParagraph()
        flushList()
        html.push('<hr />')
        continue
      }
      if (/^>\s?/u.test(line)) {
        flushParagraph()
        flushList()
        html.push(`<blockquote><p>${renderInline(line.replace(/^>\s?/u, ''))}</p></blockquote>`)
        continue
      }
      const unordered = /^\s*[-*]\s+(.+)$/u.exec(line)
      const ordered = /^\s*\d+\.\s+(.+)$/u.exec(line)
      if (unordered || ordered) {
        flushParagraph()
        const tag = unordered ? 'ul' : 'ol'
        if (!list || list.tag !== tag) {
          flushList()
          list = { tag, items: [] }
        }
        list.items.push(`<li>${renderInline((unordered || ordered)[1])}</li>`)
        continue
      }
      if (/^\$\$/.test(line) || /\$\$$/.test(line)) {
        flushParagraph()
        flushList()
        html.push(`<div class="md-math">${escapeHtml(line)}</div>`)
        continue
      }
      flushList()
      paragraph.push(line)
    }
    if (fence) html.push(`<pre><code>${escapeHtml(fence.body.join('\n'))}</code></pre>`)
    flushParagraph()
    flushList()
    return html.join('\n') || '<p>Diese Datei enthält keinen sichtbaren Text.</p>'
  }

  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value))

  const renderInk = (ink) => {
    const strokes = Array.isArray(ink?.strokes) ? ink.strokes : []
    const width = Number(ink?.sourceWidth) > 0 ? Number(ink.sourceWidth) : SOURCE_WIDTH
    let height = Number(ink?.sourceHeight) > 0 ? Number(ink.sourceHeight) : SOURCE_HEIGHT
    let maxY = 0
    const paths = []
    for (const stroke of strokes) {
      if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) continue
      const color = typeof stroke.color === 'string' && /^#[\da-fA-F]{6}$/u.test(stroke.color) ? stroke.color : '#1b1b1b'
      const baseWidth = clamp(Number(stroke.baseWidth) || 4, 0.5, 48)
      const opacity = clamp(Number(stroke.opacity) || 1, 0.08, 1)
      const d = stroke.points.map((point, index) => {
        const x = clamp(Number(point?.x) || 0) * width
        const y = clamp(Number(point?.y) || 0) * height
        if (Number(point?.y) > maxY) maxY = Number(point.y)
        return `${index ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`
      }).join(' ')
      paths.push(
        `<path d="${d}" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${baseWidth.toFixed(2)}" stroke-opacity="${opacity.toFixed(2)}" />`,
      )
    }
    const pageHeight = Math.max(height, Math.ceil((maxY + 0.08) * height), 400)
    inkSvg.setAttribute('viewBox', `0 0 ${width} ${pageHeight}`)
    inkSvg.setAttribute('aria-label', `${strokes.length} handschriftliche Striche`)
    inkSvg.innerHTML = paths.join('')
    const paper = typeof ink?.paperStyle === 'string' && ['blank', 'dots', 'squares', 'grid', 'lines', 'millimeter'].includes(ink.paperStyle)
      ? ink.paperStyle
      : 'blank'
    inkPage.dataset.paper = paper
    show(inkWrap, paths.length > 0)
    return strokes.length
  }

  const formatDate = (iso) => {
    if (!iso) return 'unbekannt'
    const date = new Date(iso)
    if (!Number.isFinite(date.getTime())) return 'unbekannt'
    return new Intl.DateTimeFormat('de-CH', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  }

  const fail = (message) => {
    text('[data-error]', message)
    show(errorBox, true)
  }

  const openSource = (name, source) => {
    show(errorBox, false)
    const parsed = parseFamd(source)
    const stem = name.replace(/\.(md|markdown|famd)$/iu, '') || 'Notiz'
    text('[data-title]', stem)
    text('[data-filename]', name)
    text('[data-updated]', formatDate(parsed.payload?.updatedAt))
    text('[data-md-count]', parsed.markdown.trim() ? `${parsed.markdown.trim().split(/\s+/u).length} Wörter` : 'kein Text')
    const strokeCount = renderInk(parsed.payload?.ink || null)
    text('[data-ink-count]', strokeCount ? `${strokeCount} Striche` : 'keine Tinte')
    const sheets = parsed.payload?.worksheets || []
    text(
      '[data-worksheets]',
      sheets.length
        ? `${sheets.length} erwähnt, in dieser Datei nicht enthalten`
        : 'keine',
    )
    markdownRoot.innerHTML = renderMarkdown(parsed.markdown)
    show(dropScreen, false)
    show(noteScreen, true)
    document.title = `${stem} · FaNotes Viewer`
  }

  const readFile = async (file) => {
    if (!file) return
    if (file.size > MAX_BYTES) {
      fail('Die Datei ist grösser als 16 MB und wird hier nicht geöffnet.')
      return
    }
    const name = file.name || 'Notiz.famd'
    if (!/\.(famd|md|markdown)$/iu.test(name)) {
      fail('Bitte eine .famd- oder Markdown-Datei wählen.')
      return
    }
    try {
      const source = await file.text()
      openSource(name, source)
    } catch {
      fail('Die Datei konnte nicht gelesen werden.')
    }
  }

  const openPicker = () => fileInput?.click()

  document.querySelectorAll('[data-open]').forEach((button) => {
    button.addEventListener('click', openPicker)
  })
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    void readFile(file)
  })

  const bindDrop = (target) => {
    if (!target) return
    target.addEventListener('dragover', (event) => {
      event.preventDefault()
      zone?.classList.add('is-over')
    })
    target.addEventListener('dragleave', () => zone?.classList.remove('is-over'))
    target.addEventListener('drop', (event) => {
      event.preventDefault()
      zone?.classList.remove('is-over')
      void readFile(event.dataTransfer?.files?.[0])
    })
  }

  bindDrop(document)
  show(dropScreen, true)
})()
