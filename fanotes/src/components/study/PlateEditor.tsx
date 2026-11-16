import { GraduationCap, ImagePlus, Trash2 } from 'lucide-react'
import { useRef } from 'react'
import { newId } from '../../lib/study/blocks'
import { PLATE_LIMITS, type PlateData } from '../../lib/study/cardsModels'
import { storeStudyImage } from '../../lib/study/imageTools'
import { VaultImg } from './VaultImg'

type Props = { data: PlateData; onChange: (data: PlateData) => void; onError: (message: string) => void; onLearn: () => void }

export function addPlateFiles(data: PlateData, files: readonly File[], onError: (message: string) => void): Promise<PlateData> {
  return files.reduce<Promise<PlateData>>(async (previous, file) => {
    const current = await previous
    if (!file.type.startsWith('image/')) return current
    // Stop before the picture is stored: a file that does not fit on the sheet would only be left behind in the vault.
    if (current.items.length >= PLATE_LIMITS.items) { onError('Eine Bildtafel fasst höchstens 40 Bilder. Die übrigen wurden nicht übernommen.'); return current }
    try {
      const img = await storeStudyImage(file)
      const label = file.name.replace(/\.[a-z0-9]+$/iu, '').replace(/[_-]+/gu, ' ').trim()
      return { ...current, items: [...current.items, { id: newId('p'), label: /^(?:image|bild|screenshot|img)\b/iu.test(label) ? '' : label.slice(0, PLATE_LIMITS.label), note: '', img }] }
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
      className="lw-editor"
      onDragOver={(event) => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault() }}
      onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void add([...event.dataTransfer.files]) } }}
    >
      <div className="lw-actions">
        <input className="lw-title-input" aria-label="Titel" placeholder="Titel" maxLength={PLATE_LIMITS.title} value={data.title} onChange={(event) => onChange({ ...data, title: event.target.value })} />
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(event) => { void add([...(event.target.files ?? [])]); event.target.value = '' }} />
        <button type="button" className="secondary-button" disabled={data.items.length >= PLATE_LIMITS.items} title={data.items.length >= PLATE_LIMITS.items ? 'Eine Bildtafel fasst höchstens 40 Bilder.' : undefined} onClick={() => fileRef.current?.click()}><ImagePlus size={14} /> Bilder wählen</button>
        <label className="lw-inline">Spalten <select value={data.cols} onChange={(event) => onChange({ ...data, cols: Number(event.target.value) })}>{[2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
        <label className="lw-inline"><input type="checkbox" checked={data.showLabels} onChange={(event) => onChange({ ...data, showLabels: event.target.checked })} /> Namen zeigen</label>
        <button type="button" className="primary-button" disabled={!learnable} title="Bilder als Karteikarten üben: Bild zeigen, Namen erraten" onClick={onLearn}><GraduationCap size={14} /> Lernen ({learnable})</button>
      </div>
      {!data.items.length && <div className="lw-dropzone">Bilder hierher ziehen, einfügen (Strg+V) oder über „Bilder wählen“ laden.</div>}
      <div className="lw-plate" style={{ gridTemplateColumns: `repeat(${data.cols}, minmax(0, 1fr))` }}>
        {data.items.map((item, index) => (
          <figure key={item.id} className="lw-plate-item">
            {item.img ? <VaultImg src={item.img} alt={item.label} draggable={false} /> : <div className="lw-plate-empty" />}
            <input aria-label={`Name Bild ${index + 1}`} placeholder="Name der Art" maxLength={PLATE_LIMITS.label} value={item.label} onChange={(event) => onChange({ ...data, items: data.items.map((entry) => (entry.id === item.id ? { ...entry, label: event.target.value } : entry)) })} />
            <input aria-label={`Merkmal Bild ${index + 1}`} placeholder="Merkmal (optional)" maxLength={PLATE_LIMITS.note} value={item.note} onChange={(event) => onChange({ ...data, items: data.items.map((entry) => (entry.id === item.id ? { ...entry, note: event.target.value } : entry)) })} />
            <button type="button" className="lw-icon-btn" aria-label={`Bild ${index + 1} entfernen`} title="Bild entfernen" onClick={() => onChange({ ...data, items: data.items.filter((entry) => entry.id !== item.id) })}><Trash2 size={14} /></button>
          </figure>
        ))}
      </div>
    </div>
  )
}
