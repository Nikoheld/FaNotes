(() => {
  'use strict'

  const MAX_BYTES = 16 * 1024 * 1024
  const { readFamd, collectPages } = window.FamdRead
  const MIN_ZOOM = 0.25
  const MAX_ZOOM = 4

  const fileInput = document.querySelector('#file')
  const dropScreen = document.querySelector('[data-drop]')
  const noteScreen = document.querySelector('[data-note]')
  const errorBox = document.querySelector('[data-error]')
  const zone = document.querySelector('[data-zone]')
  const markdownRoot = document.querySelector('[data-markdown]')
  const inkWrap = document.querySelector('[data-ink-wrap]')
  const inkPages = document.querySelector('[data-ink-pages]')
  const inkScroll = document.querySelector('[data-ink-scroll]')
  const zoomLabel = document.querySelector('[data-zoom-label]')

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

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  let pages = []
  let zoom = 1
  let fitted = true
  let redrawTimer = 0

  const pageWidthPx = (page) => {
    const width = Number(page.doc.sourceWidth) > 0 ? Number(page.doc.sourceWidth) : 900
    return width * zoom
  }

  const fitZoom = () => {
    const widest = Math.max(...pages.map((page) => Number(page.doc.sourceWidth) > 0 ? Number(page.doc.sourceWidth) : 900))
    const room = Math.max(160, (inkScroll?.clientWidth || 900) - 40)
    return clamp(room / widest, MIN_ZOOM, 1)
  }

  const paintPages = () => {
    zoomLabel.textContent = `${Math.round(zoom * 100)} %`
    inkPages.querySelectorAll('canvas').forEach((canvas, index) => {
      const page = pages[index]
      if (!page) return
      window.FamdInk.renderPage(canvas, page.doc, {
        cssWidth: pageWidthPx(page),
        dpr: Math.min(window.devicePixelRatio || 1, 2),
        paper: page.paper || null,
      })
    })
  }

  const schedulePaint = () => {
    window.clearTimeout(redrawTimer)
    redrawTimer = window.setTimeout(paintPages, 60)
  }

  const setZoom = (value, isFit = false) => {
    zoom = clamp(value, MIN_ZOOM, MAX_ZOOM)
    fitted = isFit
    schedulePaint()
  }

  const renderInk = (payload) => {
    pages = collectPages(payload).filter((page) => Array.isArray(page.doc.strokes) && page.doc.strokes.length)
    inkPages.replaceChildren()
    pages.forEach((page, index) => {
      const figure = document.createElement('figure')
      figure.className = 'ink-page'
      figure.dataset.page = String(index + 1)
      if (page.label || pages.length > 1) {
        const caption = document.createElement('figcaption')
        caption.textContent = page.label || `Seite ${index + 1}`
        figure.append(caption)
      }
      const canvas = document.createElement('canvas')
      canvas.className = 'ink-canvas'
      canvas.setAttribute('role', 'img')
      canvas.setAttribute('aria-label', `Handschrift, Seite ${index + 1}`)
      figure.append(canvas)
      inkPages.append(figure)
    })
    show(inkWrap, pages.length > 0)
    if (pages.length) {
      // The section must be visible before measuring the scroll box for "fit".
      show(noteScreen, true)
      zoom = fitZoom()
      fitted = true
      paintPages()
    }
    return pages.reduce((sum, page) => sum + page.doc.strokes.length, 0)
  }

  document.querySelectorAll('[data-zoom]').forEach((button) => {
    button.addEventListener('click', () => {
      const kind = button.dataset.zoom
      if (kind === 'fit') setZoom(fitZoom(), true)
      else setZoom(zoom * (kind === 'in' ? 1.25 : 0.8))
    })
  })
  window.addEventListener('resize', () => {
    if (fitted && pages.length) setZoom(fitZoom(), true)
  })
  inkScroll?.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1))
  }, { passive: false })

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
    const parsed = readFamd(source)
    if (parsed.error) {
      fail(`Die Tinte dieser .famd-Datei ist beschädigt und wird nicht angezeigt (${parsed.error}). Der Text bleibt sichtbar.`)
    }
    const stem = name.replace(/\.(md|markdown|famd)$/iu, '') || 'Notiz'
    text('[data-title]', stem)
    text('[data-filename]', name)
    text('[data-updated]', formatDate(parsed.payload?.updatedAt))
    text('[data-md-count]', parsed.markdown.trim() ? `${parsed.markdown.trim().split(/\s+/u).length} Wörter` : 'kein Text')
    show(noteScreen, true)
    show(dropScreen, false)
    const strokeCount = renderInk(parsed.payload)
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
