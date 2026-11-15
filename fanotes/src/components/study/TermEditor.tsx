import { GraduationCap, Plus, Trash2 } from 'lucide-react'
import { newId } from '../../lib/study/blocks'
import type { TermData, TermEntry } from '../../lib/study/cardsModels'

type Props = { data: TermData; onChange: (data: TermData) => void; onLearn: () => void }

const FIELDS: Array<[keyof Omit<TermEntry, 'id'>, string, boolean]> = [
  ['term', 'Begriff', false],
  ['definition', 'Definition (ein Satz)', true],
  ['example', 'Beispiel', true],
  ['source', 'Quelle', false],
]

export function TermEditor({ data, onChange, onLearn }: Props) {
  const patch = (id: string, change: Partial<TermEntry>) => onChange({ ...data, terms: data.terms.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)) })
  const learnable = data.terms.filter((entry) => entry.term.trim() && entry.definition.trim()).length
  return (
    <div className="lw-editor">
      {data.terms.map((entry) => (
        <div key={entry.id} className="lw-term-form">
          {FIELDS.map(([key, label, multiline]) => (
            <label key={key}><span>{label}</span>
              {multiline
                ? <textarea rows={2} value={entry[key]} onChange={(event) => patch(entry.id, { [key]: event.target.value })} />
                : <input value={entry[key]} onChange={(event) => patch(entry.id, { [key]: event.target.value })} />}
            </label>
          ))}
          <button type="button" className="lw-icon-btn" aria-label="Begriff löschen" title="Begriff löschen" disabled={data.terms.length < 2} onClick={() => onChange({ ...data, terms: data.terms.filter((item) => item.id !== entry.id) })}><Trash2 size={14} /></button>
        </div>
      ))}
      <div className="lw-actions">
        <button type="button" className="secondary-button" onClick={() => onChange({ ...data, terms: [...data.terms, { id: newId('t'), term: '', definition: '', example: '', source: '' }] })}><Plus size={14} /> Begriff</button>
        <button type="button" className="primary-button" disabled={!learnable} onClick={onLearn} title="Begriff und Definition als Karteikarten üben"><GraduationCap size={14} /> Lernen ({learnable})</button>
      </div>
    </div>
  )
}
