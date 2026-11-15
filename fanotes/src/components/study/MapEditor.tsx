import { ArrowDown, ArrowRight, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { mapFromText, type MapData } from '../../lib/study/conceptMap'
import { newId } from '../../lib/study/blocks'
import { renderMapSvg } from '../../lib/study/render'

type Props = { data: MapData; onChange: (data: MapData) => void }

export function MapEditor({ data, onChange }: Props) {
  const [quick, setQuick] = useState('')
  const preview = useMemo(() => renderMapSvg(data).svg, [data])
  const name = (id: string) => data.nodes.find((node) => node.id === id)?.text || '…'
  return (
    <div className="lw-editor">
      <div className="lw-actions">
        <input className="lw-title-input" aria-label="Titel" placeholder="Titel" value={data.title} onChange={(event) => onChange({ ...data, title: event.target.value })} />
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
                <input aria-label="Box" value={node.text} onChange={(event) => onChange({ ...data, nodes: data.nodes.map((entry) => (entry.id === node.id ? { ...entry, text: event.target.value } : entry)) })} />
                <button type="button" className="lw-icon-btn" aria-label="Box löschen" title="Box löschen" onClick={() => onChange({ ...data, nodes: data.nodes.filter((entry) => entry.id !== node.id), edges: data.edges.filter((edge) => edge.from !== node.id && edge.to !== node.id) })}><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
          <button type="button" className="secondary-button" onClick={() => onChange({ ...data, nodes: [...data.nodes, { id: newId('n'), text: '' }] })}><Plus size={14} /> Box</button>
          <h4>Pfeile</h4>
          <ul className="lw-list">
            {data.edges.map((edge) => (
              <li key={edge.id} className="lw-edge-row">
                <select aria-label="Von" value={edge.from} onChange={(event) => onChange({ ...data, edges: data.edges.map((entry) => (entry.id === edge.id ? { ...entry, from: event.target.value } : entry)) })}>{data.nodes.map((node) => <option key={node.id} value={node.id}>{name(node.id)}</option>)}</select>
                <input aria-label="Beschriftung" placeholder="Beschriftung" value={edge.label} onChange={(event) => onChange({ ...data, edges: data.edges.map((entry) => (entry.id === edge.id ? { ...entry, label: event.target.value } : entry)) })} />
                <select aria-label="Nach" value={edge.to} onChange={(event) => onChange({ ...data, edges: data.edges.map((entry) => (entry.id === edge.id ? { ...entry, to: event.target.value } : entry)) })}>{data.nodes.map((node) => <option key={node.id} value={node.id}>{name(node.id)}</option>)}</select>
                <button type="button" className="lw-icon-btn" aria-label="Pfeil löschen" title="Pfeil löschen" onClick={() => onChange({ ...data, edges: data.edges.filter((entry) => entry.id !== edge.id) })}><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
          <button type="button" className="secondary-button" disabled={data.nodes.length < 2} onClick={() => onChange({ ...data, edges: [...data.edges, { id: newId('e'), from: data.nodes[0].id, to: data.nodes[data.nodes.length - 1].id, label: '' }] })}><Plus size={14} /> Pfeil</button>
        </div>
        <div className="lw-preview" dangerouslySetInnerHTML={{ __html: preview }} />
      </div>
    </div>
  )
}
