// Inspector tab for the scene at the caret: synopsis, status, label, point of
// view, characters and places, linked notes, goal, export, and snapshots.
import { colorSwatchName } from '../../lib/colorNames'
import { Camera, ExternalLink, GitCompare, Link2, LoaderCircle, Plus, RotateCcw, X } from 'lucide-react'
import { DialogFrame } from '../../components/DialogFrame'
import { useEffect, useMemo, useState } from 'react'
import type { BibleEntry } from '../model/bible'
import type { Snapshot } from '../model/snapshots'
import type { BinderNode } from '../model/types'
import { LABEL_COLORS, PovSelect, StatusSelect } from './BoardViews'
import { L, formatNumber } from './i18n'

type NoteOption = { path: string; name: string }

const flattenNotes = (entries: import('../../types').VaultEntry[], out: NoteOption[] = []) => {
  for (const entry of entries) {
    if (entry.kind === 'folder') flattenNotes(entry.children ?? [], out)
    else if (/\.(?:md|markdown)$/iu.test(entry.relativePath)) out.push({ path: entry.relativePath, name: entry.name.replace(/\.(?:md|markdown)$/iu, '') })
  }
  return out
}

export const stampLabel = (stamp: string) => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/u.exec(stamp)
  if (!match) return stamp
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]))
  return new Intl.DateTimeFormat(document.documentElement.lang || 'de-CH', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function ScenePanel({ node, words, characters, places, stamps, onPatch, onOpenNote, onTakeSnapshot, onCompare }: {
  node: BinderNode | null
  words: number
  characters: BibleEntry[]
  places: BibleEntry[]
  stamps: string[]
  onPatch: (patch: Partial<BinderNode>) => void
  onOpenNote: (path: string) => void
  onTakeSnapshot: (note: string) => Promise<void>
  onCompare: (stamp: string) => void
}) {
  const [notes, setNotes] = useState<NoteOption[] | null>(null)
  const [linkQuery, setLinkQuery] = useState('')
  const [snapshotNote, setSnapshotNote] = useState('')
  const [taking, setTaking] = useState(false)
  useEffect(() => {
    if (!linkQuery || notes) return
    void window.fanotes?.getTree().then((tree) => setNotes(flattenNotes(tree))).catch(() => setNotes([]))
  }, [linkQuery, notes])
  const matches = useMemo(() => (notes ?? []).filter((note) => note.path.toLocaleLowerCase().includes(linkQuery.toLocaleLowerCase())).slice(0, 8), [notes, linkQuery])
  if (!node) return <div className="wm-inspector-body"><p className="wm-hint">{L('Setze den Cursor in eine Szene.', 'Put the cursor in a scene.')}</p></div>
  const byId = (list: BibleEntry[]) => new Map(list.map((entry) => [entry.id, entry]))
  const characterById = byId(characters)
  const placeById = byId(places)
  const toggle = (key: 'characters' | 'places', id: string) => {
    const current = node[key] ?? []
    onPatch({ [key]: current.includes(id) ? current.filter((value) => value !== id) : [...current, id] })
  }
  return (
    <div className="wm-inspector-body">
      <section>
        <h4>{L('Szene', 'Scene')}</h4>
        <input className="wm-input-text" value={node.title} aria-label={L('Titel', 'Title')} data-i18n-ignore onChange={(event) => onPatch({ title: event.target.value })} />
        <textarea className="wm-input-text" rows={4} value={node.synopsis ?? ''} placeholder={L('Zusammenfassung', 'Synopsis')} data-i18n-ignore onChange={(event) => onPatch({ synopsis: event.target.value || undefined })} />
        <div className="wm-inline">
          <StatusSelect value={node.status} onChange={(status) => onPatch({ status })} />
          <PovSelect value={node.pov} characters={characters} onChange={(pov) => onPatch({ pov })} />
        </div>
        <div className="wm-swatches" role="group" aria-label={L('Label-Farbe', 'Label colour')}>
          {LABEL_COLORS.map((color) => <button key={color} type="button" className={node.label === color ? 'is-on' : ''} style={{ background: color }} aria-label={colorSwatchName(color)} onClick={() => onPatch({ label: color })} />)}
          <button type="button" className="wm-swatch-clear" aria-label={L('Keine Farbe', 'No colour')} onClick={() => onPatch({ label: undefined })}><X size={12} /></button>
        </div>
        <label className="wm-inline">{L('Wortziel', 'Word goal')}
          <input className="wm-goal-input" type="number" min={0} step={100} value={node.goal ?? ''} placeholder="–" onChange={(event) => onPatch({ goal: Number(event.target.value) > 0 ? Math.round(Number(event.target.value)) : undefined })} />
          <small>{formatNumber(words)}{node.goal ? ` / ${formatNumber(node.goal)}` : ''}</small>
        </label>
        <label className="wm-toggle"><input type="checkbox" checked={!node.exclude} onChange={(event) => onPatch({ exclude: event.target.checked ? undefined : true })} /> <span>{L('Im Manuskript und in Exporten', 'In the manuscript and exports')}</span></label>
      </section>
      <section>
        <h4>{L('Figuren', 'Characters')}</h4>
        <div className="wm-chips">
          {(node.characters ?? []).map((id) => <span key={id} className="wm-chip" data-i18n-ignore>{characterById.get(id)?.name ?? '?'}<button type="button" aria-label={L('Entfernen', 'Remove')} onClick={() => toggle('characters', id)}><X size={10} /></button></span>)}
          <select className="wm-select wm-small-select" value="" onChange={(event) => { if (event.target.value) toggle('characters', event.target.value) }}>
            <option value="">{L('+ Figur', '+ Character')}</option>
            {characters.filter((entry) => !(node.characters ?? []).includes(entry.id)).map((entry) => <option key={entry.id} value={entry.id} data-i18n-ignore>{entry.name}</option>)}
          </select>
        </div>
        <h4>{L('Orte', 'Places')}</h4>
        <div className="wm-chips">
          {(node.places ?? []).map((id) => <span key={id} className="wm-chip" data-i18n-ignore>{placeById.get(id)?.name ?? '?'}<button type="button" aria-label={L('Entfernen', 'Remove')} onClick={() => toggle('places', id)}><X size={10} /></button></span>)}
          <select className="wm-select wm-small-select" value="" onChange={(event) => { if (event.target.value) toggle('places', event.target.value) }}>
            <option value="">{L('+ Ort', '+ Place')}</option>
            {places.filter((entry) => !(node.places ?? []).includes(entry.id)).map((entry) => <option key={entry.id} value={entry.id} data-i18n-ignore>{entry.name}</option>)}
          </select>
        </div>
      </section>
      <section>
        <h4>{L('Verknüpfte Notizen', 'Linked notes')}</h4>
        {(node.links ?? []).map((path) => (
          <div key={path} className="wm-linked">
            <button type="button" className="wm-link" onClick={() => onOpenNote(path)} data-i18n-ignore><Link2 size={12} /> {path.replace(/^.*\//u, '').replace(/\.(?:md|markdown)$/iu, '')}</button>
            <button type="button" className="wm-icon" aria-label={L('Verknüpfung lösen', 'Unlink')} onClick={() => onPatch({ links: (node.links ?? []).filter((value) => value !== path) })}><X size={12} /></button>
          </div>
        ))}
        <input className="wm-input-text" value={linkQuery} placeholder={L('Notiz suchen und verknüpfen …', 'Find a note to link …')} data-i18n-ignore onChange={(event) => setLinkQuery(event.target.value)} />
        {linkQuery && (
          <div className="wm-link-results">
            {notes === null && <p className="wm-hint"><LoaderCircle className="spin" size={12} /></p>}
            {matches.map((note) => (
              <button key={note.path} type="button" onClick={() => { onPatch({ links: [...new Set([...(node.links ?? []), note.path])] }); setLinkQuery('') }} data-i18n-ignore>
                <Plus size={12} /> {note.name} <small>{note.path}</small>
              </button>
            ))}
            {notes && !matches.length && <p className="wm-hint">{L('Keine Notiz gefunden.', 'No note found.')}</p>}
          </div>
        )}
      </section>
      <section>
        <h4>{L('Versionen dieser Szene', 'Versions of this scene')}</h4>
        <div className="wm-inline">
          <input className="wm-input-text" value={snapshotNote} placeholder={L('Notiz (optional)', 'Note (optional)')} data-i18n-ignore onChange={(event) => setSnapshotNote(event.target.value)} />
          <button type="button" className="secondary-button wm-small" disabled={taking} onClick={() => { setTaking(true); void onTakeSnapshot(snapshotNote).finally(() => { setTaking(false); setSnapshotNote('') }) }}><Camera size={13} /> {L('Sichern', 'Save version')}</button>
        </div>
        {stamps.map((stamp) => (
          <button key={stamp} type="button" className="wm-version" onClick={() => onCompare(stamp)}>
            <RotateCcw size={12} /> <span>{stampLabel(stamp)}</span> <ExternalLink size={11} />
          </button>
        ))}
        {!stamps.length && <p className="wm-hint">{L('Noch keine gesicherte Version. Vor dem Wiederherstellen und vor „Alle ersetzen“ wird automatisch gesichert.', 'No saved version yet. Versions are also saved automatically before a restore and before “Replace all”.')}</p>}
      </section>
    </div>
  )
}

export function SnapshotCompare({ snapshot, rows, onRestore, onClose }: {
  snapshot: Snapshot
  rows: import('../model/snapshots').DiffRow[]
  onRestore: () => void
  onClose: () => void
}) {
  const changed = rows.filter((row) => row.kind !== 'same').length
  return (
    <DialogFrame
      icon={<GitCompare size={18} />}
      eyebrow={L('Versionen', 'Versions')}
      title={snapshot.title}
      dynamicTitle
      titleId="wm-compare-title"
      closeLabel={L('Schliessen', 'Close')}
      size="xl"
      className="wm-compare"
      onClose={onClose}
      subheader={<p className="wm-compare-sub" data-i18n-ignore>{stampLabel(snapshot.stamp)}{snapshot.note ? ` · ${snapshot.note}` : ''} · {L(`${changed} Absätze anders`, `${changed} paragraphs differ`)}</p>}
      footer={(
        <>
          <small className="wm-compare-note">{L('Beim Wiederherstellen wird der jetzige Stand zuerst als Version gesichert.', 'Restoring saves the current state as a version first.')}</small>
          <button type="button" className="secondary-button" onClick={onClose}>{L('Schliessen', 'Close')}</button>
          <button type="button" className="primary-button" onClick={onRestore} disabled={!changed}><RotateCcw size={14} /> {L('Diese Version wiederherstellen', 'Restore this version')}</button>
        </>
      )}
    >
      <div className="wm-compare-head"><span>{L('Gesicherte Version', 'Saved version')}</span><span>{L('Jetzt', 'Now')}</span></div>
      <div className="wm-compare-body" data-i18n-ignore>
        {rows.map((row) => (
          <div key={row.id} className={`wm-compare-row is-${row.kind}`}>
            {row.kind === 'changed' ? (
              <>
                <p>{row.pieces.filter((piece) => piece.kind !== 'added').map((piece, index) => <span key={index} className={piece.kind === 'removed' ? 'is-removed' : ''}>{piece.text}</span>)}</p>
                <p>{row.pieces.filter((piece) => piece.kind !== 'removed').map((piece, index) => <span key={index} className={piece.kind === 'added' ? 'is-added' : ''}>{piece.text}</span>)}</p>
              </>
            ) : (
              <>
                <p className={row.kind === 'removed' ? 'is-removed' : ''}>{row.kind === 'added' ? '' : row.text}</p>
                <p className={row.kind === 'added' ? 'is-added' : ''}>{row.kind === 'removed' ? '' : row.text}</p>
              </>
            )}
          </div>
        ))}
      </div>
    </DialogFrame>
  )
}
