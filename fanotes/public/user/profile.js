(function () {
  var root = document.getElementById('profile-view')
  var MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
  var NAME = /^[a-z0-9](?:[a-z0-9]|[-_](?![_-])){1,22}[a-z0-9]$/

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function element(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }

  function usernameFromPath() {
    var parts = location.pathname.split('/').filter(Boolean)
    if (parts.length !== 2 || parts[0] !== 'user') return ''
    var name = parts[1].toLowerCase()
    return NAME.test(name) ? name : ''
  }

  function showMessage(className, text) {
    clear(root)
    var sheet = element('article', 'profile-sheet is-private')
    sheet.appendChild(element('p', 'profile-kicker', 'FaNotes'))
    sheet.appendChild(element('p', className, text))
    root.appendChild(sheet)
  }

  function formatJoined(iso) {
    var date = new Date(iso)
    if (!isFinite(date.getTime())) return iso
    return date.getUTCDate() + '. ' + MONTHS[date.getUTCMonth()] + ' ' + date.getUTCFullYear()
  }

  function showPrivate(name) {
    clear(root)
    document.title = (name || 'FaNotes') + ' · FaNotes'
    var sheet = element('article', 'profile-sheet is-private')
    sheet.appendChild(element('p', 'profile-kicker', 'FaNotes'))
    if (name) sheet.appendChild(element('h1', 'profile-name', name))
    sheet.appendChild(element('p', 'profile-private', 'Diese Übersicht ist nicht öffentlich.'))
    root.appendChild(sheet)
  }

  function showPublic(payload, name) {
    if (!payload || payload.public !== true || typeof payload.joinedAt !== 'string' || typeof payload.durationLabel !== 'string') {
      showPrivate(name)
      return
    }
    clear(root)
    document.title = name + ' · FaNotes'
    var sheet = element('article', 'profile-sheet')
    sheet.appendChild(element('p', 'profile-kicker', 'Öffentliche Übersicht'))
    sheet.appendChild(element('h1', 'profile-name', name))
    sheet.appendChild(element('p', 'profile-lead', 'Aktivität in FaNotes. Der Text der Notizen bleibt privat.'))

    var stats = element('section', 'profile-stats')

    var joined = element('article', 'profile-stat')
    joined.appendChild(element('span', '', 'Beigetreten'))
    joined.appendChild(element('strong', 'profile-joined-label', formatJoined(payload.joinedAt)))
    var time = element('time', 'profile-joined', payload.joinedAt)
    time.dateTime = payload.joinedAt
    joined.appendChild(time)

    var notes = element('article', 'profile-stat is-notes')
    notes.appendChild(element('span', '', 'Notizen'))
    notes.appendChild(element('strong', 'profile-notes', String(payload.noteCount)))

    var duration = element('article', 'profile-stat is-time')
    duration.appendChild(element('span', '', 'Zeit in FaNotes'))
    duration.appendChild(element('strong', 'profile-duration', payload.durationLabel))

    stats.appendChild(joined)
    stats.appendChild(notes)
    stats.appendChild(duration)
    sheet.appendChild(stats)

    var days = element('section', 'profile-days-block')
    days.appendChild(element('h2', '', 'Aktive Tage'))
    var list = element('div', 'profile-days')
    var active = Array.isArray(payload.activeDays) ? payload.activeDays : []
    if (!active.length) {
      list.appendChild(element('p', 'profile-empty-days', 'Noch keine aktiven Tage.'))
    } else {
      active.forEach(function (day) {
        list.appendChild(element('span', 'profile-day', day))
      })
    }
    days.appendChild(list)
    sheet.appendChild(days)
    root.appendChild(sheet)
  }

  var name = usernameFromPath()
  if (!root) return
  if (!name) {
    showMessage('profile-missing', 'Öffne eine Adresse wie /user/ und dem Benutzernamen.')
    return
  }
  fetch('/api/v1/profile/' + encodeURIComponent(name), { headers: { Accept: 'application/json' }, cache: 'no-store' })
    .then(function (response) {
      if (response.status === 404 || response.status === 410) return null
      if (!response.ok) throw new Error('status ' + response.status)
      return response.json()
    })
    .then(function (payload) {
      if (!payload) showPrivate(name)
      else showPublic(payload, name)
    })
    .catch(function () {
      showMessage('profile-missing', 'Die Übersicht konnte nicht geladen werden.')
    })
})()
