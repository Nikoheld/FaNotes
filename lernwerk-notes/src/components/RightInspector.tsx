import { ChevronRight, FileText, Hash, ListTree, Sparkles, Tags } from 'lucide-react'
import { useMemo } from 'react'
import { getUiLocale } from '../i18n'

type Heading = { level: number; title: string; line: number }

const parseHeadings = (content: string) => content.split('\n').flatMap<Heading>((line, index) => {
  const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line)
  return match ? [{ level: match[1].length, title: match[2], line: index + 1 }] : []
})

export function RightInspector({ content, path }: { content: string; path?: string }) {
  const headings = useMemo(() => parseHeadings(content), [content])
  const stats = useMemo(() => {
    const visibleContent = content.replace(/<!--\s*fanotes-(?:ink|worksheet):[a-zA-Z0-9_-]{1,96}\s*-->/gu, '')
    const plain = visibleContent.replace(/[`#>*_~[\]()-]/g, ' ')
    const words = plain.trim() ? plain.trim().split(/\s+/).length : 0
    const characters = visibleContent.length
    const reading = Math.max(1, Math.ceil(words / 210))
    const tags = [...new Set(Array.from(visibleContent.matchAll(/(?:^|\s)#([\p{L}\d_/-]+)/gu), (match) => match[1]))]
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
              <button type="button" key={`${heading.line}-${index}`} style={{ paddingLeft: `${10 + (heading.level - 1) * 12}px` }} title={`Zeile ${heading.line}`}>
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
          <h4><Tags size={14} /> Tags</h4>
          <div className="tag-cloud">{stats.tags.length ? stats.tags.map((tag) => <span key={tag}>#{tag}</span>) : <p className="inspector-empty">Noch keine Tags.</p>}</div>
        </section>
        <div className="local-first-card"><Sparkles size={16} /><div><strong>Local first</strong><p>Deine Inhalte bleiben als lesbare Dateien in deinem Vault.</p></div></div>
      </div>
    </aside>
  )
}
