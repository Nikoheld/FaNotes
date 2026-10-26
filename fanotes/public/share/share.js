(function () {
  var root = document.getElementById('share-view')
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
  function showPayload(payload) {
    clear(root)
    if (!payload || payload.stopped || !payload.notes || !payload.notes.length) {
      showStopped()
      return
    }
    var heading = document.createElement('h1')
    heading.className = 'share-title'
    heading.textContent = payload.title || ''
    root.appendChild(heading)
    payload.notes.forEach(function (note) {
      var article = document.createElement('article')
      article.className = 'share-note'
      var title = document.createElement('h2')
      title.className = 'share-note-title'
      title.textContent = note.title || ''
      var body = document.createElement('p')
      body.className = 'share-body'
      body.textContent = note.content || ''
      article.appendChild(title)
      article.appendChild(body)
      root.appendChild(article)
    })
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
