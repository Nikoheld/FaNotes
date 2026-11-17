import { Copy, Download, FileImage, GraduationCap, ListOrdered, Table2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import {
  findStudyBlocks, hashText, locateStudyBlock, serializeStudyBlock, studyBlockBody, STUDY_KIND_LABELS, type StudyKind,
} from '../../lib/study/blocks'
import type { KeyData } from '../../lib/study/keyTree'
import { keyTableToMarkdown, keyToCoupletsMarkdown } from '../../lib/study/keyTree'
import type { MapData } from '../../lib/study/conceptMap'
import type { SortData } from '../../lib/study/sortBoard'
import { sortToMarkdown } from '../../lib/study/sortBoard'
import type { PlateData, TermData } from '../../lib/study/cardsModels'
import { defaultStudyData, findLoss, normaliseStudyData, readStudyBlock } from '../../lib/study/registry'
import { EXPORT_PALETTE, renderKeyTreeSvg, renderMapSvg, type StudyAnyData } from '../../lib/study/render'
import { downloadBlob, storeStudyImage, STUDY_EVENT, svgToPngBlob } from '../../lib/study/imageTools'
import { KeyEditor } from './KeyEditor'
import { SortEditor } from './SortEditor'
import { MapEditor } from './MapEditor'
import { PlateEditor, addPlateFiles } from './PlateEditor'
import { TermEditor } from './TermEditor'

/**
 * `from` and `hash` identify the block in the note: its offset and a fingerprint of the body as we last
 * saw or wrote it. Every write re-locates the block by that fingerprint, so a change made meanwhile
 * (typing, live merge, sync) can never make the editor overwrite a different block.
 */
type Session = {
  kind: StudyKind
  data: StudyAnyData
  /** Unknown top-level fields of the block; written back unchanged. */
  extra: Record<string, unknown>
  from: number
  hash: string
  isNew: boolean
  changed: boolean
  inserted: { from: number; text: string } | null
  /** Set when the block can no longer be written safely; the editor turns read-only. */
  locked: string
  /** Set when the block could not be read; its source is shown instead of an editor. */
  broken: { error: string; body: string } | null
}

const ADJUSTED_NOTICE = 'Einige Eingaben passten nicht in den Block und wurden angepasst.'

type BlockTarget = { kind: StudyKind; from: number; hash: string }
type HostEntry = { view: EditorView; open: (target: BlockTarget | StudyKind) => void }
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

  const write = useCallback((current: Session, edited: StudyAnyData): Session => {
    const view = viewRef.current
    if (!view || current.locked || current.broken) return current
    const ref = locateStudyBlock(view.state.doc.toString(), current.kind, current.hash, current.from)
    if (!ref) {
      return { ...current, locked: 'Die Notiz wurde inzwischen geändert und der Block ist nicht mehr eindeutig zu finden. Es wurde nichts überschrieben. Schließe den Editor und öffne den Block neu.' }
    }
    // The editor can hold states the block format cannot (a result that still has branches, an arrow from a box to
    // itself, a list past its cap). They are cleaned up here, before anything is written: a block the reader would
    // cut is refused on the next open, and the editor would lock out its own author.
    const data = normaliseStudyData(current.kind, edited)
    const body = studyBlockBody(data, current.extra)
    view.dispatch({ changes: { from: ref.from, to: ref.to, insert: serializeStudyBlock(current.kind, data, current.extra) } })
    return { ...current, data, from: ref.from, hash: hashText(body), changed: true }
  }, [])

  const open = useCallback((target: BlockTarget | StudyKind) => {
    const view = getView()
    if (!view || view.state.readOnly) return
    viewRef.current = view
    setError('')
    setNotice('')
    if (typeof target !== 'string') {
      const ref = locateStudyBlock(view.state.doc.toString(), target.kind, target.hash, target.from)
      if (!ref) { setNotice('Der Block hat sich geändert. Bitte erneut auf „Bearbeiten“ klicken.'); return }
      const read = readStudyBlock(ref.kind, ref.body)
      const base = { kind: ref.kind, from: ref.from, hash: hashText(ref.body), isNew: false, changed: false, inserted: null, locked: '' }
      setSession(read.ok
        ? { ...base, data: read.data, extra: read.extra, broken: null }
        : { ...base, data: defaultStudyData(ref.kind), extra: {}, broken: { error: read.error, body: ref.body } })
      return
    }
    const kind = target
    const doc = view.state.doc
    const line = doc.lineAt(view.state.selection.main.to)
    const data = defaultStudyData(kind)
    const block = serializeStudyBlock(kind, data)
    const lead = line.text.trim() ? '\n\n' : '\n'
    const insert = `${lead}${block}\n`
    view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length } })
    const start = line.to + lead.length
    const ref = findStudyBlocks(view.state.doc.toString()).find((entry) => entry.from === start)
    if (!ref) return
    setSession({ kind, data, extra: {}, from: start, hash: hashText(ref.body), isNew: true, changed: false, inserted: { from: line.to, text: insert }, locked: '', broken: null })
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
      entry.open(detail.kind)
    }
    const onEdit = (event: Event) => {
      const detail = (event as CustomEvent<{ view?: EditorView; kind?: StudyKind; from?: number; hash?: string }>).detail
      if (detail?.view !== view || !detail.kind || typeof detail.from !== 'number' || typeof detail.hash !== 'string') return
      entry.open({ kind: detail.kind, from: detail.from, hash: detail.hash })
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

  const update = useCallback((edited: StudyAnyData) => {
    const current = sessionRef.current
    if (!current) return
    const next = write(current, edited)
    setSession(next)
    if (next.data === current.data) return
    // The editors stop short of every cap, so this is rare: say so when something entered did not fit.
    setNotice((shown) => (findLoss(edited, next.data) ? ADJUSTED_NOTICE : shown === ADJUSTED_NOTICE ? '' : shown))
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
    if (!current || !view || current.locked || current.broken) return
    const ref = locateStudyBlock(view.state.doc.toString(), current.kind, current.hash, current.from)
    if (!ref) { setSession({ ...current, locked: 'Die Notiz wurde inzwischen geändert. Es wurde nichts eingefügt. Schließe den Editor und öffne den Block neu.' }); return }
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
      // An open inline confirmation answers Escape itself (it cancels) instead of closing the whole editor.
      if ((event.target as Element | null)?.closest?.('[data-lw-esc]')) return
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
  const live = !session.broken && !session.locked
  const learn = () => { close(); window.dispatchEvent(new CustomEvent(STUDY_EVENT.openCards)) }

  return (
    <div className="modal-backdrop lw-backdrop" role="presentation" data-lw-modal="" onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <section className="lw-modal" role="dialog" aria-modal="true" aria-label={STUDY_KIND_LABELS[session.kind]} onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <h2>{STUDY_KIND_LABELS[session.kind]}</h2>
          <button type="button" aria-label="Schließen" onClick={close}><X size={17} /></button>
        </header>
        {session.locked && <p className="lw-error" role="alert">{session.locked}</p>}
        {session.broken && (
          <div className="lw-body">
            <p className="lw-error" role="alert">{session.broken.error}</p>
            <p className="lw-hint">Der Block wurde nicht verändert. So steht er in der Notiz:</p>
            <pre className="lw-raw">{session.broken.body}</pre>
          </div>
        )}
        {!session.broken && <fieldset className="lw-fieldset" disabled={Boolean(session.locked)}><div className="lw-body">
          {session.kind === 'key' && <KeyEditor data={session.data as KeyData} onChange={update} onError={setError} />}
          {session.kind === 'sort' && <SortEditor data={session.data as SortData} onChange={update} />}
          {session.kind === 'map' && <MapEditor data={session.data as MapData} onChange={update} />}
          {session.kind === 'plate' && <PlateEditor data={session.data as PlateData} onChange={update} onError={setError} onLearn={learn} />}
          {session.kind === 'term' && <TermEditor data={session.data as TermData} onChange={update} onLearn={learn} />}
        </div></fieldset>}
        {(error || notice) && <p className={error ? 'lw-error' : 'lw-notice'} role="status">{error || notice}</p>}
        <footer>
          {live && exported && (
            <>
              <button type="button" className="secondary-button" onClick={() => void withPng(async (blob) => { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); setNotice('Bild kopiert. Mit Strg+V auf das Blatt einfügen.') })}><Copy size={14} /> Bild kopieren</button>
              <button type="button" className="secondary-button" onClick={() => void withPng((blob) => downloadBlob(blob, `${exportName}.png`))}><Download size={14} /> PNG</button>
              <button type="button" className="secondary-button" onClick={() => void withPng((blob) => { window.dispatchEvent(new CustomEvent(STUDY_EVENT.placeImage, { detail: { file: new File([blob], `${exportName}.png`, { type: 'image/png' }) } })); setNotice('Als Bild auf das Blatt gelegt.') })}><FileImage size={14} /> Aufs Blatt legen</button>
            </>
          )}
          {live && session.kind === 'key' && (
            <>
              <button type="button" className="secondary-button" onClick={() => insertAfter(keyTableToMarkdown((session.data as KeyData).table))}><Table2 size={14} /> Tabelle einfügen</button>
              <button type="button" className="secondary-button" onClick={() => insertAfter(keyToCoupletsMarkdown((session.data as KeyData).tree))} title="Der Schlüssel als nummerierte Liste mit Verweisen"><ListOrdered size={14} /> Schlüssel als Text einfügen</button>
            </>
          )}
          {live && session.kind === 'sort' && (
            <>
              <button type="button" className="secondary-button" onClick={() => insertAfter(sortToMarkdown(session.data as SortData, 'table'))}><Table2 size={14} /> Als Tabelle einfügen</button>
              <button type="button" className="secondary-button" onClick={() => insertAfter(sortToMarkdown(session.data as SortData, 'list'))}>Als Liste einfügen</button>
            </>
          )}
          {live && (session.kind === 'plate' || session.kind === 'term') && <button type="button" className="secondary-button" onClick={learn}><GraduationCap size={14} /> Karteikarten</button>}
          <span className="lw-spacer" />
          <button type="button" className="primary-button" onClick={close}>Fertig</button>
        </footer>
      </section>
    </div>
  )
}

export default StudyHost
