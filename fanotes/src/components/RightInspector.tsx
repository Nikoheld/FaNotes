import { ChevronRight, FileText, Hash, History, Link2, ListTree, Sparkles, Tags } from 'lucide-react'
import { useMemo, useState } from 'react'
import { getUiLocale } from '../i18n'
import { backlinksFor } from '../lib/backlinks'
import { diffNoteLines, timelineHasInk } from '../lib/markdownDiff'
import { outlineTagsFromNote, parseNoteOutline } from '../lib/noteOutline'
import type { NoteHistorySnapshot } from '../types'

export function RightInspector({
  content,
  path,
  notes = [],
  history = [],
  onJumpToLine,
  onOpenNote,
  onShowHistory,
  onRestoreHistory,
}: {
  content: string
  path?: string
  notes?: Array<{ path: string; content: string }>
  history?: NoteHistorySnapshot[]
  onJumpToLine?: (line: number) => void
  onOpenNote?: (path: string) => void
  onShowHistory?: () => void
  onRestoreHistory?: (id: string) => void
}) {
  const headings = useMemo(() => parseNoteOutline(content), [content])
  const backlinks = useMemo(() => path ? backlinksFor(path, notes) : [], [notes, path])
  const [diffId, setDiffId] = useState<string | null>(null)
  const [diffText, setDiffText] = useState('')
  const stats = useMemo(() => {
    const visibleContent = content
      .replace(/<!--\s*fanotes-(?:ink|worksheet):[a-zA-Z0-9_-]{1,96}\s*-->/gu, '')
      .replace(/(?:^|\n)<!--\s*fanotes-famd:v1[\s\S]*$/u, '')
    const plain = visibleContent.replace(/[`#>*_~[\]()-]/g, ' ')
    const words = plain.trim() ? plain.trim().split(/\s+/).length : 0
    const characters = visibleContent.length
    const reading = Math.max(1, Math.ceil(words / 210))
    const tags = outlineTagsFromNote(content)
    return { words, characters, reading, tags }
  }, [content])

  return (
    <aside className="right-inspector">
      <header><div className="inspector-tabs"><button className="active" type="button"><ListTree size={15} /> Gliederung</button></div></header>
      <div className="inspector-scroll">
        <section>
          <h4><ListTree size={14} /> Gliederung</h4>
          {!headings.length && <p className="inspector-empty">Überschriften erscheinen hier automatisch.</p>}
          <nav className="outline-list">
            {headings.map((heading, index) => (
              <button type="button" key={`${heading.line}-${index}`} style={{ paddingLeft: `${10 + (heading.level - 1) * 12}px` }} title={`Zeile ${heading.line}`} onClick={() => onJumpToLine?.(heading.line)}>
                <ChevronRight size={12} /><span>{heading.title}</span>
              </button>
            ))}
          </nav>
        </section>
        <section>
          <h4><FileText size={14} /> Dokument</h4>
          <dl className="document-stats"><div><dt>Wörter</dt><dd>{stats.words.toLocaleString(getUiLocale())}</dd></div><div><dt>Zeichen</dt><dd>{stats.characters.toLocaleString(getUiLocale())}</dd></div><div><dt>Lesezeit</dt><dd>~ {stats.reading} min</dd></div></dl>
          {path && <div className="property-row"><Hash size={13} /><span>{path}</span></div>}
        </section>
        <section>
          <h4><Link2 size={14} /> Rückverweise</h4>
          {!backlinks.length && <p className="inspector-empty">Keine Wiki-Links auf diese Notiz.</p>}
          {backlinks.map((link) => (
            <button type="button" key={link.path} className="outline-list" onClick={() => onOpenNote?.(link.path)}>
              <span>{link.title}</span>
              <small>{link.excerpt}</small>
            </button>
          ))}
        </section>
        <section>
          <h4><History size={14} /> Versionen</h4>
          <button type="button" className="secondary-button" onClick={() => onShowHistory?.()}>Verlauf laden</button>
          {history.map((snapshot) => (
            <div key={snapshot.id}>
              <button type="button" onClick={() => {
                if (!path || !window.fanotes.readNoteHistory) return
                void window.fanotes.readNoteHistory(path, snapshot.id).then((loaded) => {
                  const previous = typeof loaded.content === 'string' ? loaded.content : ''
                  setDiffId(snapshot.id)
                  setDiffText(diffNoteLines(previous, content).map((row) => `${row.kind === 'added' ? '+' : '-'} ${row.text}`).join('\n') || 'Kein Textunterschied.')
                })
              }}>{new Date(snapshot.createdAt).toLocaleString(getUiLocale())}</button>
              <button type="button" onClick={() => onRestoreHistory?.(snapshot.id)}>Wiederherstellen</button>
              {timelineHasInk(diffId === snapshot.id ? diffText : '') && diffId === snapshot.id && <small>Enthält Handschrift.</small>}
            </div>
          ))}
          {diffId && <pre>{diffText}</pre>}
        </section>
        <section>
          <h4><Tags size={14} /> Tags</h4>
          <div className="tag-cloud">{stats.tags.length ? stats.tags.map((tag) => <span key={tag}>#{tag}</span>) : <p className="inspector-empty">Noch keine Tags.</p>}</div>
        </section>
        <div className="local-first-card"><Sparkles size={16} /><div><strong>Local first</strong><p>Deine Inhalte bleiben als lesbare Dateien in deinem Vault.</p></div></div>
      </div>
    </aside>
  )
}
