import { BookMarked, Check, ClipboardList, Copy, FilePlus2, Pause, Pencil, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { requestPdfReveal } from '../../lib/docSearch/reveal'
import { readPdfMarks, writePdfMarks } from '../../lib/pdfTextMarks'
import { groupMarksByPage, marksToMarkdown } from '../../lib/study/marks'
import { readPdfPageLines } from '../../lib/study/pdfLines'
import {
  detectTasks, formatClock, mergeDetected, newManualTask, readTaskList, sortTasks, taskProgress, writeTaskList,
  type StudyTask, type StudyTaskList,
} from '../../lib/study/tasks'

type Props = {
  path: string
  title: string
  content: string
  initialTab?: 'tasks' | 'marks'
  onContentChange: (content: string) => void
  onSaveNote: (title: string, markdown: string) => void
  onNotice: (message: string) => void
  onClose: () => void
}

const SAVE_EVERY_MS = 20_000

export function StudyPanel({ path, title, content, initialTab = 'tasks', onContentChange, onSaveNote, onNotice, onClose }: Props) {
  const [tab, setTab] = useState<'tasks' | 'marks'>(initialTab)
  const [scanning, setScanning] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [running, setRunning] = useState<{ id: string; since: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const contentRef = useRef(content)
  contentRef.current = content
  const runningRef = useRef(running)
  runningRef.current = running
  const stored = useMemo(() => readTaskList(content), [content])
  const tasks = stored?.tasks ?? []
  const marks = useMemo(() => readPdfMarks(content), [content])

  const commit = useCallback((list: StudyTaskList) => {
    const next = writeTaskList(contentRef.current, list)
    if (next === null) {
      onNotice('Die Aufgabenliste in dieser PDF-Notiz ist beschädigt (ein fanotes-tasks-v1-Kommentar ist nicht abgeschlossen). Nichts wurde überschrieben; repariere den Kommentar im Text der Notiz.')
      return
    }
    onContentChange(next)
  }, [onContentChange, onNotice])
  const update = useCallback((id: string, patch: Partial<StudyTask>) => {
    const list = readTaskList(contentRef.current) ?? { tasks: [], removed: [] }
    commit({ ...list, tasks: list.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)) })
  }, [commit])

  const updateRef = useRef(update)
  updateRef.current = update

  const scan = useCallback(async () => {
    setScanning(true)
    try {
      const pages = await readPdfPageLines(path)
      if (pages.every((page) => page.lines.length === 0)) {
        onNotice('Das PDF enthält keinen auslesbaren Text (z. B. ein Scan). Du kannst Aufträge von Hand hinzufügen.')
        return
      }
      const detected = detectTasks(pages)
      const merged = mergeDetected(readTaskList(contentRef.current), detected)
      if (merged.tasks.length || readTaskList(contentRef.current)) commit(merged)
      onNotice(detected.length ? `${detected.length} Aufträge erkannt.` : 'Keine Aufträge im Text gefunden. Du kannst sie von Hand hinzufügen.')
    } catch {
      onNotice('Das PDF konnte nicht gelesen werden. Es ist vielleicht beschädigt oder passwortgeschützt. Du kannst Aufträge von Hand hinzufügen.')
    } finally {
      setScanning(false)
    }
  }, [commit, onNotice, path])

  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current || readTaskList(contentRef.current)) return
    startedRef.current = true
    void scan()
  }, [scan])

  // Timer: the stored seconds only change when it is paused or every few seconds while it runs.
  useEffect(() => {
    if (!running) return undefined
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    const save = window.setInterval(() => {
      const current = runningRef.current
      if (!current) return
      const seconds = Math.round((Date.now() - current.since) / 1000)
      if (seconds <= 0) return
      const list = readTaskList(contentRef.current)
      const task = list?.tasks.find((entry) => entry.id === current.id)
      if (task) updateRef.current(current.id, { spentSec: task.spentSec + seconds })
      setRunning({ id: current.id, since: Date.now() })
    }, SAVE_EVERY_MS)
    return () => { window.clearInterval(tick); window.clearInterval(save) }
  }, [running?.id])

  const stop = useCallback(() => {
    const current = runningRef.current
    if (!current) return
    const seconds = Math.round((Date.now() - current.since) / 1000)
    const task = readTaskList(contentRef.current)?.tasks.find((entry) => entry.id === current.id)
    if (task && seconds > 0) updateRef.current(current.id, { spentSec: task.spentSec + seconds })
    setRunning(null)
  }, [])
  const stopRef = useRef(stop)
  stopRef.current = stop
  useEffect(() => () => { if (runningRef.current) stopRef.current() }, [])

  const toggleTimer = (id: string) => {
    if (running?.id === id) { stop(); return }
    stop()
    setRunning({ id, since: Date.now() })
    setNow(Date.now())
  }

  const progress = taskProgress(tasks)
  const spent = (task: StudyTask) => task.spentSec + (running?.id === task.id ? Math.round((now - running.since) / 1000) : 0)
  const jump = (page: number) => requestPdfReveal(path, page, '')
  const grouped = useMemo(() => groupMarksByPage(marks), [marks])

  const copyMarks = async () => {
    try { await navigator.clipboard.writeText(marksToMarkdown(title, marks)); onNotice('Markierungen als Notiz kopiert.') } catch { onNotice('Kopieren ist hier nicht erlaubt.') }
  }

  return (
    <aside className="right-inspector lw-panel" aria-label="Lernwerkzeuge für dieses PDF">
      <header>
        <div className="inspector-tabs">
          <button type="button" className={tab === 'tasks' ? 'active' : ''} aria-pressed={tab === 'tasks'} onClick={() => setTab('tasks')}><ClipboardList size={15} /> Aufträge</button>
          <button type="button" className={tab === 'marks' ? 'active' : ''} aria-pressed={tab === 'marks'} onClick={() => setTab('marks')}><BookMarked size={15} /> Markierungen</button>
        </div>
        <button type="button" className="lw-icon-btn" aria-label="Schließen" title="Schließen" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="inspector-scroll">
        {tab === 'tasks' && (
          <section>
            <div className="lw-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label="Fortschritt der Aufträge">
              <span style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
            </div>
            <p className="lw-progress-text">{progress.done} von {progress.total} erledigt{progress.plannedMinutes ? ` · noch ca. ${progress.remainingMinutes} von ${progress.plannedMinutes} Min.` : ''}</p>
            <div className="lw-actions">
              <button type="button" className="secondary-button" disabled={scanning} onClick={() => void scan()}><RefreshCw size={13} className={scanning ? 'spin' : ''} /> {scanning ? 'Suche …' : 'Neu erkennen'}</button>
              <button type="button" className="secondary-button" onClick={() => {
                const list = readTaskList(contentRef.current) ?? { tasks: [], removed: [] }
                const task = newManualTask(list.tasks, 1)
                commit({ ...list, tasks: sortTasks([...list.tasks, task]) })
                setEditing(task.id)
              }}><Plus size={13} /> Auftrag</button>
            </div>
            {!tasks.length && !scanning && <p className="inspector-empty">Keine Aufträge. Zeilen wie „Auftrag 3: …“ werden automatisch erkannt, sonst füge sie von Hand hinzu.</p>}
            <ul className="lw-task-list">
              {tasks.map((task) => {
                const seconds = spent(task)
                const over = task.minutes > 0 && seconds > task.minutes * 60
                const active = running?.id === task.id
                return (
                  <li key={task.id} className={`lw-task ${task.done ? 'is-done' : ''}`}>
                    <input type="checkbox" checked={task.done} aria-label={`Auftrag ${task.number || ''} erledigt`} onChange={(event) => { if (event.target.checked && active) stop(); update(task.id, { done: event.target.checked }) }} />
                    <div className="lw-task-main">
                      {editing === task.id ? (
                        <div className="lw-task-edit">
                          <input aria-label="Nummer" className="is-short" value={task.number} onChange={(event) => update(task.id, { number: event.target.value.slice(0, 6), manual: true })} />
                          <input aria-label="Text" value={task.title} placeholder="Was ist zu tun?" onChange={(event) => update(task.id, { title: event.target.value, manual: true })} />
                          <input aria-label="Minuten" type="number" min={0} max={600} className="is-short" value={task.minutes || ''} placeholder="Min." onChange={(event) => update(task.id, { minutes: Math.max(0, Math.min(600, Number(event.target.value) || 0)), manual: true })} />
                          <input aria-label="Seite" type="number" min={1} className="is-short" value={task.page} onChange={(event) => update(task.id, { page: Math.max(1, Number(event.target.value) || 1), manual: true })} />
                        </div>
                      ) : (
                        <button type="button" className="lw-task-title" onClick={() => jump(task.page)} title={`Zu Seite ${task.page} springen`}>
                          <strong>{task.number ? `Auftrag ${task.number}` : 'Auftrag'}</strong> {task.title || 'ohne Text'}
                        </button>
                      )}
                      <div className="lw-task-meta">
                        <button type="button" className="lw-chip" onClick={() => jump(task.page)}>S. {task.page}</button>
                        <span className={`lw-clock ${over ? 'is-over' : ''}`} aria-label="Zeit">{formatClock(seconds)}{task.minutes ? ` / ${task.minutes} min` : ''}</span>
                        <button type="button" className="lw-icon-btn" aria-label={active ? 'Timer anhalten' : 'Timer starten'} title={active ? 'Timer anhalten' : 'Timer starten'} onClick={() => toggleTimer(task.id)}>{active ? <Pause size={13} /> : <Play size={13} />}</button>
                        <button type="button" className="lw-icon-btn" aria-label={editing === task.id ? 'Fertig bearbeitet' : 'Bearbeiten'} title={editing === task.id ? 'Fertig' : 'Bearbeiten'} onClick={() => setEditing(editing === task.id ? null : task.id)}>{editing === task.id ? <Check size={13} /> : <Pencil size={13} />}</button>
                        <button type="button" className="lw-icon-btn" aria-label="Auftrag entfernen" title="Entfernen" onClick={() => {
                          if (active) stop()
                          const list = readTaskList(contentRef.current) ?? { tasks: [], removed: [] }
                          commit({ tasks: list.tasks.filter((entry) => entry.id !== task.id), removed: task.manual ? list.removed : [...new Set([...list.removed, task.id])] })
                        }}><Trash2 size={13} /></button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        {tab === 'marks' && (
          <section>
            <p className="lw-progress-text">{marks.length} Markierungen auf {grouped.length} Seiten</p>
            <div className="lw-actions">
              <button type="button" className="secondary-button" disabled={!marks.length} onClick={() => void copyMarks()}><Copy size={13} /> Als Notiz kopieren</button>
              <button type="button" className="secondary-button" disabled={!marks.length} onClick={() => onSaveNote(`Markierungen ${title.replace(/\.pdf$/iu, '')}`, marksToMarkdown(title, marks))}><FilePlus2 size={13} /> Neue Notiz</button>
            </div>
            {!marks.length && <p className="inspector-empty">Markiere Text im PDF mit dem Textmarker. Alle Stellen erscheinen hier nach Seite sortiert.</p>}
            {grouped.map((group) => (
              <div key={group.page} className="lw-mark-page">
                <button type="button" className="lw-chip" onClick={() => jump(group.page)}>Seite {group.page}</button>
                <ul>
                  {group.marks.map((mark) => (
                    <li key={mark.id}>
                      <button type="button" className={`lw-mark is-${mark.kind}`} onClick={() => jump(mark.page)} title="Zur Stelle springen">{mark.quote}</button>
                      <button type="button" className="lw-icon-btn" aria-label="Markierung entfernen" title="Markierung entfernen" onClick={() => onContentChange(writePdfMarks(contentRef.current, readPdfMarks(contentRef.current).filter((entry) => entry.id !== mark.id)))}><Trash2 size={12} /></button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>
    </aside>
  )
}

export default StudyPanel
