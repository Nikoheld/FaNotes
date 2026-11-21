// Character and place sheets, and the story timeline.
import { colorSwatchName } from '../../lib/colorNames'
import { Archive, ArrowDown, ArrowUp, ArrowUpRight, Plus, Search, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { mentionPattern, newBibleEntry, type BibleEntry, type BibleKind } from '../model/bible'
import { scenesInOrder } from '../model/binder'
import { runsText } from '../model/runs'
import type { BinderNode, Scene } from '../model/types'
import { LABEL_COLORS } from './BoardViews'
import { L, formatNumber, uiEnglish } from './i18n'

const sceneTextCache = new WeakMap<Scene, string>()
const sceneText = (scene: Scene) => {
  let text = sceneTextCache.get(scene)
  if (text === undefined) {
    text = scene.paragraphs.filter((paragraph) => !paragraph.deleted).map((paragraph) => runsText(paragraph.runs)).join('\n')
    sceneTextCache.set(scene, text)
  }
  return text
}

/** Scenes (in reading order) where an entry is named, is the point of view, or is linked. */
export const appearances = (entry: BibleEntry, binder: BinderNode[], scenes: Map<string, Scene>) => {
  const pattern = mentionPattern(entry)
  const global = pattern ? new RegExp(pattern.source, 'gu') : null
  return scenesInOrder(binder).flatMap(({ scene }) => {
    const pov = scene.pov === entry.id
    const linked = (entry.kind === 'character' ? scene.characters : scene.places)?.includes(entry.id) ?? false
    const body = scenes.get(scene.id)
    const mentions = body && global ? (sceneText(body).match(global)?.length ?? 0) : 0
    return pov || linked || mentions ? [{ scene, pov, linked, mentions }] : []
  })
}

type SheetProps = {
  kind: Exclude<BibleKind, 'event'>
  entries: BibleEntry[]
  binder: BinderNode[]
  scenes: Map<string, Scene>
  writer: string
  onSave: (entry: BibleEntry) => void
  onOpenScene: (sceneId: string) => void
}

export function BibleSheets({ kind, entries, binder, scenes, writer, onSave, onOpenScene }: SheetProps) {
  const [selected, setSelected] = useState<string | null>(entries[0]?.id ?? null)
  const [query, setQuery] = useState('')
  const entry = entries.find((candidate) => candidate.id === selected) ?? null
  const shown = entries.filter((candidate) => !query || [candidate.name, candidate.role ?? '', ...(candidate.aliases ?? [])].some((value) => value.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
  const found = useMemo(() => (entry ? appearances(entry, binder, scenes) : []), [entry, binder, scenes])
  const add = () => {
    const created = newBibleEntry(kind, kind === 'character' ? L('Neue Figur', 'New character') : L('Neuer Ort', 'New place'), uiEnglish(), writer)
    onSave(created)
    setSelected(created.id)
  }
  const patch = (change: Partial<BibleEntry>) => entry && onSave({ ...entry, ...change })
  return (
    <div className="wm-bible">
      <aside>
        <div className="wm-bible-search">
          <Search size={13} />
          <input value={query} placeholder={L('Suchen', 'Search')} data-i18n-ignore onChange={(event) => setQuery(event.target.value)} />
        </div>
        <button type="button" className="secondary-button wm-small" onClick={add}><Plus size={13} /> {kind === 'character' ? L('Figur', 'Character') : L('Ort', 'Place')}</button>
        <ul>
          {shown.map((candidate) => (
            <li key={candidate.id}>
              <button type="button" className={candidate.id === selected ? 'is-on' : ''} onClick={() => setSelected(candidate.id)}>
                <span className="wm-label-dot" style={{ background: candidate.color ?? 'var(--border-strong)' }} />
                <span data-i18n-ignore>{candidate.name || L('(ohne Namen)', '(unnamed)')}</span>
                {candidate.role && <small data-i18n-ignore>{candidate.role}</small>}
              </button>
            </li>
          ))}
          {!entries.length && <li className="wm-hint">{kind === 'character' ? L('Noch keine Figuren.', 'No characters yet.') : L('Noch keine Orte.', 'No places yet.')}</li>}
        </ul>
      </aside>
      {entry ? (
        <article className="wm-sheet">
          <input className="wm-sheet-name" value={entry.name} aria-label={L('Name', 'Name')} data-i18n-ignore onChange={(event) => patch({ name: event.target.value })} />
          <div className="wm-sheet-row">
            <label>{kind === 'character' ? L('Rolle', 'Role') : L('Art des Ortes', 'Kind of place')}
              <input value={entry.role ?? ''} placeholder={kind === 'character' ? L('z. B. Hauptfigur, Gegenspielerin', 'e.g. protagonist, antagonist') : L('z. B. Dorf, Wohnung, Schiff', 'e.g. village, flat, ship')} data-i18n-ignore onChange={(event) => patch({ role: event.target.value || undefined })} />
            </label>
            <label>{L('Auch genannt', 'Also called')}
              <input value={(entry.aliases ?? []).join(', ')} placeholder={L('Spitznamen, Kurzformen (mit Komma)', 'Nicknames, short forms (comma separated)')} data-i18n-ignore onChange={(event) => patch({ aliases: event.target.value.split(',').map((alias) => alias.trim()).filter(Boolean) })} />
            </label>
          </div>
          <div className="wm-swatches" role="group" aria-label={L('Farbe', 'Colour')}>
            {LABEL_COLORS.map((color) => <button key={color} type="button" className={entry.color === color ? 'is-on' : ''} style={{ background: color }} aria-label={colorSwatchName(color)} onClick={() => patch({ color })} />)}
            <button type="button" className="wm-swatch-clear" aria-label={L('Keine Farbe', 'No colour')} onClick={() => patch({ color: undefined })}><X size={12} /></button>
          </div>
          {entry.fields.map((field, index) => (
            <div key={index} className="wm-field">
              <input className="wm-field-label" value={field.label} aria-label={L('Feldname', 'Field name')} data-i18n-ignore onChange={(event) => patch({ fields: entry.fields.map((item, at) => (at === index ? { ...item, label: event.target.value } : item)) })} />
              <textarea rows={2} value={field.value} aria-label={field.label} data-i18n-ignore onChange={(event) => patch({ fields: entry.fields.map((item, at) => (at === index ? { ...item, value: event.target.value } : item)) })} />
              <button type="button" className="wm-icon" title={L('Feld entfernen', 'Remove field')} onClick={() => patch({ fields: entry.fields.filter((_, at) => at !== index) })}><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" className="secondary-button wm-small" onClick={() => patch({ fields: [...entry.fields, { label: L('Neues Feld', 'New field'), value: '' }] })}><Plus size={13} /> {L('Feld', 'Field')}</button>
          <label className="wm-sheet-notes">{L('Notizen', 'Notes')}
            <textarea rows={8} value={entry.notes ?? ''} data-i18n-ignore onChange={(event) => patch({ notes: event.target.value || undefined })} />
          </label>
          <section className="wm-appearances">
            <h4>{L('Kommt vor in', 'Appears in')} ({found.length})</h4>
            {found.map(({ scene, pov, linked, mentions }) => (
              <button key={scene.id} type="button" className="wm-link" onClick={() => onOpenScene(scene.id)}>
                <span data-i18n-ignore>{scene.title || L('(ohne Titel)', '(untitled)')}</span>
                <small>
                  {[pov ? L('Perspektive', 'POV') : '', linked ? L('verknüpft', 'linked') : '', mentions ? L(`${formatNumber(mentions)}× genannt`, `named ${formatNumber(mentions)}×`) : ''].filter(Boolean).join(' · ')}
                </small>
                <ArrowUpRight size={12} />
              </button>
            ))}
            {!found.length && <p className="wm-hint">{L('Noch in keiner Szene genannt.', 'Not named in any scene yet.')}</p>}
          </section>
          <button type="button" className="secondary-button wm-small wm-archive" onClick={() => { patch({ archived: true }); setSelected(null) }}><Archive size={13} /> {L('Archivieren', 'Archive')}</button>
        </article>
      ) : <p className="wm-empty">{L('Wähle links einen Eintrag oder lege einen neuen an.', 'Pick an entry on the left or add a new one.')}</p>}
    </div>
  )
}

const Chips = ({ ids, options, onChange, placeholder }: { ids: string[]; options: Array<{ id: string; name: string }>; onChange: (ids: string[]) => void; placeholder: string }) => {
  const name = new Map(options.map((option) => [option.id, option.name]))
  return (
    <div className="wm-chips">
      {ids.map((id) => (
        <span key={id} className="wm-chip" data-i18n-ignore>{name.get(id) ?? '?'}<button type="button" aria-label={L('Entfernen', 'Remove')} onClick={() => onChange(ids.filter((value) => value !== id))}><X size={10} /></button></span>
      ))}
      <select className="wm-select wm-small-select" value="" onChange={(event) => { if (event.target.value) onChange([...ids, event.target.value]) }}>
        <option value="">{placeholder}</option>
        {options.filter((option) => !ids.includes(option.id)).map((option) => <option key={option.id} value={option.id} data-i18n-ignore>{option.name}</option>)}
      </select>
    </div>
  )
}

export function Timeline({ events, characters, places, binder, writer, onSave, onOpenScene }: {
  events: BibleEntry[]
  characters: BibleEntry[]
  places: BibleEntry[]
  binder: BinderNode[]
  writer: string
  onSave: (entry: BibleEntry) => void
  onOpenScene: (sceneId: string) => void
}) {
  const scenes = scenesInOrder(binder).map(({ scene }) => ({ id: scene.id, name: scene.title || L('(ohne Titel)', '(untitled)') }))
  const sceneIndex = new Map(scenes.map((scene, index) => [scene.id, index]))
  const add = () => onSave(newBibleEntry('event', L('Neues Ereignis', 'New event'), uiEnglish(), writer, (events.at(-1)?.order ?? 0) + 1))
  // Moving swaps positions with the neighbour; equal orders are spread out first.
  const move = (index: number, direction: -1 | 1) => {
    const other = events[index + direction]
    if (!other) return
    const current = events[index]
    const a = current.order ?? index
    const b = other.order ?? index + direction
    if (a === b) {
      onSave({ ...current, order: b + direction * 0.5 })
      return
    }
    onSave({ ...current, order: b })
    onSave({ ...other, order: a })
  }
  return (
    <div className="wm-timeline">
      <div className="wm-timeline-head">
        <p className="wm-hint">{L('Ereignisse in der Reihenfolge, in der sie in der Geschichte geschehen – unabhängig davon, wann sie erzählt werden.', 'Events in the order they happen in the story, whatever order they are told in.')}</p>
        <button type="button" className="primary-button wm-small" onClick={add}><Plus size={13} /> {L('Ereignis', 'Event')}</button>
      </div>
      <ol>
        {events.map((event, index) => {
          const told = (event.scenes ?? []).map((id) => sceneIndex.get(id)).filter((value): value is number => value !== undefined)
          return (
            <li key={event.id} className="wm-event" style={event.color ? { borderLeftColor: event.color } : undefined}>
              <div className="wm-event-order">
                <button type="button" className="wm-icon" title={L('Früher', 'Earlier')} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
                <button type="button" className="wm-icon" title={L('Später', 'Later')} disabled={index === events.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
              </div>
              <div className="wm-event-body">
                <div className="wm-sheet-row">
                  <input className="wm-event-when" value={event.when ?? ''} placeholder={L('Wann? (z. B. Tag 3, Morgen)', 'When? (e.g. day 3, morning)')} data-i18n-ignore onChange={(change) => onSave({ ...event, when: change.target.value || undefined })} />
                  <input className="wm-event-title" value={event.name} aria-label={L('Ereignis', 'Event')} data-i18n-ignore onChange={(change) => onSave({ ...event, name: change.target.value })} />
                </div>
                <textarea rows={2} value={event.notes ?? ''} placeholder={L('Was passiert?', 'What happens?')} data-i18n-ignore onChange={(change) => onSave({ ...event, notes: change.target.value || undefined })} />
                <div className="wm-event-links">
                  <Chips ids={event.scenes ?? []} options={scenes} placeholder={L('+ Szene', '+ Scene')} onChange={(ids) => onSave({ ...event, scenes: ids })} />
                  <Chips ids={event.characters ?? []} options={characters.map((entry) => ({ id: entry.id, name: entry.name }))} placeholder={L('+ Figur', '+ Character')} onChange={(ids) => onSave({ ...event, characters: ids })} />
                  <Chips ids={event.places ?? []} options={places.map((entry) => ({ id: entry.id, name: entry.name }))} placeholder={L('+ Ort', '+ Place')} onChange={(ids) => onSave({ ...event, places: ids })} />
                </div>
                {told.length > 0 && (
                  <div className="wm-event-told">
                    {L('Erzählt in', 'Told in')}: {(event.scenes ?? []).map((id) => <button key={id} type="button" className="wm-link" onClick={() => onOpenScene(id)} data-i18n-ignore>{scenes.find((scene) => scene.id === id)?.name ?? '?'}</button>)}
                  </div>
                )}
              </div>
              <button type="button" className="wm-icon" title={L('Archivieren', 'Archive')} onClick={() => onSave({ ...event, archived: true })}><Archive size={13} /></button>
            </li>
          )
        })}
      </ol>
      {!events.length && <p className="wm-empty">{L('Noch keine Ereignisse. Lege das erste an, um die Chronologie zu planen.', 'No events yet. Add the first one to plan the chronology.')}</p>}
    </div>
  )
}
