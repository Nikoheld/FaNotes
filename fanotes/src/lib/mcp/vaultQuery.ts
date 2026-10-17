import { CALENDAR_NOTE_PATH, expandOccurrences, loadCalendarMarkdown, type CalendarDocument } from '../calendarModel'
import { parseStoredCards } from '../flashcards'
import { HOMEWORK_NOTE_PATH, loadHomeworkMarkdown } from '../homeworkStore'

export type VaultListing = { path: string; modifiedAt: string | null }
export type VaultNote = { path: string; modifiedAt: string | null; markdown: string }
export type VaultReader = {
  list: () => Promise<VaultListing[]>
  read: (path: string) => Promise<string>
}

const EXAM_WORD = /\b(klausur|prüfungen|prüfung|pruefung|examen|exam|matura|abitur)\b/iu
const MAX_READS = 250
const MAX_FILE_CHARS = 300_000
const MAX_TEXT = 80_000

const isNotePath = (value: string) => {
  if (!value || value.length > 240 || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return false
  return value.toLowerCase().endsWith('.md')
}

const folderOf = (path: string) => {
  const slash = path.lastIndexOf('/')
  return slash > 0 ? path.slice(0, slash) : ''
}

const titleOf = (path: string, markdown: string) => {
  const heading = /^#\s+(.+)$/mu.exec(markdown)?.[1]?.trim()
  if (heading) return heading.slice(0, 180)
  const name = path.split('/').pop() ?? path
  return name.replace(/\.md$/iu, '')
}

const dateKey = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const parseDay = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

const rangeOf = (args: Record<string, unknown>, now: Date) => {
  const from = typeof args.from === 'string' ? parseDay(args.from) : new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const fallbackTo = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 370)
  const to = typeof args.to === 'string' ? parseDay(args.to) : fallbackTo
  if (!from || !to || to.getTime() <= from.getTime()) return null
  if (to.getTime() - from.getTime() > 800 * 24 * 60 * 60 * 1000) return null
  return { from, to }
}

const stripMachine = (markdown: string) => markdown
  .replace(/<!--\s*fanotes-(?:calendar|homework|cards)-v1[\s\S]*?-->/gu, '')
  .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]{80,}/giu, '[embedded file omitted]')
  .replace(/\n{3,}/gu, '\n\n')
  .trim()

const text = (value: unknown, isError = false) => {
  const raw = JSON.stringify(value)
  const body = raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT)}\n…` : raw
  return { content: [{ type: 'text' as const, text: body }], isError }
}

const noteByPath = (notes: VaultNote[], path: string) => notes.find((note) => note.path === path)

const calendarOf = (notes: VaultNote[]) => {
  const note = noteByPath(notes, CALENDAR_NOTE_PATH)
  if (!note) return null
  const loaded = loadCalendarMarkdown(note.markdown)
  if (!loaded.ok) return null
  const document: CalendarDocument = {
    ...loaded.document,
    calendars: loaded.document.calendars.map((calendar) => ({ ...calendar, visible: true })),
  }
  return document
}

const homeworkOf = (notes: VaultNote[]) => {
  const note = noteByPath(notes, HOMEWORK_NOTE_PATH)
  if (!note) return null
  const loaded = loadHomeworkMarkdown(note.markdown)
  return loaded.ok ? loaded.document : null
}

const occurrences = (notes: VaultNote[], from: Date, to: Date) => {
  const document = calendarOf(notes)
  if (!document) return []
  const names = new Map(document.calendars.map((calendar) => [calendar.id, calendar.name]))
  return expandOccurrences(document, from, to).map((occurrence) => ({
    title: occurrence.event.title,
    start: occurrence.event.allDay ? occurrence.event.start : occurrence.event.start,
    end: occurrence.event.end,
    allDay: occurrence.event.allDay,
    calendar: names.get(occurrence.event.calendarId) ?? '',
    location: occurrence.event.location,
    notes: occurrence.event.notes,
    notePath: occurrence.event.notePath,
    occurrence: occurrence.key,
  }))
}

const isExam = (title: string, calendar: string) => EXAM_WORD.test(title) || EXAM_WORD.test(calendar)

const mentionedExams = (notes: VaultNote[]) => {
  const hits: Array<{ path: string; line: string }> = []
  for (const note of notes) {
    if (note.path === CALENDAR_NOTE_PATH || note.path === HOMEWORK_NOTE_PATH) continue
    for (const line of stripMachine(note.markdown).split('\n')) {
      if (!EXAM_WORD.test(line)) continue
      if (!/\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{2,4}/u.test(line)) continue
      hits.push({ path: note.path, line: line.trim().slice(0, 240) })
      if (hits.length >= 40) return hits
    }
  }
  return hits
}

export const answerVaultTool = (tool: string, args: Record<string, unknown>, notes: VaultNote[], now = new Date()) => {
  if (tool === 'vault_summary') {
    const folders = new Set(notes.map((note) => folderOf(note.path)).filter(Boolean))
    const range = rangeOf({}, now)
    const events = range ? occurrences(notes, range.from, range.to) : []
    const homework = homeworkOf(notes)
    const cards = notes.flatMap((note) => parseStoredCards(note.markdown))
    return text({
      notes: notes.filter((note) => note.path !== CALENDAR_NOTE_PATH && note.path !== HOMEWORK_NOTE_PATH).length,
      folders: folders.size,
      upcomingExams: events.filter((event) => isExam(event.title, event.calendar)).length,
      calendarEvents: events.length,
      openHomework: homework?.tasks.filter((task) => !task.done).length ?? 0,
      flashcards: cards.length,
    })
  }
  if (tool === 'list_notes') {
    const folder = typeof args.folder === 'string' ? args.folder.trim().replace(/\/+$/u, '') : ''
    const limit = typeof args.limit === 'number' ? args.limit : 100
    const rows = notes
      .filter((note) => !folder || note.path === folder || note.path.startsWith(`${folder}/`))
      .slice(0, limit)
      .map((note) => ({
        path: note.path,
        title: titleOf(note.path, note.markdown),
        folder: folderOf(note.path),
        modifiedAt: note.modifiedAt,
      }))
    return text({ notes: rows })
  }
  if (tool === 'read_note') {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    const note = noteByPath(notes, path)
    if (!note) return text({ error: 'That note is not in the synced vault.' }, true)
    return text({ path: note.path, title: titleOf(note.path, note.markdown), modifiedAt: note.modifiedAt, markdown: stripMachine(note.markdown).slice(0, 60_000) })
  }
  if (tool === 'search_notes') {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const limit = typeof args.limit === 'number' ? args.limit : 20
    const needle = query.toLocaleLowerCase('de')
    const matches: Array<{ path: string; excerpt: string }> = []
    for (const note of notes) {
      const body = stripMachine(note.markdown)
      const index = body.toLocaleLowerCase('de').indexOf(needle)
      if (index < 0) continue
      const start = Math.max(0, index - 60)
      matches.push({ path: note.path, excerpt: body.slice(start, start + 220).replace(/\s+/gu, ' ') })
      if (matches.length >= limit) break
    }
    return text({ query, matches })
  }
  if (tool === 'list_calendar' || tool === 'list_exams') {
    const range = rangeOf(args, now)
    if (!range) return text({ error: 'The date range is not valid.' }, true)
    const events = occurrences(notes, range.from, range.to)
    if (tool === 'list_calendar') return text({ from: dateKey(range.from), to: dateKey(range.to), events })
    const homework = homeworkOf(notes)
    const tasks = (homework?.tasks ?? []).filter((task) => task.dueDate && isExam(task.title, task.subject))
    return text({
      from: dateKey(range.from),
      to: dateKey(range.to),
      exams: events.filter((event) => isExam(event.title, event.calendar)),
      homework: tasks.map((task) => ({ title: task.title, subject: task.subject, dueDate: task.dueDate, dueTime: task.dueTime, done: task.done })),
      mentionedInNotes: mentionedExams(notes),
    })
  }
  if (tool === 'list_homework') {
    const homework = homeworkOf(notes)
    const tasks = (homework?.tasks ?? []).filter((task) => args.includeDone === true || !task.done)
    return text({
      tasks: tasks.map((task) => ({
        title: task.title,
        subject: task.subject,
        dueDate: task.dueDate,
        dueTime: task.dueTime,
        done: task.done,
        kind: task.kind,
        priority: task.priority,
        notes: task.notes,
      })),
    })
  }
  if (tool === 'list_flashcards') {
    const limit = typeof args.limit === 'number' ? args.limit : 40
    const today = dateKey(now)
    const cards = notes.flatMap((note) => parseStoredCards(note.markdown).map((card) => ({ ...card, path: note.path })))
      .filter((card) => args.dueOnly !== true || card.due <= today)
      .slice(0, limit)
      .map((card) => ({ path: card.path, front: card.front, back: card.back, due: card.due }))
    return text({ cards })
  }
  return text({ error: 'Unknown FaNotes tool.' }, true)
}

export const collectVaultNotes = async (tool: string, args: Record<string, unknown>, reader: VaultReader): Promise<VaultNote[]> => {
  const listings = (await reader.list()).filter((entry) => isNotePath(entry.path))
  const wanted = new Set<string>()
  if (tool === 'read_note' && typeof args.path === 'string' && isNotePath(args.path.trim())) wanted.add(args.path.trim())
  else if (tool === 'list_notes') {
    const folder = typeof args.folder === 'string' ? args.folder.trim().replace(/\/+$/u, '') : ''
    for (const entry of listings) {
      if (folder && entry.path !== folder && !entry.path.startsWith(`${folder}/`)) continue
      wanted.add(entry.path)
      if (wanted.size >= 200) break
    }
  } else {
    if (listings.some((entry) => entry.path === CALENDAR_NOTE_PATH)) wanted.add(CALENDAR_NOTE_PATH)
    if (listings.some((entry) => entry.path === HOMEWORK_NOTE_PATH)) wanted.add(HOMEWORK_NOTE_PATH)
    if (tool !== 'list_homework' && tool !== 'list_calendar') {
      for (const entry of listings) {
        wanted.add(entry.path)
        if (wanted.size >= MAX_READS) break
      }
    }
  }
  const notes: VaultNote[] = []
  for (const path of wanted) {
    const listed = listings.find((entry) => entry.path === path)
    if (tool === 'list_notes') {
      notes.push({ path, modifiedAt: listed?.modifiedAt ?? null, markdown: '' })
      continue
    }
    try {
      const markdown = await reader.read(path)
      notes.push({ path, modifiedAt: listed?.modifiedAt ?? null, markdown: markdown.slice(0, MAX_FILE_CHARS) })
    } catch {
      // A missing note stays absent so read_note can say it is not in the vault.
    }
  }
  return notes
}
