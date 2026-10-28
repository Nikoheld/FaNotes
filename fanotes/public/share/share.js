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
      var tokens = ['**', '__', '`', '[', '*', '_']
      for (var token = 0; token < tokens.length; token += 1) {
        var at = text.indexOf(tokens[token], i + 1)
        if (at !== -1 && at < next) next = at
      }
      parent.appendChild(document.createTextNode(text.slice(i, next)))
      i = next
    }
  }

  function renderMarkdown(parent, source) {
    var text = String(source || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n')
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
        var blockquote = document.createElement('blockquote')
        appendInline(blockquote, quote.join(' '))
        parent.appendChild(blockquote)
        emitted = true
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
      if (paragraphLines.length) addBlock('p', paragraphLines.join(' '))
    }
    return emitted
  }

  function finite(value, fallback) {
    var number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }

  function drawInk(page, ink) {
    if (!ink || !Array.isArray(ink.strokes) || !ink.strokes.length) return false
    var width = finite(ink.width, 900)
    var height = finite(ink.height, 1273)
    if (!(width > 0) || !(height > 0)) return false
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'share-ink')
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height)
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

  function drawFields(page, fields) {
    if (!Array.isArray(fields)) return
    fields.forEach(function (field) {
      if (!field || typeof field.text !== 'string' || !field.text.trim()) return
      var box = document.createElement('div')
      box.className = 'share-field'
      box.textContent = field.text
      box.style.left = (Math.max(0, Math.min(1, finite(field.x, 0))) * 100) + '%'
      box.style.top = (Math.max(0, Math.min(1, finite(field.y, 0))) * 100) + '%'
      box.style.width = (Math.max(0.12, Math.min(0.92, finite(field.width, 0.32))) * 100) + '%'
      box.style.fontSize = Math.max(10, Math.min(48, finite(field.fontSize, 16))) + 'px'
      page.appendChild(box)
    })
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
    var hasPage = (ink && Array.isArray(ink.strokes) && ink.strokes.length) || (Array.isArray(fields) && fields.length)
    var proseHost = article
    var page = null
    if (hasPage) {
      page = document.createElement('div')
      page.className = 'share-page'
      var width = finite(ink && ink.width, 900)
      var height = finite(ink && ink.height, 1273)
      page.style.aspectRatio = width + ' / ' + height
      article.appendChild(page)
      proseHost = document.createElement('div')
      proseHost.className = 'share-prose'
      page.appendChild(proseHost)
    } else {
      proseHost = document.createElement('div')
      proseHost.className = 'share-prose'
      article.appendChild(proseHost)
    }
    var wrote = renderMarkdown(proseHost, note.content || '')
    var drew = page ? drawInk(page, ink) : false
    if (page) drawFields(page, fields)
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

  function showPayload(payload) {
    clear(root)
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
