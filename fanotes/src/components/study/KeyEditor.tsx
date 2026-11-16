import { ArrowDown, ArrowUp, GitBranchPlus, ImagePlus, Plus, Trash2, Wand2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { storeStudyImage } from '../../lib/study/imageTools'
import { VaultImg } from './VaultImg'
import {
  addChild, canAddChild, descendantIds, KEY_LIMITS, moveNode, nextNodeId, parentOf, parseTablePaste, removeSubtree,
  setNodeKind, skeletonReport, tableFromGrid, wrapInQuestion,
  type KeyData, type KeyTree,
} from '../../lib/study/keyTree'
import { renderKeyTreeSvg } from '../../lib/study/render'

type Props = { data: KeyData; onChange: (data: KeyData) => void; onError: (message: string) => void }
type Tab = 'table' | 'key' | 'compare'
/** A destructive change that waits for an answer: a result cannot keep its branches, a deleted branch takes its subtree. */
type Pending = { id: string; action: 'leaf' | 'delete' }
type SkeletonNote = { unusable: string[]; merged: string[][] }

// Texts below that name a cap in digits (60 Arten, 24 Merkmale, 4 Werte) so they can be translated as they are; they must
// follow KEY_LIMITS and MAX_SPLIT in keyTree.ts (check-study-tools.mjs compares them).

/** From this depth on the editor stops indenting further, so a long ladder of questions stays inside its column. */
const INDENT_LEVELS = 6

export function KeyEditor({ data, onChange, onError }: Props) {
  const [tab, setTab] = useState<Tab>('table')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [skeletonNote, setSkeletonNote] = useState<SkeletonNote | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const textInputs = useRef(new Map<string, HTMLInputElement>())
  const focusAfter = useRef<string | null>(null)
  const { table, tree } = data
  const preview = useMemo(() => renderKeyTreeSvg(data).svg, [data])
  const nodeById = useMemo(() => new Map(tree.nodes.map((node) => [node.id, node])), [tree])

  // After an edit that adds or moves a row, the cursor goes to that row's text field.
  useEffect(() => {
    const id = focusAfter.current
    focusAfter.current = null
    if (id) textInputs.current.get(id)?.focus()
  }, [tree])
  useEffect(() => { if (pending) cancelRef.current?.focus() }, [pending])
  useEffect(() => { if (pending && !nodeById.has(pending.id)) setPending(null) }, [pending, nodeById])

  const setTable = (next: typeof table) => onChange({ ...data, table: next })
  const setFeature = (index: number, value: string) => setTable({ ...table, features: table.features.map((entry, at) => (at === index ? value : entry)) })
  const setCell = (row: number, column: number, value: string) => setTable({ ...table, items: table.items.map((item, at) => (at === row ? { ...item, values: item.values.map((entry, col) => (col === column ? value : entry)) } : item)) })
  const addFeature = () => { if (table.features.length < KEY_LIMITS.features) setTable({ features: [...table.features, `Merkmal ${table.features.length + 1}`], items: table.items.map((item) => ({ ...item, values: [...item.values, ''] })) }) }
  const addItem = () => { if (table.items.length < KEY_LIMITS.items) setTable({ ...table, items: [...table.items, { id: `i${Date.now().toString(36)}${table.items.length}`, name: '', values: table.features.map(() => '') }] }) }
  const commitTree = (next: KeyTree, focusId?: string) => {
    if (next === tree) return
    focusAfter.current = focusId ?? null
    onChange({ ...data, tree: next })
  }
  const patchNode = (id: string, patch: { text?: string }) => onChange({ ...data, tree: { ...tree, nodes: tree.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)) } })

  const applyPaste = () => {
    const grid = parseTablePaste(pasteText)
    if (grid.length < 2) { onError('Mindestens eine Kopfzeile und eine Zeile einfügen.'); return }
    setTable(tableFromGrid(grid))
    setPasteText('')
    setPasteOpen(false)
    if (grid.length - 1 > KEY_LIMITS.items || grid[0].length - 1 > KEY_LIMITS.features) onError('Die Tabelle fasst höchstens 60 Arten und 24 Merkmale. Der Rest wurde nicht übernommen.')
  }

  const generate = () => {
    const report = skeletonReport(table)
    onChange({ ...data, tree: report.tree })
    setSkeletonNote(report.unusable.length || report.merged.length ? { unusable: report.unusable, merged: report.merged } : null)
    setPending(null)
    setTab('key')
  }

  const pickImage = async (file: File | undefined) => {
    if (!file) return
    try { onChange({ ...data, compareImage: await storeStudyImage(file) }) } catch (error) { onError(error instanceof Error ? error.message : 'Bild konnte nicht gelesen werden.') }
  }

  const addBranch = (parentId: string, afterId?: string) => {
    const parent = nodeById.get(parentId)
    if (!parent || !canAddChild(tree, parentId)) return
    const label = afterId ? '' : parent.branches.length === 0 ? 'ja' : parent.branches.length === 1 ? 'nein' : ''
    commitTree(addChild(tree, parentId, 'leaf', label, afterId), nextNodeId(tree))
  }
  /** Result to question needs no answer; question to result deletes everything below it, so it asks first when there is something below. */
  const setKind = (id: string, kind: 'question' | 'leaf') => {
    if (kind === 'leaf' && descendantIds(tree, id).length) { setPending({ id, action: 'leaf' }); return }
    commitTree(setNodeKind(tree, id, kind))
  }
  const removeBranch = (id: string) => {
    if (descendantIds(tree, id).length) { setPending({ id, action: 'delete' }); return }
    commitTree(removeSubtree(tree, id), parentOf(tree, id)?.id)
  }
  const answerPending = () => {
    if (!pending) return
    const { id, action } = pending
    setPending(null)
    if (action === 'leaf') commitTree(setNodeKind(tree, id, 'leaf'), id)
    else commitTree(removeSubtree(tree, id), parentOf(tree, id)?.id)
  }

  const renderNode = (id: string, depth: number, label: string | null, seen: Set<string>) => {
    const node = nodeById.get(id)
    if (!node || seen.has(id)) return null
    seen.add(id)
    const parent = parentOf(tree, id)
    const index = parent ? parent.branches.findIndex((branch) => branch.to === id) : -1
    const siblings = parent?.branches.length ?? 0
    return (
      <li key={id} className={`lw-node is-${node.kind}`}>
        <div className="lw-node-row">
          <div className="lw-node-line">
            {label !== null
              ? <input className="lw-branch-label" aria-label="Zweig" placeholder="ja / nein" maxLength={KEY_LIMITS.branchLabel} value={label} onChange={(event) => {
                if (parent) commitTree({ ...tree, nodes: tree.nodes.map((entry) => (entry.id === parent.id ? { ...entry, branches: entry.branches.map((branch) => (branch.to === id ? { ...branch, label: event.target.value } : branch)) } : entry)) })
              }} />
              : <span className="lw-node-root">Anfang</span>}
            <span className="lw-node-tools">
              {node.kind === 'question' && <button type="button" className="lw-icon-btn" title="Zweig hinzufügen" aria-label="Zweig hinzufügen" disabled={!canAddChild(tree, id)} onClick={() => addBranch(id)}><Plus size={14} /></button>}
              {siblings > 1 && <button type="button" className="lw-icon-btn" title="Nach oben" aria-label="Nach oben" disabled={index <= 0} onClick={() => commitTree(moveNode(tree, id, -1), id)}><ArrowUp size={14} /></button>}
              {siblings > 1 && <button type="button" className="lw-icon-btn" title="Nach unten" aria-label="Nach unten" disabled={index < 0 || index >= siblings - 1} onClick={() => commitTree(moveNode(tree, id, 1), id)}><ArrowDown size={14} /></button>}
              <button type="button" className="lw-icon-btn" title="Frage davor einfügen" aria-label="Frage davor einfügen" disabled={tree.nodes.length + 2 > KEY_LIMITS.nodes} onClick={() => commitTree(wrapInQuestion(tree, id), nextNodeId(tree))}><GitBranchPlus size={14} /></button>
              {id !== tree.root && <button type="button" className="lw-icon-btn" title="Zweig löschen" aria-label="Zweig löschen" onClick={() => removeBranch(id)}><Trash2 size={14} /></button>}
            </span>
          </div>
          <div className="lw-node-line">
            <select aria-label="Art des Knotens" value={node.kind} onChange={(event) => setKind(id, event.target.value === 'leaf' ? 'leaf' : 'question')}>
              <option value="question">Frage</option>
              <option value="leaf">Ergebnis</option>
            </select>
            <input
              ref={(element) => { if (element) textInputs.current.set(id, element); else textInputs.current.delete(id) }}
              aria-label={node.kind === 'leaf' ? 'Ergebnis' : 'Frage'}
              placeholder={node.kind === 'leaf' ? 'Art / Ordnung' : 'Frage oder Merkmal'}
              maxLength={KEY_LIMITS.nodeText}
              value={node.text}
              onChange={(event) => patchNode(id, { text: event.target.value })}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Enter') {
                  // Enter is the quick way to enter a whole key: the next result goes in beside this one.
                  event.preventDefault()
                  if (parent) addBranch(parent.id, id)
                  else addBranch(id)
                } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                  event.preventDefault()
                  commitTree(moveNode(tree, id, event.key === 'ArrowUp' ? -1 : 1), id)
                }
              }}
            />
          </div>
        </div>
        {pending?.id === id && (
          <div
            className="backup-inline-confirm is-danger lw-node-confirm"
            role="alert"
            data-lw-esc=""
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPending(null) } }}
          >
            <span>{pending.action === 'leaf' ? 'Ein Ergebnis hat keine Unterzweige. Alle Zweige darunter werden gelöscht.' : 'Dieser Zweig und alle Zweige darunter werden gelöscht.'}</span>
            <button ref={cancelRef} type="button" className="secondary-button" onClick={() => setPending(null)}>Abbrechen</button>
            <button type="button" className="danger-button" onClick={answerPending}>{pending.action === 'leaf' ? 'Zum Ergebnis machen' : 'Löschen'}</button>
          </div>
        )}
        {node.kind === 'question' && node.branches.length > 0 && <ul className={depth + 1 >= INDENT_LEVELS ? 'is-flat' : undefined}>{node.branches.map((branch) => renderNode(branch.to, depth + 1, branch.label, seen))}</ul>}
      </li>
    )
  }

  return (
    <div className="lw-editor">
      <input className="lw-title-input" aria-label="Titel" placeholder="Titel" maxLength={KEY_LIMITS.title} value={data.title} onChange={(event) => onChange({ ...data, title: event.target.value })} />
      <div className="lw-tabs" role="tablist">
        {([['table', 'Tabelle'], ['key', 'Bestimmungsschlüssel'], ['compare', 'Vergleich']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'table' && (
        <div className="lw-pane">
          <div className="lw-grid-scroll">
            <table className="lw-grid">
              <thead>
                <tr>
                  <th>Art</th>
                  {table.features.map((feature, index) => (
                    <th key={index}><input aria-label={`Merkmal ${index + 1}`} maxLength={KEY_LIMITS.featureName} value={feature} onChange={(event) => setFeature(index, event.target.value)} />
                      <button type="button" className="lw-icon-btn" title="Merkmal löschen" aria-label={`Merkmal ${index + 1} löschen`} onClick={() => setTable({ features: table.features.filter((_, at) => at !== index), items: table.items.map((item) => ({ ...item, values: item.values.filter((_, at) => at !== index) })) })}><X size={12} /></button></th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {table.items.map((item, row) => (
                  <tr key={item.id}>
                    <td><input aria-label={`Art ${row + 1}`} maxLength={KEY_LIMITS.itemName} value={item.name} onChange={(event) => setTable({ ...table, items: table.items.map((entry, at) => (at === row ? { ...entry, name: event.target.value } : entry)) })} /></td>
                    {item.values.map((value, column) => <td key={column}><input aria-label={`${item.name || `Art ${row + 1}`}, ${table.features[column] || `Merkmal ${column + 1}`}`} maxLength={KEY_LIMITS.cell} value={value} onChange={(event) => setCell(row, column, event.target.value)} /></td>)}
                    <td><button type="button" className="lw-icon-btn" title="Zeile löschen" aria-label={`Zeile ${row + 1} löschen`} onClick={() => setTable({ ...table, items: table.items.filter((_, at) => at !== row) })}><Trash2 size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="lw-actions">
            <button type="button" className="secondary-button" disabled={table.items.length >= KEY_LIMITS.items} title={table.items.length >= KEY_LIMITS.items ? 'Die Tabelle fasst höchstens 60 Arten.' : undefined} onClick={addItem}><Plus size={14} /> Art</button>
            <button type="button" className="secondary-button" disabled={table.features.length >= KEY_LIMITS.features} title={table.features.length >= KEY_LIMITS.features ? 'Die Tabelle fasst höchstens 24 Merkmale.' : undefined} onClick={addFeature}><Plus size={14} /> Merkmal</button>
            <button type="button" className="secondary-button" onClick={() => setPasteOpen((open) => !open)}>Aus Text einfügen</button>
            <button type="button" className="primary-button" onClick={generate} title="Erzeugt einen Schlüssel aus den Merkmalen der Tabelle"><Wand2 size={14} /> Schlüssel erzeugen</button>
          </div>
          {pasteOpen && (
            <div className="lw-paste">
              <p>Kopfzeile zuerst, Spalten mit Tab, Semikolon oder | trennen (Excel, Word, Markdown).</p>
              <textarea aria-label="Tabelle als Text" rows={5} value={pasteText} onChange={(event) => setPasteText(event.target.value)} />
              <button type="button" className="primary-button" onClick={applyPaste}>Übernehmen</button>
            </div>
          )}
        </div>
      )}
      {tab === 'key' && (
        <div className="lw-pane">
          {skeletonNote && (
            <div className="lw-skeleton-note" role="status">
              <button type="button" className="lw-icon-btn" title="Hinweis schließen" aria-label="Hinweis schließen" onClick={() => setSkeletonNote(null)}><X size={12} /></button>
              {skeletonNote.merged.length > 0 && (
                <>
                  <p>Diese Arten lassen sich mit den Merkmalen der Tabelle nicht trennen und stehen zusammen in einem Ergebnis:</p>
                  <ul>{skeletonNote.merged.map((names, index) => <li key={index}>{names.join(', ')}</li>)}</ul>
                </>
              )}
              {skeletonNote.unusable.length > 0 && (
                <>
                  <p>Diese Merkmale wurden übergangen, weil sie mehr als 4 verschiedene Werte haben. Ja/Nein-Merkmale oder wenige feste Werte eignen sich:</p>
                  <ul>{skeletonNote.unusable.map((name, index) => <li key={index}>{name}</li>)}</ul>
                </>
              )}
            </div>
          )}
          <div className="lw-pane lw-split">
            <div className="lw-tree-pane">
              <ul className="lw-tree-editor">{renderNode(tree.root, 0, null, new Set())}</ul>
              <p className="lw-hint">Enter fügt ein weiteres Ergebnis daneben ein, Alt+Pfeil hoch oder runter verschiebt den Zweig.</p>
            </div>
            <div className="lw-preview" dangerouslySetInnerHTML={{ __html: preview }} />
          </div>
        </div>
      )}
      {tab === 'compare' && (
        <div className="lw-pane">
          <div className="lw-actions">
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => { void pickImage(event.target.files?.[0]); event.target.value = '' }} />
            <button type="button" className="secondary-button" onClick={() => fileRef.current?.click()}><ImagePlus size={14} /> Vergleichsbild wählen</button>
            <span className="lw-hint">oder Bild hier einfügen (Strg+V) oder hineinziehen</span>
            {data.compareImage && <button type="button" className="secondary-button" onClick={() => onChange({ ...data, compareImage: '' })}>Entfernen</button>}
            <input className="lw-title-input" aria-label="Beschriftung des Vergleichsbilds" placeholder="z. B. Abb. 9 im Skript" maxLength={KEY_LIMITS.compareLabel} value={data.compareLabel} onChange={(event) => onChange({ ...data, compareLabel: event.target.value })} />
          </div>
          <div className="lw-compare-view">
            <div className="lw-preview" dangerouslySetInnerHTML={{ __html: preview }} />
            {data.compareImage ? <figure className="lw-compare"><VaultImg src={data.compareImage} alt={data.compareLabel || 'Vergleichsbaum'} /><figcaption>{data.compareLabel}</figcaption></figure> : <div className="lw-compare-empty">Kein Vergleichsbild</div>}
          </div>
        </div>
      )}
    </div>
  )
}
