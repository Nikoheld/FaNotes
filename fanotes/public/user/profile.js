(function () {
  var root = document.getElementById('profile-view')
  var MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
  var MONTH_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']
  var WEEKDAYS = ['Mo', '', 'Mi', '', 'Fr', '', '']
  var NAME = /^[a-z0-9](?:[a-z0-9]|[-_](?![_-])){1,22}[a-z0-9]$/
  var HEX = /^#[0-9a-f]{6}$/i
  var THEMES = {
    dark: '#191919',
    light: '#ffffff',
    midnight: '#17181b',
    forest: '#171a18',
    aurora: '#18181c',
    sepia: '#fbfaf7',
  }

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

  function hexRgb(hex) {
    var value = parseInt(hex.slice(1), 16)
    return ((value >> 16) & 255) + ', ' + ((value >> 8) & 255) + ', ' + (value & 255)
  }

  function applyTheme(payload) {
    var page = document.documentElement
    var theme = payload && typeof payload.theme === 'string' ? payload.theme : ''
    var meta = document.querySelector('meta[name="theme-color"]')
    page.style.removeProperty('--accent')
    page.style.removeProperty('--accent-rgb')
    page.style.removeProperty('--violet')
    page.style.removeProperty('--violet-bright')
    page.style.removeProperty('--mint')
    if (!THEMES[theme]) {
      page.removeAttribute('data-appearance')
      if (meta) meta.setAttribute('content', '#0b0b12')
      return
    }
    page.setAttribute('data-appearance', theme)
    if (meta) meta.setAttribute('content', THEMES[theme])
    if (payload.accent && HEX.test(payload.accent)) {
      var accent = payload.accent.toLowerCase()
      page.style.setProperty('--accent', accent)
      page.style.setProperty('--accent-rgb', hexRgb(accent))
      page.style.setProperty('--violet', accent)
      page.style.setProperty('--violet-bright', accent)
    }
    if (payload.accentSecondary && HEX.test(payload.accentSecondary)) {
      page.style.setProperty('--mint', payload.accentSecondary.toLowerCase())
    }
  }

  function showPrivate(name) {
    applyTheme(null)
    clear(root)
    document.title = (name || 'FaNotes') + ' · FaNotes'
    var sheet = element('article', 'profile-sheet is-private')
    sheet.appendChild(element('p', 'profile-kicker', 'FaNotes'))
    if (name) sheet.appendChild(element('h1', 'profile-name', name))
    sheet.appendChild(element('p', 'profile-private', 'Diese Übersicht ist nicht öffentlich.'))
    root.appendChild(sheet)
  }

  function localDay(date) {
    var month = String(date.getMonth() + 1).padStart(2, '0')
    var day = String(date.getDate()).padStart(2, '0')
    return date.getFullYear() + '-' + month + '-' + day
  }

  function addDays(date, amount) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount)
  }

  function mondayOf(date) {
    var copy = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    var weekday = copy.getDay()
    return addDays(copy, weekday === 0 ? -6 : 1 - weekday)
  }

  function levelFor(count) {
    if (count <= 0) return 0
    if (count === 1) return 1
    if (count <= 3) return 2
    if (count <= 6) return 3
    return 4
  }

  function dayLabel(key) {
    var parts = key.split('-')
    return Number(parts[2]) + '. ' + MONTHS[Number(parts[1]) - 1] + ' ' + parts[0]
  }

  function tipFor(key, count, hasCounts, future) {
    var label = dayLabel(key)
    if (future) return label
    if (count <= 0) return 'Keine Aktivität am ' + label
    if (!hasCounts) return 'Aktiv am ' + label
    if (count === 1) return '1 Notiz am ' + label
    return count + ' Notizen am ' + label
  }

  function yearLabel(count) {
    if (count === 1) return '1 aktiver Tag im letzten Jahr'
    return count + ' aktive Tage im letzten Jahr'
  }

  function activityPanel(payload) {
    var active = Array.isArray(payload.activeDays) ? payload.activeDays.filter(function (day) {
      return typeof day === 'string'
    }) : []
    var counts = payload.dayCounts && typeof payload.dayCounts === 'object' ? payload.dayCounts : null
    var hasCounts = !!counts
    var today = new Date()
    var todayKey = localDay(today)
    var start = mondayOf(addDays(new Date(today.getFullYear(), today.getMonth(), today.getDate()), -52 * 7))
    var block = element('section', 'profile-days-block')
    block.appendChild(element('h2', '', 'Aktive Tage'))
    var panel = element('div', 'profile-cal')
    panel.setAttribute('data-active-days', active.join(' '))
    var yearCount = 0
    var weeks = []
    for (var week = 0; week < 53; week += 1) {
      var days = []
      for (var row = 0; row < 7; row += 1) days.push(addDays(start, week * 7 + row))
      weeks.push(days)
    }
    weeks.forEach(function (days) {
      days.forEach(function (date) {
        var key = localDay(date)
        if (key <= todayKey && active.indexOf(key) !== -1) yearCount += 1
      })
    })
    block.appendChild(element('p', 'profile-cal-count', yearLabel(yearCount)))
    var scroll = element('div', 'profile-cal-scroll')
    var months = element('div', 'profile-cal-months')
    var lastMonth = -1
    weeks.forEach(function (days) {
      var month = days[0].getMonth()
      var label = month === lastMonth ? '' : MONTH_SHORT[month]
      lastMonth = month
      months.appendChild(element('span', 'profile-cal-month', label))
    })
    var body = element('div', 'profile-cal-body')
    var weekdayCol = element('div', 'profile-cal-weekdays')
    WEEKDAYS.forEach(function (name) {
      weekdayCol.appendChild(element('span', '', name))
    })
    var grid = element('div', 'profile-cal-grid')
    weeks.forEach(function (days) {
      days.forEach(function (date) {
        var key = localDay(date)
        var future = key > todayKey
        var noted = counts && typeof counts[key] === 'number' ? counts[key] : 0
        var count = noted > 0 ? noted : (!future && active.indexOf(key) !== -1 ? 1 : 0)
        var level = future ? 0 : levelFor(count)
        var cell = element('span', 'profile-cal-cell' + (level ? ' is-on is-l' + level : '') + (future ? ' is-future' : ''))
        cell.title = tipFor(key, count, hasCounts, future)
        cell.setAttribute('data-day', key)
        grid.appendChild(cell)
      })
    })
    body.appendChild(weekdayCol)
    body.appendChild(grid)
    scroll.appendChild(months)
    scroll.appendChild(body)
    panel.appendChild(scroll)
    var legend = element('div', 'profile-cal-legend')
    legend.appendChild(element('span', '', 'Weniger'))
    for (var level = 0; level <= 4; level += 1) {
      legend.appendChild(element('span', 'profile-cal-cell' + (level ? ' is-on is-l' + level : '')))
    }
    legend.appendChild(element('span', '', 'Mehr'))
    panel.appendChild(legend)
    if (!active.length) panel.appendChild(element('p', 'profile-empty-days', 'Noch keine aktiven Tage.'))
    block.appendChild(panel)
    return block
  }

  function showPublic(payload, name) {
    if (!payload || payload.public !== true || typeof payload.joinedAt !== 'string' || typeof payload.durationLabel !== 'string') {
      showPrivate(name)
      return
    }
    applyTheme(payload)
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
    sheet.appendChild(activityPanel(payload))
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
