'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

const installTranslationDom = () => {
  const documentStub = {
    documentElement: { lang: '', dataset: {} },
    querySelector: () => null,
    createTreeWalker: () => ({ nextNode: () => null }),
    body: {},
  }
  const windowStub = globalThis.window && typeof globalThis.window === 'object' ? globalThis.window : {}
  Object.assign(windowStub, {
    document: documentStub,
    dispatchEvent: () => true,
    addEventListener: () => undefined,
    setTimeout,
    clearTimeout,
    requestIdleCallback: (callback) => {
      callback()
      return 0
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type
        this.detail = init?.detail
      }
    },
  })
  if (!globalThis.window) globalThis.window = windowStub
  if (!globalThis.document) globalThis.document = documentStub
  if (!globalThis.Node) globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 }
  if (!globalThis.NodeFilter) globalThis.NodeFilter = { SHOW_ELEMENT: 1, SHOW_TEXT: 4 }
  if (!globalThis.Element) globalThis.Element = class Element {}
  if (!globalThis.Text) globalThis.Text = class Text {}
  if (!globalThis.MutationObserver) globalThis.MutationObserver = windowStub.MutationObserver
}

const installNavigator = () => {
  const localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  }
  const windowStub = globalThis.window && typeof globalThis.window === 'object' ? globalThis.window : {}
  Object.assign(windowStub, { localStorage })
  if (!globalThis.window) globalThis.window = windowStub
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'de', languages: ['de'] },
      configurable: true,
    })
  } catch {
    /* Node 22 navigator is a getter. */
  }
}

const article = (html, id) => {
  const match = html.match(new RegExp(`<article class="dashboard-card"[^>]*data-card-id="${id}"[^>]*>`, 'u'))
  assert.ok(match, `Karte ${id} fehlt.`)
  return match[0]
}

async function main() {
  installNavigator()
  const { createServer } = await import('vite')
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const server = await createServer({
    root,
    appType: 'custom',
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  })
  try {
    const dashboard = await server.ssrLoadModule('/src/components/StartDashboard.tsx')
    const layoutApi = await server.ssrLoadModule('/src/lib/dashboardLayout.ts')
    const notes = [
      { path: 'Feldstudien/Libellen.md', title: 'Libellen am Teich' },
      { path: 'Atelier/Skizzen.md', title: 'Abendskizzen' },
    ]
    const subjects = [
      { id: 'feld', name: 'Feldstudien', color: '#31756f' },
      { id: 'atelier', name: 'Abendatelier', color: '#8a6232' },
    ]
    const time = new Date(2026, 2, 14, 9, 7, 30)
    let opened = ''
    const render = (layoutPayload) => renderToStaticMarkup(createElement(dashboard.StartDashboard, {
      notes,
      subjects,
      time,
      layoutPayload,
      onOpenNote: (notePath) => { opened = notePath },
      onLeave: () => undefined,
      onLayoutChange: () => undefined,
    }))

    const html = render(undefined)
    assert.equal(render(undefined), html)
    assert.match(html, /aria-label="Startfläche"/u)
    for (const kind of ['clock', 'date', 'note', 'subject']) {
      assert.match(html, new RegExp(`data-kind="${kind}"`, 'u'))
    }
    assert.ok(html.includes('Libellen am Teich'))
    assert.ok(html.includes('Feldstudien'))
    assert.equal(html.includes('Mathematik'), false)
    assert.equal(html.includes('Deutsch'), false)
    assert.ok(html.includes(layoutApi.formatDashboardClock(time)))
    assert.ok(html.includes(layoutApi.formatDashboardDate(time)))
    assert.equal(layoutApi.formatDashboardClock(time), '09:07')
    assert.equal(layoutApi.formatDashboardDate(time), '14.03.2026')
    for (const id of ['clock', 'date', 'note', 'subject']) {
      assert.match(article(html, id), /aria-label="/u)
    }

    let layout = layoutApi.parseDashboardLayout(undefined, notes, subjects)
    assert.deepEqual(layout.cards.map((card) => card.kind), ['clock', 'date', 'note', 'subject'])
    assert.equal(layout.cards.find((card) => card.kind === 'note').notePath, notes[0].path)
    assert.equal(layout.cards.find((card) => card.kind === 'subject').subjectId, subjects[0].id)
    layout = layoutApi.moveDashboardCard(layout, 'note', 180, 96)
    layout = layoutApi.resizeDashboardCard(layout, 'note', 420, 260)
    layout = layoutApi.retargetDashboardCard(layout, 'note', { kind: 'note', notePath: notes[1].path })
    layout = layoutApi.retargetDashboardCard(layout, 'subject', { kind: 'subject', subjectId: subjects[1].id })
    layout = layoutApi.retargetDashboardCard(layout, 'clock', { kind: 'date' })
    assert.equal(layout.cards.find((card) => card.id === 'clock').kind, 'date')
    layout = layoutApi.addDashboardCard(layout, 'clock', notes, subjects)
    const added = layout.cards.at(-1)
    assert.equal(added.kind, 'clock')
    assert.notEqual(added.id, 'clock')
    layout = layoutApi.removeDashboardCard(layout, 'date')
    assert.equal(layout.cards.some((card) => card.id === 'date'), false)

    const payload = layoutApi.serializeDashboardLayout(layout)
    const restored = layoutApi.parseDashboardLayout(payload, notes, subjects)
    assert.deepEqual(restored, layout)
    const missing = layoutApi.parseDashboardLayout(undefined, notes, subjects)
    assert.deepEqual(layoutApi.parseDashboardLayout('', notes, subjects), missing)
    assert.deepEqual(layoutApi.parseDashboardLayout(null, notes, subjects), missing)
    assert.deepEqual(missing.cards.map((card) => card.kind), ['clock', 'date', 'note', 'subject'])

    const html2 = render(payload)
    const noteCard = article(html2, 'note')
    assert.match(noteCard, /data-x="180"/u)
    assert.match(noteCard, /data-y="96"/u)
    assert.match(noteCard, /data-width="420"/u)
    assert.match(noteCard, /data-height="260"/u)
    assert.match(noteCard, /data-note-path="Atelier\/Skizzen.md"/u)
    assert.match(noteCard, /left:180px/u)
    assert.match(noteCard, /top:96px/u)
    assert.match(noteCard, /width:420px/u)
    assert.match(noteCard, /height:260px/u)
    assert.ok(html2.includes('Abendskizzen'))
    const subjectCard = article(html2, 'subject')
    assert.match(subjectCard, /data-subject-id="atelier"/u)
    assert.ok(html2.includes('Abendatelier'))
    assert.match(article(html2, 'clock'), /data-kind="date"/u)
    assert.match(article(html2, added.id), /data-kind="clock"/u)
    assert.equal(html2.includes('data-card-id="date"'), false)
    layoutApi.activateDashboardNote(layout.cards.find((card) => card.id === 'note'), (notePath) => { opened = notePath })
    assert.equal(opened, notes[1].path)
    assert.match(html2, /Notiz öffnen/u)

    const appSource = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8')
    const componentSource = fs.readFileSync(path.join(root, 'src', 'components', 'StartDashboard.tsx'), 'utf8')
    assert.match(appSource, /chooseStartSurface\(/u)
    assert.match(appSource, /start\.openLastNote && startupNote/u)
    assert.match(appSource, /dashboardLayout: payload/u)
    assert.match(componentSource, /moveDashboardCard\(/u)
    assert.match(componentSource, /resizeDashboardCard\(/u)
    assert.match(componentSource, /retargetDashboardCard\(/u)
    assert.match(componentSource, /addDashboardCard\(/u)
    assert.match(componentSource, /removeDashboardCard\(/u)
    assert.match(componentSource, /activateDashboardNote\(/u)
    const onboarding = layoutApi.chooseStartSurface(true)
    const started = layoutApi.chooseStartSurface(false)
    assert.deepEqual(onboarding, { surface: 'onboarding', openLastNote: false })
    assert.deepEqual(started, { surface: 'dashboard', openLastNote: false })
    const electron = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
    assert.match(electron, /dashboardLayout:\s*\{\s*type:\s*'string',\s*max:\s*100000\s*\}/u)

    const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')
    const marker = '@media (max-width: 760px)'
    let phone = ''
    let phoneStart = css.indexOf(marker)
    while (phoneStart >= 0) {
      const phoneEnd = css.indexOf('@media', phoneStart + marker.length)
      const block = css.slice(phoneStart, phoneEnd === -1 ? css.length : phoneEnd)
      if (block.includes('.dashboard-card')) {
        phone = block
        break
      }
      phoneStart = css.indexOf(marker, phoneStart + marker.length)
    }
    assert.ok(phone, 'Die schmale Startfläche fehlt.')
    assert.match(phone, /body:has\(\.dashboard-shell\)[^{]*\{[^}]*min-width:\s*0/u)
    assert.match(phone, /\.dashboard-shell[^{]*\{[^}]*overflow:\s*auto/u)
    assert.doesNotMatch(phone, /\.dashboard-card[^{]*\{[^}]*display:\s*none/u)

    installTranslationDom()
    const i18n = await server.ssrLoadModule('/src/i18n.ts')
    const chrome = [
      ['Startfläche', 'Start surface'],
      ['Karte hinzufügen', 'Add card'],
      ['Zur letzten Notiz', 'Open the last note'],
      ['Uhr', 'Clock'],
      ['Datum', 'Date'],
      ['Notiz', 'note'],
      ['Fach', 'Subject'],
      ['Karte entfernen', 'Remove card'],
      ['Anzeige ändern', 'Change what this card shows'],
      ['Karte verschieben', 'Move card'],
      ['Kartengröße ändern', 'Resize card'],
      ['Notiz öffnen', 'Open note'],
      ['Notizkarte', 'Note'],
      ['Fachkarte', 'Subject'],
      ['Notiz wählen', 'Choose note'],
      ['Fach wählen', 'Choose subject'],
      ['Ziehe Karten, ändere ihre Größe und wähle Uhr, Datum, Notiz oder Fach.', 'Drag cards, resize them, and choose clock, date, note, or subject.'],
      ['Noch keine Notiz', 'No note yet'],
      ['Noch kein Fach', 'No subject yet'],
    ]
    await i18n.setUiLanguage('de')
    for (const [source] of chrome) assert.equal(i18n.translateUiText(source), source)
    await i18n.setUiLanguage('en')
    for (const [source, english] of chrome) assert.equal(i18n.translateUiText(source), english)
    console.log('Dashboard geprüft: Startfläche, Uhr, Datum, Notizen, Fächer, Layout.')
  } finally {
    await server.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
