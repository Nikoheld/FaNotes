(function () {
  var root = document.getElementById('share-view')
  var INK_COMMENT = /<!--\s*fanotes-ink:[a-zA-Z0-9_-]{1,96}\s*-->/u

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild) }

  function paragraph(className, text) {
    var element = document.createElement('p')
    element.className = className
    element.textContent = text
    return element
  }

  function showStopped() {
    clear(root)
    root.appendChild(paragraph('share-stopped', 'Diese Freigabe wurde beendet.'))
  }

  function safeUrl(value) {
    var url = String(value || '').trim()
    if (!url || /[\s<>"']/.test(url)) return ''
    var lower = url.toLowerCase()
    if (lower.indexOf('javascript:') === 0 || lower.indexOf('data:') === 0) return ''
    if (lower.indexOf('https://') === 0 || lower.indexOf('http://') === 0 || lower.indexOf('mailto:') === 0) return url
    return ''
  }

  function appendInline(parent, text) {
    var i = 0
    while (i < text.length) {
      if (text.startsWith('**', i) || text.startsWith('__', i)) {
        var marker = text.slice(i, i + 2)
        var end = text.indexOf(marker, i + 2)
        if (end > i + 2) {
          var strong = document.createElement('strong')
          appendInline(strong, text.slice(i + 2, end))
          parent.appendChild(strong)
          i = end + 2
          continue
        }
      }
      if (text.startsWith('~~', i)) {
        var endStrike = text.indexOf('~~', i + 2)
        if (endStrike > i + 2) {
          var del = document.createElement('del')
          appendInline(del, text.slice(i + 2, endStrike))
          parent.appendChild(del)
          i = endStrike + 2
          continue
        }
      }
      if (text.charAt(i) === '`') {
        var endCode = text.indexOf('`', i + 1)
        if (endCode > i + 1) {
          var code = document.createElement('code')
          code.textContent = text.slice(i + 1, endCode)
          parent.appendChild(code)
          i = endCode + 1
          continue
        }
      }
      if (text.charAt(i) === '[') {
        var close = text.indexOf(']', i + 1)
        if (close > i && text.charAt(close + 1) === '(') {
          var urlEnd = text.indexOf(')', close + 2)
          if (urlEnd > close) {
            var href = safeUrl(text.slice(close + 2, urlEnd))
            if (href) {
              var link = document.createElement('a')
              link.href = href
              link.rel = 'noopener noreferrer'
              link.target = '_blank'
              appendInline(link, text.slice(i + 1, close))
              parent.appendChild(link)
              i = urlEnd + 1
              continue
            }
          }
        }
      }
      if ((text.charAt(i) === '*' || text.charAt(i) === '_') && text.charAt(i + 1) !== text.charAt(i)) {
        var endEm = text.indexOf(text.charAt(i), i + 1)
        if (endEm > i + 1) {
          var em = document.createElement('em')
          appendInline(em, text.slice(i + 1, endEm))
          parent.appendChild(em)
          i = endEm + 1
          continue
        }
      }
      var next = text.length
      var tokens = ['**', '__', '~~', '`', '[', '*', '_']
      for (var token = 0; token < tokens.length; token += 1) {
        var at = text.indexOf(tokens[token], i + 1)
        if (at !== -1 && at < next) next = at
      }
      parent.appendChild(document.createTextNode(text.slice(i, next)))
      i = next
    }
  }

  // The saved note ends with a fanotes-famd companion. That JSON is not part of
  // the document, and rendering it makes a huge block under the last paragraph.
  function visibleShareText(source) {
    var text = String(source || '').replace(/\r\n/g, '\n')
    var v1 = text.lastIndexOf('fanotes-famd:v1')
    var v2 = text.lastIndexOf('fanotes-famd:v2')
    var tokenAt = v1 > v2 ? v1 : v2
    if (tokenAt >= 0) {
      var start = text.lastIndexOf('<!--', tokenAt)
      if (start < 0) start = tokenAt
      var cut = start > 0 && text.charAt(start - 1) === '\n' ? start - 1 : start
      return text.slice(0, cut).replace(/\s+$/g, '')
    }
    var tail = /\n(\{[\s\S]*\})\s*$/u.exec(text)
    if (tail && /"schema"\s*:\s*"fanotes-famd-v[12]"/u.test(tail[1])) {
      return text.slice(0, tail.index).replace(/\s+$/g, '')
    }
    return text
  }

  function renderMarkdown(parent, source) {
    var text = visibleShareText(source).replace(/<!--[\s\S]*?-->/g, '')
    var lines = text.split('\n')
    var index = 0
    var emitted = false
    function blank(line) { return !line || !line.trim() }
    function addBlock(tag, line) {
      var element = document.createElement(tag)
      appendInline(element, line)
      parent.appendChild(element)
      emitted = true
    }
    function addPieces(tag, parts) {
      var element = document.createElement(tag)
      parts.forEach(function (part, piece) {
        if (piece) element.appendChild(document.createElement('br'))
        appendInline(element, part)
      })
      parent.appendChild(element)
      emitted = true
    }
    while (index < lines.length) {
      var line = lines[index]
      if (blank(line)) { index += 1; continue }
      if (line.indexOf('```') === 0) {
        var codeLines = []
        index += 1
        while (index < lines.length && lines[index].indexOf('```') !== 0) {
          codeLines.push(lines[index])
          index += 1
        }
        if (index < lines.length) index += 1
        var pre = document.createElement('pre')
        var code = document.createElement('code')
        code.textContent = codeLines.join('\n')
        pre.appendChild(code)
        parent.appendChild(pre)
        emitted = true
        continue
      }
      var heading = /^(#{1,6})\s+(\S.*)$/u.exec(line)
      if (heading) {
        addBlock('h' + heading[1].length, heading[2].trim())
        index += 1
        continue
      }
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
        parent.appendChild(document.createElement('hr'))
        emitted = true
        index += 1
        continue
      }
      if (line.charAt(0) === '>') {
        var quote = []
        while (index < lines.length && lines[index].charAt(0) === '>') {
          quote.push(lines[index].replace(/^>\s?/u, ''))
          index += 1
        }
        addPieces('blockquote', quote)
        continue
      }
      var item = /^(\s*)(?:[-*+]|\d+[.)])\s+(\S.*)$/u.exec(line)
      if (item) {
        var ordered = /^\s*\d+[.)]\s+/u.test(line)
        var list = document.createElement(ordered ? 'ol' : 'ul')
        while (index < lines.length) {
          var nextItem = /^(\s*)(?:[-*+]|\d+[.)])\s+(\S.*)$/u.exec(lines[index])
          if (!nextItem) break
          var li = document.createElement('li')
          var body = nextItem[2]
          var task = /^\[( |x|X)\]\s+/u.exec(body)
          if (task) {
            li.textContent = (task[1] === ' ' ? '☐ ' : '☑ ')
            appendInline(li, body.slice(task[0].length))
          } else {
            appendInline(li, body)
          }
          list.appendChild(li)
          index += 1
        }
        parent.appendChild(list)
        emitted = true
        continue
      }
      var paragraphLines = []
      while (index < lines.length && !blank(lines[index]) && lines[index].indexOf('```') !== 0 && !/^(#{1,6})\s+\S/u.test(lines[index]) && lines[index].charAt(0) !== '>' && !/^(\s*)(?:[-*+]|\d+[.)])\s+\S/u.test(lines[index]) && !/^(-{3,}|\*{3,}|_{3,})\s*$/u.test(lines[index])) {
        paragraphLines.push(lines[index].trim())
        index += 1
      }
      if (paragraphLines.length) addPieces('p', paragraphLines)
    }
    return emitted
  }

  function finite(value, fallback) {
    var number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }

  var TEXT_PAD_X = 72
  var TEXT_PAD_Y = 78
  var TEXT_SLACK = 144
  var TEXT_COLUMN = 820
  var TEXT_FONT = 16
  var TEXT_LEADING = 1.72

  function textColumnOf(note) {
    var column = note && note.textColumn
    return {
      originX: Math.max(0, finite(column && column.originX, 0)),
      originY: Math.max(0, finite(column && column.originY, 0)),
      column: Math.max(540, Math.min(900, finite(column && column.column, TEXT_COLUMN))),
      padX: Math.max(0, finite(column && column.padX, TEXT_PAD_X)),
      padY: Math.max(0, finite(column && column.padY, TEXT_PAD_Y)),
      fontSize: Math.max(12, Math.min(26, finite(column && column.fontSize, TEXT_FONT))),
      lineHeight: Math.max(1.3, Math.min(2.2, finite(column && column.lineHeight, TEXT_LEADING))),
    }
  }

  function sourceLines(source) {
    var text = visibleShareText(source)
    var marker = /<!--\s*fanotes-ink:[a-zA-Z0-9_-]{1,96}\s*-->/gu
    return text.split('\n').map(function (line) { return line.replace(marker, '') })
  }

  function drawInk(page, ink, viewHeight) {
    if (!ink || !Array.isArray(ink.strokes) || !ink.strokes.length) return false
    var width = finite(ink.width, 900)
    var height = finite(ink.height, 1273)
    var view = finite(viewHeight, height)
    if (!(width > 0) || !(height > 0) || !(view > 0)) return false
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'share-ink')
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + view)
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', 'Handschrift')
    var drawn = false
    ink.strokes.forEach(function (stroke) {
      if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) return
      var color = /^#[0-9a-fA-F]{6}$/u.test(stroke.color) ? stroke.color : '#20222b'
      var opacity = Math.max(0.08, Math.min(1, finite(stroke.opacity, 1)))
      var pen = Math.max(0.5, Math.min(48, finite(stroke.width, 3.5)))
      if (stroke.points.length === 1) {
        var point = stroke.points[0]
        var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        dot.setAttribute('cx', String(finite(point.x, 0) * width))
        dot.setAttribute('cy', String(finite(point.y, 0) * height))
        dot.setAttribute('r', String(pen / 2))
        dot.setAttribute('fill', color)
        dot.setAttribute('opacity', String(opacity))
        svg.appendChild(dot)
        drawn = true
        return
      }
      var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
      poly.setAttribute('fill', 'none')
      poly.setAttribute('stroke', color)
      poly.setAttribute('stroke-width', String(pen))
      poly.setAttribute('stroke-linecap', 'round')
      poly.setAttribute('stroke-linejoin', 'round')
      poly.setAttribute('opacity', String(opacity))
      poly.setAttribute('points', stroke.points.map(function (point) {
        return (finite(point.x, 0) * width) + ',' + (finite(point.y, 0) * height)
      }).join(' '))
      svg.appendChild(poly)
      drawn = true
    })
    if (!drawn) return false
    page.appendChild(svg)
    return true
  }

  function sectionEnd(section, sections) {
    var end = 1
    var body = finite(section.bodyTop, 0)
    sections.forEach(function (other) {
      if (!other || other === section) return
      var top = finite(other.top, 1)
      if (top >= body && top < end) end = top
    })
    return end
  }

  function drawSections(page, ink) {
    if (!ink || !Array.isArray(ink.sections) || !ink.sections.length) return
    var width = finite(ink.width, 900)
    var height = finite(ink.height, 1273)
    if (!(width > 0) || !(height > 0)) return
    var host = document.createElement('div')
    host.className = 'share-sections'
    host.setAttribute('aria-label', 'Abschnitte')
    ink.sections.forEach(function (section) {
      if (!section) return
      var top = finite(section.top, 0)
      var bodyTop = finite(section.bodyTop, top)
      if (!(bodyTop > top)) return
      var left = Math.max(0, Math.min(1, finite(section.left, 0)))
      var right = Math.max(left, Math.min(1, finite(section.width, 1)))
      var nested = typeof section.parentId === 'string' && section.parentId.length > 0
      var band = document.createElement('div')
      band.className = 'share-section' + (nested ? ' is-subsection' : '')
      band.style.top = (top * height) + 'px'
      band.style.height = ((bodyTop - top) * height) + 'px'
      band.style.left = (left * 100) + '%'
      band.style.width = ((right - left) * 100) + '%'
      var mark = document.createElement('span')
      mark.className = 'share-section-mark'
      mark.setAttribute('aria-hidden', 'true')
      band.appendChild(mark)
      if (typeof section.title === 'string' && section.title.trim()) {
        var title = document.createElement('span')
        title.className = 'share-section-title'
        title.textContent = section.title.trim()
        band.appendChild(title)
      }
      host.appendChild(band)
      var end = sectionEnd(section, ink.sections)
      if (end <= bodyTop) return
      var rail = document.createElement('div')
      rail.className = 'share-section-rail' + (nested ? ' is-subsection' : '')
      rail.style.top = (bodyTop * height) + 'px'
      rail.style.height = ((end - bodyTop) * height) + 'px'
      rail.style.left = (left * width + (nested ? 40 : 28)) + 'px'
      host.appendChild(rail)
      if (left > 0) {
        var edge = document.createElement('div')
        edge.className = 'share-section-edge'
        edge.style.top = (bodyTop * height) + 'px'
        edge.style.height = ((end - bodyTop) * height) + 'px'
        edge.style.left = (left * 100) + '%'
        host.appendChild(edge)
      }
      var rightEdge = document.createElement('div')
      rightEdge.className = 'share-section-edge'
      rightEdge.style.top = (bodyTop * height) + 'px'
      rightEdge.style.height = ((end - bodyTop) * height) + 'px'
      rightEdge.style.left = (right * 100) + '%'
      host.appendChild(rightEdge)
    })
    if (host.childNodes.length) page.appendChild(host)
  }

  function drawFields(page, fields, width, height) {
    if (!Array.isArray(fields)) return
    var sheetW = finite(width, 900)
    var sheetH = finite(height, 1273)
    fields.forEach(function (field) {
      if (!field || typeof field.text !== 'string' || !field.text.trim()) return
      var box = document.createElement('div')
      box.className = 'share-field'
      box.textContent = field.text
      box.style.left = (Math.max(0, Math.min(1, finite(field.x, 0))) * sheetW) + 'px'
      box.style.top = (Math.max(0, Math.min(1, finite(field.y, 0))) * sheetH) + 'px'
      box.style.width = (Math.max(0.12, Math.min(0.92, finite(field.width, 0.32))) * sheetW) + 'px'
      box.style.fontSize = Math.max(10, Math.min(48, finite(field.fontSize, 16))) + 'px'
      page.appendChild(box)
    })
  }

  // One source line stays one row. Handwriting is placed on that same grid,
  // so a paragraph break is the blank line and a heading cannot grow the row.
  function paintSourceLine(row, line, fence) {
    row.className = 'share-line'
    if (fence) {
      if (line.indexOf('```') === 0) {
        row.className += ' is-fence'
        return false
      }
      row.className += ' is-code'
      row.textContent = line
      return true
    }
    if (line.indexOf('```') === 0) {
      row.className += ' is-fence'
      return true
    }
    if (!line.trim()) {
      row.className += ' is-blank'
      return false
    }
    var heading = /^(\s*)(#{1,6})\s+(\S.*)$/u.exec(line)
    if (heading) {
      row.className += ' is-heading is-h' + heading[2].length
      appendInline(row, heading[3].trim())
      return false
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      row.className += ' is-rule'
      return false
    }
    var quote = /^(\s*)>\s?(.*)$/u.exec(line)
    if (quote) {
      row.className += ' is-quote'
      appendInline(row, quote[2])
      return false
    }
    var task = /^(\s*)(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(\S.*)$/u.exec(line)
    if (task) {
      row.className += ' is-task'
      row.appendChild(document.createTextNode(task[2] === ' ' ? '☐ ' : '☑ '))
      appendInline(row, task[3])
      return false
    }
    var item = /^(\s*)([-*+]|\d+[.)])\s+(\S.*)$/u.exec(line)
    if (item) {
      var ordered = /^\d/u.test(item[2])
      row.className += ordered ? ' is-ordered' : ' is-item'
      if (item[1]) row.appendChild(document.createTextNode(item[1]))
      row.appendChild(document.createTextNode(ordered ? item[2].replace(/[.)]$/u, '') + '. ' : '• '))
      appendInline(row, item[3])
      return false
    }
    row.className += ' is-text'
    appendInline(row, line)
    return false
  }

  function showNote(note, showTitle) {
    var article = document.createElement('article')
    article.className = 'share-note'
    if (showTitle && note.title) {
      var title = document.createElement('h2')
      title.className = 'share-note-title'
      title.textContent = note.title
      article.appendChild(title)
    }
    var ink = note.ink
    var fields = note.textFields
    var hasInk = ink && ((Array.isArray(ink.strokes) && ink.strokes.length) || (Array.isArray(ink.sections) && ink.sections.length))
    var hasPage = hasInk || (Array.isArray(fields) && fields.length)
    var proseHost = article
    var page = null
    var pageHeight = 0
    var wrote = false
    if (hasPage) {
      var metrics = textColumnOf(note)
      var width = finite(ink && ink.width, 900)
      var sheetHeight = finite(ink && ink.height, 1273)
      var lines = sourceLines(note.content || '')
      var textBottom = metrics.originY + metrics.padY + lines.length * metrics.fontSize * metrics.lineHeight + TEXT_SLACK
      pageHeight = Math.max(sheetHeight, Math.ceil(textBottom))
      var fit = document.createElement('div')
      fit.className = 'share-fit'
      fit.style.setProperty('--sheet-w', width + 'px')
      fit.style.setProperty('--sheet-h', pageHeight + 'px')
      var frame = document.createElement('div')
      frame.className = 'share-frame'
      page = document.createElement('div')
      page.className = 'share-page'
      frame.appendChild(page)
      fit.appendChild(frame)
      article.appendChild(fit)
      proseHost = document.createElement('div')
      proseHost.className = 'share-prose share-column'
      var columnLeft = metrics.originX + metrics.padX
      var columnWidth = Math.max(40, Math.min(metrics.column - metrics.padX * 2, width - columnLeft - metrics.padX))
      proseHost.style.left = columnLeft + 'px'
      proseHost.style.top = (metrics.originY + metrics.padY) + 'px'
      proseHost.style.width = columnWidth + 'px'
      proseHost.style.fontSize = metrics.fontSize + 'px'
      proseHost.style.lineHeight = String(metrics.lineHeight)
      var fence = false
      var lineBox = metrics.fontSize * metrics.lineHeight
      lines.forEach(function (line) {
        var row = document.createElement('div')
        fence = paintSourceLine(row, line, fence)
        row.style.minHeight = lineBox + 'px'
        if (!row.textContent) row.style.height = lineBox + 'px'
        if (row.textContent.trim() || row.className.indexOf('is-rule') !== -1) wrote = true
        proseHost.appendChild(row)
      })
      page.appendChild(proseHost)
      if (ink && Array.isArray(ink.sections)) drawSections(page, ink)
    } else {
      proseHost = document.createElement('div')
      proseHost.className = 'share-prose'
      article.appendChild(proseHost)
      wrote = renderMarkdown(proseHost, note.content || '')
    }
    var drew = page ? drawInk(page, ink, pageHeight) : false
    if (page) drawFields(page, fields, finite(ink && ink.width, 900), finite(ink && ink.height, 1273))
    if (!wrote && !drew && !showTitle) {
      var fallback = document.createElement('h1')
      fallback.textContent = note.title || ''
      proseHost.appendChild(fallback)
    }
    if (!drew && INK_COMMENT.test(String(note.content || ''))) {
      article.appendChild(paragraph('share-ink-missing', 'Die Handschrift fehlt in dieser Freigabe.'))
    }
    root.appendChild(article)
  }

  function choiceButton(label, onClick) {
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'share-choice-button'
    button.textContent = label
    button.addEventListener('click', onClick)
    return button
  }

  function installerHref() {
    var link = window.FANOTES_SHARE_LINK
    var platform = /Win/i.test(navigator.platform || navigator.userAgent || '') ? 'windows' : /Mac/i.test(navigator.platform || navigator.userAgent || '') ? 'mac' : 'linux'
    return link.installerFor(platform)
  }

  function showAgainGate(payload) {
    clear(root)
    var link = window.FANOTES_SHARE_LINK
    var id = String(payload.id || '')
    var box = document.createElement('section')
    box.className = 'share-choice'
    var heading = document.createElement('h1')
    heading.textContent = link.prompts.again
    box.appendChild(heading)
    var open = document.createElement('a')
    open.className = 'share-choice-button'
    open.href = link.openRequest(id).protocol
    open.textContent = link.openLabel
    open.setAttribute('data-share-choice', 'open')
    box.appendChild(open)
    root.appendChild(box)
  }

  function showInstallGate(payload) {
    clear(root)
    var link = window.FANOTES_SHARE_LINK
    var id = String(payload.id || '')
    var box = document.createElement('section')
    box.className = 'share-choice'
    var heading = document.createElement('h1')
    heading.textContent = link.prompts.downloadOrInstalled
    box.appendChild(heading)
    var download = choiceButton(link.prompts.download, function () {
      var href = installerHref()
      var anchor = document.createElement('a')
      anchor.className = 'share-installer'
      anchor.href = href
      anchor.rel = 'noopener'
      anchor.textContent = link.prompts.download
      document.body.appendChild(anchor)
      window.__fanotesShareDownload = href
      fetch(href, { method: 'GET', redirect: 'manual', cache: 'no-store' }).catch(function () { /* the installer route was still requested */ })
      showAgainGate(payload)
    })
    download.setAttribute('data-share-choice', 'download')
    var installed = document.createElement('a')
    installed.className = 'share-choice-button'
    installed.href = link.openRequest(id).protocol
    installed.textContent = link.prompts.installed
    installed.setAttribute('data-share-choice', 'installed')
    box.appendChild(download)
    box.appendChild(installed)
    root.appendChild(box)
  }

  function showEditGate(payload) {
    clear(root)
    var link = window.FANOTES_SHARE_LINK
    var box = document.createElement('section')
    box.className = 'share-choice'
    var heading = document.createElement('h1')
    heading.textContent = link.prompts.viewOrEdit
    box.appendChild(heading)
    var view = choiceButton(link.prompts.view, function () {
      var next = {}
      Object.keys(payload).forEach(function (key) { next[key] = payload[key] })
      next.__viewing = true
      showPayload(next)
    })
    view.setAttribute('data-share-choice', 'view')
    var desktop = choiceButton(link.prompts.desktop, function () { showInstallGate(payload) })
    desktop.setAttribute('data-share-choice', 'desktop')
    box.appendChild(view)
    box.appendChild(desktop)
    root.appendChild(box)
  }

  function showPayload(payload) {
    clear(root)
    if (payload && payload.mode === 'edit' && !payload.__viewing && window.FANOTES_SHARE_LINK) {
      showEditGate(payload)
      return
    }
    if (!payload || payload.stopped || !payload.notes || !payload.notes.length) {
      showStopped()
      return
    }
    if (payload.title) document.title = payload.title + ' — FaNotes'
    var many = payload.notes.length > 1
    if (many && payload.title) {
      var heading = document.createElement('h1')
      heading.className = 'share-title'
      heading.textContent = payload.title
      root.appendChild(heading)
    }
    payload.notes.forEach(function (note) { showNote(note || {}, many) })
  }

  if (location.protocol === 'file:') {
    clear(root)
    root.appendChild(paragraph('share-missing', 'Diese Seite braucht einen Webserver. Im Ordner public zum Beispiel npx serve ausführen und dann /share/?id= öffnen.'))
    return
  }
  var params = new URLSearchParams(location.search)
  var inline = params.get('payload')
  if (inline) {
    try { showPayload(JSON.parse(decodeURIComponent(inline))); return } catch (error) { /* fetch the id */ }
  }
  var id = params.get('id') || ''
  if (!id) {
    clear(root)
    root.appendChild(paragraph('share-missing', 'Öffne diese Seite mit der id aus einem Freigabe-Link.'))
    return
  }
  fetch('/api/v1/share/' + encodeURIComponent(id), { headers: { Accept: 'application/json' }, cache: 'no-store' })
    .then(function (response) {
      if (response.status === 404 || response.status === 410) { showStopped(); return null }
      if (!response.ok) throw new Error('status ' + response.status)
      return response.json()
    })
    .then(function (payload) { if (payload) showPayload(payload) })
    .catch(function () {
      clear(root)
      root.appendChild(paragraph('share-missing', 'Die Freigabe konnte nicht geladen werden.'))
    })
})()
