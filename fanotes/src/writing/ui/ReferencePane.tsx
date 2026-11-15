// Split view: a read-only reference next to the manuscript (another scene, a
// character or place sheet, or a linked FaNotes note).
import { LoaderCircle, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BibleEntry } from '../model/bible'
import { scenesInOrder } from '../model/binder'
import { runsText } from '../model/runs'
import type { BinderNode, Scene } from '../model/types'
import { L } from './i18n'

export type Reference = { kind: 'scene'; id: string } | { kind: 'bible'; id: string } | { kind: 'note'; path: string }

const encode = (reference: Reference) => (reference.kind === 'note' ? `note:${reference.path}` : `${reference.kind}:${reference.id}`)
const decode = (value: string): Reference | null => {
  const at = value.indexOf(':')
  const kind = value.slice(0, at)
  const rest = value.slice(at + 1)
  if (kind === 'note') return { kind: 'note', path: rest }
  if (kind === 'scene' || kind === 'bible') return { kind, id: rest }
  return null
}

export function ReferencePane({ reference, binder, scenes, bible, links, onChange, onClose }: {
  reference: Reference
  binder: BinderNode[]
  scenes: Map<string, Scene>
  bible: BibleEntry[]
  /** Notes linked to any scene: offered in the picker. */
  links: string[]
  onChange: (reference: Reference) => void
  onClose: () => void
}) {
  const [note, setNote] = useState<{ path: string; text: string | null; error?: string } | null>(null)
  useEffect(() => {
    if (reference.kind !== 'note') return
    let alive = true
    setNote({ path: reference.path, text: null })
    void window.fanotes?.readFile(reference.path)
      .then((text) => { if (alive) setNote({ path: reference.path, text: text.replace(/<!-- fanotes-famd:v1[\s\S]*$/u, '') }) })
      .catch((error) => { if (alive) setNote({ path: reference.path, text: '', error: error instanceof Error ? error.message : String(error) }) })
    return () => { alive = false }
  }, [reference])
  const order = scenesInOrder(binder)
  const entry = reference.kind === 'bible' ? bible.find((candidate) => candidate.id === reference.id) : undefined
  const scene = reference.kind === 'scene' ? scenes.get(reference.id) : undefined
  return (
    <aside className="wm-reference" aria-label={L('Referenz', 'Reference')}>
      <header>
        <select className="wm-select" value={encode(reference)} onChange={(event) => { const next = decode(event.target.value); if (next) onChange(next) }}>
          <optgroup label={L('Szenen', 'Scenes')}>
            {order.map(({ scene: node }) => <option key={node.id} value={`scene:${node.id}`} data-i18n-ignore>{node.title || L('(ohne Titel)', '(untitled)')}</option>)}
          </optgroup>
          {bible.length > 0 && (
            <optgroup label={L('Figuren, Orte, Ereignisse', 'Characters, places, events')}>
              {bible.map((item) => <option key={item.id} value={`bible:${item.id}`} data-i18n-ignore>{item.name}</option>)}
            </optgroup>
          )}
          {links.length > 0 && (
            <optgroup label={L('Verknüpfte Notizen', 'Linked notes')}>
              {links.map((path) => <option key={path} value={`note:${path}`} data-i18n-ignore>{path.replace(/^.*\//u, '')}</option>)}
            </optgroup>
          )}
        </select>
        <button type="button" className="wm-icon" aria-label={L('Referenz schliessen', 'Close reference')} onClick={onClose}><X size={14} /></button>
      </header>
      <div className="wm-reference-body" data-i18n-ignore>
        {reference.kind === 'scene' && (scene
          ? scene.paragraphs.filter((paragraph) => !paragraph.deleted).map((paragraph) => <p key={paragraph.id} className={`is-${paragraph.style}`}>{runsText(paragraph.runs) || ' '}</p>)
          : <p className="wm-hint">{L('Diese Szene ist (noch) nicht auf diesem Gerät.', 'This scene is not on this device (yet).')}</p>)}
        {reference.kind === 'bible' && (entry ? (
          <>
            <h3>{entry.name}</h3>
            {entry.role && <p><em>{entry.role}</em></p>}
            {entry.when && <p><strong>{entry.when}</strong></p>}
            {entry.aliases?.length ? <p>{L('Auch genannt', 'Also called')}: {entry.aliases.join(', ')}</p> : null}
            {entry.fields.filter((field) => field.value).map((field, index) => <p key={index}><strong>{field.label}:</strong> {field.value}</p>)}
            {entry.notes && <p className="wm-pre">{entry.notes}</p>}
          </>
        ) : <p className="wm-hint">{L('Eintrag nicht gefunden.', 'Entry not found.')}</p>)}
        {reference.kind === 'note' && (note?.text === null
          ? <p className="wm-hint"><LoaderCircle className="spin" size={12} /></p>
          : note?.error ? <p className="wm-hint">{note.error}</p> : <div className="wm-pre">{note?.text}</div>)}
      </div>
    </aside>
  )
}
