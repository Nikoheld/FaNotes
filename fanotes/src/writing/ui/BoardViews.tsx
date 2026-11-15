// Corkboard (index cards per chapter) and outline (table) of the binder.
import { ArrowUpRight, GripVertical } from 'lucide-react'
import { useState } from 'react'
import type { BibleEntry } from '../model/bible'
import { canDrop, scenesInOrder, type DropPosition } from '../model/binder'
import type { BinderNode, SceneStatus } from '../model/types'
import { L, formatNumber } from './i18n'

export const STATUS_LABEL: Record<SceneStatus, [string, string]> = {
  idea: ['Idee', 'Idea'],
  draft: ['Entwurf', 'Draft'],
  revised: ['Überarbeitet', 'Revised'],
  final: ['Fertig', 'Final'],
}
export const LABEL_COLORS = ['#ef4444', '#f59e0b', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b']

type Shared = {
  binder: BinderNode[]
  sceneWords: (id: string) => number | null
  characters: BibleEntry[]
  onPatch: (id: string, patch: Partial<BinderNode>) => void
  onMove: (id: string, targetId: string, position: DropPosition) => void
  onOpen: (sceneId: string) => void
}

const groups = (binder: BinderNode[]) => {
  const out: Array<{ chapter: BinderNode | null; scenes: BinderNode[] }> = []
  for (const { scene, chapter } of scenesInOrder(binder)) {
    const last = out.at(-1)
    if (last && last.chapter?.id === chapter?.id) last.scenes.push(scene)
    else out.push({ chapter, scenes: [scene] })
  }
  return out
}

export const StatusSelect = ({ value, onChange }: { value: SceneStatus | undefined; onChange: (status: SceneStatus | undefined) => void }) => (
  <select className="wm-select wm-small-select" value={value ?? ''} onChange={(event) => onChange((event.target.value || undefined) as SceneStatus | undefined)}>
    <option value="">{L('Status', 'Status')}</option>
    {(Object.keys(STATUS_LABEL) as SceneStatus[]).map((status) => <option key={status} value={status}>{L(...STATUS_LABEL[status])}</option>)}
  </select>
)

export const PovSelect = ({ value, characters, onChange }: { value: string | undefined; characters: BibleEntry[]; onChange: (pov: string | undefined) => void }) => (
  <select className="wm-select wm-small-select" value={value ?? ''} title={L('Erzählperspektive', 'Point of view')} onChange={(event) => onChange(event.target.value || undefined)}>
    <option value="">{L('Perspektive', 'POV')}</option>
    {characters.map((character) => <option key={character.id} value={character.id} data-i18n-ignore>{character.name || L('(ohne Namen)', '(unnamed)')}</option>)}
  </select>
)

export function Corkboard({ binder, sceneWords, characters, onPatch, onMove, onOpen }: Shared) {
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string; position: DropPosition } | null>(null)
  const sections = groups(binder)
  if (!sections.length) return <p className="wm-empty">{L('Noch keine Szenen.', 'No scenes yet.')}</p>
  return (
    <div className="wm-board">
      {sections.map(({ chapter, scenes }) => (
        <section key={chapter?.id ?? 'top'}>
          <h3 data-i18n-ignore>{chapter?.title || L('Ohne Kapitel', 'No chapter')}</h3>
          <div className="wm-cards">
            {scenes.map((scene) => (
              <article
                key={scene.id}
                className={`wm-card${drag === scene.id ? ' is-dragging' : ''}${over?.id === scene.id ? ` drop-${over.position}` : ''}${scene.exclude ? ' is-excluded' : ''}`}
                style={scene.label ? { borderTopColor: scene.label } : undefined}
                draggable
                onDragStart={(event) => { setDrag(scene.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', scene.id) }}
                onDragEnd={() => { setDrag(null); setOver(null) }}
                onDragOver={(event) => {
                  if (!drag) return
                  const rect = event.currentTarget.getBoundingClientRect()
                  const position: DropPosition = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
                  if (!canDrop(binder, drag, scene.id, position)) return
                  event.preventDefault()
                  if (over?.id !== scene.id || over.position !== position) setOver({ id: scene.id, position })
                }}
                onDrop={(event) => { event.preventDefault(); if (drag && over) onMove(drag, over.id, over.position); setDrag(null); setOver(null) }}
              >
                <header>
                  <GripVertical size={13} className="wm-grip" aria-hidden />
                  <input value={scene.title} aria-label={L('Titel der Szene', 'Scene title')} data-i18n-ignore onChange={(event) => onPatch(scene.id, { title: event.target.value })} />
                  <button type="button" className="wm-icon" title={L('Im Manuskript öffnen', 'Open in the manuscript')} onClick={() => onOpen(scene.id)}><ArrowUpRight size={14} /></button>
                </header>
                <textarea
                  value={scene.synopsis ?? ''}
                  rows={4}
                  placeholder={L('Worum geht es in dieser Szene?', 'What happens in this scene?')}
                  aria-label={L('Zusammenfassung', 'Synopsis')}
                  data-i18n-ignore
                  onChange={(event) => onPatch(scene.id, { synopsis: event.target.value || undefined })}
                />
                <footer>
                  <StatusSelect value={scene.status} onChange={(status) => onPatch(scene.id, { status })} />
                  <PovSelect value={scene.pov} characters={characters} onChange={(pov) => onPatch(scene.id, { pov })} />
                  <small data-i18n-ignore>{formatNumber(sceneWords(scene.id) ?? 0)} {L('W.', 'w.')}</small>
                </footer>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

const Progress = ({ value, goal }: { value: number; goal?: number }) => (goal ? (
  <span className="wm-goal" title={`${formatNumber(value)} / ${formatNumber(goal)}`}>
    <span className="wm-goal-bar"><span style={{ width: `${Math.min(100, (value / goal) * 100)}%` }} /></span>
    <small>{Math.min(999, Math.round((value / goal) * 100))} %</small>
  </span>
) : null)

export function Outline({ binder, sceneWords, characters, onPatch, onOpen }: Shared) {
  const name = new Map(characters.map((character) => [character.id, character.name]))
  const sections = groups(binder)
  return (
    <div className="wm-outline">
      <table>
        <thead>
          <tr>
            <th>{L('Titel', 'Title')}</th>
            <th>{L('Zusammenfassung', 'Synopsis')}</th>
            <th>{L('Perspektive', 'POV')}</th>
            <th>{L('Status', 'Status')}</th>
            <th className="is-number">{L('Wörter', 'Words')}</th>
            <th>{L('Ziel', 'Goal')}</th>
          </tr>
        </thead>
        <tbody>
          {sections.map(({ chapter, scenes }) => {
            const chapterWords = scenes.reduce((sum, scene) => sum + (sceneWords(scene.id) ?? 0), 0)
            return [
              chapter && (
                <tr key={chapter.id} className="is-chapter">
                  <td data-i18n-ignore>{chapter.title}</td>
                  <td data-i18n-ignore>{chapter.synopsis ?? ''}</td>
                  <td />
                  <td>{chapter.status ? L(...STATUS_LABEL[chapter.status]) : ''}</td>
                  <td className="is-number">{formatNumber(chapterWords)}</td>
                  <td>
                    <input className="wm-goal-input" type="number" min={0} step={500} value={chapter.goal ?? ''} placeholder="–" aria-label={L('Wortziel des Kapitels', 'Chapter word goal')} onChange={(event) => onPatch(chapter.id, { goal: Number(event.target.value) > 0 ? Number(event.target.value) : undefined })} />
                    <Progress value={chapterWords} goal={chapter.goal} />
                  </td>
                </tr>
              ),
              ...scenes.map((scene) => (
                <tr key={scene.id} className={scene.exclude ? 'is-excluded' : ''}>
                  <td>
                    {scene.label && <span className="wm-label-dot" style={{ background: scene.label }} />}
                    <button type="button" className="wm-link" onClick={() => onOpen(scene.id)} data-i18n-ignore>{scene.title || L('(ohne Titel)', '(untitled)')}</button>
                  </td>
                  <td>
                    <input className="wm-cell-input" value={scene.synopsis ?? ''} placeholder="…" aria-label={L('Zusammenfassung', 'Synopsis')} data-i18n-ignore onChange={(event) => onPatch(scene.id, { synopsis: event.target.value || undefined })} />
                  </td>
                  <td data-i18n-ignore>
                    <PovSelect value={scene.pov} characters={characters} onChange={(pov) => onPatch(scene.id, { pov })} />
                    {scene.pov && !name.has(scene.pov) && <small>?</small>}
                  </td>
                  <td><StatusSelect value={scene.status} onChange={(status) => onPatch(scene.id, { status })} /></td>
                  <td className="is-number">{formatNumber(sceneWords(scene.id) ?? 0)}</td>
                  <td>
                    <input className="wm-goal-input" type="number" min={0} step={100} value={scene.goal ?? ''} placeholder="–" aria-label={L('Wortziel der Szene', 'Scene word goal')} onChange={(event) => onPatch(scene.id, { goal: Number(event.target.value) > 0 ? Number(event.target.value) : undefined })} />
                    <Progress value={sceneWords(scene.id) ?? 0} goal={scene.goal} />
                  </td>
                </tr>
              )),
            ]
          })}
        </tbody>
      </table>
    </div>
  )
}
