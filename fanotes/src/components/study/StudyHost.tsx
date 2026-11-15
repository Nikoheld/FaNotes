import { Copy, Download, FileImage, GraduationCap, Table2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import {
  findStudyBlocks, serializeStudyBlock, STUDY_KIND_LABELS, type StudyKind,
} from '../../lib/study/blocks'
import type { KeyData } from '../../lib/study/keyTree'
import { keyTableToMarkdown } from '../../lib/study/keyTree'
import type { MapData } from '../../lib/study/conceptMap'
import type { SortData } from '../../lib/study/sortBoard'
import { sortToMarkdown } from '../../lib/study/sortBoard'
import type { PlateData, TermData } from '../../lib/study/cardsModels'
import { defaultStudyData, parseStudyData } from '../../lib/study/registry'
import { EXPORT_PALETTE, renderKeyTreeSvg, renderMapSvg, type StudyAnyData } from '../../lib/study/render'
import { downloadBlob, storeStudyImage, STUDY_EVENT, svgToPngBlob } from '../../lib/study/imageTools'
import { KeyEditor } from './KeyEditor'
import { SortEditor } from './SortEditor'
import { MapEditor } from './MapEditor'
import { PlateEditor, addPlateFiles } from './PlateEditor'
import { TermEditor } from './TermEditor'

type Session = { kind: StudyKind; index: number; data: StudyAnyData; isNew: boolean; changed: boolean; inserted: { from: number; text: string } | null }

type HostEntry = { view: EditorView; open: (kind: StudyKind, index: number | null) => void }
const hosts = new Set<HostEntry>()
let lastFocused: EditorView | null = null

const pickHost = (view?: EditorView | null): HostEntry | null => {
  const list = [...hosts]
  return (view && list.find((entry) => entry.view === view)) || list.find((entry) => entry.view === lastFocused) || list[list.length - 1] || null
}

/** Opens the matching editor for a study block of the Markdown editor and writes edits straight back into the note. */
export function StudyHost({ getView }: { getView: () => EditorView | null }) {
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const sessionRef = useRef<Session | null>(null)
  sessionRef.current = session
  const viewRef = useRef<EditorView | null>(null)

  const write = useCallback((current: Session, data: StudyAnyData): Session => {
    const view = viewRef.current
    if (!view) return current
    const text = serializeStudyBlock(current.kind, data)
    const ref = findStudyBlocks(view.state.doc.toString())[current.index]
    if (!ref || ref.kind !== current.kind) return { ...current, data }
    view.dispatch({ changes: { from: ref.from, to: ref.to, insert: text } })
    return { ...current, data, changed: true }
  }, [])

  const open = useCallback((kind: StudyKind, index: number | null) => {
    const view = getView()
    if (!view || view.state.readOnly) return
    viewRef.current = view
    setError('')
    setNotice('')
    if (index !== null) {
      const ref = findStudyBlocks(view.state.doc.toString())[index]
      if (!ref) return
      setSession({ kind: ref.kind, index, data: parseStudyData(ref.kind, ref.body), isNew: false, changed: false, inserted: null })
      return
    }
    const doc = view.state.doc
    const line = doc.lineAt(view.state.selection.main.to)
    const data = defaultStudyData(kind)
    const block = serializeStudyBlock(kind, data)
    const lead = line.text.trim() ? '\n\n' : '\n'
    const insert = `${lead}${block}\n`
    view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length } })
    const start = line.to + lead.length
    const at = findStudyBlocks(view.state.doc.toString()).findIndex((ref) => ref.from === start)
    if (at < 0) return
    setSession({ kind, index: at, data, isNew: true, changed: false, inserted: { from: line.to, text: insert } })
  }, [getView])

  useEffect(() => {
    const view = getView()
    if (!view) return undefined
    viewRef.current = view
    const entry: HostEntry = { view, open }
    hosts.add(entry)
    const focus = () => { lastFocused = view }
    view.dom.addEventListener('focusin', focus)
    const onInsert = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: StudyKind; view?: EditorView }>).detail
      if (!detail?.kind || pickHost(detail.view) !== entry) return
      entry.open(detail.kind, null)
    }
    const onEdit = (event: Event) => {
      const detail = (event as CustomEvent<{ view?: EditorView; index?: number }>).detail
      if (detail?.view !== view || typeof detail.index !== 'number') return
      entry.open('key', detail.index)
    }
    window.addEventListener(STUDY_EVENT.insert, onInsert)
    window.addEventListener(STUDY_EVENT.edit, onEdit)
    return () => {
      hosts.delete(entry)
      view.dom.removeEventListener('focusin', focus)
      window.removeEventListener(STUDY_EVENT.insert, onInsert)
      window.removeEventListener(STUDY_EVENT.edit, onEdit)
    }
  }, [getView, open])

  const update = useCallback((data: StudyAnyData) => {
    const current = sessionRef.current
    if (!current) return
    setSession(write(current, data))
  }, [write])

  const close = useCallback(() => {
    const current = sessionRef.current
    const view = viewRef.current
    if (current?.isNew && !current.changed && current.inserted && view) {
      // Nothing was entered: take the starter block out of the note again.
      const { from, text } = current.inserted
      if (view.state.sliceDoc(from, from + text.length) === text) view.dispatch({ changes: { from, to: from + text.length, insert: '' } })
    }
    setSession(null)
    view?.focus()
  }, [])

  const insertAfter = (markdown: string) => {
    const current = sessionRef.current
    const view = viewRef.current
    if (!current || !view) return
    const ref = findStudyBlocks(view.state.doc.toString())[current.index]
    if (!ref) return
    view.dispatch({ changes: { from: ref.to, insert: `\n\n${markdown}\n` } })
    setNotice('In die Notiz eingefügt.')
  }

  // Pasted pictures go into the open editor instead of onto the worksheet underneath.
  useEffect(() => {
    if (!session) return undefined
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'))
      const current = sessionRef.current
      if (!files.length || !current) return
      if (current.kind === 'plate') { event.preventDefault(); void addPlateFiles(current.data as PlateData, files, setError).then((next) => update(next)) }
      else if (current.kind === 'key') { event.preventDefault(); void storeStudyImage(files[0]).then((img) => update({ ...(current.data as KeyData), compareImage: img })).catch((reason) => setError(reason instanceof Error ? reason.message : 'Bild konnte nicht gelesen werden.')) }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [session?.kind, Boolean(session), update])

  useEffect(() => {
    if (!session) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close, Boolean(session)])

  const exported = useMemo(() => {
    if (!session) return null
    if (session.kind === 'key') return renderKeyTreeSvg(session.data as KeyData, EXPORT_PALETTE)
    if (session.kind === 'map') return renderMapSvg(session.data as MapData, EXPORT_PALETTE)
    return null
  }, [session])

  const exportName = session?.kind === 'map' ? 'Begriffsnetz' : 'Bestimmungsschluessel'
  const withPng = async (task: (blob: Blob) => Promise<void> | void) => {
    if (!exported) return
    try { await task(await svgToPngBlob(exported.svg, exported.width, exported.height)); setError('') } catch (reason) { setError(reason instanceof Error ? reason.message : 'Bild konnte nicht erzeugt werden.') }
  }

  if (!session) return null
  const learn = () => { close(); window.dispatchEvent(new CustomEvent(STUDY_EVENT.openCards)) }

  return (
    <div className="modal-backdrop study-backdrop" role="presentation" data-study-modal="" onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <section className="study-modal" role="dialog" aria-modal="true" aria-label={STUDY_KIND_LABELS[session.kind]} onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <h2>{STUDY_KIND_LABELS[session.kind]}</h2>
          <button type="button" aria-label="Schließen" onClick={close}><X size={17} /></button>
        </header>
        <div className="study-body">
          {session.kind === 'key' && <KeyEditor data={session.data as KeyData} onChange={update} onError={setError} />}
          {session.kind === 'sort' && <SortEditor data={session.data as SortData} onChange={update} />}
          {session.kind === 'map' && <MapEditor data={session.data as MapData} onChange={update} />}
          {session.kind === 'plate' && <PlateEditor data={session.data as PlateData} onChange={update} onError={setError} onLearn={learn} />}
          {session.kind === 'term' && <TermEditor data={session.data as TermData} onChange={update} onLearn={learn} />}
        </div>
        {(error || notice) && <p className={error ? 'study-error' : 'study-notice'} role="status">{error || notice}</p>}
        <footer>
          {exported && (
            <>
              <button type="button" className="secondary-button" onClick={() => void withPng(async (blob) => { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); setNotice('Bild kopiert. Mit Strg+V auf das Blatt einfügen.') })}><Copy size={14} /> Bild kopieren</button>
              <button type="button" className="secondary-button" onClick={() => void withPng((blob) => downloadBlob(blob, `${exportName}.png`))}><Download size={14} /> PNG</button>
              <button type="button" className="secondary-button" onClick={() => void withPng((blob) => { window.dispatchEvent(new CustomEvent(STUDY_EVENT.placeImage, { detail: { file: new File([blob], `${exportName}.png`, { type: 'image/png' }) } })); setNotice('Als Bild auf das Blatt gelegt.') })}><FileImage size={14} /> Aufs Blatt legen</button>
            </>
          )}
          {session.kind === 'key' && <button type="button" className="secondary-button" onClick={() => insertAfter(keyTableToMarkdown((session.data as KeyData).table))}><Table2 size={14} /> Tabelle einfügen</button>}
          {session.kind === 'sort' && (
            <>
              <button type="button" className="secondary-button" onClick={() => insertAfter(sortToMarkdown(session.data as SortData, 'table'))}><Table2 size={14} /> Als Tabelle einfügen</button>
              <button type="button" className="secondary-button" onClick={() => insertAfter(sortToMarkdown(session.data as SortData, 'list'))}>Als Liste einfügen</button>
            </>
          )}
          {(session.kind === 'plate' || session.kind === 'term') && <button type="button" className="secondary-button" onClick={learn}><GraduationCap size={14} /> Karteikarten</button>}
          <span className="study-spacer" />
          <button type="button" className="primary-button" onClick={close}>Fertig</button>
        </footer>
      </section>
    </div>
  )
}

export default StudyHost
