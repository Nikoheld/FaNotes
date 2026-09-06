import { ChevronRight, Clock3, FileText, Hash, ListTree, Sparkles, Tags } from 'lucide-react'
import { useMemo } from 'react'
import { getUiLocale } from '../i18n'
import { outlineTagsFromNote, parseNoteOutline } from '../lib/noteOutline'
import { formatPageDwell, type PageStats } from '../lib/pageStats'

export function RightInspector({
  content,
  path,
  pageStats,
  onJumpToLine,
}: {
  content: string
  path?: string
  pageStats?: PageStats | null
  onJumpToLine?: (line: number) => void
}) {
  const headings = useMemo(() => parseNoteOutline(content), [content])
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
          <h4><Clock3 size={14} /> Seite</h4>
          {pageStats ? (
            <dl className="document-stats page-stats">
              <div><dt>Erstellt</dt><dd>{new Date(pageStats.createdAt).toLocaleString(getUiLocale())}</dd></div>
              <div><dt>Geändert</dt><dd>{new Date(pageStats.modifiedAt).toLocaleString(getUiLocale())}</dd></div>
              <div><dt>Auf der Seite</dt><dd>{formatPageDwell(pageStats.dwellMs)}</dd></div>
              <div><dt>Zuletzt geöffnet</dt><dd>{new Date(pageStats.lastOpenedAt).toLocaleString(getUiLocale())}</dd></div>
              <div><dt>Öffnungen</dt><dd>{pageStats.openCount.toLocaleString(getUiLocale())}</dd></div>
            </dl>
          ) : (
            <p className="inspector-empty">Statistik erscheint, sobald die Seite geöffnet ist.</p>
          )}
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
