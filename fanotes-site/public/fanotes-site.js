// FaNotes homepage. Everything here is progressive enhancement: navigation,
// downloads and all content work without JavaScript.
const root = document.documentElement
const header = document.querySelector('[data-header]')
const nav = document.querySelector('[data-nav]')
const menuToggle = document.querySelector('[data-menu-toggle]')
const themeToggle = document.querySelector('[data-theme-toggle]')
const uiLocale = () => (root.dataset.uiLanguage === 'en' ? 'en-US' : 'de-CH')
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

// ---------- Anonymous daily counter (disclosed in the privacy section) ----------

const reportAnonymousSessionEvent = (type, storageKey) => {
  try {
    if (sessionStorage.getItem(storageKey) === '1') return
    sessionStorage.setItem(storageKey, '1')
  } catch {
    // Storage can be unavailable in strict private modes; the event itself
    // remains free of identifiers and still works once for this page load.
  }
  void fetch('/api/v1/analytics/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type }),
    credentials: 'omit',
    cache: 'no-store',
    keepalive: true,
  }).catch(() => undefined)
}

window.setTimeout(() => reportAnonymousSessionEvent('website_view', 'fanotes-analytics-website-session-v1'), 1200)

// ---------- Colour scheme ----------

const currentTheme = () => root.dataset.theme || (systemDark.matches ? 'dark' : 'light')

const syncThemeControl = () => {
  const dark = currentTheme() === 'dark'
  themeToggle?.setAttribute('aria-label', dark ? 'Helles Farbschema verwenden' : 'Dunkles Farbschema verwenden')
  themeToggle?.setAttribute('aria-pressed', String(dark))
}

themeToggle?.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark'
  root.dataset.theme = next
  try {
    localStorage.setItem('fanotes-site-theme', next)
  } catch {
    // The choice still applies to this page view.
  }
  syncThemeControl()
})
systemDark.addEventListener('change', syncThemeControl)
syncThemeControl()

// ---------- Header and mobile navigation ----------

const compactNav = window.matchMedia('(max-width: 860px)')

const setMenu = (open, { restoreFocus = false, focusFirst = false } = {}) => {
  if (!nav || !menuToggle) return
  nav.classList.toggle('is-open', open)
  menuToggle.setAttribute('aria-expanded', String(open))
  menuToggle.setAttribute('aria-label', open ? 'Menü schließen' : 'Menü öffnen')
  // The links come before the toggle in the DOM, so keyboard users are moved
  // into the opened menu. A tap leaves focus where it is.
  if (open && focusFirst) nav.querySelector('a')?.focus()
  else if (!open && restoreFocus) menuToggle.focus()
}

menuToggle?.addEventListener('click', (event) => setMenu(!nav?.classList.contains('is-open'), { focusFirst: event.detail === 0 }))
nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setMenu(false)))
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && nav?.classList.contains('is-open')) setMenu(false, { restoreFocus: true })
})
document.addEventListener('pointerdown', (event) => {
  if (nav?.classList.contains('is-open') && header && !header.contains(event.target)) setMenu(false)
})
nav?.addEventListener('focusout', (event) => {
  if (compactNav.matches && nav.classList.contains('is-open') && !header?.contains(event.relatedTarget)) setMenu(false)
})
compactNav.addEventListener('change', () => setMenu(false))

let scrollFrame = null
const updateHeader = () => {
  scrollFrame = null
  header?.classList.toggle('is-scrolled', window.scrollY > 8)
}
window.addEventListener('scroll', () => {
  if (scrollFrame === null) scrollFrame = window.requestAnimationFrame(updateHeader)
}, { passive: true })
updateHeader()

// Mark the section currently in view in the navigation.
const navLinks = [...(nav?.querySelectorAll('a[href^="#"]') || [])]
if ('IntersectionObserver' in window && navLinks.length) {
  const linkFor = new Map(navLinks.map((link) => [link.getAttribute('href').slice(1), link]))
  const visible = new Set()
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target.id)
      else visible.delete(entry.target.id)
    }
    const current = [...linkFor.keys()].find((id) => visible.has(id))
    for (const [id, link] of linkFor) {
      if (id === current) link.setAttribute('aria-current', 'location')
      else link.removeAttribute('aria-current')
    }
  }, { rootMargin: '-35% 0px -55% 0px' })
  for (const id of linkFor.keys()) {
    const section = document.getElementById(id)
    if (section) observer.observe(section)
  }
}

// ---------- Platform tabs (WAI-ARIA tabs pattern) ----------

const tablist = document.querySelector('[data-platform-tabs]')
const tabs = [...document.querySelectorAll('[data-platform-tab]')]
const panels = new Map([...document.querySelectorAll('[data-platform-panel]')].map((panel) => [panel.dataset.platformPanel, panel]))

const selectPlatform = (platform, { focus = false } = {}) => {
  for (const tab of tabs) {
    const selected = tab.dataset.platformTab === platform
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
    if (selected && focus) tab.focus()
  }
  for (const [name, panel] of panels) panel.hidden = name !== platform
}

if (tablist && tabs.length && panels.size) {
  for (const tab of tabs) {
    const panel = panels.get(tab.dataset.platformTab)
    if (!panel) continue
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', tab.id)
    panel.tabIndex = -1
    tab.addEventListener('click', () => selectPlatform(tab.dataset.platformTab))
    tab.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(tab)
      const target = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length]
        : event.key === 'ArrowLeft' ? tabs[(index - 1 + tabs.length) % tabs.length]
          : event.key === 'Home' ? tabs[0]
            : event.key === 'End' ? tabs.at(-1)
              : null
      if (!target) return
      event.preventDefault()
      selectPlatform(target.dataset.platformTab, { focus: true })
    })
  }
  tablist.hidden = false
  const prefersLinux = /Linux|X11/u.test(navigator.userAgent) && !/Android/u.test(navigator.userAgent)
  selectPlatform(prefersLinux ? 'linux' : 'windows')
}

// ---------- Copy buttons ----------

const copyStatus = document.querySelector('[data-copy-status]')
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy)
    if (!source) return
    let copied = false
    try {
      await navigator.clipboard.writeText(source.textContent.trim())
      copied = true
    } catch {
      // Clipboard can be blocked (permissions, insecure context): select the
      // text so the visitor can copy it by hand.
      const range = document.createRange()
      range.selectNodeContents(source)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    const label = copied ? 'Kopiert' : 'Markiert – mit Strg+C kopieren'
    button.textContent = label
    button.classList.toggle('is-done', copied)
    if (copyStatus) copyStatus.textContent = copied ? 'Befehl in die Zwischenablage kopiert.' : 'Befehl markiert. Mit Strg+C kopieren.'
    window.setTimeout(() => {
      button.textContent = 'Kopieren'
      button.classList.remove('is-done')
    }, 2200)
  })
})

// ---------- Release information ----------

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '–'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: exponent > 1 ? 1 : 0 }).format(bytes / 1024 ** exponent)} ${units[exponent]}`
}

const setText = (selector, value) => {
  document.querySelectorAll(selector).forEach((element) => { element.textContent = value })
}

const germanText = /[ÄÖÜäöüß]|\b(?:der|die|das|und|nicht|wird|werden|mit|für|auf)\b/u

const renderChangelog = (changes) => {
  const list = document.querySelector('[data-changelog]')
  if (!list) return
  const items = Array.isArray(changes) ? changes.filter((change) => typeof change === 'string' && change.trim()) : []
  if (!items.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Für diese Version liegen keine Release-Notizen vor.' }))
    return
  }
  list.replaceChildren(...items.slice(0, 6).map((change) => {
    const item = document.createElement('li')
    // The server already localises release notes. Untranslated German notes keep
    // their language for screen readers and are not word-swapped by the catalogue.
    item.dataset.i18nIgnore = ''
    if (root.dataset.uiLanguage === 'en' && germanText.test(change)) item.lang = 'de'
    // "**Lead.** Rest" → bold lead sentence, plain rest. No HTML is interpreted.
    const match = /^\*\*(.+?)\*\*\s*(.*)$/su.exec(change.trim())
    if (match) {
      const strong = document.createElement('strong')
      strong.textContent = match[1].replaceAll('`', '')
      item.append(strong, ` ${match[2].replaceAll('**', '').replaceAll('`', '')}`)
    } else {
      item.textContent = change.replaceAll('**', '').replaceAll('`', '')
    }
    return item
  }))
}

const releaseStatus = document.querySelector('[data-release-status]')

const applyRelease = (release) => {
  if (!release?.version || !release?.appimage || !release?.portable || !release?.windows?.packages?.installer || !release?.windows?.packages?.portable) {
    throw new Error('Release API: unvollständige Antwort')
  }
  setText('[data-version]', release.version)
  setText('[data-windows-version]', release.windows.version || release.version)
  setText('[data-appimage-size]', formatBytes(release.appimage.sizeBytes))
  setText('[data-portable-size]', formatBytes(release.portable.sizeBytes))
  setText('[data-windows-installer-size]', formatBytes(release.windows.packages.installer.sizeBytes))
  setText('[data-windows-portable-size]', formatBytes(release.windows.packages.portable.sizeBytes))
  const releaseDate = document.querySelector('[data-release-date]')
  const parsedDate = new Date(release.releasedAt)
  if (releaseDate) {
    releaseDate.textContent = Number.isNaN(parsedDate.getTime())
      ? ''
      : `${root.dataset.uiLanguage === 'en' ? 'Released on' : 'Veröffentlicht am'} ${new Intl.DateTimeFormat(uiLocale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(parsedDate)}`
  }
  renderChangelog(release.changes)
  releaseStatus?.classList.add('is-ready')
}

const showReleaseError = () => {
  setText('[data-version]', 'neueste Version')
  setText('[data-windows-version]', 'neueste Version')
  for (const selector of ['[data-appimage-size]', '[data-portable-size]', '[data-windows-installer-size]', '[data-windows-portable-size]']) setText(selector, '–')
  const releaseDate = document.querySelector('[data-release-date]')
  if (releaseDate) releaseDate.textContent = 'Release-Informationen sind momentan nicht erreichbar.'
  const list = document.querySelector('[data-changelog]')
  list?.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Die Downloads funktionieren trotzdem. Details stehen auch auf GitHub.' }))
  if (releaseStatus) {
    releaseStatus.classList.add('is-error')
    const dot = document.createElement('span')
    dot.className = 'status-dot'
    dot.setAttribute('aria-hidden', 'true')
    const message = document.createElement('span')
    message.textContent = 'Versionsangaben gerade nicht verfügbar. Die Download-Links funktionieren weiterhin.'
    releaseStatus.replaceChildren(dot, message)
  }
}

const loadRelease = async () => {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch('/api/release', { cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) throw new Error(`Release API: ${response.status}`)
    applyRelease(await response.json())
  } catch (error) {
    console.warn(error)
    showReleaseError()
  } finally {
    window.clearTimeout(timeout)
  }
}

void loadRelease()

// ---------- Footer year ----------

setText('[data-year]', String(new Date().getFullYear()))
