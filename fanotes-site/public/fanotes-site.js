const root = document.documentElement
root.classList.add('js')

const header = document.querySelector('[data-header]')
const nav = document.querySelector('[data-nav]')
const menuToggle = document.querySelector('[data-menu-toggle]')
const themeToggle = document.querySelector('[data-theme-toggle]')
const toast = document.querySelector('[data-toast]')
const scrollProgress = document.querySelector('[data-scroll-progress]')
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const systemTheme = window.matchMedia('(prefers-color-scheme: light)')
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
const prefersWindows = /Windows NT/u.test(navigator.userAgent)
const uiLocale = root.dataset.uiLanguage === 'en' ? 'en-US' : 'de-CH'

let latestRelease = null
let activePlatform = prefersWindows ? 'windows' : 'linux'
let scrollFrame = null
let themeTimer = null
let toastTimer = null

const reportAnonymousSessionEvent = (type, storageKey, details = {}) => {
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
    body: JSON.stringify({ type, ...details }),
    credentials: 'omit',
    cache: 'no-store',
    keepalive: true,
  }).catch(() => undefined)
}

window.setTimeout(() => reportAnonymousSessionEvent('website_view', 'fanotes-analytics-website-session-v1'), 1200)

const safelyReadTheme = () => {
  try {
    return localStorage.getItem('fanotes-site-theme')
  } catch {
    return null
  }
}

const safelyStoreTheme = (theme) => {
  try {
    localStorage.setItem('fanotes-site-theme', theme)
  } catch {
    // Private browser modes may disable storage. The current session still works.
  }
}

const syncThemeControls = () => {
  const isLight = root.dataset.theme === 'light'
  themeToggle?.setAttribute('aria-label', isLight ? 'Dunkles Farbschema verwenden' : 'Helles Farbschema verwenden')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isLight ? '#f5f3f8' : '#0b0b12')
}

const applyTheme = (theme, persist = false) => {
  root.dataset.theme = theme
  syncThemeControls()
  if (persist) safelyStoreTheme(theme)
}

const savedTheme = safelyReadTheme()
applyTheme(savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : systemTheme.matches ? 'light' : 'dark')

themeToggle?.addEventListener('click', () => {
  root.classList.add('is-switching-theme')
  window.clearTimeout(themeTimer)
  applyTheme(root.dataset.theme === 'light' ? 'dark' : 'light', true)
  themeTimer = window.setTimeout(() => root.classList.remove('is-switching-theme'), 420)
})

systemTheme.addEventListener('change', (event) => {
  if (!safelyReadTheme()) applyTheme(event.matches ? 'light' : 'dark')
})

const showToast = (message) => {
  if (!toast) return
  toast.textContent = message
  toast.classList.add('is-visible')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2400)
}

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '–'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${new Intl.NumberFormat(uiLocale, { maximumFractionDigits: exponent > 1 ? 1 : 0 }).format(bytes / 1024 ** exponent)} ${units[exponent]}`
}

const setText = (selector, value) => {
  document.querySelectorAll(selector).forEach((element) => { element.textContent = value })
}

const setHref = (selector, value) => {
  if (!value) return
  document.querySelectorAll(selector).forEach((element) => { element.href = value })
}

const renderChangelog = (changes) => {
  const list = document.querySelector('[data-changelog]')
  if (!list || !Array.isArray(changes) || changes.length === 0) return
  list.replaceChildren(...changes.slice(0, 6).map((change, index) => {
    const item = document.createElement('li')
    const number = document.createElement('span')
    const copy = document.createElement('p')
    number.textContent = String(index + 1).padStart(2, '0')
    copy.textContent = String(change).replaceAll('**', '').replaceAll('`', '')
    item.append(number, copy)
    return item
  }))
}

document.querySelectorAll('[data-command]').forEach((element) => {
  element.dataset.template = element.textContent
})

const updatePrimaryDownload = () => {
  if (!latestRelease) return
  const windowsRelease = latestRelease.windows
  const useWindows = activePlatform === 'windows' && windowsRelease?.packages?.installer
  const target = useWindows ? windowsRelease.packages.installer : latestRelease.appimage
  setHref('[data-primary-download]', target.url)
  setText('[data-primary-label]', useWindows ? 'Für Windows herunterladen' : 'Für Linux herunterladen')
  setText('[data-primary-detail]', `${useWindows ? 'Installer' : 'AppImage'} · ${formatBytes(target.sizeBytes)}`)
}

const activatePlatform = (platform) => {
  if (platform !== 'windows' && platform !== 'linux') return
  activePlatform = platform
  document.querySelectorAll('[data-platform-tab]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.platformTab === platform))
  })
  document.querySelectorAll('[data-platform-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.platformPanel !== platform
  })
  document.querySelectorAll('[data-platform-install-guide]').forEach((guide) => {
    guide.hidden = guide.dataset.platformInstallGuide !== platform
  })
  updatePrimaryDownload()
}

document.querySelectorAll('[data-platform-tab]').forEach((button) => {
  button.addEventListener('click', () => activatePlatform(button.dataset.platformTab))
})
activatePlatform(activePlatform)

const applyRelease = (release) => {
  if (!release?.version || !release?.appimage || !release?.portable || !release?.windows?.packages?.installer || !release?.windows?.packages?.portable) {
    throw new Error('Release API: unvollständige Antwort')
  }
  latestRelease = release
  setText('[data-version]', release.version)
  setText('[data-windows-version]', release.windows.version)
  setText('[data-appimage-size]', formatBytes(release.appimage.sizeBytes))
  setText('[data-portable-size]', formatBytes(release.portable.sizeBytes))
  setText('[data-windows-installer-size]', formatBytes(release.windows.packages.installer.sizeBytes))
  setText('[data-windows-portable-size]', formatBytes(release.windows.packages.portable.sizeBytes))
  setHref('[data-download-appimage]', release.appimage.url)
  setHref('[data-download-portable]', release.portable.url)
  setHref('[data-download-windows-installer]', release.windows.packages.installer.url)
  setHref('[data-download-windows-portable]', release.windows.packages.portable.url)
  setHref('[data-checksums]', release.checksumsUrl)
  updatePrimaryDownload()

  const releaseDate = document.querySelector('[data-release-date]')
  const parsedDate = new Date(release.releasedAt)
  if (releaseDate && !Number.isNaN(parsedDate.getTime())) {
    releaseDate.textContent = `Veröffentlicht am ${new Intl.DateTimeFormat(uiLocale, { day: '2-digit', month: 'long', year: 'numeric' }).format(parsedDate)}`
  }

  document.querySelectorAll('[data-command]').forEach((element) => {
    const version = element.dataset.command?.startsWith('windows') ? release.windows.version : release.version
    element.textContent = (element.dataset.template || element.textContent).replaceAll('VERSION', version)
  })
  renderChangelog(release.changes)
}

const loadRelease = async () => {
  try {
    const response = await fetch('/api/release', { cache: 'no-store', headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`Release API: ${response.status}`)
    applyRelease(await response.json())
  } catch (error) {
    console.error(error)
    setText('[data-version]', 'neueste Version')
    const releaseDate = document.querySelector('[data-release-date]')
    if (releaseDate) releaseDate.textContent = 'Release-Informationen sind momentan nicht erreichbar.'
  }
}

const setMenuState = (open, restoreFocus = false) => {
  nav?.classList.toggle('is-open', open)
  menuToggle?.classList.toggle('is-open', open)
  menuToggle?.setAttribute('aria-expanded', String(open))
  menuToggle?.setAttribute('aria-label', open ? 'Navigation schließen' : 'Navigation öffnen')
  if (!open && restoreFocus) menuToggle?.focus()
}

menuToggle?.addEventListener('click', () => setMenuState(!nav?.classList.contains('is-open')))
nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setMenuState(false)))

document.addEventListener('pointerdown', (event) => {
  if (nav?.classList.contains('is-open') && header && !header.contains(event.target)) setMenuState(false)
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && nav?.classList.contains('is-open')) setMenuState(false, true)
})

const navLinks = [...(nav?.querySelectorAll('a[href^="#"]') || [])]
const navSections = navLinks
  .map((link) => ({ link, section: document.querySelector(link.getAttribute('href')) }))
  .filter(({ section }) => section)

const updateScrollState = () => {
  scrollFrame = null
  const scrollTop = window.scrollY
  const scrollable = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1)
  header?.classList.toggle('is-scrolled', scrollTop > 24)
  scrollProgress?.style.setProperty('--scroll-progress', Math.min(scrollTop / scrollable, 1))

  if (!reducedMotion.matches && window.innerWidth > 820) {
    const heroShift = Math.min(scrollTop * 0.09, 50)
    const paperShift = Math.min(scrollTop * -0.025, 0)
    root.style.setProperty('--hero-shift', `${heroShift}px`)
    root.style.setProperty('--paper-shift', `${paperShift}px`)
  } else {
    root.style.removeProperty('--hero-shift')
    root.style.removeProperty('--paper-shift')
  }

  const marker = scrollTop + window.innerHeight * 0.34
  let active = null
  navSections.forEach((entry) => {
    if (entry.section.offsetTop <= marker) active = entry
  })
  navSections.forEach(({ link }) => {
    const selected = link === active?.link
    link.classList.toggle('is-active', selected)
    if (selected) link.setAttribute('aria-current', 'location')
    else link.removeAttribute('aria-current')
  })
}

const requestScrollUpdate = () => {
  if (scrollFrame === null) scrollFrame = window.requestAnimationFrame(updateScrollState)
}

window.addEventListener('scroll', requestScrollUpdate, { passive: true })
window.addEventListener('resize', () => {
  if (window.innerWidth > 820) setMenuState(false)
  requestScrollUpdate()
}, { passive: true })
updateScrollState()

const revealObserver = 'IntersectionObserver' in window && !reducedMotion.matches
  ? new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return
      entry.target.classList.add('is-visible')
      observer.unobserve(entry.target)
    })
  }, { threshold: 0.08, rootMargin: '0px 0px -28px' })
  : null

document.querySelectorAll('.reveal').forEach((element) => {
  if (revealObserver) revealObserver.observe(element)
  else element.classList.add('is-visible')
})

document.querySelectorAll('[data-install-tabs]').forEach((tablist) => {
  const tabs = [...tablist.querySelectorAll('[data-install-tab]')]
  const panelRoot = tablist.closest('.install-panel')
  const activateTab = (button, focus = false) => {
    const target = button.dataset.installTab
    tabs.forEach((candidate) => {
      const selected = candidate === button
      candidate.setAttribute('aria-selected', String(selected))
      candidate.tabIndex = selected ? 0 : -1
    })
    panelRoot?.querySelectorAll('[data-install-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.installPanel !== target
    })
    if (focus) button.focus()
  }
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => activateTab(button))
    button.addEventListener('keydown', (event) => {
      let nextIndex = null
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
      if (event.key === 'Home') nextIndex = 0
      if (event.key === 'End') nextIndex = tabs.length - 1
      if (nextIndex === null) return
      event.preventDefault()
      activateTab(tabs[nextIndex], true)
    })
  })
})

const copyText = async (text) => {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  const helper = document.createElement('textarea')
  helper.value = text
  helper.setAttribute('readonly', '')
  helper.style.position = 'fixed'
  helper.style.opacity = '0'
  document.body.append(helper)
  helper.select()
  const copied = document.execCommand('copy')
  helper.remove()
  if (!copied) throw new Error('copy failed')
}

document.querySelectorAll('[data-copy-target]').forEach((button) => {
  const defaultLabel = button.textContent
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copyTarget)
    if (!target) return
    try {
      await copyText(target.textContent)
      button.textContent = 'Kopiert ✓'
      showToast('Terminalbefehl kopiert.')
      window.setTimeout(() => { button.textContent = defaultLabel }, 1700)
    } catch {
      showToast('Kopieren wurde vom Browser blockiert.')
    }
  })
})

document.querySelectorAll('.faq-list details').forEach((details) => details.addEventListener('toggle', () => {
  if (!details.open) return
  document.querySelectorAll('.faq-list details').forEach((candidate) => {
    if (candidate !== details) candidate.open = false
  })
}))

const setPressedChoice = (buttons, activeButton) => {
  buttons.forEach((button) => {
    const active = button === activeButton
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-pressed', String(active))
  })
}

const inkReplay = document.querySelector('[data-ink-replay]')
const inkCard = inkReplay?.closest('.ink-card')
inkReplay?.addEventListener('click', () => {
  if (!inkCard || reducedMotion.matches) return
  inkCard.classList.remove('is-replaying')
  void inkCard.offsetWidth
  inkCard.classList.add('is-replaying')
  window.setTimeout(() => inkCard.classList.remove('is-replaying'), 1300)
})

const vaultButtons = [...document.querySelectorAll('[data-vault-folder]')]
vaultButtons.forEach((button) => button.addEventListener('click', () => {
  setPressedChoice(vaultButtons, button)
}))

const recognitionExamples = {
  math: { sample: '∫₀⁵ f(x) dx', mode: 'Mathematik', confidence: '94%' },
  text: { sample: 'Gedanken verbinden.', mode: 'Text', confidence: '97%' }
}
const recognitionStage = document.querySelector('.recognition-stage')
const recognitionSample = document.querySelector('[data-recognition-sample]')
const recognitionMode = document.querySelector('[data-recognition-mode]')
const recognitionConfidence = document.querySelector('[data-recognition-confidence]')
const recognitionButtons = [...document.querySelectorAll('[data-recognition-choice]')]
let recognitionTimer = null
recognitionButtons.forEach((button) => button.addEventListener('click', () => {
  const example = recognitionExamples[button.dataset.recognitionChoice]
  if (!example) return
  setPressedChoice(recognitionButtons, button)
  recognitionStage?.classList.add('is-changing')
  window.clearTimeout(recognitionTimer)
  recognitionTimer = window.setTimeout(() => {
    if (recognitionSample) recognitionSample.textContent = example.sample
    if (recognitionMode) recognitionMode.textContent = example.mode
    if (recognitionConfidence) recognitionConfidence.textContent = example.confidence
    recognitionStage?.classList.remove('is-changing')
  }, reducedMotion.matches ? 0 : 150)
}))

const worksheetButtons = [...document.querySelectorAll('[data-worksheet-mode]')]
const worksheetPreview = document.querySelector('.worksheet-mini')
const worksheetAnswer = worksheetPreview?.querySelector('b')
worksheetButtons.forEach((button) => button.addEventListener('click', () => {
  setPressedChoice(worksheetButtons, button)
  const keyboard = button.dataset.worksheetMode === 'keyboard'
  worksheetPreview?.classList.toggle('is-keyboard', keyboard)
  worksheetPreview?.classList.toggle('is-pen', !keyboard)
  if (worksheetAnswer) worksheetAnswer.textContent = keyboard ? '42 N' : 'Antwort'
}))

const aiMessages = {
  correct: 'Rechtschreibung wird mit deiner AI geprüft',
  link: 'Passende Wikilinks werden gefunden',
  summary: 'Die Kernaussagen werden verdichtet'
}
const aiButtons = [...document.querySelectorAll('[data-ai-action]')]
const aiStatus = document.querySelector('.ai-status')
const aiStatusText = document.querySelector('[data-ai-status]')
let aiTimer = null
aiButtons.forEach((button) => button.addEventListener('click', () => {
  setPressedChoice(aiButtons, button)
  aiStatus?.classList.add('is-changing')
  window.clearTimeout(aiTimer)
  aiTimer = window.setTimeout(() => {
    if (aiStatusText) aiStatusText.textContent = aiMessages[button.dataset.aiAction] || ''
    aiStatus?.classList.remove('is-changing')
  }, reducedMotion.matches ? 0 : 130)
}))

const markdownButtons = [...document.querySelectorAll('[data-markdown-mode]')]
const activateMarkdownMode = (button, focus = false) => {
  const mode = button.dataset.markdownMode
  markdownButtons.forEach((candidate) => {
    const active = candidate === button
    candidate.classList.toggle('is-active', active)
    candidate.setAttribute('aria-selected', String(active))
    candidate.tabIndex = active ? 0 : -1
  })
  document.querySelectorAll('[data-markdown-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.markdownPanel !== mode
  })
  if (focus) button.focus()
}
markdownButtons.forEach((button, index) => {
  button.addEventListener('click', () => activateMarkdownMode(button))
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    activateMarkdownMode(markdownButtons[(index + direction + markdownButtons.length) % markdownButtons.length], true)
  })
})

const setupPointerEffects = () => {
  if (!finePointer.matches || reducedMotion.matches) return
  document.querySelectorAll('.hero-card, .feature-card, .download-card').forEach((surface) => {
    surface.classList.add('interactive-surface')
    surface.addEventListener('pointermove', (event) => {
      const bounds = surface.getBoundingClientRect()
      const relativeX = (event.clientX - bounds.left) / bounds.width
      const relativeY = (event.clientY - bounds.top) / bounds.height
      const strength = surface.classList.contains('hero-card') ? 2.1 : 3.2
      surface.style.setProperty('--pointer-x', `${relativeX * 100}%`)
      surface.style.setProperty('--pointer-y', `${relativeY * 100}%`)
      surface.style.setProperty('--tilt-x', `${(0.5 - relativeY) * strength}deg`)
      surface.style.setProperty('--tilt-y', `${(relativeX - 0.5) * strength}deg`)
    })
    surface.addEventListener('pointerleave', () => {
      surface.style.removeProperty('--tilt-x')
      surface.style.removeProperty('--tilt-y')
    })
  })
}

setupPointerEffects()

document.querySelectorAll('[data-download-appimage], [data-download-portable], [data-download-windows-installer], [data-download-windows-portable], [data-primary-download]').forEach((link) => link.addEventListener('click', () => {
  if (latestRelease) showToast(`FaNotes ${latestRelease.version} wird vorbereitet …`)
}))

setText('[data-year]', new Date().getFullYear())
window.requestAnimationFrame(() => root.classList.add('is-ready'))
void loadRelease()
