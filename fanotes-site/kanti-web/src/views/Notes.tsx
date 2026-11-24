import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { dateLabel } from '../lib/i18n'
import { renderMarkdown, type MarkdownHooks } from '../lib/markdown'
import { collectPages, readFamd } from '../lib/famd'
import { renderPage } from '../lib/inkRender'
import { readStoryText, type StoryText } from '../lib/story'
import { useKanti } from '../state'
import { Banner, Button, Card, Empty, Icon, IconButton } from '../components/ui'
import type { VaultBackend } from '../vault/backend'
import type { VaultEntry } from '../vault/client'
import { VaultError } from '../vault/client'
import { bytesOf, textOf } from '../vault/files'
import {
  buildTextIndex, bytesToDataUrl, countIn, folderContents, libraryNotes, mimeOf, readTrash, resolveVaultPath, resolveWikiLink, searchNotes, sortNotes,
  type LibNote, type NoteSort, type TrashItem,
} from '../vault/notes'
import { useVault } from '../vault/store'
import { VaultHint } from '../vault/ui'

const PdfViewer = lazy(() => import('../components/PdfViewer').then((module) => ({ default: module.PdfViewer })))

const useBytes = (backend: VaultBackend, path: string, reloadKey = 0) => {
  const [state, setState] = useState<{ path: string; bytes: Uint8Array | null; error: boolean; loading: boolean }>({ path, bytes: null, error: false, loading: true })
  useEffect(() => {
    let live = true
    setState({ path, bytes: null, error: false, loading: true })
    backend.read(path).then((file) => { if (live) setState({ path, bytes: file.bytes, error: file.bytes === null, loading: false }) }, () => { if (live) setState({ path, bytes: null, error: true, loading: false }) })
    return () => { live = false }
  }, [backend, path, reloadKey])
  return state
}

/** An image of the vault as a data: URL (the CSP allows img-src data:). */
const VaultImage = ({ backend, path, alt }: { backend: VaultBackend; path: string; alt: string }) => {
  const file = useBytes(backend, path)
  const url = useMemo(() => (file.bytes ? bytesToDataUrl(file.bytes, mimeOf(path)) : ''), [file.bytes, path])
  if (file.loading) return <span className="spinner spinner-small" aria-hidden="true" />
  return url ? <img className="md-image" src={url} alt={alt} /> : <span className="muted">{alt}</span>
}

const MediaPlayer = ({ bytes, path, kind }: { bytes: Uint8Array; path: string; kind: 'audio' | 'video' }) => {
  const { t } = useKanti()
  // Playback needs a blob: URL (CSP media-src 'self' blob:); images and PDFs never do.
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOf(path) })), [bytes, path])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return kind === 'audio' ? <audio controls src={url} className="note-media">{t.mediaUnsupported}</audio> : <video controls src={url} className="note-media">{t.mediaUnsupported}</video>
}

const InkPages = ({ source }: { source: string }) => {
  const { t } = useKanti()
  const parsed = useMemo(() => readFamd(source), [source])
  const pages = useMemo(() => collectPages(parsed.payload), [parsed])
  const refs = useRef<(HTMLCanvasElement | null)[]>([])
  useEffect(() => {
    pages.forEach((page, index) => {
      const canvas = refs.current[index]
      if (canvas) renderPage(canvas, page.doc, { cssWidth: Math.min(820, Math.max(280, (canvas.parentElement?.clientWidth || 820) - 8)), paper: page.paper, dpr: Math.min(window.devicePixelRatio || 1, 2) })
    })
  }, [pages])
  return (
    <>
      {parsed.error || (parsed.version && !parsed.payload) ? <Banner tone="warning" icon="warning">{t.noteHandwritingPending}</Banner> : null}
      {pages.length ? <p className="muted small">{t.noteHandwritingReadOnly}</p> : null}
      <div className="ink-pages">
        {pages.map((page, index) => <figure key={index}>{page.label ? <figcaption>{page.label}</figcaption> : null}<canvas ref={(node) => { refs.current[index] = node }} role="img" aria-label={t.noteHandwriting} /></figure>)}
      </div>
    </>
  )
}

const StoryView = ({ backend, path }: { backend: VaultBackend; path: string }) => {
  const { t } = useKanti()
  const [story, setStory] = useState<StoryText | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    readStoryText(async (file) => textOf((await backend.read(`${path}/${file}`)).bytes)).then((value) => { if (live) setStory(value) }, () => { if (live) setStory(null) })
    return () => { live = false }
  }, [backend, path])
  if (story === undefined) return <span className="spinner" aria-hidden="true" />
  if (!story) return <Banner tone="warning" icon="warning">{t.noteFailed}</Banner>
  return (
    <article className="md story">
      <p className="muted small">{t.storyReadOnly}</p>
      <h1>{story.title || path}</h1>
      {story.subtitle ? <p className="muted">{story.subtitle}</p> : null}
      {story.author ? <p className="muted">{story.author}</p> : null}
      {story.blocks.map((block, index) => (block.kind === 'part' ? <h2 key={index}>{block.text}</h2> : block.kind === 'chapter' ? <h3 key={index}>{block.text}</h3> : block.kind === 'scene' ? <h4 key={index}>{block.text}</h4> : <p key={index} className={`story-${block.style}`}>{block.text}</p>))}
      {story.truncated ? <p className="muted small">{t.storyTruncated}</p> : null}
    </article>
  )
}

const MarkdownNote = ({ backend, note, notes, paths, onOpen, writable }: { backend: VaultBackend; note: LibNote; notes: LibNote[]; paths: Set<string>; onOpen: (path: string) => void; writable: boolean }) => {
  const { t } = useKanti()
  const [reloadKey, setReloadKey] = useState(0)
  const file = useBytes(backend, note.path, reloadKey)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [base, setBase] = useState('')
  const [status, setStatus] = useState<'' | 'saving' | 'saved' | 'conflict' | 'failed'>('')
  const [message, setMessage] = useState('')
  const text = textOf(file.bytes) ?? ''
  const hooks = useMemo<MarkdownHooks>(() => ({
    image: (src, alt) => {
      if (/^[a-z][a-z0-9+.-]*:/iu.test(src)) return <span className="muted">{alt || src}</span>
      const path = resolveVaultPath(src, note.path, paths)
      return path ? <VaultImage backend={backend} path={path} alt={alt} /> : <span className="muted">{alt || src}</span>
    },
    openNote: (target) => {
      const found = resolveWikiLink(target, notes) || notes.find((item) => item.path === resolveVaultPath(target, note.path, paths))
      if (found) onOpen(found.path)
    },
    noteExists: (target) => resolveWikiLink(target, notes) !== null,
  }), [backend, note.path, notes, paths, onOpen])
  const body = useMemo(() => renderMarkdown(text, hooks), [text, hooks])
  const startEditing = () => { setDraft(text); setBase(text); setStatus(''); setMessage(''); setEditing(true) }
  const save = async () => {
    setStatus('saving')
    try {
      // The change is "replace the text I started from". If the file is no longer what I started from, nothing is written.
      await backend.update(note.path, (current) => {
        if ((textOf(current) ?? '') !== base) throw new VaultError('conflict', t.noteChangedElsewhere)
        return bytesOf(draft)
      })
      setStatus('saved')
      setEditing(false)
      setReloadKey((value) => value + 1)
    } catch (problem) {
      setStatus(problem instanceof VaultError && problem.code === 'conflict' ? 'conflict' : 'failed')
      setMessage(problem instanceof VaultError && problem.code === 'conflict' ? t.noteChangedElsewhere : t.vaultSaveFailed(problem instanceof Error ? problem.message : String(problem)))
    }
  }
  if (file.loading) return <span className="spinner" aria-hidden="true" />
  if (file.error) return <Banner tone="warning" icon="warning">{t.noteFailed}</Banner>
  return (
    <>
      {writable ? (
        <div className="note-tools">
          {editing ? (
            <>
              <Button icon="check" disabled={status === 'saving' || draft === base} onClick={() => void save()}>{status === 'saving' ? t.vaultBusy : t.saveNote}</Button>
              <Button tone="quiet" onClick={() => setEditing(false)}>{t.cancel}</Button>
              {draft !== base ? <span className="muted small">{t.noteUnsaved}</span> : null}
            </>
          ) : <Button tone="outline" icon="edit" onClick={startEditing}>{t.editNote}</Button>}
          {status === 'saved' && !editing ? <span className="muted small" role="status">{t.noteSaved}</span> : null}
        </div>
      ) : null}
      {message && status !== 'saved' ? <Banner tone="danger" icon="warning" action={status === 'conflict' ? <Button tone="outline" onClick={() => { setEditing(false); setStatus(''); setMessage(''); setReloadKey((value) => value + 1) }}>{t.noteReload}</Button> : undefined}>{message}</Banner> : null}
      {editing ? <textarea className="note-editor" aria-label={t.editNote} value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck /> : <article className="md">{body}</article>}
    </>
  )
}

const NoteBody = ({ backend, note, notes, paths, onOpen, writable }: { backend: VaultBackend; note: LibNote; notes: LibNote[]; paths: Set<string>; onOpen: (path: string) => void; writable: boolean }) => {
  const { t } = useKanti()
  if (note.kind === 'markdown') return <MarkdownNote backend={backend} note={note} notes={notes} paths={paths} onOpen={onOpen} writable={writable} />
  if (note.kind === 'story') return <StoryView backend={backend} path={note.path} />
  return <BinaryNote backend={backend} note={note} fallback={t.fileOpenFailed} />
}

const BinaryNote = ({ backend, note, fallback }: { backend: VaultBackend; note: LibNote; fallback: string }) => {
  const { t } = useKanti()
  const file = useBytes(backend, note.path)
  const text = useMemo(() => (note.kind === 'famd' ? textOf(file.bytes) ?? '' : ''), [note.kind, file.bytes])
  const image = useMemo(() => (note.kind === 'image' && file.bytes ? bytesToDataUrl(file.bytes, mimeOf(note.path)) : ''), [note.kind, note.path, file.bytes])
  if (file.loading) return <span className="spinner" aria-hidden="true" />
  if (!file.bytes) return <Banner tone="warning" icon="warning">{fallback}</Banner>
  if (note.kind === 'famd') return <InkPages source={text} />
  if (note.kind === 'pdf') return <Suspense fallback={<span className="spinner" aria-hidden="true" />}><PdfViewer bytes={file.bytes} /></Suspense>
  if (note.kind === 'image') return <img className="md-image note-image" src={image} alt={note.name} />
  if (note.kind === 'audio' || note.kind === 'video') return <MediaPlayer bytes={file.bytes} path={note.path} kind={note.kind} />
  return <p className="muted">{t.kindFile}: {note.name}</p>
}

const kindIcon = (kind: LibNote['kind']) => (kind === 'story' || kind === 'markdown' || kind === 'famd' ? 'note' : 'open')

/** The note library of the account's vault: folders, recently edited, search, and a reader for every kind of file. */
export const Notes = () => {
  const kanti = useKanti()
  const { t, language, route } = kanti
  const vault = useVault()
  const backend = vault.backend
  const [entries, setEntries] = useState<VaultEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [sort, setSort] = useState<NoteSort>('recent')
  const [query, setQuery] = useState('')
  const [trash, setTrash] = useState<TrashItem[] | null>(null)
  const [indexing, setIndexing] = useState(false)
  const texts = useRef(new Map<string, string>())
  const [textVersion, setTextVersion] = useState(0)
  const folder = route.params.get('ordner') || ''
  const selectedPath = route.params.get('notiz') || ''

  const load = useCallback(async () => {
    if (!backend) return
    try { setEntries(await backend.list()); setFailed(false) } catch { setFailed(true) }
  }, [backend])
  useEffect(() => { void load() }, [load])

  const notes = useMemo(() => libraryNotes(entries || []), [entries])
  const paths = useMemo(() => new Set((entries || []).map((entry) => entry.path)), [entries])
  const selected = notes.find((note) => note.path === selectedPath) || null
  const go = useCallback((patch: { ordner?: string; notiz?: string }, replace = false) => kanti.navigate('notes', { ordner: patch.ordner ?? folder, notiz: patch.notiz ?? '' }, replace), [kanti, folder])
  const openNote = useCallback((path: string) => kanti.navigate('notes', { ordner: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', notiz: path }), [kanti])

  // The text of the notes is read (and decrypted) once, when the first search needs it.
  useEffect(() => {
    if (!backend || query.trim().length < 2 || !entries) return undefined
    let cancelled = false
    setIndexing(true)
    void buildTextIndex(backend, notes, texts.current, () => cancelled).then(() => { if (!cancelled) { setIndexing(false); setTextVersion((value) => value + 1) } })
    return () => { cancelled = true }
  }, [backend, query, entries, notes])
  const hits = useMemo(() => searchNotes(notes, query, texts.current), [notes, query, textVersion])

  if (vault.mode !== 'ready' || !backend) {
    return <div className="view view-notes"><VaultHint />{vault.mode === 'pair' || vault.mode === 'locked' || vault.mode === 'unavailable' ? null : <Card><Empty icon="note">{vault.mode === 'off' ? t.notesNeedAccount : t.noteOpening}</Empty></Card>}</div>
  }
  const here = folderContents(notes, folder)
  const listed = sortNotes(here.notes, sort)
  const crumbs = folder ? folder.split('/') : []
  const row = (note: LibNote) => (
    <button type="button" key={note.path} className={`note-row${note.path === selectedPath ? ' selected' : ''}`} onClick={() => go({ notiz: note.path }, false)}>
      <Icon name={kindIcon(note.kind)} size={18} />
      <span className="note-row-main"><span className="note-row-title">{note.name}</span><small className="muted">{[note.folder, note.kind === 'markdown' ? '' : kindName(note.kind, t), note.mtimeMs ? dateLabel(new Date(note.mtimeMs).toISOString().slice(0, 10), language, { day: 'numeric', month: 'short', year: 'numeric' }) : ''].filter(Boolean).join(' · ')}</small></span>
    </button>
  )
  const searching = query.trim().length >= 2
  return (
    <div className="view view-notes">
      <div className="columns columns-notes">
        <Card className="notes-library">
          <div className="notes-search">
            <label className="field"><span className="sr-only">{t.searchAllNotes}</span><input type="search" placeholder={t.searchAllNotes} value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t.searchAllNotes} /></label>
            {!searching ? (
              <div className="segments" role="group" aria-label={t.library}>
                <button type="button" className={sort === 'recent' ? 'active' : ''} aria-pressed={sort === 'recent'} onClick={() => setSort('recent')}>{t.recentlyEdited}</button>
                <button type="button" className={sort === 'name' ? 'active' : ''} aria-pressed={sort === 'name'} onClick={() => setSort('name')}>{t.sortName}</button>
              </div>
            ) : null}
          </div>
          {failed ? <Banner tone="warning" icon="warning" action={<Button tone="outline" onClick={() => void load()}>{t.vaultRetry}</Button>}>{t.vaultUnavailable}</Banner> : null}
          {entries === null && !failed ? <span className="spinner" aria-hidden="true" /> : null}
          {searching ? (
            <div className="note-list" aria-label={t.searchAllNotes}>
              {indexing ? <span className="spinner spinner-small" aria-hidden="true" /> : null}
              {hits.length ? hits.map((hit) => <div key={hit.note.path}>{row(hit.note)}{hit.excerpt ? <p className="note-excerpt">{hit.excerpt}</p> : null}</div>) : <Empty icon="search">{t.noMatchingNotes}</Empty>}
            </div>
          ) : (
            <div className="note-list">
              <nav className="crumbs" aria-label={t.library}>
                <button type="button" onClick={() => go({ ordner: '' })}>{t.myNotes}</button>
                {crumbs.map((part, index) => <button type="button" key={index} onClick={() => go({ ordner: crumbs.slice(0, index + 1).join('/') })}>/ {part}</button>)}
              </nav>
              {folder ? <button type="button" className="note-row" onClick={() => go({ ordner: crumbs.slice(0, -1).join('/') })}><Icon name="left" size={18} /><span className="note-row-main"><span className="note-row-title">{t.notesFolderUp}</span></span></button> : null}
              {here.folders.map((name) => {
                const path = folder ? `${folder}/${name}` : name
                return <button type="button" key={path} className="note-row" onClick={() => go({ ordner: path })}><Icon name="folder" size={18} /><span className="note-row-main"><span className="note-row-title">{name}</span><small className="muted">{t.notesCount(countIn(notes, path))}</small></span></button>
              })}
              {listed.map(row)}
              {entries && !here.folders.length && !listed.length ? <Empty icon="note">{folder ? t.nothingHere : t.notesEmptyBody}</Empty> : null}
              <button type="button" className="note-row trash-row" onClick={() => { setTrash(null); void readTrash(backend).then(setTrash) }}><Icon name="delete" size={18} /><span className="note-row-main"><span className="note-row-title">{t.recentlyDeleted}</span></span></button>
              {trash ? (
                <div className="trash-list">
                  <p className="muted small">{t.trashNote}</p>
                  {trash.length ? trash.map((item) => <div key={item.id} className="note-row"><Icon name={item.folder ? 'folder' : 'note'} size={18} /><span className="note-row-main"><span className="note-row-title">{item.name}</span><small className="muted">{item.path}</small></span></div>) : <p className="muted">{t.trashEmpty}</p>}
                </div>
              ) : null}
            </div>
          )}
        </Card>
        <Card className="note-reader">
          {selected ? (
            <>
              <header className="note-head">
                <div><h2>{selected.name}</h2><p className="muted small">{[selected.folder, kindName(selected.kind, t)].filter(Boolean).join(' · ')}</p></div>
                <IconButton icon="close" label={t.close} onClick={() => go({ notiz: '' }, true)} />
              </header>
              <NoteBody key={selected.path} backend={backend} note={selected} notes={notes} paths={paths} onOpen={openNote} writable={vault.actions.writable} />
            </>
          ) : <Empty icon="note">{t.pickNote}</Empty>}
        </Card>
      </div>
    </div>
  )
}

const kindName = (kind: LibNote['kind'], t: ReturnType<typeof useKanti>['t']): ReactNode =>
  ({ markdown: t.kindNote, famd: t.noteHandwriting, pdf: t.kindPdf, image: t.kindImage, audio: t.kindAudio, video: t.kindVideo, story: t.kindStory, other: t.kindFile })[kind]
