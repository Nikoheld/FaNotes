import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// Public share: one note or every note in a folder, copy versus live, stop,
// the settings page that lists the link, and the browser viewer.

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const viewerPath = fileURLToPath(new URL('../public/share/index.html', import.meta.url))
const viewerScriptPath = fileURLToPath(new URL('../public/share/share.js', import.meta.url))
const viewerStylePath = fileURLToPath(new URL('../public/share/share.css', import.meta.url))
const viewerLinkPath = fileURLToPath(new URL('../public/share/share-link.js', import.meta.url))
const viewerHtml = readFileSync(viewerPath, 'utf8')
const viewerScript = readFileSync(viewerScriptPath, 'utf8')
const viewerStyle = readFileSync(viewerStylePath, 'utf8')
const viewerLink = readFileSync(viewerLinkPath, 'utf8')
const scratch = process.env.FANOTES_SHARE_SCRATCH || ''
const writeScratch = (name, text) => {
  if (scratch) writeFileSync(join(scratch, name), text)
}

if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { language: 'de-CH', languages: ['de-CH'] }
}
if (typeof globalThis.window === 'undefined') {
  const storage = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, String(value)) },
    },
    fanotes: {},
    requestAnimationFrame: (callback) => { callback(); return 0 },
    location: { origin: 'http://127.0.0.1' },
    document: { documentElement: { lang: '', dataset: {} }, querySelector: () => null },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
}
if (typeof globalThis.document === 'undefined') globalThis.document = globalThis.window.document

const siteRoot = fileURLToPath(new URL('../../fanotes-site/', import.meta.url))
const siteViewerPath = join(siteRoot, 'public', 'share', 'index.html')
const serverSource = readFileSync(join(siteRoot, 'server.mjs'), 'utf8')
const serviceSource = readFileSync(join(siteRoot, 'deploy', 'fanotes-site.service'), 'utf8')
const nginxSource = readFileSync(join(siteRoot, 'deploy', 'fanotes-fasrv.conf'), 'utf8')
assert.equal(readFileSync(siteViewerPath, 'utf8'), viewerHtml, 'the site must serve the shipped share viewer')
assert.equal(readFileSync(join(siteRoot, 'public', 'share', 'share.js'), 'utf8'), viewerScript)
assert.equal(readFileSync(join(siteRoot, 'public', 'share', 'share.css'), 'utf8'), viewerStyle)
assert.equal(readFileSync(join(siteRoot, 'public', 'share', 'share-link.js'), 'utf8'), viewerLink)
assert.doesNotMatch(viewerHtml, /<style[\s>]/u)
assert.match(viewerHtml, /<script src="share\.js\?v=4"><\/script>/u)
assert.match(viewerHtml, /href="share\.css\?v=4"/u)
assert.match(viewerHtml, /<script src="share-link\.js\?v=4"><\/script>/u)
assert.match(viewerScript, /share-note-title/u)
assert.match(viewerScript, /share-prose/u)
assert.match(viewerScript, /share-ink/u)
assert.match(viewerScript, /share-section/u)
assert.match(viewerScript, /share-column/u)
assert.match(viewerStyle, /share-column/u)
assert.doesNotMatch(viewerStyle, /left:\s*8%/u)
assert.doesNotMatch(viewerScript, /innerHTML/u)
assert.match(serviceSource, /Environment=FANOTES_SHARE_DIR=\/var\/lib\/fanotes-shares/u)
assert.match(serviceSource, /ReadWritePaths=\/var\/lib\/fanotes-shares/u)
assert.match(nginxSource, /location \^~ \/api\/v1\/share\/ \{[\s\S]*?client_max_body_size 8m;/u)
assert.match(nginxSource, /location \^~ \/api\/v1\/share\/ \{[\s\S]*?Cross-Origin-Resource-Policy "cross-origin"/u)
const treeSource = readFileSync(join(appRoot, 'src/components/FileTree.tsx'), 'utf8')
const appSource = readFileSync(join(appRoot, 'src/App.tsx'), 'utf8')
assert.match(treeSource, /file-tree__menu-label">Teilen/u)
assert.match(treeSource, /onShare\(path, 'copy'\)/u)
assert.match(treeSource, /onShare\(path, 'live'\)/u)
assert.match(treeSource, /onShare\(path, 'edit'\)/u)
assert.match(treeSource, /Eine Kopie bleibt so, wie sie hochgeladen wurde\./u)
assert.match(treeSource, /Eine Live-Freigabe zeigt spätere Änderungen\./u)
assert.match(treeSource, /Andere können diese Freigabe gleichzeitig bearbeiten\./u)
const shareMenu = appSource.slice(appSource.indexOf('const shareVaultEntry'), appSource.indexOf('if (!shareLinkDialog)'))
assert.match(shareMenu, /mode: 'copy' \| 'live' \| 'edit'/u)
assert.match(shareMenu, /const shareMode = mode === 'live' \? 'live' : mode === 'edit' \? 'edit' : 'copy'/u)
assert.doesNotMatch(shareMenu, /settingsRef\.current\.shareMode/u)
assert.match(treeSource, /contextMenu\.entry\.kind === 'folder' \|\| !isPdfEntry\(contextMenu\.entry\)/u)
assert.match(appSource, /onShare=\{shareVaultEntry\}/u)
assert.match(appSource, /publishShare\(\{/u)
assert.match(appSource, /collectShareNotes\(entries, relativePath\)/u)
assert.match(appSource, /beginDesktopShareOpen\(/u)
assert.match(appSource, /confirmShareIdentity\(/u)
assert.match(appSource, /claimUsername\(/u)
assert.match(appSource, /remoteTextForEditor\(/u)
assert.match(appSource, /applyRemoteTextFields\(/u)
assert.match(appSource, /session\.noteInk\(/u)
assert.match(appSource, /drawingJsonWithRemoteInk\(/u)
assert.match(appSource, /setDrawingSession\(/u)
const shareTickAt = appSource.indexOf('await session.pull()')
const shareTick = appSource.slice(shareTickAt, appSource.indexOf('const timer = window.setInterval', shareTickAt))
assert.ok(shareTickAt >= 0 && shareTick.length > 0, 'share tick missing')
assert.match(shareTick, /shareTickDecision\(/u)
assert.match(shareTick, /basisContent\(/u)
assert.match(shareTick, /changesPending\(/u)
assert.doesNotMatch(shareTick, /const dirty\b/u)
assert.doesNotMatch(shareTick, /const clean\b/u)
const showAt = shareTick.indexOf("=== 'showRemote'")
const absorbAt = shareTick.indexOf("=== 'absorb'")
assert.ok(showAt >= 0 && absorbAt > showAt, 'showRemote must precede absorb')
assert.doesNotMatch(shareTick.slice(showAt, absorbAt), /absorb\(/u)
assert.match(shareTick.slice(absorbAt, absorbAt + 240), /session\.absorb\(/u)
const editorSource = readFileSync(join(appRoot, 'src/components/MarkdownEditor.tsx'), 'utf8')
const pendingAt = editorSource.indexOf('changesPending: () => ({')
const pendingBody = editorSource.slice(pendingAt, editorSource.indexOf('getSelection:', pendingAt))
assert.ok(pendingAt >= 0 && pendingBody.includes('pending()'), 'changesPending must read the coalescer')
assert.match(pendingBody, /composing/u)
assert.doesNotMatch(pendingBody, /\.flush\(/u)
const boardSource = readFileSync(join(appRoot, 'src/components/DrawingBoard.tsx'), 'utf8')
const boardEffectAt = boardSource.indexOf('if (!initialDrawingJson) return')
const boardEffect = boardSource.slice(boardEffectAt, boardSource.indexOf('}, [bumpInkRevision', boardEffectAt))
assert.match(boardEffect, /drawingLoadStep\(/u)
assert.match(boardEffect, /strokesAfterRemoteJson\(/u)
const mergeStepAt = boardEffect.indexOf("step === 'mergeRemote'")
const remoteStrokeAt = boardEffect.indexOf('strokesAfterRemoteJson(')
const sameIdGuardAt = boardEffect.indexOf('if (loadedDrawingIdRef.current === sourceId) return')
assert.ok(mergeStepAt >= 0 && remoteStrokeAt > mergeStepAt && sameIdGuardAt > remoteStrokeAt, 'a changed drawing JSON is merged before the same-id load guard')
assert.match(viewerScript, /FANOTES_SHARE_LINK/u)
assert.match(viewerScript, /__fanotesShareDownload/u)
assert.match(viewerLink, /Im Browser ansehen oder in der Desktop-App bearbeiten\?/u)
assert.match(viewerLink, /Installer herunterladen oder ist FaNotes schon installiert\?/u)
assert.match(viewerLink, /Öffne die Datei jetzt in FaNotes\./u)
assert.match(viewerLink, /\/download\/windows-installer/u)
assert.match(viewerLink, /\/download\/appimage/u)
const electronMain = readFileSync(join(appRoot, 'electron/main.cjs'), 'utf8')
assert.match(electronMain, /fanotes:\\\/\\\/share\\\/\(\[a-f0-9\]\{32\}\)/u)
const shareRoute = serverSource.indexOf('handleShareRequest(request, response, url)')
const getGuard = serverSource.indexOf('Nur GET und HEAD sind erlaubt.')
assert.ok(shareRoute >= 0 && getGuard >= 0 && shareRoute < getGuard, 'share route must run before the GET/HEAD guard')

const serverTemp = mkdtempSync(join(tmpdir(), 'fanotes-share-server-'))
const shareDir = join(serverTemp, 'shares')
const enrollmentPath = join(serverTemp, 'enrollment-token')
mkdirSync(shareDir, { recursive: true })
writeFileSync(enrollmentPath, randomBytes(36).toString('base64url'), { mode: 0o600 })
const sitePort = 18400 + Math.floor(Math.random() * 800)
const origin = `http://127.0.0.1:${sitePort}`
let childOutput = ''
const siteServer = spawn(process.execPath, [join(siteRoot, 'server.mjs')], {
  cwd: siteRoot,
  env: {
    ...process.env,
    FANOTES_HOST: '127.0.0.1',
    FANOTES_PORT: String(sitePort),
    FANOTES_PUBLIC_ORIGIN: origin,
    FANOTES_SHARE_DIR: shareDir,
    FANOTES_BACKUP_DIR: join(serverTemp, 'backups'),
    FANOTES_BACKUP_ENROLLMENT_TOKEN_PATH: enrollmentPath,
    FANOTES_ANALYTICS_DIR: join(serverTemp, 'analytics'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
siteServer.stdout.on('data', (chunk) => { childOutput += chunk })
siteServer.stderr.on('data', (chunk) => { childOutput += chunk })

const vite = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForSite = async () => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (siteServer.exitCode !== null) throw new Error(`share server exited ${siteServer.exitCode}\n${childOutput}`)
    if (childOutput.includes('FaNotes website listening')) return
    await wait(100)
  }
  throw new Error(`share server did not listen\n${childOutput}`)
}

const noteText = (payload) => (payload?.notes ?? []).map((note) => `${note.title}\n${note.content}`).join('\n')

let chromium = null
let chromiumProfile = ''

try {
  await waitForSite()
  const share = await vite.ssrLoadModule('/src/lib/sync/share.ts')
  const shareEdit = await vite.ssrLoadModule('/src/lib/sync/shareEdit.ts')
  const overlay = await vite.ssrLoadModule('/src/lib/overlayInteract.ts')
  const api = await vite.ssrLoadModule('/src/lib/sync/api.ts')
  const page = await vite.ssrLoadModule('/src/components/ShareSettingsPage.tsx')
  const settingsModule = await vite.ssrLoadModule('/src/components/SettingsModal.tsx')
  const defaults = await vite.ssrLoadModule('/src/defaults.ts')
  assert.equal(share.SHARE_API_PATH, '/api/v1/share')
  assert.notEqual(share.SHARE_API_PATH, api.SYNC_API_PATH)
  assert.equal(page.shareStopControl, share.stopShare)

  const localExchanges = []
  const directPort = share.createFetchSharePort()
  const sharePort = {
    async exchange(request) {
      const response = await directPort.exchange(request)
      localExchanges.push({ method: request.method, status: response.status, url: request.url })
      assert.ok(response.status !== 405, `${request.method} ${request.url} was refused by the share server`)
      assert.doesNotMatch(response.body, /Nur GET und HEAD sind erlaubt/u)
      return response
    },
  }
  const oneEntries = await share.loadShareEntries(
    [{ relativePath: 'Hallo.md', kind: 'file', extension: 'md' }],
    async () => '# Hallo\n\nGuten Tag aus der Notiz',
  )
  const note = await share.publishShare({
    entries: oneEntries,
    rootPath: 'Hallo.md',
    mode: 'copy',
    port: sharePort,
    origin,
    now: '2026-10-26T12:00:00.000Z',
  })
  assert.ok(note.record.link.length > 0, 'share link is empty')
  assert.match(note.record.link, /\/share\/\?id=/u)
  assert.equal(note.record.link, `${origin}/share/?id=${encodeURIComponent(note.record.id)}`)
  const storedNote = readFileSync(join(shareDir, `${note.record.id}.json`), 'utf8')
  assert.match(storedNote, /Guten Tag aus der Notiz/)
  const servedViewer = await fetch(`${origin}/share/?id=${encodeURIComponent(note.record.id)}`)
  assert.equal(servedViewer.status, 200)
  assert.equal(await servedViewer.text(), viewerHtml)
  const servedScript = await fetch(`${origin}/share/share.js`)
  const servedStyle = await fetch(`${origin}/share/share.css`)
  assert.equal(servedScript.status, 200)
  assert.equal(servedStyle.status, 200)
  assert.equal(await servedScript.text(), viewerScript)
  assert.equal(await servedStyle.text(), viewerStyle)
  assert.match(note.request.body, /Guten Tag aus der Notiz/)
  assert.match(note.request.url, /\/api\/v1\/share\//u)
  assert.doesNotMatch(note.request.url, /\/api\/v1\/sync/u)
  const noteRead = await share.readShare({ id: note.record.id, port: sharePort, origin, entries: oneEntries })
  assert.match(noteText(noteRead), /Hallo/)
  assert.match(noteText(noteRead), /Guten Tag aus der Notiz/)

  const inkDocument = {
    schemaVersion: 1,
    sourceWidth: 900,
    sourceHeight: 600,
    strokes: [{
      points: [
        { x: 0.2, y: 0.3, t: 0, pressure: 0.4, tiltX: 0, tiltY: 0, pointerType: 'pen' },
        { x: 0.55, y: 0.62, t: 8, pressure: 0.8, tiltX: 0, tiltY: 0, pointerType: 'pen' },
      ],
      baseWidth: 3.5,
      color: '#203040',
      pressureEnabled: true,
    }],
    inkHistory: { undo: ['INK-HISTORY-MUST-NOT-UPLOAD'] },
  }
  const inkEntries = await share.loadShareEntries(
    [{ relativePath: 'Skizze.md', kind: 'file', extension: 'md' }],
    async () => '# Skizze\n\n<!-- fanotes-ink:abc -->\n',
    async () => ({
      ink: { drawingJson: JSON.stringify(inkDocument) },
      textFields: [{ id: 'tf-1', page: 1, x: 0.2, y: 0.15, width: 0.32, fontSize: 16, text: 'Neben der Linie' }],
    }),
  )
  assert.equal(inkEntries[0].ink.strokes[0].color, '#203040')
  assert.equal(inkEntries[0].textFields[0].text, 'Neben der Linie')
  const inkShare = await share.publishShare({
    entries: inkEntries,
    rootPath: 'Skizze.md',
    mode: 'copy',
    port: sharePort,
    origin,
    now: '2026-10-29T12:00:00.000Z',
  })
  assert.match(inkShare.request.body, /#203040/)
  assert.match(inkShare.request.body, /Neben der Linie/)
  assert.doesNotMatch(inkShare.request.body, /INK-HISTORY-MUST-NOT-UPLOAD/)
  assert.doesNotMatch(inkShare.request.body, /pressureEnabled/)
  const storedInk = readFileSync(join(shareDir, `${inkShare.record.id}.json`), 'utf8')
  assert.match(storedInk, /#203040/)
  assert.match(storedInk, /Neben der Linie/)
  assert.doesNotMatch(storedInk, /INK-HISTORY-MUST-NOT-UPLOAD/)
  assert.equal(inkEntries[0].textColumn.padX, 72)
  assert.equal(inkEntries[0].textColumn.padY, 78)
  assert.equal(inkEntries[0].textColumn.column, 820)
  assert.equal(inkEntries[0].textColumn.fontSize, 16)
  assert.equal(inkEntries[0].ink.height, 600)

  const sectionDocument = {
    schemaVersion: 1,
    sourceWidth: 900,
    sourceHeight: 800,
    sourceOriginX: 12,
    sourceOriginY: 20,
    strokes: [{
      points: [
        { x: 0.1, y: 0.1, t: 0, pressure: 0.4, tiltX: 0, tiltY: 0, pointerType: 'pen' },
        { x: 0.2, y: 0.12, t: 8, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' },
      ],
      baseWidth: 2,
      color: '#112233',
    }],
    sections: [{
      id: 'sec-1',
      top: 0.2,
      bodyTop: 0.29,
      collapsed: true,
      title: 'Strahlensatz',
      hidden: {
        widthPx: 900,
        heightPx: 200,
        strokes: [{
          points: [
            { x: 0.3, y: 0.4, t: 0, pressure: 0.4, tiltX: 0, tiltY: 0, pointerType: 'pen' },
            { x: 0.5, y: 0.6, t: 8, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' },
          ],
          baseWidth: 3,
          color: '#445566',
          secret: 'SECRET-MUST-NOT-UPLOAD',
        }],
        sections: [{
          id: 'sub-1',
          top: 0.05,
          bodyTop: 0.29,
          collapsed: false,
          title: 'Unterteil',
          hidden: null,
        }],
      },
    }],
    inkHistory: { undo: ['INK-HISTORY-MUST-NOT-UPLOAD'] },
  }
  const sectionEntries = await share.loadShareEntries(
    [{ relativePath: 'Theorie.md', kind: 'file', extension: 'md' }],
    async () => '# Theorie\n\nZeile unter dem Abschnitt\n',
    async () => ({
      ink: { drawingJson: JSON.stringify(sectionDocument) },
      textFields: [{ id: 'tf-2', page: 1, x: 0.2, y: 0.5, width: 0.32, fontSize: 16, text: 'Im Abschnitt' }],
    }),
  )
  const sectionInk = sectionEntries[0].ink
  assert.equal(sectionInk.strokes.length, 2)
  assert.equal(sectionInk.strokes[0].color, '#112233')
  assert.equal(sectionInk.strokes[1].color, '#445566')
  assert.equal(sectionInk.height, 1000)
  assert.equal(sectionInk.sections.length, 2)
  assert.equal(sectionInk.sections[0].title, 'Strahlensatz')
  assert.equal(sectionInk.sections[1].title, 'Unterteil')
  assert.equal(sectionInk.sections[1].parentId, 'sec-1')
  assert.equal(sectionEntries[0].textColumn.originX, 12)
  assert.equal(sectionEntries[0].textColumn.originY, 20)
  assert.ok(Math.abs(sectionEntries[0].textFields[0].y - 0.4) < 0.001, `field y ${sectionEntries[0].textFields[0].y}`)
  assert.ok(Math.abs(sectionInk.strokes[0].points[0].y - 0.08) < 0.001, `live y ${sectionInk.strokes[0].points[0].y}`)
  assert.ok(Math.abs(sectionInk.sections[0].top - 0.16) < 0.001, `section top ${sectionInk.sections[0].top}`)
  const sectionShare = await share.publishShare({
    entries: sectionEntries,
    rootPath: 'Theorie.md',
    mode: 'copy',
    port: sharePort,
    origin,
    now: '2026-10-29T12:05:00.000Z',
  })
  assert.match(sectionShare.request.body, /Strahlensatz/)
  assert.match(sectionShare.request.body, /Unterteil/)
  assert.match(sectionShare.request.body, /#445566/)
  assert.match(sectionShare.request.body, /Zeile unter dem Abschnitt/)
  assert.doesNotMatch(sectionShare.request.body, /SECRET-MUST-NOT-UPLOAD/)
  assert.doesNotMatch(sectionShare.request.body, /INK-HISTORY-MUST-NOT-UPLOAD/)
  const storedSection = readFileSync(join(shareDir, `${sectionShare.record.id}.json`), 'utf8')
  assert.match(storedSection, /Strahlensatz/)
  assert.match(storedSection, /Unterteil/)
  assert.match(storedSection, /#445566/)
  assert.doesNotMatch(storedSection, /SECRET-MUST-NOT-UPLOAD/)
  const sectionRead = share.parseSharePayload(sectionShare.request.body)
  assert.equal(sectionRead.notes[0].ink.sections.length, 2)
  assert.equal(sectionRead.notes[0].ink.strokes.length, 2)
  assert.equal(sectionRead.notes[0].textColumn.originY, 20)

  const folderEntries = await share.loadShareEntries([
    {
      relativePath: 'Schule',
      kind: 'folder',
      children: [{
        relativePath: 'Schule/Mathe',
        kind: 'folder',
        children: [
          { relativePath: 'Schule/Mathe/Aufgabe.md', kind: 'file', extension: 'md' },
          {
            relativePath: 'Schule/Mathe/Uebung',
            kind: 'folder',
            children: [{ relativePath: 'Schule/Mathe/Uebung/Blatt.md', kind: 'file', extension: 'md' }],
          },
        ],
      }],
    },
    { relativePath: 'Schule/Mathe-Extra', kind: 'folder', children: [{ relativePath: 'Schule/Mathe-Extra/Neben.md', kind: 'file', extension: 'md' }] },
    { relativePath: 'Andere.md', kind: 'file', extension: 'md' },
  ], async (path) => ({
    'Schule/Mathe/Aufgabe.md': '# Aufgabe\n\nIntegral von x',
    'Schule/Mathe/Uebung/Blatt.md': '# Blatt\n\nVerschachtelte Uebung',
    'Schule/Mathe-Extra/Neben.md': '# Neben\n\nNICHT-TEILEN-AUSSEN',
    'Andere.md': '# Andere\n\nAUSSEN-NOTIZ',
  })[path])
  const folder = await share.publishShare({
    entries: folderEntries,
    rootPath: 'Schule/Mathe',
    mode: 'copy',
    port: sharePort,
    origin,
    now: '2026-10-26T12:01:00.000Z',
  })
  assert.match(folder.request.body, /Integral von x/)
  assert.match(folder.request.body, /Verschachtelte Uebung/)
  assert.doesNotMatch(folder.request.body, /NICHT-TEILEN-AUSSEN/)
  assert.doesNotMatch(folder.request.body, /AUSSEN-NOTIZ/)
  const storedFolder = readFileSync(join(shareDir, `${folder.record.id}.json`), 'utf8')
  assert.match(storedFolder, /Integral von x/)
  assert.match(storedFolder, /Verschachtelte Uebung/)
  assert.doesNotMatch(storedFolder, /NICHT-TEILEN-AUSSEN/)
  assert.doesNotMatch(storedFolder, /AUSSEN-NOTIZ/)
  const folderRead = await share.readShare({ id: folder.record.id, port: sharePort, origin, entries: folderEntries })
  assert.equal(folderRead.notes.length, 2)
  assert.match(noteText(folderRead), /Integral von x/)
  assert.match(noteText(folderRead), /Verschachtelte Uebung/)
  assert.doesNotMatch(noteText(folderRead), /NICHT-TEILEN-AUSSEN/)
  assert.doesNotMatch(noteText(folderRead), /AUSSEN-NOTIZ/)

  const original = [{ path: 'Tagebuch.md', kind: 'file', content: '# Tagebuch\n\nErster Satz' }]
  const edited = [{ path: 'Tagebuch.md', kind: 'file', content: '# Tagebuch\n\nSpaeter geaendert' }]
  const copy = await share.publishShare({ entries: original, rootPath: 'Tagebuch.md', mode: 'copy', port: sharePort, origin })
  const copyRead = await share.readShare({ id: copy.record.id, port: sharePort, origin, entries: edited })
  assert.match(noteText(copyRead), /Erster Satz/)
  assert.doesNotMatch(noteText(copyRead), /Spaeter geaendert/)
  const live = await share.publishShare({ entries: original, rootPath: 'Tagebuch.md', mode: 'live', port: sharePort, origin })
  const liveRead = await share.readShare({ id: live.record.id, port: sharePort, origin, entries: edited })
  assert.match(noteText(liveRead), /Spaeter geaendert/)
  await share.refreshLiveShares({ entries: edited, directory: live.directory, port: sharePort, origin, now: '2026-10-26T12:02:00.000Z' })
  const liveStored = await share.readShare({ id: live.record.id, port: sharePort, origin })
  assert.match(noteText(liveStored), /Spaeter geaendert/)
  const copyStored = await share.readShare({ id: copy.record.id, port: sharePort, origin })
  assert.match(noteText(copyStored), /Erster Satz/)
  assert.doesNotMatch(noteText(copyStored), /Spaeter geaendert/)
  const copyFile = readFileSync(join(shareDir, `${copy.record.id}.json`), 'utf8')
  const liveFile = readFileSync(join(shareDir, `${live.record.id}.json`), 'utf8')
  assert.match(copyFile, /Erster Satz/)
  assert.doesNotMatch(copyFile, /Spaeter geaendert/)
  assert.match(liveFile, /Spaeter geaendert/)
  await assertLiveRefreshTimer(share, sharePort, origin)
  await assertStopBeatsLateUpload(share, sharePort, origin, sitePort)

  const settings = {
    ...defaults.defaultSettingsForPlatform('linux'),
    shareMode: 'copy',
    shareRecent: share.serializeShareDirectory(note.directory),
  }
  const html = renderToStaticMarkup(createElement(settingsModule.SettingsModal, {
    platform: 'linux',
    settings,
    vaultPath: '/vault',
    initialSection: 'share',
    onChange: () => undefined,
    onClose: () => undefined,
    onSelectVault: () => undefined,
    updateState: {
      status: 'idle',
      supported: true,
      currentVersion: '0',
      latestVersion: null,
      publishedAt: null,
      releaseNotes: [],
      downloadedBytes: 0,
      totalBytes: 0,
      progress: 0,
      error: null,
      block: null,
      checkedAt: null,
      installationKind: 'appimage',
      autoCheckUpdates: false,
      autoDownloadUpdates: false,
      installUpdatesOnQuit: false,
      updateChannel: 'stable',
    },
    onCheckUpdate: async () => undefined,
    onDownloadUpdate: async () => undefined,
    onInstallUpdate: async () => undefined,
    onResetSettings: () => undefined,
    onResetAppData: async () => undefined,
  }))
  const nav = html.slice(html.indexOf('aria-label="Einstellungsbereiche"'), html.indexOf('reset-settings'))
  const groups = [...nav.matchAll(/<div class="settings-nav-group"><small>([^<]+)<\/small>/gu)].map((match) => match[1].replaceAll('&amp;', '&'))
  const sections = [...nav.matchAll(/<span><b>[^<]+<\/b>/gu)].length
  const placeholder = html.match(/placeholder="([^"]+)"/u)?.[1] ?? ''
  assert.deepEqual(groups, ['Aussehen & Schreiben', 'Bedienung', 'Stift & Arbeitsbereich', 'Dateien & Vault', 'Sync', 'Profil', 'Teilen', 'Add-ons', 'Updates', 'Experimentell', 'Erweitert'])
  assert.equal(groups.includes('FaNotes & System'), false)
  assert.equal(sections, 12)
  assert.equal(placeholder, 'Einstellungen suchen')
  assert.match(html, /id="settings-share"/u)
  assert.doesNotMatch(html, /id="settings-editor"/u)
  assert.doesNotMatch(html, /id="settings-update-channel"/u)
  assert.doesNotMatch(html, /id="settings-reset"/u)
  assert.equal(Number(html.match(/Anpassung · (\d+) Optionen/u)?.[1]), html.match(/class="setting-row(?: [^"]*)?"/gu)?.length ?? 0)
  assert.match(html, /<b>Hallo<\/b>/u)
  assert.match(html, new RegExp(`data-share-stop="${note.record.id}"`, 'u'))
  const settingsLog = [
    `groups ${groups.join('|')}`,
    `sections ${sections}`,
    `searchPlaceholder ${placeholder}`,
    `listed Hallo`,
    `stopControl shareStopControl`,
    `shareId ${note.record.id}`,
  ].join('\n')
  writeScratch('share-settings.log', `${settingsLog}\nshare-settings ok\n`)
  console.log(settingsLog)

  const editable = await share.publishShare({
    entries: [{ path: 'Blatt.md', kind: 'file', content: '# Blatt\n\nEDITIERBARE ZEILE' }],
    rootPath: 'Blatt.md',
    mode: 'edit',
    port: sharePort,
    origin,
  })
  assert.equal(editable.payload.mode, 'edit')
  const editableStored = JSON.parse(readFileSync(join(shareDir, `${editable.record.id}.json`), 'utf8'))
  assert.equal(editableStored.mode, 'edit')
  assert.deepEqual(editableStored.editors, [])
  assert.equal(editableStored.revision, 1)
  const editablePublic = await (await fetch(`${origin}/api/v1/share/${editable.record.id}`)).json()
  assert.equal(editablePublic.mode, 'edit')
  assert.equal(Object.hasOwn(editablePublic, 'history'), false)
  assert.equal(Object.hasOwn(editablePublic, 'present'), false)
  assert.match(noteText(editablePublic), /EDITIERBARE ZEILE/)
  const copyAfterEdit = await share.readShare({ id: copy.record.id, port: sharePort, origin })
  const liveAfterEdit = await share.readShare({ id: live.record.id, port: sharePort, origin })
  assert.equal(copyAfterEdit.mode, 'copy')
  assert.equal(liveAfterEdit.mode, 'live')
  assert.match(noteText(copyAfterEdit), /Erster Satz/)
  assert.doesNotMatch(noteText(copyAfterEdit), /EDITIERBARE ZEILE/)
  assert.match(noteText(liveAfterEdit), /Spaeter geaendert/)
  assert.equal(Object.hasOwn(copyAfterEdit, 'editors'), false)
  assert.equal(Object.hasOwn(liveAfterEdit, 'editors'), false)
  await share.refreshLiveShares({
    entries: [{ path: 'Blatt.md', kind: 'file', content: '# Blatt\n\nLIVE-DARF-NICHT' }],
    directory: editable.directory,
    port: sharePort,
    origin,
  })
  const savedEdit = await share.readShare({ id: editable.record.id, port: sharePort, origin })
  assert.equal(savedEdit.mode, 'edit')
  assert.match(noteText(savedEdit), /EDITIERBARE ZEILE/)
  assert.doesNotMatch(noteText(savedEdit), /LIVE-DARF-NICHT/)
  const folderChoice = shareEdit.beginDesktopShareOpen(savedEdit, ['Schule', 'Privat'])
  assert.equal(folderChoice.step, 'folder')
  assert.equal(folderChoice.prompt, shareEdit.SHARE_DESKTOP_PROMPTS.folder)
  assert.deepEqual(folderChoice.folders, ['Schule', 'Privat'])
  assert.throws(() => shareEdit.chooseShareFolder(folderChoice, 'Geheim'), /Dieser Ordner gehört nicht zum Vault/u)
  const named = shareEdit.chooseShareFolder(folderChoice, 'Schule')
  assert.equal(named.step, 'identity')
  assert.equal(named.prompt, shareEdit.SHARE_DESKTOP_PROMPTS.identity)
  assert.equal(named.files[0].relativePath, 'Schule/Blatt.md')
  assert.equal(named.files[0].sharePath, 'Blatt.md')
  let nameClaimed = false
  const namedPerson = await shareEdit.confirmShareIdentity({
    state: named,
    choice: { kind: 'name', name: 'Ada Beispiel' },
    port: sharePort,
    origin,
    claim: async () => { nameClaimed = true; return 'should-not-run' },
  })
  assert.equal(nameClaimed, false)
  assert.deepEqual(namedPerson.editors, ['Ada Beispiel'])
  assert.equal(namedPerson.account, undefined)
  const sharerList = await share.readShare({ id: editable.record.id, port: sharePort, origin })
  assert.deepEqual(shareEdit.editorNames(sharerList.editors), ['Ada Beispiel'])
  await share.publishShare({
    entries: [{ path: 'Blatt.md', kind: 'file', content: '# Blatt\n\nUEBERSCHRIEBEN' }],
    rootPath: 'Blatt.md',
    mode: 'edit',
    id: editable.record.id,
    port: sharePort,
    origin,
  })
  const keptEdit = await share.readShare({ id: editable.record.id, port: sharePort, origin })
  assert.match(noteText(keptEdit), /EDITIERBARE ZEILE/)
  assert.doesNotMatch(noteText(keptEdit), /UEBERSCHRIEBEN/)
  assert.deepEqual(shareEdit.editorNames(keptEdit.editors), ['Ada Beispiel'])
  const accountShare = await share.publishShare({
    entries: [{ path: 'Konto.md', kind: 'file', content: '# Konto\n\nKontozeile' }],
    rootPath: 'Konto.md',
    mode: 'edit',
    port: sharePort,
    origin,
  })
  const accountSaved = await share.readShare({ id: accountShare.record.id, port: sharePort, origin })
  const accountFolder = shareEdit.beginDesktopShareOpen(accountSaved, ['Privat'])
  const accountIdentity = shareEdit.chooseShareFolder(accountFolder, 'Privat')
  let claimedInput = ''
  const accountPerson = await shareEdit.confirmShareIdentity({
    state: accountIdentity,
    choice: { kind: 'account', name: 'Ada Beispiel' },
    port: sharePort,
    origin,
    claim: async (value) => { claimedInput = value; return 'ada_notes' },
  })
  assert.equal(claimedInput, 'Ada Beispiel')
  assert.equal(accountPerson.name, 'ada_notes')
  assert.equal(accountPerson.account, 'ada_notes')
  assert.deepEqual(accountPerson.editors, ['ada_notes'])
  const accountListed = await share.readShare({ id: accountShare.record.id, port: sharePort, origin })
  assert.deepEqual(shareEdit.editorNames(accountListed.editors), ['ada_notes'])
  assert.equal(accountListed.editors.some((editor) => editor.name === 'Ada Beispiel'), false)
  const identityLog = [
    `folderPrompt ${folderChoice.prompt}`,
    `placed ${named.files[0].relativePath}`,
    `identityPrompt ${named.prompt}`,
    `typedName ${namedPerson.name}`,
    `editors ${namedPerson.editors.join('|')}`,
    `accountClaimInput ${claimedInput}`,
    `accountName ${accountPerson.name}`,
    `accountEditors ${accountPerson.editors.join('|')}`,
  ].join('\n')
  writeScratch('share-identity.log', `${identityLog}\nshare-identity ok\n`)
  console.log(identityLog)

  const baseCollab = '# Blatt\n\nAlpha\n\nOmega\n'
  const collabShare = await share.publishShare({
    entries: [{
      path: 'Blatt.md',
      kind: 'file',
      content: baseCollab,
      textFields: [{ page: 1, x: 0.2, y: 0.3, width: 0.4, fontSize: 16, text: 'Startfeld' }],
    }],
    rootPath: 'Blatt.md',
    mode: 'edit',
    port: sharePort,
    origin,
  })
  const collabSaved = await share.readShare({ id: collabShare.record.id, port: sharePort, origin })
  const ada = await shareEdit.openShareEditor({ share: collabSaved, name: 'Ada Beispiel', port: sharePort, origin, clientId: 'ada-client' })
  const bea = await shareEdit.openShareEditor({ share: collabSaved, name: 'Bea Beispiel', port: sharePort, origin, clientId: 'bea-client' })
  await ada.pull()
  assert.deepEqual(ada.peopleWhoCanEdit().sort(), ['Ada Beispiel', 'Bea Beispiel'])
  assert.ok(ada.peopleEditing().includes('Ada Beispiel') && ada.peopleEditing().includes('Bea Beispiel'), `editing ${ada.peopleEditing().join('|')}`)
  assert.ok(bea.peopleEditing().includes('Ada Beispiel') && bea.peopleEditing().includes('Bea Beispiel'), `editing ${bea.peopleEditing().join('|')}`)
  const adaSentence = 'Ada schreibt sofort eine eigene Zeile.'
  await ada.editNote('Blatt.md', { content: `${ada.documentText().replace(/\n$/u, '')}\n${adaSentence}\n` })
  await bea.pull()
  assert.match(bea.documentText(), new RegExp(adaSentence, 'u'))
  const beaSentence = 'Bea schreibt sofort eine eigene Zeile.'
  await bea.editNote('Blatt.md', { content: `${bea.documentText().replace(/\n$/u, '')}\n${beaSentence}\n` })
  await ada.pull()
  assert.match(ada.documentText(), new RegExp(adaSentence, 'u'))
  assert.match(ada.documentText(), new RegExp(beaSentence, 'u'))
  assert.match(bea.documentText(), new RegExp(beaSentence, 'u'))
  await bea.leave()
  await ada.pull()
  assert.equal(ada.peopleEditing().includes('Bea Beispiel'), false)
  assert.ok(ada.peopleEditing().includes('Ada Beispiel'))
  const field = { page: 1, x: 0.2, y: 0.3, width: 0.4, fontSize: 16, text: 'Feld von Bea' }
  const stroke = { color: '#112233', width: 2, opacity: 1, points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.6 }] }
  const adaInk = { width: 900, height: 1273, strokes: [stroke] }
  const fresh = await share.publishShare({
    entries: [{
      path: 'Blatt.md',
      kind: 'file',
      content: baseCollab,
      textFields: [{ page: 1, x: 0.2, y: 0.3, width: 0.4, fontSize: 16, text: 'Startfeld' }],
    }],
    rootPath: 'Blatt.md',
    mode: 'edit',
    port: sharePort,
    origin,
  })
  const freshSaved = await share.readShare({ id: fresh.record.id, port: sharePort, origin })
  const adaTwo = await shareEdit.openShareEditor({ share: freshSaved, name: 'Ada Beispiel', port: sharePort, origin, clientId: 'ada-two' })
  const beaTwo = await shareEdit.openShareEditor({ share: freshSaved, name: 'Bea Beispiel', port: sharePort, origin, clientId: 'bea-two' })
  await Promise.all([
    adaTwo.editNote('Blatt.md', { content: '# Blatt\n\nAlpha von Ada\n\nOmega\n', ink: adaInk }),
    beaTwo.editNote('Blatt.md', { content: '# Blatt\n\nAlpha\n\nOmega von Bea\n', textFields: [field] }),
  ])
  await adaTwo.pull()
  await beaTwo.pull()
  assert.match(adaTwo.documentText(), /Alpha von Ada/u)
  assert.match(adaTwo.documentText(), /Omega von Bea/u)
  assert.match(beaTwo.documentText(), /Alpha von Ada/u)
  assert.match(beaTwo.documentText(), /Omega von Bea/u)
  const mergedRead = await share.readShare({ id: fresh.record.id, port: sharePort, origin })
  assert.equal(mergedRead.notes[0].ink.strokes.length, 1)
  assert.equal(mergedRead.notes[0].textFields[0].text, 'Feld von Bea')
  assert.match(mergedRead.notes[0].content, /Alpha von Ada/u)
  assert.match(mergedRead.notes[0].content, /Omega von Bea/u)
  await adaTwo.editNote('Blatt.md', { content: `${adaTwo.documentText().replace(/\n$/u, '')}\nNur Text.\n` })
  await beaTwo.pull()
  assert.match(beaTwo.documentText(), /Nur Text\./u)
  const keptInk = await share.readShare({ id: fresh.record.id, port: sharePort, origin })
  assert.equal(keptInk.notes[0].ink.strokes.length, 1)
  await adaTwo.editNote('Blatt.md', { ink: null })
  await beaTwo.pull()
  const cleared = await share.readShare({ id: fresh.record.id, port: sharePort, origin })
  assert.equal(cleared.notes[0].ink, undefined)
  assert.match(cleared.notes[0].content, /Nur Text\./u)
  assert.match(cleared.notes[0].content, /Alpha von Ada/u)
  assert.match(beaTwo.documentText(), /Nur Text\./u)

  const dirtyShare = await share.publishShare({
    entries: [{ path: 'Zeile.md', kind: 'file', content: 'Zeile\n' }],
    rootPath: 'Zeile.md',
    mode: 'edit',
    port: sharePort,
    origin,
  })
  const dirtySaved = await share.readShare({ id: dirtyShare.record.id, port: sharePort, origin })
  const adaDirty = await shareEdit.openShareEditor({ share: dirtySaved, name: 'Ada Beispiel', port: sharePort, origin, clientId: 'ada-dirty' })
  const beaHold = await shareEdit.openShareEditor({ share: dirtySaved, name: 'Bea Beispiel', port: sharePort, origin, clientId: 'bea-hold' })
  const beaShow = await shareEdit.openShareEditor({ share: dirtySaved, name: 'Bea Beispiel', port: sharePort, origin, clientId: 'bea-show' })
  const beaAbsorb = await shareEdit.openShareEditor({ share: dirtySaved, name: 'Bea Beispiel', port: sharePort, origin, clientId: 'bea-absorb' })
  await adaDirty.editNote('Zeile.md', { content: 'Zeile\nAda\n' })
  await beaHold.pull()
  await beaShow.pull()
  await beaAbsorb.pull()
  assert.equal(beaHold.basisContent('Zeile.md'), 'Zeile\n')
  assert.equal(beaHold.noteContent('Zeile.md'), 'Zeile\nAda\n')
  assert.equal(shareEdit.remoteTextForEditor('Zeile\nBea\n', beaHold.noteContent('Zeile.md'), true), null)
  assert.equal(shareEdit.remoteTextForEditor('Zeile\n', '', false), '')
  assert.equal(shareEdit.remoteTextForEditor('Zeile\n', beaHold.noteContent('Zeile.md'), false), beaHold.noteContent('Zeile.md'))
  const decisionHold = shareEdit.shareTickDecision({
    editorDoc: 'Zeile\nBea\n',
    coalescerPending: true,
    composing: false,
    remoteText: beaHold.noteContent('Zeile.md'),
    basisText: beaHold.basisContent('Zeile.md'),
  })
  const decisionShow = shareEdit.shareTickDecision({
    editorDoc: 'Zeile\n',
    coalescerPending: false,
    composing: false,
    remoteText: beaShow.noteContent('Zeile.md'),
    basisText: beaShow.basisContent('Zeile.md'),
  })
  const decisionAbsorb = shareEdit.shareTickDecision({
    editorDoc: beaAbsorb.noteContent('Zeile.md'),
    coalescerPending: false,
    composing: false,
    remoteText: beaAbsorb.noteContent('Zeile.md'),
    basisText: beaAbsorb.basisContent('Zeile.md'),
  })
  assert.equal(decisionHold, 'hold')
  assert.equal(decisionShow, 'showRemote')
  assert.equal(decisionAbsorb, 'absorb')
  assert.equal(shareEdit.shareTickDecision({
    editorDoc: null,
    coalescerPending: false,
    composing: false,
    remoteText: beaHold.noteContent('Zeile.md'),
    basisText: beaHold.basisContent('Zeile.md'),
  }), 'hold')
  assert.equal(shareEdit.shareTickDecision({
    editorDoc: 'Zeile\n',
    coalescerPending: false,
    composing: true,
    remoteText: beaShow.noteContent('Zeile.md'),
    basisText: beaShow.basisContent('Zeile.md'),
  }), 'hold')
  const showBasis = beaShow.basisContent('Zeile.md')
  assert.equal(showBasis, 'Zeile\n')
  beaAbsorb.absorb('Zeile.md', { content: beaAbsorb.noteContent('Zeile.md') })
  const absorbedBasis = beaAbsorb.basisContent('Zeile.md')
  assert.equal(absorbedBasis, 'Zeile\nAda\n')
  await beaHold.editNote('Zeile.md', { content: 'Zeile\nBea\n' })
  assert.match(beaHold.documentText(), /Ada/u)
  assert.match(beaHold.documentText(), /Bea/u)
  await beaShow.editNote('Zeile.md', { content: 'Zeile\nBea\n' })
  assert.match(beaShow.documentText(), /Ada/u)
  assert.match(beaShow.documentText(), /Bea/u)
  const dirtyRead = await share.readShare({ id: dirtyShare.record.id, port: sharePort, origin })
  assert.match(dirtyRead.notes[0].content, /Ada/u)
  assert.match(dirtyRead.notes[0].content, /Bea/u)

  const adaStroke = { color: '#112233', width: 2, opacity: 1, points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.6 }] }
  const localStroke = { color: '#112233', width: 2, opacity: 1, points: [{ x: 0.5, y: 0.2 }, { x: 0.5, y: 0.6 }] }
  const adaField = { page: 1, x: 0.2, y: 0.3, width: 0.4, fontSize: 16, text: 'Feld von Ada' }
  const beaField = { page: 1, x: 0.7, y: 0.3, width: 0.4, fontSize: 16, text: 'Feld von Bea' }
  const inkEditShare = await share.publishShare({
    entries: [{ path: 'Blatt.md', kind: 'file', content: 'Zeile\n' }],
    rootPath: 'Blatt.md',
    mode: 'edit',
    port: sharePort,
    origin,
  })
  const inkEditSaved = await share.readShare({ id: inkEditShare.record.id, port: sharePort, origin })
  const adaInkClient = await shareEdit.openShareEditor({ share: inkEditSaved, name: 'Ada Beispiel', port: sharePort, origin, clientId: 'ada-ink' })
  const beaInkClient = await shareEdit.openShareEditor({ share: inkEditSaved, name: 'Bea Beispiel', port: sharePort, origin, clientId: 'bea-ink' })
  await adaInkClient.editNote('Blatt.md', { ink: { width: 900, height: 1273, strokes: [adaStroke] }, textFields: [adaField] })
  await beaInkClient.pull()
  const previousJson = JSON.stringify({ schemaVersion: 1, width: 900, height: 1273, strokes: [localStroke] })
  const nextJson = JSON.stringify({ schemaVersion: 1, width: 900, height: 1273, strokes: [adaStroke] })
  const afterSave = { id: 'sheet-1', drawingJson: previousJson }
  assert.equal(overlay.inkDocumentIsOwnSave(afterSave, 'sheet-1', nextJson), true)
  const loadStep = overlay.drawingLoadStep({
    loadedId: 'sheet-1',
    loadedJson: previousJson,
    sourceId: 'sheet-1',
    nextJson,
    authored: afterSave,
  })
  assert.equal(loadStep, 'mergeRemote')
  const echoStep = overlay.drawingLoadStep({
    loadedId: 'sheet-1',
    loadedJson: '{"strokes":[]}',
    sourceId: 'sheet-1',
    nextJson: previousJson,
    authored: afterSave,
  })
  assert.equal(echoStep, 'acknowledge')
  const paintedStrokes = loadStep === 'mergeRemote'
    ? shareEdit.strokesAfterRemoteJson([localStroke], previousJson, nextJson)
    : [localStroke]
  const paintedXs = paintedStrokes.flatMap((stroke) => (stroke.points ?? []).map((point) => point.x))
  assert.equal(paintedStrokes.length, 2)
  assert.ok(paintedXs.includes(0.1), `remote stroke x ${paintedXs.join(',')}`)
  assert.ok(paintedXs.includes(0.5), `local stroke x ${paintedXs.join(',')}`)
  const paintedAgain = shareEdit.strokesAfterRemoteJson(paintedStrokes, nextJson, nextJson)
  assert.equal(paintedAgain.length, 2)
  const prepared = beaInkClient.prepareLocalEdit('Blatt.md', {
    ink: { width: 900, height: 1273, strokes: [localStroke] },
    textFields: [beaField],
  })
  assert.equal(prepared.ink.strokes.length, 2)
  assert.equal(prepared.textFields.length, 2)
  await beaInkClient.editNote('Blatt.md', {
    ink: { width: 900, height: 1273, strokes: [localStroke] },
    textFields: [beaField],
  })
  const bothInk = await share.readShare({ id: inkEditShare.record.id, port: sharePort, origin })
  assert.equal(bothInk.notes[0].ink.strokes.length, 2)
  const inkXs = bothInk.notes[0].ink.strokes.flatMap((stroke) => stroke.points.map((point) => point.x))
  assert.ok(inkXs.includes(0.1), `ink x ${inkXs.join(',')}`)
  assert.ok(inkXs.includes(0.5), `ink x ${inkXs.join(',')}`)
  assert.ok(bothInk.notes[0].textFields.some((field) => field.text === 'Feld von Ada'))
  assert.ok(bothInk.notes[0].textFields.some((field) => field.text === 'Feld von Bea'))
  await beaInkClient.editNote('Blatt.md', { ink: { width: 900, height: 1273, strokes: [localStroke] } })
  const keptBoth = await share.readShare({ id: inkEditShare.record.id, port: sharePort, origin })
  assert.equal(keptBoth.notes[0].ink.strokes.length, 2)

  const staleShare = await share.publishShare({
    entries: [{ path: 'Ursprung.md', kind: 'file', content: 'Ursprung\n' }],
    rootPath: 'Ursprung.md',
    mode: 'edit',
    port: sharePort,
    origin,
  })
  const staleSaved = await share.readShare({ id: staleShare.record.id, port: sharePort, origin })
  const mover = await shareEdit.openShareEditor({ share: staleSaved, name: 'Ada Beispiel', port: sharePort, origin, clientId: 'ada-move' })
  const staleClient = await shareEdit.openShareEditor({ share: staleSaved, name: 'Bea Beispiel', port: sharePort, origin, clientId: 'bea-stale' })
  for (let step = 1; step <= 5; step += 1) {
    await mover.editNote('Ursprung.md', { content: `Stand ${step}\n` })
  }
  await staleClient.editNote('Ursprung.md', { content: 'Ursprung\n' })
  const afterStale = await share.readShare({ id: staleShare.record.id, port: sharePort, origin })
  assert.match(afterStale.notes[0].content, /Stand 5/u)
  assert.doesNotMatch(afterStale.notes[0].content, /Ursprung/u)
  const stalePost = await sharePort.exchange({
    method: 'POST',
    url: `${origin}/api/v1/share/${staleShare.record.id}/edit`,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-FaNotes-Share': '1' },
    body: JSON.stringify({
      clientId: 'bea-stale-raw',
      name: 'Bea Beispiel',
      baseRevision: 1,
      notes: staleSaved.notes,
    }),
  })
  assert.equal(stalePost.status, 409)
  const afterRaw = await share.readShare({ id: staleShare.record.id, port: sharePort, origin })
  assert.match(afterRaw.notes[0].content, /Stand 5/u)
  assert.doesNotMatch(afterRaw.notes[0].content, /Ursprung/u)

  const refused = await sharePort.exchange({
    method: 'POST',
    url: `${origin}/api/v1/share/${copy.record.id}/edit`,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-FaNotes-Share': '1' },
    body: JSON.stringify({ clientId: 'copy-client', name: 'Ada Beispiel', baseRevision: 1, notes: copy.payload.notes }),
  })
  assert.equal(refused.status, 409)
  const collabLog = [
    `adaSentence ${adaSentence}`,
    `beaSawAda ${bea.documentText().includes(adaSentence)}`,
    `beaSentence ${beaSentence}`,
    `adaSawBea ${ada.documentText().includes(beaSentence)}`,
    `editingAfterLeave ${ada.peopleEditing().join('|')}`,
    `merged ${adaTwo.documentText().replace(/\n/gu, ' | ')}`,
    `strokes ${mergedRead.notes[0].ink.strokes.length}`,
    `textKeepsStroke ${keptInk.notes[0].ink.strokes.length}`,
    `clearedInk ${cleared.notes[0].ink === undefined}`,
    `field ${mergedRead.notes[0].textFields[0].text}`,
    `dirtyBoth ${dirtyRead.notes[0].content.includes('Ada') && dirtyRead.notes[0].content.includes('Bea')}`,
    `hold ${decisionHold}`,
    `showRemote ${decisionShow}`,
    `showBasis ${showBasis === 'Zeile\n'}`,
    `absorbWhenAda ${decisionAbsorb === 'absorb' && absorbedBasis === 'Zeile\nAda\n'}`,
    `strokesBoth ${paintedXs.includes(0.5) && paintedXs.includes(0.1)}`,
    `mergeRemote ${loadStep === 'mergeRemote' && echoStep === 'acknowledge'}`,
    `remoteClear ${shareEdit.remoteTextForEditor('Zeile\n', '', false) === ''}`,
    `inkBoth ${bothInk.notes[0].ink.strokes.length}`,
    `inkKept ${keptBoth.notes[0].ink.strokes.length}`,
    `staleKept ${afterRaw.notes[0].content.includes('Stand 5')}`,
    `staleStatus ${stalePost.status}`,
    `copyEditStatus ${refused.status}`,
  ].join('\n')
  writeScratch('share-collab.log', `${collabLog}\nshare-collab ok\n`)
  console.log(collabLog)

  const viewed = await openViewer(note.record.link, 'Guten Tag aus der Notiz')
  if (viewed.launched) {
    assert.equal(viewed.errors.length, 0, `page errors: ${viewed.errors.join(' | ')}`)
    assert.match(viewed.text, /Hallo/)
    assert.match(viewed.text, /Guten Tag aus der Notiz/)
    assert.doesNotMatch(viewed.text, /# Hallo/)
    const inkView = await reloadViewer({ ...viewed, link: inkShare.record.link }, 'Neben der Linie')
    assert.equal(inkView.errors.length, 0, `ink page errors: ${inkView.errors.join(' | ')}`)
    assert.match(inkView.text, /Skizze/)
    assert.match(inkView.text, /Neben der Linie/)
    assert.doesNotMatch(inkView.text, /fanotes-ink/)
    assert.doesNotMatch(inkView.text, /Die Handschrift fehlt/)
    const inkShapes = await viewed.cdp.evaluate('document.querySelectorAll(".share-ink polyline").length')
    assert.equal(inkShapes, 1)
    const columnLeft = await viewed.cdp.evaluate('document.querySelector(".share-column").style.left')
    assert.equal(columnLeft, '72px')
    const columnTop = await viewed.cdp.evaluate('document.querySelector(".share-column").style.top')
    assert.equal(columnTop, '78px')
    const lineText = await viewed.cdp.evaluate('[...document.querySelectorAll(".share-line")].map((line) => line.textContent).join("\\n")')
    assert.match(lineText, /# Skizze/)
    assert.doesNotMatch(lineText, /fanotes-ink/)
    const sectionView = await reloadViewer({ ...viewed, link: sectionShare.record.link }, 'Strahlensatz')
    assert.equal(sectionView.errors.length, 0, `section page errors: ${sectionView.errors.join(' | ')}`)
    assert.match(sectionView.text, /Strahlensatz/)
    assert.match(sectionView.text, /Unterteil/)
    assert.match(sectionView.text, /Zeile unter dem Abschnitt/)
    assert.match(sectionView.text, /Im Abschnitt/)
    assert.doesNotMatch(sectionView.text, /fanotes-ink/)
    const sectionBands = await viewed.cdp.evaluate('document.querySelectorAll(".share-section").length')
    assert.equal(sectionBands, 2)
    const sectionShapes = await viewed.cdp.evaluate('document.querySelectorAll(".share-ink polyline").length')
    assert.equal(sectionShapes, 2)
    const sectionOrigin = await viewed.cdp.evaluate('document.querySelector(".share-column").style.top')
    assert.equal(sectionOrigin, '98px')
    if (scratch && viewed.screenshot) writeFileSync(join(scratch, 'share-view.png'), viewed.screenshot)
    const folderView = await reloadViewer({ ...viewed, link: folder.record.link }, 'Verschachtelte Uebung')
    assert.equal(folderView.errors.length, 0, `folder page errors: ${folderView.errors.join(' | ')}`)
    assert.match(folderView.text, /Integral von x/)
    assert.match(folderView.text, /Verschachtelte Uebung/)
    assert.doesNotMatch(folderView.text, /NICHT-TEILEN-AUSSEN/)
    assert.doesNotMatch(folderView.text, /AUSSEN-NOTIZ/)
    viewed.errors.length = 0
    await viewed.cdp.send('Page.navigate', { url: editable.record.link })
    const editQuestion = 'Im Browser ansehen oder in der Desktop-App bearbeiten?'
    let editText = await waitForText(viewed.cdp, editQuestion)
    assert.equal(viewed.errors.length, 0, `edit page errors: ${viewed.errors.join(' | ')}`)
    assert.match(editText, /Im Browser ansehen/u)
    assert.match(editText, /In der Desktop-App bearbeiten/u)
    assert.doesNotMatch(editText, /EDITIERBARE ZEILE/u)
    viewed.errors.length = 0
    await viewed.cdp.send('Page.navigate', { url: editable.record.link })
    editText = await waitForText(viewed.cdp, editQuestion)
    assert.equal(viewed.errors.length, 0, `edit reload errors: ${viewed.errors.join(' | ')}`)
    assert.equal(editText.includes(editQuestion), true)
    assert.doesNotMatch(editText, /EDITIERBARE ZEILE/u)
    await viewed.cdp.evaluate(`document.querySelector('[data-share-choice="desktop"]').click()`)
    const installQuestion = 'Installer herunterladen oder ist FaNotes schon installiert?'
    editText = await waitForText(viewed.cdp, installQuestion)
    assert.match(editText, /Installer herunterladen/u)
    assert.match(editText, /FaNotes ist schon installiert/u)
    const installedHref = await viewed.cdp.evaluate(`document.querySelector('[data-share-choice="installed"]').getAttribute('href')`)
    assert.equal(installedHref, `fanotes://share/${editable.record.id}`)
    assert.equal(shareEdit.parseShareProtocol(installedHref), editable.record.id)
    const installedPayload = await share.readShare({ id: editable.record.id, port: sharePort, origin })
    const installedFolder = shareEdit.beginDesktopShareOpen(installedPayload, ['Schule', 'Privat'])
    assert.equal(installedFolder.step, 'folder')
    assert.equal(installedFolder.prompt, 'In welchem Ordner soll die geteilte Datei liegen?')
    assert.equal(installedFolder.share.id, editable.record.id)
    await viewed.cdp.evaluate(`document.querySelector('[data-share-choice="download"]').click()`)
    const again = 'Öffne die Datei jetzt in FaNotes.'
    editText = await waitForText(viewed.cdp, again)
    const downloadHref = await viewed.cdp.evaluate('window.__fanotesShareDownload')
    assert.equal(downloadHref, '/download/appimage')
    const openHref = await viewed.cdp.evaluate(`document.querySelector('[data-share-choice="open"]').getAttribute('href')`)
    assert.equal(openHref, `fanotes://share/${editable.record.id}`)
    assert.equal(viewed.errors.length, 0, `edit choice errors: ${viewed.errors.join(' | ')}`)
    const pageLaunch = [
      `errors 0`,
      `question ${editQuestion}`,
      `reload ${editQuestion}`,
      `install ${installQuestion}`,
      `installed ${installedHref}`,
      `folder ${installedFolder.prompt}`,
      `download ${downloadHref}`,
      `again ${again}`,
    ].join('\n')
    writeScratch('share-page-launch.log', `${pageLaunch}\nshare-page-launch ok\n`)
    console.log(pageLaunch)
  } else {
    writeScratch('share-page-launch.log', 'launch failed\n')
  }

  const stopped = await page.shareStopControl({ id: note.record.id, port: sharePort, origin, directory: note.directory })
  assert.equal(stopped.shares.find((item) => item.id === note.record.id)?.stopped, true)
  const stoppedResponse = await fetch(`${origin}/api/v1/share/${note.record.id}`)
  assert.equal(stoppedResponse.status, 410)
  const afterStop = await share.readShare({ id: note.record.id, port: sharePort, origin, entries: oneEntries })
  assert.equal(afterStop, null)

  if (viewed.launched) {
    const stoppedView = await reloadViewer(viewed, 'Diese Freigabe wurde beendet.')
    assert.equal(stoppedView.errors.length, 0, `stopped page errors: ${stoppedView.errors.join(' | ')}`)
    assert.match(stoppedView.text, /Diese Freigabe wurde beendet/)
    assert.doesNotMatch(stoppedView.text, /Guten Tag aus der Notiz/)
    assert.doesNotMatch(stoppedView.text, /Hallo/)
  }

  const putStatuses = localExchanges.filter((exchange) => exchange.method === 'PUT').map((exchange) => exchange.status)
  assert.ok(putStatuses.length > 0, 'the shipped client did not PUT a share')
  assert.ok(putStatuses.every((status) => status === 200), `local PUT statuses ${putStatuses.join(',')}`)
  const hostLog = [
    `status ${putStatuses[0]}`,
    `link ${note.record.link}`,
    `puts ${putStatuses.join(',')}`,
  ].join('\n')
  writeScratch('share-host.log', `${hostLog}\n`)
  console.log(hostLog.trim())
  console.log(JSON.stringify({
    link: note.record.link,
    folderNotes: folderRead.notes.map((item) => item.path),
    copyKeepsOriginal: true,
    liveShowsEdit: true,
    stopped: true,
    settingsSections: sections,
    placeholder,
    viewer: viewed.launched ? 'shown' : 'launch-failed',
    cloud: 'server.mjs',
  }))
  console.log('share-check ok')
  if (viewed?.socket) viewed.socket.close()
} finally {
  if (chromium && chromium.exitCode === null) {
    try { process.kill(-chromium.pid, 'SIGTERM') } catch { chromium.kill('SIGTERM') }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      chromium.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  if (chromiumProfile) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        rmSync(chromiumProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        break
      } catch (error) {
        if (attempt === 7) throw error
        await wait(250)
      }
    }
  }
  if (siteServer && siteServer.exitCode === null) {
    siteServer.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500)
      siteServer.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  rmSync(serverTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  await vite.close()
}

async function assertLiveRefreshTimer(share, sharePort, origin) {
  const calls = []
  const recordingPort = {
    async exchange(request) {
      calls.push({ method: request.method, body: request.body })
      return sharePort.exchange(request)
    },
  }
  const published = await share.publishShare({
    entries: [{ path: 'Timer.md', kind: 'file', content: '# Timer\n\nVorher' }],
    rootPath: 'Timer.md',
    mode: 'live',
    port: sharePort,
    origin,
  })
  const recent = share.serializeShareDirectory(published.directory)
  share.queueLiveShareRefresh({
    settingsRecent: () => recent,
    loadEntries: async () => [{ path: 'Timer.md', kind: 'file', content: '# Timer\n\nNachher-Timer' }],
    port: recordingPort,
    origin,
  })
  await wait(2500)
  assert.ok(calls.some((call) => call.method === 'PUT' && call.body.includes('Nachher-Timer')))
  const updated = await share.readShare({ id: published.record.id, port: sharePort, origin })
  assert.match(noteText(updated), /Nachher-Timer/)

  const currentShare = await share.publishShare({
    entries: [{ path: 'Aktuell.md', kind: 'file', content: '# Aktuell\n\nOriginal-Timer' }],
    rootPath: 'Aktuell.md',
    mode: 'live',
    port: sharePort,
    origin,
  })
  let current = share.serializeShareDirectory(currentShare.directory)
  calls.length = 0
  share.queueLiveShareRefresh({
    settingsRecent: () => current,
    loadEntries: async () => [{ path: 'Aktuell.md', kind: 'file', content: '# Aktuell\n\nDARF-NICHT-HOCH' }],
    port: recordingPort,
    origin,
  })
  current = share.serializeShareDirectory(share.markShareStopped(currentShare.directory, currentShare.record.id))
  await wait(2500)
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0, 'timer must read the directory when it fires')
  const untouched = await share.readShare({ id: currentShare.record.id, port: sharePort, origin })
  assert.match(noteText(untouched), /Original-Timer/)
  assert.doesNotMatch(noteText(untouched), /DARF-NICHT-HOCH/)

  const stopping = await share.publishShare({
    entries: [{ path: 'Stopp.md', kind: 'file', content: '# Stopp\n\nBleibt-weg' }],
    rootPath: 'Stopp.md',
    mode: 'live',
    port: sharePort,
    origin,
  })
  const stale = share.serializeShareDirectory(stopping.directory)
  calls.length = 0
  share.queueLiveShareRefresh({
    settingsRecent: () => stale,
    loadEntries: async () => [{ path: 'Stopp.md', kind: 'file', content: '# Stopp\n\nWIEDER-DA' }],
    port: recordingPort,
    origin,
  })
  await share.stopShare({ id: stopping.record.id, port: recordingPort, origin, directory: stopping.directory })
  await wait(2500)
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0, 'stop must cancel the pending live refresh')
  assert.ok(calls.some((call) => call.method === 'DELETE'))
  assert.equal(await share.readShare({ id: stopping.record.id, port: sharePort, origin }), null)
}

function startBlockedPut(port, id) {
  let release = () => undefined
  const response = new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/share/${id}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-FaNotes-Share': '1',
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.flushHeaders()
    release = (body) => req.end(body)
  })
  return { response, release: (body) => release(body) }
}

async function assertStopBeatsLateUpload(share, sharePort, origin, sitePort) {
  const chunk = 'B'.repeat(400_000)
  const large = await share.publishShare({
    entries: [1, 2, 3].map((number) => ({
      path: `Gross/Blatt-${number}.md`,
      kind: 'file',
      content: `# Blatt ${number}\n\n${chunk}`,
    })),
    rootPath: 'Gross',
    mode: 'copy',
    port: sharePort,
    origin,
  })
  const largeFile = readFileSync(join(shareDir, `${large.record.id}.json`), 'utf8')
  assert.ok(largeFile.length > 1_000_000, 'a share larger than the old 1 MB proxy cap was not stored')
  assert.equal(largeFile.split(chunk).length, 4)

  const existing = await share.publishShare({
    entries: [{ path: 'Rennen.md', kind: 'file', content: '# Rennen\n\nOriginal-Rennen' }],
    rootPath: 'Rennen.md',
    mode: 'live',
    port: sharePort,
    origin,
  })
  const replacement = JSON.stringify({
    schemaVersion: 1,
    id: existing.record.id,
    mode: 'live',
    kind: 'note',
    rootPath: 'Rennen.md',
    title: 'Rennen',
    notes: [{ path: 'Rennen.md', title: 'Rennen', content: '# Rennen\n\nWIEDER-DA' }],
    updatedAt: '2026-10-26T12:03:00.000Z',
  })
  const blocked = startBlockedPut(sitePort, existing.record.id)
  await wait(150)
  const deleted = await fetch(`${origin}/api/v1/share/${existing.record.id}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json', 'X-FaNotes-Share': '1' },
  })
  assert.equal(deleted.status, 200)
  blocked.release(replacement)
  const latePut = await blocked.response
  assert.equal(latePut.status, 410)
  assert.doesNotMatch(latePut.body, /WIEDER-DA/)
  const after = await fetch(`${origin}/api/v1/share/${existing.record.id}`)
  assert.equal(after.status, 410)
  const disk = readFileSync(join(shareDir, `${existing.record.id}.json`), 'utf8')
  assert.doesNotMatch(disk, /WIEDER-DA/)
  assert.match(disk, /"stopped":true/u)

  let releaseEntries
  const calls = []
  const recording = {
    async exchange(request) {
      calls.push(request.method)
      return { status: 200, body: '{}' }
    },
  }
  const pending = share.refreshSharesOpenedInSettings({
    loadEntries: () => new Promise((resolve) => { releaseEntries = resolve }),
    readDirectory: () => share.serializeShareDirectory(existing.directory),
    port: recording,
    origin,
  })
  await share.stopShare({ id: existing.record.id, port: recording, origin, directory: existing.directory })
  releaseEntries([{ path: 'Rennen.md', kind: 'file', content: '# Rennen\n\nSpaeter' }])
  assert.equal(await pending, 'skipped')
  assert.equal(calls.filter((method) => method === 'PUT').length, 0)
  assert.ok(calls.includes('DELETE'))

  let releaseFirst = null
  let markStarted = () => undefined
  const started = new Promise((resolve) => { markStarted = resolve })
  const methods = []
  const blockingPort = {
    async exchange(request) {
      methods.push(request.method)
      if (request.method === 'PUT' && releaseFirst === null) {
        await new Promise((resolve) => {
          releaseFirst = resolve
          markStarted()
        })
      }
      return { status: 200, body: '{}' }
    },
  }
  const liveShare = (id, path) => ({
    id, link: `${origin}/share/?id=${id}`, title: path, rootPath: path, mode: 'live', kind: 'note', createdAt: '', stopped: false,
  })
  const refreshing = share.refreshLiveShares({
    entries: [
      { path: 'A.md', kind: 'file', content: '# A\n\nEins' },
      { path: 'B.md', kind: 'file', content: '# B\n\nZwei' },
    ],
    directory: { shares: [liveShare('a'.repeat(32), 'A.md'), liveShare('b'.repeat(32), 'B.md')] },
    port: blockingPort,
    origin,
  })
  await started
  await share.stopShare({
    id: 'a'.repeat(32),
    port: blockingPort,
    origin,
    directory: { shares: [liveShare('a'.repeat(32), 'A.md'), liveShare('b'.repeat(32), 'B.md')] },
  })
  releaseFirst()
  await refreshing
  assert.equal(methods.filter((method) => method === 'PUT').length, 1, 'a settings refresh must not upload another note after stop')
}

function createCdp(socket, errors) {
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || 'exception')
    }
    if (!message.id || !pending.has(message.id)) return
    const callback = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) callback.reject(new Error(message.error.message))
    else callback.resolve(message.result)
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    evaluate(expression) {
      return this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then((result) => {
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
        return result.result.value
      })
    },
  }
}

class LaunchError extends Error {}

async function openViewer(link, expected) {
  const errors = []
  try {
    const debugPort = 23000 + Math.floor(Math.random() * 10000)
    chromiumProfile = mkdtempSync(join(tmpdir(), 'fanotes-share-chrome-'))
    chromium = spawn('/usr/bin/chromium', [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=1280,800',
      `--user-data-dir=${chromiumProfile}`,
      `--remote-debugging-port=${debugPort}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
    let socket
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (chromium.exitCode !== null) throw new LaunchError(`Chromium exited ${chromium.exitCode}`)
      try {
        const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
        const page = pages.find((candidate) => candidate.type === 'page')
        if (page?.webSocketDebuggerUrl) {
          socket = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true })
            socket.addEventListener('error', reject, { once: true })
          })
          break
        }
      } catch { /* still booting */ }
      await wait(80)
    }
    if (!socket) throw new LaunchError('Chromium debugging did not become available.')
    const cdp = createCdp(socket, errors)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url: link })
    const text = await waitForText(cdp, expected)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    return { launched: true, link, text, errors, screenshot: Buffer.from(shot.data, 'base64'), cdp, socket }
  } catch (error) {
    if (error instanceof LaunchError || (error instanceof Error && /Chromium|ECONNREFUSED|debugging/u.test(error.message))) {
      const message = error instanceof Error ? error.message : String(error)
      writeScratch('share-view-launch.txt', `${message}\n`)
      console.log(`share-view launch failed: ${message}`)
      return { launched: false, text: '', errors, screenshot: null, cdp: null, socket: null }
    }
    throw error
  }
}

async function reloadViewer(viewed, expected) {
  viewed.errors.length = 0
  await viewed.cdp.send('Page.navigate', { url: viewed.link })
  const text = await waitForText(viewed.cdp, expected)
  return { text, errors: viewed.errors }
}

async function waitForText(cdp, expected) {
  const deadline = Date.now() + 8000
  let text = ''
  while (Date.now() < deadline) {
    text = await cdp.evaluate('document.body ? document.body.innerText : ""')
    if (text.includes(expected)) return text
    await wait(80)
  }
  throw new Error(`Viewer did not show «${expected}». Page text: ${text.slice(0, 500)}`)
}
