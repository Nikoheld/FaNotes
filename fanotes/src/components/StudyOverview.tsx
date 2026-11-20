import { BarChart3, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { readPageStatsFromNote } from '../lib/famd'
import { aggregateStudy, formatStudyDuration, type StudyOverview as StudyOverviewModel } from '../lib/studyOverview'
import type { VaultEntry } from '../types'

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

const markdownPaths = (entries: VaultEntry[]): string[] => {
  const paths: string[] = []
  const walk = (nodes: VaultEntry[]) => {
    for (const node of nodes) {
      if (node.kind === 'file' && /\.(md|markdown)$/iu.test(node.relativePath)) paths.push(node.relativePath)
      if (node.children) walk(node.children)
    }
  }
  walk(entries)
  return paths
}

export function StudyOverview({
  entries,
  onClose,
}: {
  entries: VaultEntry[]
  onClose: () => void
}) {
  const [overview, setOverview] = useState<StudyOverviewModel | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const paths = markdownPaths(entries).slice(0, 240)
      const notes = []
      for (const path of paths) {
        try {
          const content = await window.fanotes.readFile(path)
          notes.push({ path, stats: readPageStatsFromNote(content) })
        } catch {
          /* a missing companion must not hide the other notes */
        }
      }
      if (!cancelled) setOverview(aggregateStudy(notes))
    }
    void load().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Lernzeit konnte nicht gelesen werden.')
    })
    return () => { cancelled = true }
  }, [entries])

  const peak = overview ? Math.max(1, ...overview.dwellByWeekday) : 1

  return (
    <section className="study-overview" aria-label="Lernzeit">
      <style>{`
        .study-overview{display:flex;min-height:0;flex:1;flex-direction:column;background:var(--bg)}
        .study-overview header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 22px 8px}
        .study-overview header div{display:flex;align-items:center;gap:10px}
        .study-overview h2{margin:0;font-size:18px}
        .study-overview header p{margin:2px 0 0;color:var(--text-muted);font-size:12px}
        .study-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:8px 22px}
        .study-grid article,.study-panel{border:1px solid var(--border);border-radius:14px;background:var(--panel);padding:12px 14px}
        .study-grid strong{display:block;font-size:18px}
        .study-grid span,.study-panel h3{color:var(--text-muted);font-size:12px}
        .study-body{display:grid;grid-template-columns:220px minmax(0,1fr);gap:12px;min-height:0;padding:8px 22px 22px}
        .study-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;align-items:end;height:120px}
        .study-week i{display:block;border-radius:7px 7px 3px 3px;background:var(--accent)}
        .study-week b{display:block;margin-top:4px;color:var(--text-muted);font-size:10px;text-align:center}
        .study-subjects{display:grid;gap:8px}
        .study-subjects div{display:grid;grid-template-columns:minmax(0,1.4fr) repeat(3,minmax(0,.7fr));gap:8px;font-size:13px}
        @media(max-width:800px){.study-grid,.study-body{grid-template-columns:1fr}.study-subjects div{grid-template-columns:1fr 1fr}}
      `}</style>
      <header>
        <div>
          <BarChart3 size={18} />
          <div>
            <h2>Lernzeit</h2>
            <p>Aus den stillen Seitenstatistiken auf diesem Gerät. Nichts wird gesendet.</p>
          </div>
        </div>
        <button type="button" className="icon-button" aria-label="Lernzeit schließen" onClick={onClose}><X size={16} /></button>
      </header>
      {error && <p>{error}</p>}
      {overview && <>
        <div className="study-grid">
          <article><span>Auf Seiten</span><strong>{formatStudyDuration(overview.dwellMs)}</strong></article>
          <article><span>Tippen</span><strong>{formatStudyDuration(overview.typingMs)}</strong></article>
          <article><span>Handschrift</span><strong>{formatStudyDuration(overview.inkMs)}</strong></article>
          <article><span>Tinte</span><strong>{Math.round(overview.inkMm)} mm</strong></article>
        </div>
        <div className="study-body">
          <section className="study-panel">
            <h3>Wochentage</h3>
            <div className="study-week">
              {overview.dwellByWeekday.map((value, index) => (
                <div key={WEEKDAYS[index]}>
                  <i style={{ height: `${Math.max(4, Math.round((value / peak) * 96))}px` }} />
                  <b>{WEEKDAYS[index]}</b>
                </div>
              ))}
            </div>
          </section>
          <section className="study-panel">
            <h3>Fächer</h3>
            <div className="study-subjects">
              {overview.subjects.length === 0 && <p>Noch keine Seitenstatistik.</p>}
              {overview.subjects.map((row) => (
                <div key={row.subject}>
                  <b>{row.subject}</b>
                  <span>{formatStudyDuration(row.dwellMs)}</span>
                  <span>{formatStudyDuration(row.typingMs)} Tippen</span>
                  <span>{formatStudyDuration(row.inkMs)} Stift</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </>}
    </section>
  )
}
