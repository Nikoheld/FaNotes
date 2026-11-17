// Aggregation and loader check for Settings → Statistik on a synthetic temp vault.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-stats-check-'))
try {
  const { loadVaultStats, factsFromNote } = await server.ssrLoadModule('/src/lib/vaultStatsLoader.ts')
  const { aggregateVault, countWords, streaks, dayKey } = await server.ssrLoadModule('/src/lib/vaultStats.mjs')
  const { writePageStatsIntoNote, parseFamd } = await server.ssrLoadModule('/src/lib/famd.ts')
  const { emptyPageStats } = await server.ssrLoadModule('/src/lib/pageStats.ts')
  const { embedCards } = await server.ssrLoadModule('/src/lib/flashcards.ts')
  const { serializeHomeworkMarkdown, createHomeworkTask } = await server.ssrLoadModule('/src/lib/homeworkStore.ts')

  const now = new Date(2026, 10, 15, 12, 0, 0)
  const day = (offset) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 10, 0, 0)
  const vault = path.join(temporary, 'vault')
  const put = (relative, content, when = day(0)) => {
    const target = path.join(vault, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
    fs.utimesSync(target, when, when)
  }
  const stats = (patch) => ({ ...emptyPageStats(now.getTime()), ...patch })
  const cards = [
    { id: 'a', front: 'Q1', back: 'A1', ease: 2.5, intervalDays: 1, due: '2026-11-10', reps: 4, lapses: 1 },
    { id: 'b', front: 'Q2', back: 'A2', ease: 2.5, intervalDays: 3, due: '2026-12-31', reps: 0, lapses: 0 },
  ]
  let math = embedCards('# Mathe\n\nEins zwei drei vier fünf sechs.\n', cards)
  math = writePageStatsIntoNote(math, stats({ dwellMs: 600_000, dwellByWeekday: [0, 600_000, 0, 0, 0, 0, 0], activeDays: ['2026-11-13', '2026-11-14'], typing: { ...emptyPageStats(0).typing, wordsTyped: 40 } }))
  put('Mathe/Algebra.md', math, day(-1))
  put('Mathe/Geometrie.md', '# Geo\n\nZwei Wörter.\n', day(-40))
  const ink = writePageStatsIntoNote('Skizze', stats({ ink: { ...emptyPageStats(0).ink, strokes: 120, penDownMs: 30_000 } }))
  put('Deutsch/Skizze.md', ink, day(-2))
  put('Deutsch/Buch.pdf', Buffer.alloc(5000), day(-3))
  put('Deutsch/Bild.png', Buffer.alloc(1200), day(-3))
  put('Notiz im Eingang.md', 'Eingang Inhalt', day(0))
  put('Roman.story/manifest.json', '{}', day(0))
  put('Roman.story/progress/abcd1234.json', JSON.stringify({ format: 'fanotes-story-progress-v1', writer: 'abcd1234', days: { '2026-11-14': { start: 0, words: 500 }, '2026-11-15': { start: 500, words: -20 } }, updatedAt: now.toISOString() }), day(0))
  put('Roman.story/progress/efgh5678.json', JSON.stringify({ format: 'fanotes-story-progress-v1', writer: 'efgh5678', days: { '2026-11-14': { start: 0, words: 100 } }, updatedAt: now.toISOString() }), day(0))
  put('Hausaufgaben.md', serializeHomeworkMarkdown({ version: 1, tasks: [
    createHomeworkTask({ title: 'Aufgabe 1', subject: 'Mathe', dueDate: '2026-11-10' }),
    createHomeworkTask({ title: 'Aufgabe 2', subject: 'Mathe', dueDate: '2026-11-20', done: true }),
    createHomeworkTask({ title: 'Aufsatz', subject: 'Deutsch', dueDate: '2026-11-30' }),
    createHomeworkTask({ title: 'Mathe Klausur', subject: 'Mathe', dueDate: '2026-11-25', kind: 'appointment' }),
    createHomeworkTask({ title: 'Ausflug', dueDate: '2026-11-18', kind: 'appointment' }),
  ] }))

  const colors = { Mathe: '#ff0000' }
  const walk = (directory, relative = '') => fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.')).map((entry) => {
    const full = path.join(directory, entry.name)
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    const info = fs.statSync(full)
    if (entry.isDirectory() && /\.story$/iu.test(entry.name)) return { name: entry.name, relativePath: rel, kind: 'file', extension: 'story', modifiedAt: info.mtime.toISOString() }
    if (entry.isDirectory()) return { name: entry.name, relativePath: rel, kind: 'folder', color: colors[entry.name], children: walk(full, rel) }
    return { name: entry.name, relativePath: rel, kind: 'file', extension: path.extname(entry.name).slice(1), size: info.size, modifiedAt: info.mtime.toISOString(), createdAt: info.mtime.toISOString() }
  })
  const tree = walk(vault)

  let reads = 0
  const host = {
    getTree: async () => tree,
    readFile: async (relative) => { reads += 1; return parseFamd(fs.readFileSync(path.join(vault, relative), 'utf8')).markdown },
    readNotePageStats: async (relative) => parseFamd(fs.readFileSync(path.join(vault, relative), 'utf8')).payload?.pageStats ?? null,
    listNoteHistory: async (relative) => (relative === 'Mathe/Algebra.md' ? [{ createdAt: day(-5).toISOString() }, { createdAt: day(-6).toISOString() }] : []),
    storyList: async (relative) => fs.readdirSync(path.join(vault, relative), { recursive: true }).map(String).filter((name) => name.endsWith('.json')).map((name) => name.split(path.sep).join('/')),
    storyRead: async (relative) => fs.readFileSync(path.join(vault, relative), 'utf8'),
  }

  // 1. loader result
  const updates = []
  let final
  await loadVaultStats(host, new AbortController().signal, (value, progress) => { updates.push(progress.phase); final = value }, { now })
  assert.ok(updates.includes('tree') && updates.at(-1) === 'done', 'tree first, done last')
  assert.equal(final.kinds.markdown.count, 4, 'Algebra, Geometrie, Eingang and Hausaufgaben are plain markdown')
  assert.equal(final.kinds.handwriting.count, 1)
  assert.equal(final.kinds.pdf.count, 1)
  assert.equal(final.kinds.image.count, 1)
  assert.equal(final.kinds.story.count, 1)
  const mathe = final.subjects.find((row) => row.name === 'Mathe')
  assert.equal(mathe.count, 2)
  assert.equal(mathe.color, '#ff0000')
  assert.equal(final.subjects.find((row) => row.name === 'Eingang').count, 3)
  assert.equal(final.largest[0].name, 'Buch.pdf')
  assert.equal(final.writing.wordsTyped, 40)
  assert.equal(final.writing.storyWords, 600, 'negative days are clamped, devices are summed')
  assert.equal(final.writing.strokes, 120)
  assert.equal(final.time.dwellMs, 600_000)
  assert.equal(final.time.byWeekday[1], 600_000)
  assert.deepEqual({ total: final.cards.total, due: final.cards.due, reviewed: final.cards.reviewed }, { total: 2, due: 1, reviewed: 1 })
  assert.equal(final.cards.retention, 0.75)
  assert.deepEqual({ done: final.school.done, open: final.school.open, overdue: final.school.overdue }, { done: 1, open: 2, overdue: 1 })
  assert.equal(final.school.upcoming.length, 2)
  assert.equal(final.school.exams.length, 1)
  assert.equal(final.school.exams[0].title, 'Mathe Klausur')
  assert.equal(final.activity.cells.length, 53 * 7)
  const cell = (offset) => final.activity.cells.find((entry) => entry.date === dayKey(day(offset)))
  assert.ok(cell(0).count >= 1 && cell(-1).count >= 1, 'mtime days are active')
  assert.ok(cell(-5).count >= 1 && cell(-6).count >= 1, 'history snapshot days are active')
  assert.ok(final.activity.cells.every((entry) => entry.future === (entry.date > dayKey(now))), 'only cells after today are future')
  assert.equal(final.activity.cells.at(-1).date, dayKey(now), 'the calendar ends with this week (today is a Sunday)')
  assert.ok(final.activity.streak.current >= 2, 'today and yesterday form a streak')

  // 2. cache: unchanged files are not read again (only Hausaufgaben.md)
  reads = 0
  await loadVaultStats(host, new AbortController().signal, () => {}, { now })
  assert.equal(reads, 1, 'second run reads only the homework file (statistics come from the short-lived cache)')

  // 3. cancel: an aborted run stops reading
  const controller = new AbortController()
  const many = Array.from({ length: 400 }, (_, index) => ({ name: `n${index}.md`, relativePath: `Viele/n${index}.md`, kind: 'file', extension: 'md', size: 10, modifiedAt: day(-1).toISOString() }))
  let manyReads = 0
  const slow = { getTree: async () => [{ name: 'Viele', relativePath: 'Viele', kind: 'folder', children: many }], readFile: async () => { manyReads += 1; if (manyReads === 5) controller.abort(); return 'x' } }
  await loadVaultStats(slow, controller.signal, () => {}, { now })
  assert.ok(manyReads < 40, `aborted run stopped early (${manyReads} reads)`)

  // 4. UI-thread friendliness: 5000 synthetic files aggregate quickly and loading yields to the event loop
  const big = Array.from({ length: 5000 }, (_, index) => ({ name: `b${index}.md`, relativePath: `F${index % 30}/b${index}.md`, kind: 'file', extension: 'md', size: index, modifiedAt: day(-(index % 300)).toISOString() }))
  const startedAt = performance.now()
  const aggregated = aggregateVault({ tree: [{ name: 'root', relativePath: 'root', kind: 'folder', children: big }], now })
  assert.ok(performance.now() - startedAt < 400, 'aggregating 5000 files is fast')
  assert.equal(aggregated.totals.files, 5000)

  // 5. helpers
  assert.equal(countWords('# Titel\n\n**fett** und [Link](http://x.y) <!-- hidden words -->'), 4)
  assert.deepEqual(streaks(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-14', '2026-11-15'], now), { current: 2, longest: 3, activeDays: 5 })
  assert.equal(factsFromNote('plain text here', now).words, 3)
  // "Heute fällig" follows the calendar day without re-reading the note (M1).
  const dueNote = factsFromNote(embedCards('x', [
    { id: 'a', front: 'Q1', back: 'A1', ease: 2.5, intervalDays: 1, due: '2026-11-15', reps: 1, lapses: 0 },
    { id: 'b', front: 'Q2', back: 'A2', ease: 2.5, intervalDays: 1, due: '2026-11-16', reps: 1, lapses: 0 },
  ]), now)
  const dueTree = [{ name: 'd.md', relativePath: 'd.md', kind: 'file', extension: 'md', size: 1, modifiedAt: now.toISOString() }]
  const dueOn = (date) => aggregateVault({ tree: dueTree, facts: { 'd.md': dueNote }, now: date }).cards.due
  assert.equal(dueOn(now), 1)
  assert.equal(dueOn(new Date(2026, 10, 16, 0, 5)), 2, 'a card due tomorrow is due after midnight')
  // Page-stats time is capped per tick and per session (M7).
  const { tickPageStats, openPageStats, MAX_TICK_GAP_MS, MAX_SESSION_DWELL_MS } = await server.ssrLoadModule('/src/lib/pageStats.ts')
  const t0 = Date.UTC(2026, 10, 15, 8)
  const idle = tickPageStats(openPageStats(emptyPageStats(t0), t0), t0 + 3 * 3600_000, true)
  assert.equal(idle.dwellMs, MAX_TICK_GAP_MS, 'a three hour gap adds only the cap')
  let session = openPageStats(emptyPageStats(t0), t0)
  for (let i = 1; i <= 400; i += 1) session = tickPageStats(session, t0 + i * MAX_TICK_GAP_MS, true)
  assert.equal(session.dwellMs, MAX_SESSION_DWELL_MS, 'one session stops at the session cap')
  // Loader: aggregate runs are throttled while scanning, and nothing is emitted after abort (M4, L5).
  {
    const manyDir = path.join(temporary, 'many')
    fs.mkdirSync(manyDir)
    const names = Array.from({ length: 300 }, (_, i) => `n${i}.md`)
    for (const name of names) fs.writeFileSync(path.join(manyDir, name), `word ${name}`)
    const entries = names.map((name) => ({ name, relativePath: name, kind: 'file', extension: 'md', size: 10, modifiedAt: now.toISOString() }))
    let updates = 0
    await loadVaultStats({ getTree: async () => entries, readFile: async (p) => fs.readFileSync(path.join(manyDir, p), 'utf8') }, new AbortController().signal, () => { updates += 1 }, { force: true, now })
    assert.ok(updates >= 2 && updates < 40, `throttled emits (${updates})`)
    const aborted = new AbortController()
    aborted.abort()
    let afterAbort = 0
    await loadVaultStats({ getTree: async () => entries, readFile: async () => '' }, aborted.signal, () => { afterAbort += 1 }, { force: true, now })
    assert.equal(afterAbort, 0)
  }
  console.log('Statistik-Prüfung bestanden: Aggregation, Cache, Abbruch und Skalierung auf einem synthetischen Vault.')
} finally {
  await server.close()
  fs.rmSync(temporary, { recursive: true, force: true })
}
