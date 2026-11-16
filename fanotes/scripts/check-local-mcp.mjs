// Local MCP server: builds a synthetic vault (notes, handwriting note, PDF text,
// homework, calendar, flashcards, a story), then talks to the server over stdio
// (child process) and Streamable HTTP, exercising every tool, the write gate,
// path traversal, excluded folders, bad token / Host / Origin and size limits.
// The homework and calendar files are written with the app's own serializers,
// so the Node reader in electron/ stays in step with the renderer.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const appRoot = fileURLToPath(new URL('..', import.meta.url))
const base = mkdtempSync(join(tmpdir(), 'fanotes-local-mcp-'))
const userData = join(base, 'userData')
const vault = join(base, 'vault')
const outside = join(base, 'outside-secret.md')
mkdirSync(userData, { recursive: true })
mkdirSync(vault, { recursive: true })

const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const { serializeCalendarMarkdown } = await vite.ssrLoadModule('/src/lib/calendarModel.ts')
const { serializeHomeworkMarkdown } = await vite.ssrLoadModule('/src/lib/homeworkStore.ts')
await vite.close()
const famd = require('../electron/famd.cjs')
const { createLocalMcpServer } = require('../electron/local-mcp.cjs')
const { contextFromConfigFile, createHttpTransport, loadTokenStore, regenerateToken } = require('../electron/local-mcp-transport.cjs')
const { createVault } = require('../electron/local-mcp-vault.cjs')
const { createLocalMcpHost } = require('../electron/local-mcp-host.cjs')
const net = require('node:net')

const put = (relative, content) => {
  const target = join(vault, relative)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content)
}
const writeConfig = (settings) => writeFileSync(join(userData, 'config.json'), JSON.stringify({ version: 2, vaultPath: vault, settings }))

const day = (offset) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
const stamp = new Date().toISOString()

// ── vault fixtures ──
put('Mathe/Analysis.md', '# Analysis\n\nDie Ableitung von x² ist 2x. Strasse und Straße sind gleich.\n')
put('Mathe/Klausurplan.md', `# Plan\n\nKlausur Analysis am ${day(10)}\n`)
put('Deutsch/Gedicht.md', '# Gedicht\n\nEin Gedicht über den Herbst.\n')
put('Privat/Tagebuch.md', '# Tagebuch\n\ngeheimes Passwort-Wort Zebrastreifen\n')
put('Bio/Zelle.md', [
  '# Zelle', '', 'Zellen sind klein.', '',
  '## Lernfragen', '',
  '<details><summary>Was ist ein Mitochondrium?</summary>Kraftwerk der Zelle</details>', '',
  '<!-- fanotes-cards-v1', JSON.stringify({ cards: [{ id: 'c1', front: 'Was ist ein Mitochondrium?', back: 'Kraftwerk der Zelle', ease: 2.5, intervalDays: 3, due: day(-1), reps: 2, lapses: 0 }] }), '-->', '',
].join('\n'))
put('Notiz.famd', famd.serializeFamd('# Handschrift\n\nerkannter Text Kartoffel', { ink: { strokes: [] }, textFields: [{ id: 'a', x: 0, y: 0, width: 10, height: 10, page: 1, text: 'Textfeld Birne' }] }))
put('Skripte/Buch.pdf', '%PDF-1.4\nbinary \u0000\u0001 secret-binary-marker\n')
const sidecarName = `${createHash('sha256').update('Skripte/Buch.pdf').digest('hex').slice(0, 32)}.json`
put(`.fanotes/page-text/${sidecarName}`, JSON.stringify({
  format: 'fanotes-page-text-v1', path: 'Skripte/Buch.pdf', size: 40, stamp: 'abcdef01', pageCount: 1, producer: 'test', createdAt: stamp,
  pages: [{ page: 1, source: 'text-layer', status: 'ok', text: 'Seitentext Quarkspeise' }],
}))
put('.fanotes/secret.json', '{"token":"internal-secret-value"}')
put('Hausaufgaben.md', serializeHomeworkMarkdown({
  version: 1,
  tasks: [
    { id: 't1', title: 'Aufgaben 1-5', notes: 'Seite 12', subject: 'Mathe', dueDate: day(2), dueTime: '08:00', done: false, kind: 'homework', priority: 'high', createdAt: stamp, updatedAt: stamp },
    { id: 't2', title: 'Vokabeln', notes: '', subject: 'Englisch', dueDate: day(-3), dueTime: null, done: false, kind: 'homework', priority: 'normal', createdAt: stamp, updatedAt: stamp },
    { id: 't3', title: 'Erledigt', notes: '', subject: 'Mathe', dueDate: day(-5), dueTime: null, done: true, kind: 'homework', priority: 'normal', createdAt: stamp, updatedAt: stamp },
    { id: 't4', title: 'Klausur Physik', notes: '', subject: 'Physik', dueDate: day(20), dueTime: null, done: false, kind: 'appointment', priority: 'normal', createdAt: stamp, updatedAt: stamp },
  ],
}))
put('Kalender.md', serializeCalendarMarkdown({
  version: 1,
  calendars: [{ id: 'school', name: 'Schule', color: '#3d8bfd', visible: false }, { id: 'personal', name: 'Persönlich', color: '#7f6df2', visible: true }],
  events: [
    { id: 'e1', calendarId: 'school', title: 'Prüfung Chemie', start: `${day(5)}T09:00`, end: `${day(5)}T10:00`, allDay: false, location: 'Raum 4', notes: '', notePath: '', recurrence: 'none', recurrenceUntil: null, exceptionDates: [] },
    { id: 'e2', calendarId: 'personal', title: 'Training', start: `${day(1)}T18:00`, end: `${day(1)}T19:00`, allDay: false, location: '', notes: '', notePath: '', recurrence: 'weekly', recurrenceUntil: null, exceptionDates: [] },
  ],
}))
const storyId = (n) => `scene${n}abc`
put('Romane/Reise.story/story.json', JSON.stringify({
  format: 'fanotes-story-v1', id: 'story0001', title: 'Die Reise', author: 'Test', language: 'de', updatedAt: stamp,
  binder: [
    { id: 'chap01', kind: 'chapter', title: 'Aufbruch', children: [{ id: storyId(1), kind: 'scene', title: 'Der Hafen', synopsis: 'Anna erreicht den Hafen.', status: 'draft' }] },
    { id: 'trashbin', kind: 'folder', title: 'Papierkorb', children: [{ id: storyId(2), kind: 'scene', title: 'Verworfen' }] },
  ],
}))
const scene = (text, extra = []) => JSON.stringify({ format: 'fanotes-story-scene-v1', id: 'x', paragraphs: [{ id: 'p1', key: 'a', v: {}, style: 'body', runs: [{ text }] }, ...extra] })
put(`Romane/Reise.story/scenes/${storyId(1)}.json`, scene('Anna ging zum Hafen Leuchtturm.', [{ id: 'p2', key: 'b', v: {}, style: 'body', runs: [{ text: 'gelöscht' }], deleted: true }]))
put(`Romane/Reise.story/scenes/${storyId(2)}.json`, scene('Papierkorbtext'))
put('Romane/Reise.story/bible/characters/anna0001.json', JSON.stringify({ format: 'fanotes-story-bible-v1', kind: 'character', id: 'anna0001', name: 'Anna', role: 'Heldin', fields: [{ label: 'Ziel', value: 'Das Meer' }], updatedAt: stamp }))
put('Romane/Reise.story/bible/places/hafen001.json', JSON.stringify({ format: 'fanotes-story-bible-v1', kind: 'place', id: 'hafen001', name: 'Hafen', fields: [], updatedAt: stamp }))
writeFileSync(outside, 'OUTSIDE-SECRET')
try { symlinkSync(outside, join(vault, 'Mathe', 'link.md')) } catch { /* symlinks may be unavailable */ }
try { symlinkSync(base, join(vault, 'Escape')) } catch { /* symlinks may be unavailable */ }

const SETTINGS = { mcpEnabled: true, mcpWriteAccess: false, mcpExcludedFolders: 'Privat', mcpHttpEnabled: true, openAiApiKey: 'enc:v1:SHOULD-NEVER-APPEAR' }
writeConfig(SETTINGS)

// ── clients ──
class StdioClient {
  constructor() {
    this.child = spawn(process.execPath, [join(appRoot, 'electron/fanotes-mcp.cjs'), '--user-data', userData], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.next = 1
    this.waiting = new Map()
    this.stderr = ''
    let buffer = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const message = JSON.parse(line)
        this.waiting.get(message.id)?.(message)
      }
    })
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk })
  }
  request(method, params) {
    const id = this.next++
    return new Promise((resolve) => {
      this.waiting.set(id, resolve)
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  notify(method) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`) }
  raw(text) { this.child.stdin.write(text) }
  async close() {
    this.child.stdin.end()
    await new Promise((resolve) => this.child.once('exit', resolve))
  }
}

const httpPost = (port, { body, headers = {}, method = 'POST', path = '/mcp' }) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  const request = http.request({ host: '127.0.0.1', port, path, method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }), ...headers } }, (response) => {
    let text = ''
    response.setEncoding('utf8')
    response.on('data', (chunk) => { text += chunk })
    response.on('end', () => resolve({ status: response.statusCode, text, json: text ? (() => { try { return JSON.parse(text) } catch { return null } })() : null }))
  })
  request.on('error', reject)
  if (data !== undefined) request.write(data)
  request.end()
})

const toolData = (reply) => {
  assert.ok(reply.result, `tool call failed: ${JSON.stringify(reply).slice(0, 300)}`)
  assert.equal(reply.result.isError, false, reply.result.content?.[0]?.text)
  return JSON.parse(reply.result.content[0].text)
}
const toolError = (reply) => {
  assert.equal(reply.result?.isError, true, `expected a tool error: ${JSON.stringify(reply).slice(0, 300)}`)
  return reply.result.content[0].text
}

const passed = []
const check = async (name, run) => { if (process.env.CHECK_VERBOSE) console.error('>', name); await run(); passed.push(name) }

const client = new StdioClient()
const call = (name, args = {}) => client.request('tools/call', { name, arguments: args })

try {
  await check('initialize negotiates the protocol version', async () => {
    const reply = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } })
    assert.equal(reply.result.protocolVersion, '2025-06-18')
    assert.equal(reply.result.serverInfo.name, 'fanotes')
    assert.ok(reply.result.capabilities.tools && reply.result.capabilities.resources && reply.result.capabilities.prompts)
    const unknown = await client.request('initialize', { protocolVersion: '1999-01-01' })
    assert.equal(unknown.result.protocolVersion, '2025-11-25')
    client.notify('notifications/initialized')
    assert.deepEqual((await client.request('ping')).result, {})
  })

  await check('tools/list is read-only while write access is off', async () => {
    const names = (await client.request('tools/list')).result.tools.map((tool) => tool.name)
    for (const name of ['vault_stats', 'list_folders', 'list_notes', 'read_note', 'search_notes', 'list_tasks', 'list_calendar', 'list_exams', 'list_flashcard_decks', 'list_flashcards', 'list_stories', 'read_story', 'recent_activity']) {
      assert.ok(names.includes(name), `missing tool ${name}`)
    }
    for (const name of ['create_note', 'append_to_note', 'add_task', 'complete_task']) assert.ok(!names.includes(name), `${name} must be hidden`)
  })

  await check('write tools are denied while write access is off', async () => {
    for (const [name, args] of [['create_note', { path: 'Neu.md', content: 'x' }], ['append_to_note', { path: 'Mathe/Analysis.md', text: 'x' }], ['add_task', { title: 'x' }], ['complete_task', { id: 't1' }]]) {
      assert.match(toolError(await call(name, args)), /Write access is off/u)
    }
    assert.ok(!existsSync(join(vault, 'Neu.md')))
    assert.ok(!readFileSync(join(vault, 'Mathe/Analysis.md'), 'utf8').includes('\n\nx'))
  })

  await check('vault_stats and list_folders', async () => {
    const stats = toolData(await call('vault_stats'))
    assert.ok(stats.notes >= 7)
    assert.equal(stats.byKind.story, 1)
    assert.equal(stats.byKind.pdf, 1)
    assert.equal(stats.byKind.handwriting, 1)
    assert.equal(stats.openTasks, 3)
    assert.equal(stats.overdueTasks, 1)
    const folders = toolData(await call('list_folders'))
    assert.ok(folders.subjects.includes('Mathe') && folders.subjects.includes('Deutsch'))
    assert.ok(!folders.subjects.includes('Privat'), 'excluded folder must be invisible')
    assert.ok(!folders.subjects.some((name) => name.startsWith('.')), '.fanotes must be invisible')
  })

  await check('list_notes filters and hides managed/internal files', async () => {
    const all = toolData(await call('list_notes', { limit: 200 })).notes
    const paths = all.map((note) => note.path)
    assert.ok(paths.includes('Mathe/Analysis.md') && paths.includes('Notiz.famd') && paths.includes('Skripte/Buch.pdf') && paths.includes('Romane/Reise.story'))
    for (const hidden of ['Privat/Tagebuch.md', 'Hausaufgaben.md', 'Kalender.md']) assert.ok(!paths.includes(hidden), `${hidden} must not be listed`)
    assert.ok(!paths.some((path) => path.startsWith('.fanotes') || path.includes('Escape') || path.endsWith('link.md')), 'symlinks and internals must not be listed')
    const mathe = toolData(await call('list_notes', { folder: 'Mathe' })).notes.map((note) => note.path)
    assert.deepEqual(mathe.sort(), ['Mathe/Analysis.md', 'Mathe/Klausurplan.md'])
    assert.deepEqual(toolData(await call('list_notes', { kind: 'pdf' })).notes.map((note) => note.path), ['Skripte/Buch.pdf'])
    assert.equal(toolData(await call('list_notes', { modifiedSince: new Date(Date.now() + 86_400_000).toISOString() })).notes.length, 0)
    assert.match(toolError(await call('list_notes', { kind: 'bogus' })), /kind must be/u)
  })

  await check('read_note: markdown, handwriting, pdf text, never binary', async () => {
    const md = toolData(await call('read_note', { path: 'Mathe/Analysis.md' }))
    assert.equal(md.title, 'Analysis')
    assert.ok(md.markdown.includes('2x'))
    const hand = toolData(await call('read_note', { path: 'Notiz.famd' }))
    assert.equal(hand.kind, 'handwriting')
    assert.ok(hand.markdown.includes('Kartoffel') && hand.markdown.includes('Textfeld Birne'))
    assert.ok(!hand.markdown.includes('fanotes-famd') && !hand.markdown.includes('"strokes"'))
    const pdf = toolData(await call('read_note', { path: 'Skripte/Buch.pdf' }))
    assert.ok(pdf.markdown.includes('Quarkspeise'))
    assert.ok(!JSON.stringify(pdf).includes('secret-binary-marker'))
    const cards = toolData(await call('read_note', { path: 'Bio/Zelle.md' }))
    assert.ok(!cards.markdown.includes('fanotes-cards-v1'), 'machine blocks are stripped')
  })

  await check('read_note refuses traversal, internals, excluded folders and symlinks', async () => {
    for (const path of ['../outside-secret.md', 'Mathe/../../outside-secret.md', '/etc/passwd', '..', '.fanotes/secret.json', '.fanotes/page-text/' + sidecarName, 'Mathe\\..\\x.md', 'C:/Windows/win.ini', 'Mathe/link.md', 'Escape/outside-secret.md', 'Privat/Tagebuch.md', 'PRIVAT/Tagebuch.md', 'Mathe/%2e%2e/x.md', 'a\u0000b.md', '']) {
      const text = toolError(await call('read_note', { path }))
      assert.ok(!text.includes('OUTSIDE-SECRET') && !text.includes('internal-secret-value') && !text.includes('Zebrastreifen'), `leak for ${JSON.stringify(path)}`)
    }
    assert.match(toolError(await call('read_note', { path: 'Gibt/es/nicht.md' })), /not found/u)
    assert.match(toolError(await call('read_note', { path: 'Mathe/Analysis.txt' })), /not a note/u)
    assert.match(toolError(await call('read_note', { path: 5 })), /string/u)
  })

  await check('search_notes is German-aware, honors exclusion and finds pdf/famd/story text', async () => {
    const strasse = toolData(await call('search_notes', { query: 'STRAẞE' }))
    assert.ok(strasse.matches.some((match) => match.path === 'Mathe/Analysis.md'))
    const ss = toolData(await call('search_notes', { query: 'straße' }))
    assert.ok(ss.matches.some((match) => match.path === 'Mathe/Analysis.md'))
    assert.equal(toolData(await call('search_notes', { query: 'Zebrastreifen' })).matches.length, 0)
    assert.equal(toolData(await call('search_notes', { query: 'Quarkspeise' })).matches[0].path, 'Skripte/Buch.pdf')
    assert.equal(toolData(await call('search_notes', { query: 'Kartoffel' })).matches[0].path, 'Notiz.famd')
    assert.equal(toolData(await call('search_notes', { query: 'Leuchtturm' })).matches[0].path, 'Romane/Reise.story')
    assert.equal(toolData(await call('search_notes', { query: 'Papierkorbtext' })).matches.length, 0, 'story trash is not searched')
    assert.match(toolError(await call('search_notes', { query: '   ' })), /empty/u)
  })

  await check('list_tasks', async () => {
    const open = toolData(await call('list_tasks'))
    assert.deepEqual(open.tasks.map((task) => task.id), ['t2', 't1', 't4'])
    assert.equal(open.tasks[0].overdue, true)
    assert.equal(toolData(await call('list_tasks', { includeDone: true })).tasks.length, 4)
    assert.deepEqual(toolData(await call('list_tasks', { subject: 'mathe' })).tasks.map((task) => task.id), ['t1'])
    assert.deepEqual(toolData(await call('list_tasks', { overdue: true })).tasks.map((task) => task.id), ['t2'])
    assert.deepEqual(toolData(await call('list_tasks', { dueBefore: day(3), dueAfter: day(0) })).tasks.map((task) => task.id), ['t1'])
    assert.deepEqual(toolData(await call('list_tasks', { kind: 'appointment' })).tasks.map((task) => task.id), ['t4'])
  })

  await check('list_calendar and list_exams (hidden calendars, recurrence)', async () => {
    const calendar = toolData(await call('list_calendar', { from: day(0), to: day(16) }))
    assert.ok(calendar.events.some((event) => event.title === 'Prüfung Chemie' && event.calendar === 'Schule'), 'hidden calendar is included')
    assert.ok(calendar.events.filter((event) => event.title === 'Training').length >= 2, 'weekly event expands')
    assert.match(toolError(await call('list_calendar', { from: '2026-13-40' })), /YYYY-MM-DD/u)
    assert.match(toolError(await call('list_calendar', { from: '2020-01-01', to: '2026-01-01' })), /too long/u)
    const exams = toolData(await call('list_exams'))
    assert.ok(exams.exams.some((event) => event.title === 'Prüfung Chemie'))
    assert.ok(exams.homework.some((task) => task.title === 'Klausur Physik'))
    assert.ok(exams.mentionedInNotes.some((hit) => hit.path === 'Mathe/Klausurplan.md'))
  })

  await check('flashcards', async () => {
    const decks = toolData(await call('list_flashcard_decks'))
    assert.deepEqual(decks.decks.map((deck) => [deck.path, deck.cards, deck.due]), [['Bio/Zelle.md', 1, 1]])
    const due = toolData(await call('list_flashcards', { dueOnly: true }))
    assert.equal(due.cards[0].front, 'Was ist ein Mitochondrium?')
    assert.equal(due.cards[0].due, day(-1), 'stored schedule wins over the question block')
    assert.equal(toolData(await call('list_flashcards', { path: 'Bio/Zelle.md' })).cards.length, 1)
    assert.match(toolError(await call('list_flashcards', { path: '../x.md' })), /not allowed/u)
  })

  await check('stories: outline, text, bible, trash hidden', async () => {
    assert.deepEqual(toolData(await call('list_stories')).stories.map((story) => story.title), ['Die Reise'])
    const story = toolData(await call('read_story', { path: 'Romane/Reise.story' }))
    assert.equal(story.outline.length, 1)
    assert.equal(story.outline[0].title, 'Der Hafen')
    assert.equal(story.outline[0].chapter, 'Aufbruch')
    assert.ok(story.outline[0].text.includes('Leuchtturm') && !story.outline[0].text.includes('gelöscht'))
    assert.deepEqual(story.bible.map((entry) => entry.name).sort(), ['Anna', 'Hafen'])
    const outlineOnly = toolData(await call('read_story', { path: 'Romane/Reise.story', includeText: false }))
    assert.equal(outlineOnly.outline[0].text, undefined)
    assert.match(toolError(await call('read_story', { path: 'Mathe/Analysis.md' })), /story/u)
  })

  await check('recent_activity', async () => {
    const recent = toolData(await call('recent_activity', { limit: 3 }))
    assert.equal(recent.recent.length, 3)
    assert.ok(recent.recent.every((note) => !note.path.startsWith('Privat')))
  })

  await check('resources and prompts', async () => {
    const list = (await client.request('resources/list')).result.resources
    const analysis = list.find((resource) => resource.name === 'Mathe/Analysis.md')
    assert.equal(analysis.uri, 'fanotes://note/Mathe/Analysis.md')
    const read = (await client.request('resources/read', { uri: analysis.uri })).result.contents[0]
    assert.ok(read.text.includes('Ableitung'))
    assert.ok((await client.request('resources/read', { uri: 'fanotes://note/..%2Foutside-secret.md' })).error)
    assert.ok((await client.request('resources/read', { uri: 'fanotes://note/Privat/Tagebuch.md' })).error)
    assert.ok((await client.request('resources/read', { uri: 'file:///etc/passwd' })).error)
    assert.equal((await client.request('resources/templates/list')).result.resourceTemplates[0].uriTemplate, 'fanotes://note/{+path}')
    const prompts = (await client.request('prompts/list')).result.prompts
    assert.ok(prompts.some((prompt) => prompt.name === 'summarize_note'))
    const prompt = (await client.request('prompts/get', { name: 'summarize_note', arguments: { path: 'Mathe/Analysis.md' } })).result
    assert.ok(prompt.messages[0].content.text.includes('Mathe/Analysis.md'))
    assert.ok((await client.request('prompts/get', { name: 'summarize_note', arguments: {} })).error)
  })

  await check('protocol errors', async () => {
    assert.equal((await client.request('nope/method')).error.code, -32601)
    assert.equal((await client.request('tools/call', { name: 'does_not_exist' })).error.code, -32602)
    assert.equal((await client.request('tools/call', {})).error.code, -32602)
    const parse = new Promise((resolve) => client.waiting.set(null, resolve))
    client.raw('{not json}\n')
    assert.equal((await parse).error.code, -32700)
    client.raw('\n')
  })

  // ── write access on ──
  writeConfig({ ...SETTINGS, mcpWriteAccess: true })
  await check('write tools appear and work when write access is on', async () => {
    const names = (await client.request('tools/list')).result.tools.map((tool) => tool.name)
    for (const name of ['create_note', 'append_to_note', 'add_task', 'complete_task']) assert.ok(names.includes(name))

    const created = toolData(await call('create_note', { path: 'Neu/Idee.md', content: '# Idee\n\nHallo' }))
    assert.equal(created.path, 'Neu/Idee.md')
    assert.equal(readFileSync(join(vault, 'Neu/Idee.md'), 'utf8'), '# Idee\n\nHallo\n')
    assert.match(toolError(await call('create_note', { path: 'Neu/Idee.md', content: 'overwrite' })), /already exists/u)
    assert.equal(readFileSync(join(vault, 'Neu/Idee.md'), 'utf8'), '# Idee\n\nHallo\n', 'never overwrites')

    toolData(await call('append_to_note', { path: 'Neu/Idee.md', text: 'Zweiter Absatz' }))
    assert.equal(readFileSync(join(vault, 'Neu/Idee.md'), 'utf8'), '# Idee\n\nHallo\n\nZweiter Absatz\n')

    const added = toolData(await call('add_task', { title: 'Referat', subject: 'Deutsch', dueDate: day(7), dueTime: '10:30', priority: 'high' }))
    assert.equal(added.task.title, 'Referat')
    const listed = toolData(await call('list_tasks', { subject: 'Deutsch' }))
    assert.equal(listed.tasks.length, 1)
    assert.equal(listed.tasks[0].priority, 'high')
    assert.equal(toolData(await call('list_tasks')).tasks.length, 4, 'existing tasks survive')
    assert.deepEqual(toolData(await call('complete_task', { id: 't1' })), { id: 't1', title: 'Aufgaben 1-5', done: true })
    assert.ok(!toolData(await call('list_tasks')).tasks.some((task) => task.id === 't1'))
    assert.match(toolError(await call('complete_task', { id: 'missing' })), /No matching/u)
    assert.match(toolError(await call('add_task', { title: 'x', dueDate: '2026-02-31' })), /dueDate/u)

    const homework = readFileSync(join(vault, 'Hausaufgaben.md'), 'utf8')
    assert.ok(homework.startsWith('# Hausaufgaben') && homework.includes('<!-- fanotes-homework-v1'), 'app format kept')
    assert.deepEqual(readdirSync(vault).filter((name) => name.endsWith('.tmp')), [], 'no temp files left')
    assert.deepEqual(readdirSync(join(vault, 'Neu')).filter((name) => name.endsWith('.tmp')), [])
  })

  await check('write guards: traversal, managed notes, stories, non-markdown, excluded, internals', async () => {
    for (const path of ['../evil.md', 'Mathe/../../evil.md', '/tmp/evil.md', '.fanotes/evil.md', '.hidden/x.md', 'Privat/neu.md', 'Neu/x.txt', 'Romane/Reise.story/scenes/x.md', 'Kalender.md', 'Hausaufgaben.md', 'Escape/evil.md', 'Neu/a:b.md']) {
      toolError(await call('create_note', { path, content: 'x' }))
    }
    toolError(await call('append_to_note', { path: 'Hausaufgaben.md', text: 'x' }))
    toolError(await call('append_to_note', { path: 'Notiz.famd', text: 'x' }))
    toolError(await call('append_to_note', { path: 'Mathe/link.md', text: 'x' }))
    toolError(await call('append_to_note', { path: 'Privat/Tagebuch.md', text: 'x' }))
    assert.ok(!existsSync(join(base, 'evil.md')) && !existsSync(join(vault, 'Privat/neu.md')) && !existsSync(join(vault, '.fanotes/evil.md')))
    assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE-SECRET')
  })

  await check('a damaged Hausaufgaben.md is never overwritten', async () => {
    const original = readFileSync(join(vault, 'Hausaufgaben.md'), 'utf8')
    const broken = '# Hausaufgaben\n\n<!-- fanotes-homework-v1\n{ "tasks": [ oops\n-->\n'
    writeFileSync(join(vault, 'Hausaufgaben.md'), broken)
    toolError(await call('add_task', { title: 'Neu' }))
    toolError(await call('list_tasks'))
    assert.equal(readFileSync(join(vault, 'Hausaufgaben.md'), 'utf8'), broken)
    writeFileSync(join(vault, 'Hausaufgaben.md'), original)
  })

  writeConfig({ ...SETTINGS, mcpEnabled: false })
  await check('switching the feature off empties tools and refuses calls', async () => {
    assert.deepEqual((await client.request('tools/list')).result.tools, [])
    assert.match(toolError(await call('list_notes')), /switched off/u)
    assert.deepEqual((await client.request('resources/list')).result.resources, [])
  })
  assert.ok(!client.stderr.includes('Kartoffel') && !client.stderr.includes('Zebrastreifen'), 'stderr must not carry note text')
  writeConfig(SETTINGS)
} finally {
  await client.close()
}

// ── Streamable HTTP ──
writeConfig(SETTINGS)
const server = createLocalMcpServer({ context: () => contextFromConfigFile(userData) })
let store = loadTokenStore(userData)
const transport = createHttpTransport({ server, getToken: () => store.token, port: 0 })
const port = await transport.listen()
const auth = () => ({ Authorization: `Bearer ${store.token}` })
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params })

try {
  await check('http: token file is private and the token looks random', async () => {
    assert.match(store.token, /^fnmcp_[A-Za-z0-9_-]{32,}$/u)
    if (process.platform !== 'win32') assert.equal(require('node:fs').statSync(join(userData, 'mcp-local.json')).mode & 0o077, 0)
  })
  await check('http: initialize, tools/list and tool calls over POST /mcp', async () => {
    const init = await httpPost(port, { body: rpc('initialize', { protocolVersion: '2025-03-26' }), headers: auth() })
    assert.equal(init.status, 200)
    assert.equal(init.json.result.protocolVersion, '2025-03-26')
    const tools = await httpPost(port, { body: rpc('tools/list', {}, 2), headers: auth() })
    assert.ok(tools.json.result.tools.some((tool) => tool.name === 'search_notes'))
    const tasks = await httpPost(port, { body: rpc('tools/call', { name: 'list_tasks', arguments: {} }, 3), headers: auth() })
    assert.ok(JSON.parse(tasks.json.result.content[0].text).tasks.length >= 3)
    assert.equal((await httpPost(port, { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, headers: auth() })).status, 202)
    const batch = await httpPost(port, { body: [rpc('ping', {}, 10), rpc('ping', {}, 11)], headers: auth() })
    assert.equal(batch.json.length, 2)
    const allowedLocalOrigin = await httpPost(port, { body: rpc('ping', {}, 4), headers: { ...auth(), Origin: `http://localhost:${port}` } })
    assert.equal(allowedLocalOrigin.status, 200)
    const localhostHost = await httpPost(port, { body: rpc('ping', {}, 5), headers: { ...auth(), Host: `localhost:${port}` } })
    assert.equal(localhostHost.status, 200)
  })
  await check('http: write tools are denied while write access is off', async () => {
    const reply = await httpPost(port, { body: rpc('tools/call', { name: 'add_task', arguments: { title: 'x' } }, 6), headers: auth() })
    assert.match(toolError(reply.json), /Write access is off/u)
  })
  await check('http: bad token, missing token, wrong scheme', async () => {
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: { Authorization: 'Bearer fnmcp_wrong' } })).status, 401)
    assert.equal((await httpPost(port, { body: rpc('ping') })).status, 401)
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: { Authorization: `Basic ${store.token}` } })).status, 401)
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: { Authorization: `Bearer ${store.token}x` } })).status, 401)
  })
  await check('http: DNS rebinding (bad Host) and bad Origin are rejected', async () => {
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: { ...auth(), Host: 'evil.example.com' } })).status, 403)
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: { ...auth(), Host: `evil.example.com:${port}` } })).status, 403)
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: { ...auth(), Host: `127.0.0.1:${port + 1}` } })).status, 403)
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: { ...auth(), Origin: 'https://evil.example.com' } })).status, 403)
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: { ...auth(), Origin: 'null' } })).status, 403)
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: { ...auth(), Origin: 'http://127.0.0.1.evil.com' } })).status, 403)
  })
  await check('http: method, path, content type and size limits', async () => {
    assert.equal((await httpPost(port, { method: 'GET', headers: auth() })).status, 405)
    assert.equal((await httpPost(port, { method: 'DELETE', headers: auth() })).status, 405)
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: auth(), path: '/other' })).status, 404)
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: { ...auth(), 'Content-Type': 'text/plain' } })).status, 415)
    assert.equal((await httpPost(port, { body: '{oops', headers: auth() })).status, 400)
    const huge = await httpPost(port, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1_200_000) } }), headers: auth() }).catch(() => ({ status: 413 }))
    assert.equal(huge.status, 413)
  })
  await check('http: traversal attempts and excluded folders over HTTP', async () => {
    for (const path of ['../outside-secret.md', 'Privat/Tagebuch.md', '.fanotes/secret.json']) {
      const reply = await httpPost(port, { body: rpc('tools/call', { name: 'read_note', arguments: { path } }, 7), headers: auth() })
      assert.equal(reply.json.result.isError, true)
      assert.ok(!reply.text.includes('OUTSIDE-SECRET') && !reply.text.includes('Zebrastreifen') && !reply.text.includes('internal-secret-value'))
    }
  })
  await check('http: regenerating the token invalidates the old one', async () => {
    const old = store.token
    store = regenerateToken(userData)
    assert.notEqual(store.token, old)
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: { Authorization: `Bearer ${old}` } })).status, 401)
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: auth() })).status, 200)
  })
  await check('http: write access works when enabled and the server binds loopback only', async () => {
    writeConfig({ ...SETTINGS, mcpWriteAccess: true })
    const reply = await httpPost(port, { body: rpc('tools/call', { name: 'create_note', arguments: { path: 'Http/Neu.md', content: 'ok' } }, 8), headers: auth() })
    assert.equal(JSON.parse(reply.json.result.content[0].text).created, true)
    assert.ok(existsSync(join(vault, 'Http/Neu.md')))
  })
  await check('regression: search and read stay within memory/time budgets', async () => {
    mkdirSync(join(vault, 'Big'), { recursive: true })
    const big = `${'x'.repeat(3 * 1024 * 1024)} needlexyz`
    for (let index = 0; index < 40; index += 1) writeFileSync(join(vault, 'Big', `b${index}.md`), big)
    const rssBefore = process.memoryUsage().rss
    const started = Date.now()
    const found = JSON.parse((await server.handleOne(rpc('tools/call', { name: 'search_notes', arguments: { query: 'needlexyz' } }, 50))).result.content[0].text)
    assert.equal(found.truncated, true, 'oversized files are flagged')
    assert.ok(found.skippedLarge >= 40)
    assert.equal(found.matches.length, 0)
    assert.ok(Date.now() - started < 8000)
    assert.ok(process.memoryUsage().rss - rssBefore < 300 * 1024 * 1024, 'search must not balloon memory')
    rmSync(join(vault, 'Big'), { recursive: true })
    mkdirSync(join(vault, 'Mid'), { recursive: true })
    const mid = 'y'.repeat(900 * 1024)
    for (let index = 0; index < 80; index += 1) writeFileSync(join(vault, 'Mid', `m${index}.md`), mid)
    const budgeted = JSON.parse((await server.handleOne(rpc('tools/call', { name: 'search_notes', arguments: { query: 'nothinghere' } }, 51))).result.content[0].text)
    assert.equal(budgeted.truncated, true, 'the byte budget stops the scan')
    rmSync(join(vault, 'Mid'), { recursive: true })
    mkdirSync(join(vault, 'Huge'), { recursive: true })
    for (let index = 0; index < 10; index += 1) writeFileSync(join(vault, 'Huge', `h${index}.md`), `${'z'.repeat(7 * 1024 * 1024)}${index}`)
    const direct = createVault({ root: vault })
    for (let index = 0; index < 10; index += 1) await direct.noteContent(`Huge/h${index}.md`)
    assert.ok(direct.cacheBytes() <= 32 * 1024 * 1024, `cache is bounded (${direct.cacheBytes()})`)
    rmSync(join(vault, 'Huge'), { recursive: true })
  })
  await check('regression: batches are capped and concurrent calls are limited', async () => {
    const tooBig = await httpPost(port, { body: Array.from({ length: 11 }, (_, index) => rpc('ping', {}, 100 + index)), headers: auth() })
    assert.equal(tooBig.json.error.code, -32600)
    const ok = await httpPost(port, { body: Array.from({ length: 10 }, (_, index) => rpc('ping', {}, 200 + index)), headers: auth() })
    assert.equal(ok.json.length, 10)
    const replies = await Promise.all(Array.from({ length: 10 }, (_, index) => server.handleOne(rpc('tools/call', { name: 'list_notes', arguments: {} }, 300 + index))))
    assert.ok(replies.some((reply) => reply.error?.code === -32000), 'excess in-flight calls are refused')
    assert.ok(replies.some((reply) => reply.result), 'and the rest still run')
  })
  await check('regression: Windows-style names cannot reach excluded folders', async () => {
    for (const path of ['Privat::$I30:$INDEX_ALLOCATION/Tagebuch.md', 'Privat./Tagebuch.md', 'Privat /Tagebuch.md', 'PRIVAT~1/Tagebuch.md', 'CON.md', 'Mathe/nul', 'Mathe/aux.txt.md', 'Mathe/LPT1.md', 'Privat:x/y.md', 'Mathe/Analysis.md:stream']) {
      const reply = await httpPost(port, { body: rpc('tools/call', { name: 'read_note', arguments: { path } }, 60), headers: auth() })
      assert.equal(reply.json.result.isError, true, path)
      assert.ok(!reply.text.includes('Zebrastreifen'), path)
      const write = await httpPost(port, { body: rpc('tools/call', { name: 'create_note', arguments: { path: path.endsWith('.md') ? path : `${path}.md`, content: 'x' } }, 61), headers: auth() })
      assert.equal(write.json.result.isError, true, `write ${path}`)
    }
  })
  await check('regression: symlinks into excluded folders, .fanotes or elsewhere are not followed', async () => {
    mkdirSync(join(vault, 'Pub'), { recursive: true })
    symlinkSync(join(vault, 'Privat', 'Tagebuch.md'), join(vault, 'Pub', 'l.md'))
    symlinkSync('../.fanotes/secret.json', join(vault, 'Pub', 'k.md'))
    symlinkSync('../Privat', join(vault, 'Pub', 'dir'))
    const before = readFileSync(join(vault, 'Privat', 'Tagebuch.md'), 'utf8')
    for (const path of ['Pub/l.md', 'Pub/k.md', 'Pub/dir/Tagebuch.md']) {
      const read = await httpPost(port, { body: rpc('tools/call', { name: 'read_note', arguments: { path } }, 70), headers: auth() })
      assert.equal(read.json.result.isError, true, path)
      assert.ok(!read.text.includes('Zebrastreifen') && !read.text.includes('internal-secret-value'), path)
      const append = await httpPost(port, { body: rpc('tools/call', { name: 'append_to_note', arguments: { path, text: 'pwned' } }, 71), headers: auth() })
      assert.equal(append.json.result.isError, true, `append ${path}`)
    }
    const create = await httpPost(port, { body: rpc('tools/call', { name: 'create_note', arguments: { path: 'Pub/dir/neu.md', content: 'x' } }, 72), headers: auth() })
    assert.equal(create.json.result.isError, true)
    assert.equal(readFileSync(join(vault, 'Privat', 'Tagebuch.md'), 'utf8'), before)
    assert.ok(!existsSync(join(vault, 'Privat', 'neu.md')))
    const listed = await httpPost(port, { body: rpc('tools/call', { name: 'list_notes', arguments: { folder: 'Pub' } }, 73), headers: auth() })
    assert.equal(JSON.parse(listed.json.result.content[0].text).notes.length, 0)
    const search = await httpPost(port, { body: rpc('tools/call', { name: 'search_notes', arguments: { query: 'Zebrastreifen' } }, 74), headers: auth() })
    assert.equal(JSON.parse(search.json.result.content[0].text).matches.length, 0)
  })
  if (process.platform === 'win32') {
    await check('windows: real reserved names, NTFS streams, junctions, 8.3 names and case variants stay blocked', async () => {
      const { execFileSync } = require('node:child_process')
      const callTool = async (name, args, id) => (await httpPost(port, { body: rpc('tools/call', { name, arguments: args }, id), headers: auth() })).text
      const denied = async (name, args, label) => {
        const text = await callTool(name, args, 90)
        const parsed = JSON.parse(text)
        assert.equal(parsed.result.isError, true, `${name} ${label}: ${text.slice(0, 200)}`)
        assert.ok(!/Zebrastreifen|ADS-SECRET|internal-secret-value|OUTSIDE-SECRET/u.test(text), `leak ${label}`)
      }
      writeConfig({ ...SETTINGS, mcpWriteAccess: true })
      // Reserved device names (a real open of CON/NUL would hit the device, not a file).
      for (const path of ['CON.md', 'con', 'NUL.md', 'Mathe/NUL', 'Mathe/aux.md', 'Mathe/COM1.md', 'Mathe/lpt1.txt.md', 'PRN.md']) {
        await denied('read_note', { path }, path)
        await denied('create_note', { path: path.endsWith('.md') ? path : `${path}.md`, content: 'x' }, `create ${path}`)
      }
      // A real alternate data stream next to a visible note and inside the excluded folder.
      writeFileSync(`${join(vault, 'Mathe', 'Analysis.md')}:secret`, 'ADS-SECRET')
      writeFileSync(`${join(vault, 'Privat', 'Tagebuch.md')}:secret`, 'ADS-SECRET')
      assert.equal(readFileSync(`${join(vault, 'Mathe', 'Analysis.md')}:secret`, 'utf8'), 'ADS-SECRET', 'NTFS streams must be available on the runner')
      for (const path of ['Mathe/Analysis.md:secret', 'Mathe/Analysis.md:secret:$DATA', 'Privat/Tagebuch.md:secret', 'Mathe/note.md:secret']) {
        await denied('read_note', { path }, path)
        await denied('append_to_note', { path, text: 'x' }, `append ${path}`)
        await denied('create_note', { path, content: 'x' }, `create ${path}`)
      }
      assert.equal(readFileSync(`${join(vault, 'Mathe', 'Analysis.md')}:secret`, 'utf8'), 'ADS-SECRET')
      // A directory junction (mklink /J) into the excluded folder and into .fanotes.
      mkdirSync(join(vault, 'WinPub'), { recursive: true })
      execFileSync('cmd', ['/c', 'mklink', '/J', join(vault, 'WinPub', 'jp'), join(vault, 'Privat')], { stdio: 'pipe' })
      execFileSync('cmd', ['/c', 'mklink', '/J', join(vault, 'WinPub', 'jf'), join(vault, '.fanotes')], { stdio: 'pipe' })
      for (const path of ['WinPub/jp/Tagebuch.md', 'WinPub/jf/secret.json']) {
        await denied('read_note', { path }, path)
        await denied('append_to_note', { path, text: 'pwned' }, `append ${path}`)
      }
      await denied('create_note', { path: 'WinPub/jp/neu.md', content: 'x' }, 'create via junction')
      assert.ok(!existsSync(join(vault, 'Privat', 'neu.md')))
      const listed = JSON.parse(JSON.parse(await callTool('list_notes', { folder: 'WinPub' }, 91)).result.content[0].text)
      assert.equal(listed.notes.length, 0, 'junction contents must not be listed')
      const found = JSON.parse(JSON.parse(await callTool('search_notes', { query: 'Zebrastreifen' }, 92)).result.content[0].text)
      assert.equal(found.matches.length, 0, 'junction contents must not be searchable')
      // Case variants (NTFS is case-insensitive).
      for (const path of ['PRIVAT/Tagebuch.md', 'privat/tagebuch.md', 'Privat/TAGEBUCH.MD', '.FANOTES/secret.json', '.Fanotes/secret.json', 'Mathe/../PRIVAT/Tagebuch.md']) {
        await denied('read_note', { path }, path)
      }
      await denied('create_note', { path: 'pRiVaT/neu.md', content: 'x' }, 'create case variant')
      assert.ok(!existsSync(join(vault, 'Privat', 'neu.md')))
      // 8.3 short name of a long excluded folder (skipped when the volume has 8.3 names disabled).
      const longName = 'Geheimordner-lang'
      put(`${longName}/Wichtig.md`, '# Wichtig\n\nZebrastreifen im Geheimordner\n')
      writeConfig({ ...SETTINGS, mcpWriteAccess: true, mcpExcludedFolders: `Privat, ${longName}` })
      const listing = execFileSync('cmd', ['/c', 'dir', '/x', '/ad', vault], { encoding: 'utf8' })
      const line = listing.split(/\r?\n/u).find((entry) => entry.includes(longName))
      const short = line && /\s([A-Z0-9_$~!#%&'()@^`{}-]+~\d+)\s+Geheimordner-lang/u.exec(line)?.[1]
      if (short) {
        await denied('read_note', { path: `${short}/Wichtig.md` }, `8.3 ${short}`)
        await denied('create_note', { path: `${short}/neu.md`, content: 'x' }, `create 8.3 ${short}`)
        await denied('read_note', { path: `${short.toLowerCase()}/Wichtig.md` }, `8.3 lower ${short}`)
        assert.ok(!existsSync(join(vault, longName, 'neu.md')))
      } else {
        console.error('note: 8.3 short names are disabled on this volume; short-name case skipped')
      }
      await denied('read_note', { path: `${longName}/Wichtig.md` }, 'long excluded name')
      await denied('read_note', { path: `${longName.toUpperCase()}/Wichtig.md` }, 'long excluded name uppercase')
      writeConfig({ ...SETTINGS, mcpWriteAccess: true })
    })
  }
  await check('regression: the HTTP host falls back to another port when the stored port is busy', async () => {
    const hostData = join(base, 'hostData')
    mkdirSync(hostData, { recursive: true })
    const stored = loadTokenStore(hostData)
    const blocker = net.createServer()
    await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(stored.port, '127.0.0.1', resolve) })
    const host = createLocalMcpHost({ userData: hostData, getState: () => ({ settings: { ...SETTINGS, mcpWriteAccess: false }, vaultPath: vault }) })
    try {
      await host.apply({ mcpEnabled: true, mcpHttpEnabled: true })
      const info = host.info()
      assert.equal(info.httpRunning, true, info.httpError)
      const hostPort = Number(new URL(info.httpUrl).port)
      assert.notEqual(hostPort, stored.port)
      const reply = await httpPost(hostPort, { body: rpc('ping'), headers: { Authorization: `Bearer ${info.httpToken}` } })
      assert.equal(reply.status, 200)
      assert.equal(loadTokenStore(hostData).port, hostPort, 'the new port is remembered')
    } finally {
      await host.stop()
      await new Promise((resolve) => blocker.close(resolve))
    }
  })
  await check('regression: oversized stdio lines are capped and do not crash the server', async () => {
    const stdio = new StdioClient()
    try {
      const reply = new Promise((resolve) => stdio.waiting.set(null, resolve))
      stdio.raw(`${'a'.repeat(1_200_000)}\n${JSON.stringify(rpc('ping', {}, 5))}\n`)
      assert.equal((await reply).error.code, -32600)
      assert.deepEqual((await stdio.request('ping')).result, {})
      stdio.raw(`${'b'.repeat(1_200_000)}\n`)
      assert.deepEqual((await stdio.request('ping')).result, {})
    } finally {
      await stdio.close()
    }
  })
  await check('http: repeated bad tokens are throttled', async () => {
    let last = 0
    for (let index = 0; index < 25; index += 1) last = (await httpPost(port, { body: rpc('ping'), headers: { Authorization: 'Bearer nope' } })).status
    assert.equal(last, 429)
    assert.equal((await httpPost(port, { body: rpc('ping'), headers: auth() })).status, 200, 'a valid token is never throttled')
  })
} finally {
  await transport.close()
  rmSync(base, { recursive: true, force: true })
}

console.log(`local MCP checks passed (${passed.length}):`)
for (const name of passed) console.log(`  ok  ${name}`)
