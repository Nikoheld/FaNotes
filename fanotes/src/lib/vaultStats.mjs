// Statistics for the Settings → Statistik page. Pure functions: the loader reads
// the vault in small steps and hands the facts over; nothing here does I/O.

export const STATS_HEATMAP_WEEKS = 53
const EXAM_WORDS = /klausur|prüfung|pruefung|exam|test|schulaufgabe|probe|lernkontrolle|lk\b|arbeit/iu
const NO_SUBJECT = 'Eingang'

const pad = (value) => String(value).padStart(2, '0')
export const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const keyOfTime = (value) => {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '')
  return Number.isFinite(ms) && ms > 0 ? dayKey(new Date(ms)) : null
}
const timeOf = (value) => {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '')
  return Number.isFinite(ms) ? ms : 0
}
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)

/** Words the way a student counts them: markdown syntax and the famd payload do not count. */
export const countWords = (markdown) => {
  if (typeof markdown !== 'string' || !markdown) return 0
  const body = markdown
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[#>*_`~|-]+/gu, ' ')
  return (body.match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu) ?? []).length
}

export const noteKindOf = (entry, hasInk = false) => {
  const extension = String(entry.extension ?? '').toLowerCase().replace(/^\./u, '')
  if (extension === 'story') return 'story'
  if (extension === 'pdf') return 'pdf'
  if (extension === 'famd') return 'handwriting'
  if (extension === 'md' || extension === 'markdown') return hasInk ? 'handwriting' : 'markdown'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(extension)) return 'image'
  return 'media'
}

/** Flat file list. The subject is the first folder; its colour comes from that folder entry. */
export const flattenVault = (tree) => {
  const files = []
  let folders = 0
  const walk = (nodes, subject, color) => {
    for (const node of nodes ?? []) {
      if (node.kind === 'folder') {
        folders += 1
        const top = subject === null
        walk(node.children, top ? node.name : subject, top ? node.color : color)
      } else {
        files.push({
          path: node.relativePath,
          name: node.name,
          extension: node.extension,
          size: Number(node.size) || 0,
          mtime: timeOf(node.modifiedAt),
          ctime: timeOf(node.createdAt),
          subject: subject ?? NO_SUBJECT,
          color: color ?? null,
        })
      }
    }
  }
  walk(tree, null, null)
  return { files, folders }
}

const countDueOn = (dueDays, today) => { let n = 0; for (const day of dueDays) if (day <= today) n += 1; return n }

export const summarizeCards = (cards, today) => {
  if (!Array.isArray(cards) || !cards.length) return null
  let due = 0
  const dueDays = []
  let reps = 0
  let lapses = 0
  let reviewed = 0
  for (const card of cards) {
    if (card.due <= today) due += 1
    if (typeof card.due === 'string') dueDays.push(card.due)
    if (card.reps > 0) reviewed += 1
    reps += Math.max(0, card.reps || 0)
    lapses += Math.max(0, card.lapses || 0)
  }
  // dueDays lets the aggregate recount "due" for a later day without re-reading the note.
  return { total: cards.length, due, dueDays, reviewed, reps, lapses }
}

const level = (count, max) => (count <= 0 ? 0 : max <= 1 ? 4 : Math.min(4, 1 + Math.floor(((count - 1) / max) * 4)))

export const streaks = (activeDays, today) => {
  const set = activeDays instanceof Set ? activeDays : new Set(activeDays)
  let current = 0
  let cursor = new Date(today)
  // Today without activity does not break a streak that ran until yesterday.
  if (!set.has(dayKey(cursor))) cursor = addDays(cursor, -1)
  while (set.has(dayKey(cursor))) { current += 1; cursor = addDays(cursor, -1) }
  const sorted = [...set].filter((day) => /^\d{4}-\d{2}-\d{2}$/u.test(day)).sort()
  let longest = 0
  let run = 0
  let previous = null
  for (const day of sorted) {
    const [y, m, d] = day.split('-').map(Number)
    const at = new Date(y, m - 1, d)
    run = previous && dayKey(addDays(previous, 1)) === day ? run + 1 : 1
    previous = at
    longest = Math.max(longest, run)
  }
  return { current, longest, activeDays: sorted.length }
}

const top = (list, limit, by) => [...list].sort(by).slice(0, limit)

/**
 * @param input.tree        VaultEntry[]
 * @param input.facts       path -> { words, ink, cards, stats }  (markdown notes only)
 * @param input.history     path -> ISO timestamps of note-history snapshots
 * @param input.stories     path -> { 'YYYY-MM-DD': words written that day } (summed over devices)
 * @param input.homework    HomeworkTask[] | null
 * @param input.now         Date
 */
export const aggregateVault = (input) => {
  const now = input.now ?? new Date()
  const today = dayKey(now)
  const facts = input.facts ?? {}
  const { files, folders } = flattenVault(input.tree)
  const counts = { markdown: 0, handwriting: 0, pdf: 0, story: 0, image: 0, media: 0 }
  const bytesByKind = { markdown: 0, handwriting: 0, pdf: 0, story: 0, image: 0, media: 0 }
  const subjects = new Map()
  const activity = new Map()
  const activeDays = new Set()
  const bump = (day, field, by = 1) => {
    if (!day) return
    const cell = activity.get(day) ?? { edited: 0, created: 0, opened: 0, words: 0 }
    cell[field] += by
    activity.set(day, cell)
    if (field !== 'opened' || by > 0) activeDays.add(day)
  }
  const writing = { wordsInNotes: 0, wordsTyped: 0, storyWords: 0, strokes: 0, penMs: 0 }
  const time = { dwellMs: 0, byWeekday: [0, 0, 0, 0, 0, 0, 0], bySubject: new Map(), notesMeasured: 0 }
  const cards = { total: 0, due: 0, reviewed: 0, reps: 0, lapses: 0, notes: 0 }
  const sized = []

  for (const file of files) {
    const fact = facts[file.path]
    const kind = noteKindOf(file, Boolean(fact?.ink))
    file.kind = kind
    counts[kind] += 1
    bytesByKind[kind] += file.size
    const subject = subjects.get(file.subject) ?? { name: file.subject, color: file.color, count: 0, bytes: 0, words: 0, dwellMs: 0, kinds: { markdown: 0, handwriting: 0, pdf: 0, story: 0, image: 0, media: 0 } }
    subject.count += 1
    subject.bytes += file.size
    subject.kinds[kind] += 1
    subjects.set(file.subject, subject)
    sized.push(file)
    if (file.mtime) bump(keyOfTime(file.mtime), 'edited')
    if (file.ctime) bump(keyOfTime(file.ctime), 'created')
    if (fact) {
      writing.wordsInNotes += fact.words || 0
      subject.words += fact.words || 0
      if (fact.cards) {
        cards.total += fact.cards.total; cards.due += Array.isArray(fact.cards.dueDays) ? countDueOn(fact.cards.dueDays, today) : fact.cards.due; cards.reviewed += fact.cards.reviewed
        cards.reps += fact.cards.reps; cards.lapses += fact.cards.lapses; cards.notes += 1
      }
      const stats = fact.stats
      if (stats) {
        writing.wordsTyped += stats.wordsTyped || 0
        writing.strokes += stats.strokes || 0
        writing.penMs += stats.penMs || 0
        if (stats.dwellMs > 0) {
          time.dwellMs += stats.dwellMs
          time.notesMeasured += 1
          subject.dwellMs += stats.dwellMs
          stats.dwellByWeekday?.forEach((ms, index) => { if (index < 7) time.byWeekday[index] += ms || 0 })
        }
        for (const day of stats.activeDays ?? []) bump(day, 'opened')
      }
    }
    for (const stamp of input.history?.[file.path] ?? []) {
      const day = keyOfTime(stamp)
      if (day && day !== keyOfTime(file.mtime)) bump(day, 'edited')
    }
  }
  for (const [, perDay] of Object.entries(input.stories ?? {})) {
    for (const [day, words] of Object.entries(perDay)) {
      if (words > 0) { writing.storyWords += words; bump(day, 'words', words); }
    }
  }

  // Heatmap: Monday-first columns, ending with the current week.
  const monday = addDays(now, -((now.getDay() + 6) % 7))
  const start = addDays(monday, -7 * (STATS_HEATMAP_WEEKS - 1))
  const cells = []
  let max = 0
  for (let index = 0; index < STATS_HEATMAP_WEEKS * 7; index += 1) {
    const date = addDays(start, index)
    const key = dayKey(date)
    const cell = activity.get(key)
    const count = cell ? cell.edited + cell.created + cell.opened + (cell.words > 0 ? 1 : 0) : 0
    max = Math.max(max, count)
    cells.push({ date: key, count, future: key > today, active: activeDays.has(key), words: cell?.words ?? 0 })
  }
  const percentile = Math.max(1, ...cells.map((cell) => cell.count).sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(cells.length * 0.95))).slice(-1))
  for (const cell of cells) cell.level = cell.future ? 0 : level(cell.count, percentile)
  const weeks = []
  for (let week = 0; week < 12; week += 1) {
    const from = addDays(monday, -7 * (11 - week))
    let edited = 0
    let created = 0
    for (let day = 0; day < 7; day += 1) {
      const cell = activity.get(dayKey(addDays(from, day)))
      if (cell) { edited += cell.edited; created += cell.created }
    }
    weeks.push({ start: dayKey(from), edited, created })
  }

  // School
  const tasks = Array.isArray(input.homework) ? input.homework : null
  let school = null
  if (tasks) {
    const work = tasks.filter((task) => task.kind !== 'appointment')
    const appointments = tasks.filter((task) => task.kind === 'appointment')
    const bySubject = new Map()
    let overdue = 0
    for (const task of work) {
      const name = task.subject || 'Ohne Fach'
      const row = bySubject.get(name) ?? { name, done: 0, open: 0, overdue: 0 }
      if (task.done) row.done += 1
      else {
        row.open += 1
        if (task.dueDate && task.dueDate < today) { row.overdue += 1; overdue += 1 }
      }
      bySubject.set(name, row)
    }
    const upcoming = appointments
      .filter((task) => !task.done && task.dueDate && task.dueDate >= today)
      .sort((a, b) => `${a.dueDate} ${a.dueTime ?? ''}`.localeCompare(`${b.dueDate} ${b.dueTime ?? ''}`))
      .map((task) => ({ title: task.title, subject: task.subject || '', date: task.dueDate, time: task.dueTime, exam: EXAM_WORDS.test(task.title) }))
    school = {
      done: work.filter((task) => task.done).length,
      open: work.filter((task) => !task.done).length,
      overdue,
      bySubject: [...bySubject.values()].sort((a, b) => (b.open + b.done) - (a.open + a.done)),
      upcoming: upcoming.slice(0, 8),
      exams: upcoming.filter((item) => item.exam).slice(0, 5),
    }
  }

  const bytes = files.reduce((sum, file) => sum + file.size, 0)
  const subjectRows = [...subjects.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'de'))
  const slim = (file) => ({ path: file.path, name: file.name, kind: file.kind, size: file.size, mtime: file.mtime, ctime: file.ctime, subject: file.subject })
  return {
    generatedAt: now.getTime(),
    totals: { files: files.length, bytes, folders, notes: counts.markdown + counts.handwriting + counts.pdf + counts.story },
    kinds: Object.fromEntries(Object.keys(counts).map((kind) => [kind, { count: counts[kind], bytes: bytesByKind[kind] }])),
    subjects: subjectRows,
    largest: top(sized, 8, (a, b) => b.size - a.size).map(slim),
    newest: top(sized.filter((file) => file.ctime || file.mtime), 8, (a, b) => (b.ctime || b.mtime) - (a.ctime || a.mtime)).map(slim),
    recent: top(sized.filter((file) => file.mtime), 8, (a, b) => b.mtime - a.mtime).map(slim),
    activity: { cells, weeks, streak: streaks(activeDays, now), total: cells.reduce((sum, cell) => sum + cell.count, 0) },
    writing,
    time: { dwellMs: time.dwellMs, byWeekday: time.byWeekday, notesMeasured: time.notesMeasured, bySubject: subjectRows.filter((row) => row.dwellMs > 0).sort((a, b) => b.dwellMs - a.dwellMs).slice(0, 6).map((row) => ({ name: row.name, color: row.color, dwellMs: row.dwellMs })) },
    cards: { ...cards, retention: cards.reps > 0 ? Math.max(0, Math.min(1, (cards.reps - cards.lapses) / cards.reps)) : null },
    school,
  }
}
