import { GraduationCap, ImagePlus, Trash2 } from 'lucide-react'
import { useRef } from 'react'
import { newId } from '../../lib/study/blocks'
import type { PlateData } from '../../lib/study/cardsModels'
import { storeStudyImage } from '../../lib/study/imageTools'
import { VaultImg } from './VaultImg'

type Props = { data: PlateData; onChange: (data: PlateData) => void; onError: (message: string) => void; onLearn: () => void }

export function addPlateFiles(data: PlateData, files: readonly File[], onError: (message: string) => void): Promise<PlateData> {
  return files.reduce<Promise<PlateData>>(async (previous, file) => {
    const current = await previous
    if (!file.type.startsWith('image/')) return current
    try {
      const img = await storeStudyImage(file)
      const label = file.name.replace(/\.[a-z0-9]+$/iu, '').replace(/[_-]+/gu, ' ').trim()
      return { ...current, items: [...current.items, { id: newId('p'), label: /^(?:image|bild|screenshot|img)\b/iu.test(label) ? '' : label.slice(0, 120), note: '', img }].slice(0, 40) }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Bild konnte nicht gelesen werden.')
      return current
    }
  }, Promise.resolve(data))
}

export function PlateEditor({ data, onChange, onError, onLearn }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const dataRef = useRef(data)
  dataRef.current = data
  const add = async (files: File[]) => onChange(await addPlateFiles(dataRef.current, files, onError))
  const learnable = data.items.filter((item) => item.img && item.label.trim()).length
  return (
    <div
      className="study-editor"
      onDragOver={(event) => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault() }}
      onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void add([...event.dataTransfer.files]) } }}
    >
      <div className="study-actions">
        <input className="study-title-input" aria-label="Titel" placeholder="Titel" value={data.title} onChange={(event) => onChange({ ...data, title: event.target.value })} />
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(event) => { void add([...(event.target.files ?? [])]); event.target.value = '' }} />
        <button type="button" className="secondary-button" onClick={() => fileRef.current?.click()}><ImagePlus size={14} /> Bilder wählen</button>
        <label className="study-inline">Spalten <select value={data.cols} onChange={(event) => onChange({ ...data, cols: Number(event.target.value) })}>{[2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
        <label className="study-inline"><input type="checkbox" checked={data.showLabels} onChange={(event) => onChange({ ...data, showLabels: event.target.checked })} /> Namen zeigen</label>
        <button type="button" className="primary-button" disabled={!learnable} title="Bilder als Karteikarten üben: Bild zeigen, Namen erraten" onClick={onLearn}><GraduationCap size={14} /> Lernen ({learnable})</button>
      </div>
      {!data.items.length && <div className="study-dropzone">Bilder hierher ziehen, einfügen (Strg+V) oder über „Bilder wählen“ laden.</div>}
      <div className="study-plate" style={{ gridTemplateColumns: `repeat(${data.cols}, minmax(0, 1fr))` }}>
        {data.items.map((item, index) => (
          <figure key={item.id} className="study-plate-item">
            {item.img ? <VaultImg src={item.img} alt={item.label} draggable={false} /> : <div className="study-plate-empty" />}
            <input aria-label={`Name Bild ${index + 1}`} placeholder="Name der Art" value={item.label} onChange={(event) => onChange({ ...data, items: data.items.map((entry) => (entry.id === item.id ? { ...entry, label: event.target.value } : entry)) })} />
            <input aria-label={`Merkmal Bild ${index + 1}`} placeholder="Merkmal (optional)" value={item.note} onChange={(event) => onChange({ ...data, items: data.items.map((entry) => (entry.id === item.id ? { ...entry, note: event.target.value } : entry)) })} />
            <button type="button" className="study-icon-btn" aria-label={`Bild ${index + 1} entfernen`} title="Bild entfernen" onClick={() => onChange({ ...data, items: data.items.filter((entry) => entry.id !== item.id) })}><Trash2 size={14} /></button>
          </figure>
        ))}
      </div>
    </div>
  )
}
