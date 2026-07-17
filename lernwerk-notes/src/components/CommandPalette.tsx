import { ArrowDown, ArrowUp, CornerDownLeft, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

export type PaletteAction = {
  id: string
  label: string
  detail?: string
  shortcut?: string
  group: string
  keywords?: string
  icon?: React.ReactNode
  run: () => void
}

export function CommandPalette({ actions, onClose }: { actions: PaletteAction[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const filtered = useMemo(() => {
    const terms = query.toLocaleLowerCase('de').trim().split(/\s+/).filter(Boolean)
    if (!terms.length) return actions
    return actions.filter((action) => {
      const haystack = `${action.label} ${action.detail ?? ''} ${action.group} ${action.keywords ?? ''}`.toLocaleLowerCase('de')
      return terms.every((term) => haystack.includes(term))
    })
  }, [actions, query])

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setSelected(0) }, [query])

  const execute = (action: PaletteAction | undefined) => {
    if (!action) return
    onClose()
    action.run()
  }

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Befehlspalette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-search">
          <Search size={19} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Befehl suchen …"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose()
              if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => Math.min(filtered.length - 1, value + 1)) }
              if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)) }
              if (event.key === 'Enter') { event.preventDefault(); execute(filtered[selected]) }
            }}
          />
          <button type="button" onClick={onClose} aria-label="Schließen"><X size={16} /></button>
        </div>
        <div className="palette-results">
          {!filtered.length && <div className="palette-empty">Kein passender Befehl</div>}
          {filtered.map((action, index) => {
            const previousGroup = filtered[index - 1]?.group
            return (
              <div key={action.id}>
                {action.group !== previousGroup && <div className="palette-group">{action.group}</div>}
                <button
                  type="button"
                  className={index === selected ? 'selected' : ''}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => execute(action)}
                >
                  <span className="palette-action-icon">{action.icon}</span>
                  <span className="palette-action-copy"><strong>{action.label}</strong>{action.detail && <small>{action.detail}</small>}</span>
                  {action.shortcut && <kbd>{action.shortcut}</kbd>}
                </button>
              </div>
            )
          })}
        </div>
        <footer><span><ArrowUp size={13} /><ArrowDown size={13} /> auswählen</span><span><CornerDownLeft size={13} /> öffnen</span><span>Esc schließen</span></footer>
      </section>
    </div>
  )
}
