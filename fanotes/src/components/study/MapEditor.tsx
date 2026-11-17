import { ArrowDown, ArrowRight, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { addMapEdge, addMapNode, freeMapPair, MAP_LIMITS, mapFromText, patchMapEdge, type MapData, type MapEdge } from '../../lib/study/conceptMap'
import { renderMapSvg } from '../../lib/study/render'

type Props = { data: MapData; onChange: (data: MapData) => void }

// Texts in this file that name a cap in digits (80 Boxen, 160 Pfeile) can then be translated as they are; they must follow MAP_LIMITS.
const HINTS = {
  loop: 'Ein Pfeil kann nicht in dieselbe Box zurückführen.',
  copy: 'Diesen Pfeil gibt es schon: gleiche Boxen, gleiche Beschriftung.',
} as const

export function MapEditor({ data, onChange }: Props) {
  const [quick, setQuick] = useState('')
  const [hint, setHint] = useState('')
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const focusAfter = useRef<string | null>(null)
  const preview = useMemo(() => renderMapSvg(data).svg, [data])
  const name = (id: string) => data.nodes.find((node) => node.id === id)?.text || '…'
  const nodesFull = data.nodes.length >= MAP_LIMITS.nodes
  const edgesFull = data.edges.length >= MAP_LIMITS.edges

  // A new row takes the cursor, so a map is typed in without reaching for the mouse in between.
  useEffect(() => {
    const key = focusAfter.current
    focusAfter.current = null
    if (key) inputs.current.get(key)?.focus()
  }, [data])
  const field = (key: string) => (element: HTMLInputElement | null) => { if (element) inputs.current.set(key, element); else inputs.current.delete(key) }

  const changeEdge = (edge: MapEdge, patch: Partial<Pick<MapEdge, 'from' | 'to' | 'label'>>) => {
    const next = patchMapEdge(data, edge.id, patch)
    if (typeof next === 'string') { setHint(HINTS[next]); return }
    setHint('')
    onChange(next)
  }
  const addNode = () => {
    const next = addMapNode(data)
    if (next === data) return
    focusAfter.current = `node:${next.nodes[next.nodes.length - 1].id}`
    onChange(next)
  }
  const addEdge = () => {
    const next = addMapEdge(data)
    if (next === data) return
    focusAfter.current = `edge:${next.edges[next.edges.length - 1].id}`
    onChange(next)
  }

  return (
    <div className="lw-editor">
      <div className="lw-actions">
        <input className="lw-title-input" aria-label="Titel" placeholder="Titel" maxLength={MAP_LIMITS.title} value={data.title} onChange={(event) => onChange({ ...data, title: event.target.value })} />
        <button type="button" className="secondary-button" aria-pressed={data.dir === 'TB'} onClick={() => onChange({ ...data, dir: data.dir === 'TB' ? 'LR' : 'TB' })} title="Richtung wechseln">{data.dir === 'TB' ? <><ArrowDown size={14} /> von oben</> : <><ArrowRight size={14} /> von links</>}</button>
      </div>
      <div className="lw-pane lw-split">
        <div className="lw-map-forms">
          <div className="lw-paste">
            <label htmlFor="lw-map-quick">Schnell eingeben: eine Beziehung pro Zeile</label>
            <textarea id="lw-map-quick" rows={3} placeholder={'Häutungshormon -> löst aus -> Häutung\nJuvenilhormon -> hemmt -> Verpuppung'} value={quick} onChange={(event) => setQuick(event.target.value)} />
            <button type="button" className="primary-button" disabled={!quick.trim()} onClick={() => { onChange(mapFromText(data, quick)); setQuick('') }}>Übernehmen</button>
          </div>
          <h4>Boxen</h4>
          <ul className="lw-list">
            {data.nodes.map((node) => (
              <li key={node.id}>
                <input ref={field(`node:${node.id}`)} aria-label="Box" maxLength={MAP_LIMITS.nodeText} value={node.text} onChange={(event) => onChange({ ...data, nodes: data.nodes.map((entry) => (entry.id === node.id ? { ...entry, text: event.target.value } : entry)) })} />
                <button type="button" className="lw-icon-btn" aria-label="Box löschen" title="Box löschen" onClick={() => onChange({ ...data, nodes: data.nodes.filter((entry) => entry.id !== node.id), edges: data.edges.filter((edge) => edge.from !== node.id && edge.to !== node.id) })}><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
          <button type="button" className="secondary-button" disabled={nodesFull} title={nodesFull ? 'Ein Begriffsnetz fasst höchstens 80 Boxen.' : undefined} onClick={addNode}><Plus size={14} /> Box</button>
          <h4>Pfeile</h4>
          <ul className="lw-list">
            {data.edges.map((edge) => (
              <li key={edge.id} className="lw-edge-row">
                <select aria-label="Von" value={edge.from} onChange={(event) => changeEdge(edge, { from: event.target.value })}>{data.nodes.map((node) => <option key={node.id} value={node.id} disabled={node.id === edge.to}>{name(node.id)}</option>)}</select>
                <input ref={field(`edge:${edge.id}`)} aria-label="Beschriftung" placeholder="Beschriftung" maxLength={MAP_LIMITS.edgeLabel} value={edge.label} onChange={(event) => changeEdge(edge, { label: event.target.value })} />
                <select aria-label="Nach" value={edge.to} onChange={(event) => changeEdge(edge, { to: event.target.value })}>{data.nodes.map((node) => <option key={node.id} value={node.id} disabled={node.id === edge.from}>{name(node.id)}</option>)}</select>
                <button type="button" className="lw-icon-btn" aria-label="Pfeil löschen" title="Pfeil löschen" onClick={() => onChange({ ...data, edges: data.edges.filter((entry) => entry.id !== edge.id) })}><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
          <button type="button" className="secondary-button" disabled={!freeMapPair(data)} title={edgesFull ? 'Ein Begriffsnetz fasst höchstens 160 Pfeile.' : undefined} onClick={addEdge}><Plus size={14} /> Pfeil</button>
          {hint && <p className="lw-hint" role="status">{hint}</p>}
        </div>
        <div className="lw-preview" dangerouslySetInnerHTML={{ __html: preview }} />
      </div>
    </div>
  )
}
