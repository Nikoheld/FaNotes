import { ImagePlus, Plus, Trash2, Wand2, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { fileToSmallDataUrl } from '../../lib/study/imageTools'
import {
  addChild, parseTablePaste, removeSubtree, skeletonFromTable, tableFromGrid,
  type KeyData, type KeyNode,
} from '../../lib/study/keyTree'
import { renderKeyTreeSvg } from '../../lib/study/render'

type Props = { data: KeyData; onChange: (data: KeyData) => void; onError: (message: string) => void }
type Tab = 'table' | 'key' | 'compare'

export function KeyEditor({ data, onChange, onError }: Props) {
  const [tab, setTab] = useState<Tab>('table')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const { table, tree } = data
  const preview = useMemo(() => renderKeyTreeSvg(data).svg, [data])
  const nodeById = useMemo(() => new Map(tree.nodes.map((node) => [node.id, node])), [tree])

  const setTable = (next: typeof table) => onChange({ ...data, table: next })
  const setFeature = (index: number, value: string) => setTable({ ...table, features: table.features.map((entry, at) => (at === index ? value : entry)) })
  const setCell = (row: number, column: number, value: string) => setTable({ ...table, items: table.items.map((item, at) => (at === row ? { ...item, values: item.values.map((entry, col) => (col === column ? value : entry)) } : item)) })
  const addFeature = () => setTable({ features: [...table.features, `Merkmal ${table.features.length + 1}`], items: table.items.map((item) => ({ ...item, values: [...item.values, ''] })) })
  const addItem = () => setTable({ ...table, items: [...table.items, { id: `i${Date.now().toString(36)}${table.items.length}`, name: '', values: table.features.map(() => '') }] })
  const patchNode = (id: string, patch: Partial<KeyNode>) => onChange({ ...data, tree: { ...tree, nodes: tree.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)) } })

  const applyPaste = () => {
    const grid = parseTablePaste(pasteText)
    if (grid.length < 2) { onError('Mindestens eine Kopfzeile und eine Zeile einfügen.'); return }
    setTable(tableFromGrid(grid))
    setPasteText('')
    setPasteOpen(false)
  }

  const generate = () => {
    const skeleton = skeletonFromTable(table)
    onChange({ ...data, tree: skeleton })
    setTab('key')
  }

  const pickImage = async (file: File | undefined) => {
    if (!file) return
    try { onChange({ ...data, compareImage: await fileToSmallDataUrl(file, 900) }) } catch (error) { onError(error instanceof Error ? error.message : 'Bild konnte nicht gelesen werden.') }
  }

  const renderNode = (id: string, depth: number, label: string | null, seen: Set<string>) => {
    const node = nodeById.get(id)
    if (!node || seen.has(id)) return null
    seen.add(id)
    return (
      <li key={id} className={`study-node is-${node.kind}`} style={{ marginLeft: depth ? 14 : 0 }}>
        <div className="study-node-row">
          {label !== null && <input className="study-branch-label" aria-label="Zweig" placeholder="ja / nein" value={label} onChange={(event) => {
            const parent = tree.nodes.find((entry) => entry.branches.some((branch) => branch.to === id))
            if (parent) patchNode(parent.id, { branches: parent.branches.map((branch) => (branch.to === id ? { ...branch, label: event.target.value } : branch)) })
          }} />}
          <select aria-label="Art des Knotens" value={node.kind} onChange={(event) => patchNode(id, { kind: event.target.value === 'leaf' ? 'leaf' : 'question' })}>
            <option value="question">Frage</option>
            <option value="leaf">Ergebnis</option>
          </select>
          <input aria-label={node.kind === 'leaf' ? 'Ergebnis' : 'Frage'} placeholder={node.kind === 'leaf' ? 'Art / Ordnung' : 'Frage oder Merkmal'} value={node.text} onChange={(event) => patchNode(id, { text: event.target.value })} />
          {node.kind === 'question' && <button type="button" className="study-icon-btn" title="Zweig hinzufügen" aria-label="Zweig hinzufügen" onClick={() => onChange({ ...data, tree: addChild(tree, id, 'leaf', node.branches.length === 0 ? 'ja' : node.branches.length === 1 ? 'nein' : '') })}><Plus size={14} /></button>}
          {id !== tree.root && <button type="button" className="study-icon-btn" title="Zweig löschen" aria-label="Zweig löschen" onClick={() => onChange({ ...data, tree: removeSubtree(tree, id) })}><Trash2 size={14} /></button>}
        </div>
        {node.kind === 'question' && node.branches.length > 0 && <ul>{node.branches.map((branch) => renderNode(branch.to, depth + 1, branch.label, seen))}</ul>}
      </li>
    )
  }

  return (
    <div className="study-editor">
      <input className="study-title-input" aria-label="Titel" placeholder="Titel" value={data.title} onChange={(event) => onChange({ ...data, title: event.target.value })} />
      <div className="study-tabs" role="tablist">
        {([['table', 'Tabelle'], ['key', 'Bestimmungsschlüssel'], ['compare', 'Vergleich']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'table' && (
        <div className="study-pane">
          <div className="study-grid-scroll">
            <table className="study-grid">
              <thead>
                <tr>
                  <th>Art</th>
                  {table.features.map((feature, index) => (
                    <th key={index}><input aria-label={`Merkmal ${index + 1}`} value={feature} onChange={(event) => setFeature(index, event.target.value)} />
                      <button type="button" className="study-icon-btn" title="Merkmal löschen" aria-label={`Merkmal ${index + 1} löschen`} onClick={() => setTable({ features: table.features.filter((_, at) => at !== index), items: table.items.map((item) => ({ ...item, values: item.values.filter((_, at) => at !== index) })) })}><X size={12} /></button></th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {table.items.map((item, row) => (
                  <tr key={item.id}>
                    <td><input aria-label={`Art ${row + 1}`} value={item.name} onChange={(event) => setTable({ ...table, items: table.items.map((entry, at) => (at === row ? { ...entry, name: event.target.value } : entry)) })} /></td>
                    {item.values.map((value, column) => <td key={column}><input aria-label={`${item.name || `Art ${row + 1}`}, ${table.features[column] || `Merkmal ${column + 1}`}`} value={value} onChange={(event) => setCell(row, column, event.target.value)} /></td>)}
                    <td><button type="button" className="study-icon-btn" title="Zeile löschen" aria-label={`Zeile ${row + 1} löschen`} onClick={() => setTable({ ...table, items: table.items.filter((_, at) => at !== row) })}><Trash2 size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="study-actions">
            <button type="button" className="secondary-button" onClick={addItem}><Plus size={14} /> Art</button>
            <button type="button" className="secondary-button" onClick={addFeature}><Plus size={14} /> Merkmal</button>
            <button type="button" className="secondary-button" onClick={() => setPasteOpen((open) => !open)}>Aus Text einfügen</button>
            <button type="button" className="primary-button" onClick={generate} title="Erzeugt einen Schlüssel aus den Merkmalen der Tabelle"><Wand2 size={14} /> Schlüssel erzeugen</button>
          </div>
          {pasteOpen && (
            <div className="study-paste">
              <p>Kopfzeile zuerst, Spalten mit Tab, Semikolon oder | trennen (Excel, Word, Markdown).</p>
              <textarea aria-label="Tabelle als Text" rows={5} value={pasteText} onChange={(event) => setPasteText(event.target.value)} />
              <button type="button" className="primary-button" onClick={applyPaste}>Übernehmen</button>
            </div>
          )}
        </div>
      )}
      {tab === 'key' && (
        <div className="study-pane study-split">
          <ul className="study-tree-editor">{renderNode(tree.root, 0, null, new Set())}</ul>
          <div className="study-preview" dangerouslySetInnerHTML={{ __html: preview }} />
        </div>
      )}
      {tab === 'compare' && (
        <div className="study-pane">
          <div className="study-actions">
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => { void pickImage(event.target.files?.[0]); event.target.value = '' }} />
            <button type="button" className="secondary-button" onClick={() => fileRef.current?.click()}><ImagePlus size={14} /> Vergleichsbild wählen</button>
            <span className="study-hint">oder Bild hier einfügen (Strg+V) oder hineinziehen</span>
            {data.compareImage && <button type="button" className="secondary-button" onClick={() => onChange({ ...data, compareImage: '' })}>Entfernen</button>}
            <input className="study-title-input" aria-label="Beschriftung des Vergleichsbilds" placeholder="z. B. Abb. 9 im Skript" value={data.compareLabel} onChange={(event) => onChange({ ...data, compareLabel: event.target.value })} />
          </div>
          <div className="study-compare-view">
            <div className="study-preview" dangerouslySetInnerHTML={{ __html: preview }} />
            {data.compareImage ? <figure className="study-compare"><img src={data.compareImage} alt={data.compareLabel || 'Vergleichsbaum'} /><figcaption>{data.compareLabel}</figcaption></figure> : <div className="study-compare-empty">Kein Vergleichsbild</div>}
          </div>
        </div>
      )}
    </div>
  )
}
