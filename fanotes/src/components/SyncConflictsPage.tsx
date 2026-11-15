import { ArrowLeft, Check, CheckCircle2, CloudOff, Copy, FileText, Image as ImageIcon, LoaderCircle, PenLine, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getUiLanguage, getUiLocale } from '../i18n'
import { createMarkerCoverage, drawInkStroke } from '../lib/inkStrokePaint'
import { conflictFingerprint, type ConflictGroup, type ConflictKeep } from '../lib/sync/conflicts'
import { changedLines, previewOfVersion, type ConflictPreview } from '../lib/sync/conflictPreview'
import type { SyncEngine, SyncPublicState } from '../lib/sync/engine'
import { parseInkPreviewPage } from './InkPreviewLayer'
import './syncConflicts.css'

/** German or English, chosen when rendering: most lines here carry names, dates or counts. */
const L = (de: string, en: string) => (getUiLanguage() === 'en' ? en : de)

type Side = 'original' | 'copy'
type Loaded = {
  group: ConflictGroup
  previews: Record<Side, ConflictPreview>
  expected: Record<string, string | null>
}
type Notice = { kind: 'success' | 'error' | 'info'; text: string } | null

const formatWhen = (value: string | number | null | undefined) => {
  if (value === null || value === undefined || value === '') return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return date.toLocaleString(getUiLocale(), { dateStyle: 'medium', timeStyle: 'short' })
}

const formatBytes = (bytes: number) => (bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`)
const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const count = (value: number, one: [string, string], many: [string, string]) => `${value.toLocaleString(getUiLocale())} ${value === 1 ? L(...one) : L(...many)}`

const lineClass = (line: string) => (
  /^#{1,2}\s/u.test(line) ? 'is-heading'
    : /^#{3,6}\s/u.test(line) ? 'is-subheading'
      : /^\s*(?:[-*+]|\d+[.)])\s/u.test(line) ? 'is-item'
        : /^>\s?/u.test(line) ? 'is-quote'
          : line.trim() ? '' : 'is-blank'
)
const lineText = (line: string) => line.replace(/^#{1,6}\s+/u, '').replace(/^>\s?/u, '').replace(/\*\*(.+?)\*\*/gu, '$1').replace(/(^|\s)[*_](.+?)[*_](?=\s|$)/gu, '$1$2')

/** The page's handwriting, painted at the column width. */
function InkThumbnail({ inkJson, label }: { inkJson: string; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const page = useMemo(() => parseInkPreviewPage(inkJson), [inkJson])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !page) return
    const paint = () => {
      const cssWidth = Math.max(120, canvas.parentElement?.clientWidth ?? 360)
      const ratio = Math.min(2, window.devicePixelRatio || 1)
      const scale = cssWidth / page.width
      const cssHeight = Math.min(page.height * scale, 4000)
      const width = Math.round(cssWidth * ratio)
      const height = Math.round(cssHeight * ratio)
      canvas.width = width
      canvas.height = height
      canvas.style.height = `${Math.round(cssHeight)}px`
      const context = canvas.getContext('2d')
      if (!context) return
      context.clearRect(0, 0, width, height)
      const coverage = createMarkerCoverage(width, height)
      const fullHeight = Math.round(page.height * scale * ratio)
      for (const stroke of page.strokes) {
        drawInkStroke(context, stroke, width, fullHeight, 0.5, 1, page.width, page.width, stroke.points.length, { coverage, stamp: true })
      }
    }
    paint()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => paint()) : null
    if (canvas.parentElement) observer?.observe(canvas.parentElement)
    return () => observer?.disconnect()
  }, [page])
  if (!page) return null
  return <div className="conflict-ink"><canvas ref={canvasRef} role="img" aria-label={label} /></div>
}

/** First page of a PDF, rendered with the app's PDF engine. */
function PdfThumbnail({ bytes }: { bytes: Uint8Array }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [pages, setPages] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    let destroy: (() => Promise<void>) | null = null
    void (async () => {
      try {
        const { openPdfDocument } = await import('../lib/pdfDocument')
        const { pdf, task } = await openPdfDocument(bytes.slice())
        destroy = () => task.destroy()
        if (!alive) return
        setPages(pdf.numPages)
        const page = await pdf.getPage(1)
        const canvas = canvasRef.current
        if (!canvas || !alive) return
        const cssWidth = Math.max(120, canvas.parentElement?.clientWidth ?? 360)
        const base = page.getViewport({ scale: 1 })
        const ratio = Math.min(2, window.devicePixelRatio || 1)
        const viewport = page.getViewport({ scale: (cssWidth / base.width) * ratio })
        canvas.width = Math.round(viewport.width)
        canvas.height = Math.round(viewport.height)
        canvas.style.height = `${Math.round(viewport.height / ratio)}px`
        const context = canvas.getContext('2d')
        if (!context) return
        await page.render({ canvasContext: context, viewport, canvas } as Parameters<typeof page.render>[0]).promise
      } catch {
        if (alive) setFailed(true)
      }
    })()
    return () => {
      alive = false
      void destroy?.().catch(() => undefined)
    }
  }, [bytes])
  if (failed) return <p className="conflict-empty">{L('Die PDF konnte nicht angezeigt werden.', 'The PDF could not be shown.')}</p>
  return (
    <div className="conflict-pdf">
      <canvas ref={canvasRef} role="img" aria-label={L('Erste Seite der PDF', 'First page of the PDF')} />
      {pages !== null && <small>{count(pages, ['Seite', 'page'], ['Seiten', 'pages'])}</small>}
    </div>
  )
}

function ImagePreview({ bytes, mime }: { bytes: Uint8Array; mime: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes.slice()], { type: mime })), [bytes, mime])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return <img className="conflict-image" src={url} alt={L('Bildvorschau', 'Image preview')} />
}

function PreviewBody({ preview, changed, highlight }: { preview: ConflictPreview; changed: Set<number>; highlight: boolean }) {
  switch (preview.kind) {
    case 'missing':
      return <p className="conflict-empty">{L('Diese Datei gibt es nicht mehr. Es ist nur die andere Fassung übrig.', 'This file no longer exists. Only the other version is left.')}</p>
    case 'damaged':
      return <p className="conflict-empty is-warning"><TriangleAlert size={14} /> {L('Diese Fassung ist beschädigt und kann nicht angezeigt werden. Behalte die andere oder beide.', 'This version is damaged and cannot be shown. Keep the other one or both.')}</p>
    case 'binary':
      return <p className="conflict-empty">{L('Für diesen Dateityp gibt es keine Vorschau.', 'There is no preview for this file type.')}</p>
    case 'pdf':
      return <PdfThumbnail bytes={preview.bytes} />
    case 'image':
      return <ImagePreview bytes={preview.bytes} mime={preview.mime} />
    case 'ink':
      return preview.inkJson
        ? <InkThumbnail inkJson={preview.inkJson} label={L('Handschrift', 'Handwriting')} />
        : <p className="conflict-empty">{L('Keine Handschrift auf dieser Seite.', 'No handwriting on this page.')}</p>
    case 'text':
    case 'note': {
      const lines = preview.lines
      return (
        <>
          {preview.kind === 'note' && preview.inkJson && <InkThumbnail inkJson={preview.inkJson} label={L('Handschrift dieser Fassung', 'Handwriting of this version')} />}
          {lines.length ? (
            <div className={`conflict-text ${preview.kind === 'text' ? 'is-plain' : ''}`}>
              {lines.map((line, index) => (
                <div key={index} className={`conflict-line ${preview.kind === 'note' ? lineClass(line) : ''} ${highlight && changed.has(index) ? 'is-changed' : ''}`}>
                  {(preview.kind === 'note' ? lineText(line) : line) || ' '}
                </div>
              ))}
            </div>
          ) : (
            !(preview.kind === 'note' && preview.inkJson) && <p className="conflict-empty">{L('Kein Text.', 'No text.')}</p>
          )}
        </>
      )
    }
  }
}

const facts = (preview: ConflictPreview) => {
  const out: string[] = []
  if (preview.kind === 'note') {
    out.push(count(preview.words, ['Wort', 'word'], ['Wörter', 'words']))
    if (preview.strokes) out.push(count(preview.strokes, ['Strich', 'stroke'], ['Striche', 'strokes']))
    if (preview.textFields) out.push(count(preview.textFields, ['Textfeld', 'text box'], ['Textfelder', 'text boxes']))
  }
  if (preview.kind === 'ink') out.push(count(preview.strokes, ['Strich', 'stroke'], ['Striche', 'strokes']))
  if (preview.kind === 'text') out.push(count(preview.lines.length, ['Zeile', 'line'], ['Zeilen', 'lines']))
  if (preview.kind !== 'missing') out.push(formatBytes(preview.size))
  return out
}

export function SyncConflictsPage({ engine, syncState }: { engine: SyncEngine; syncState: SyncPublicState }) {
  const [groups, setGroups] = useState<ConflictGroup[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [highlight, setHighlight] = useState(true)
  const [confirm, setConfirm] = useState<ConflictKeep | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const signedIn = Boolean(syncState.account)
  const online = syncState.status !== 'offline'

  const refresh = useCallback(async () => {
    try {
      const next = await engine.listConflicts()
      setGroups(next)
      setListError(null)
      return next
    } catch (error) {
      setListError(error instanceof Error ? error.message : L('Die Konflikte konnten nicht gelesen werden.', 'The conflicts could not be read.'))
      setGroups([])
      return []
    }
  }, [engine])

  useEffect(() => { void refresh() }, [refresh, syncState.lastSyncAt, syncState.openConflicts])

  const selected = useMemo(() => groups?.find((group) => group.id === selectedId) ?? null, [groups, selectedId])

  const loadVersions = useCallback(async (group: ConflictGroup) => {
    setLoadingVersions(true)
    setConfirm(null)
    try {
      const expected: Record<string, string | null> = {}
      const original = []
      const copy = []
      for (const pair of group.pairs) {
        const [originalBytes, copyBytes] = await Promise.all([engine.readConflictFile(pair.path), engine.readConflictFile(pair.copyPath)])
        expected[pair.path] = await conflictFingerprint(pair.path, originalBytes)
        expected[pair.copyPath] = await conflictFingerprint(pair.copyPath, copyBytes)
        original.push({ path: pair.path, bytes: originalBytes })
        copy.push({ path: pair.path, bytes: copyBytes })
      }
      setLoaded({ group, expected, previews: { original: previewOfVersion(original), copy: previewOfVersion(copy) } })
    } finally {
      setLoadingVersions(false)
    }
  }, [engine])

  useEffect(() => {
    if (!selected) {
      setLoaded(null)
      return
    }
    if (loaded?.group.id === selected.id) return
    void loadVersions(selected)
  }, [selected, loaded?.group.id, loadVersions])

  const diff = useMemo(() => {
    if (!loaded) return { left: new Set<number>(), right: new Set<number>() }
    const left = loaded.previews.original
    const right = loaded.previews.copy
    const linesOf = (preview: ConflictPreview) => (preview.kind === 'note' || preview.kind === 'text' ? preview.lines : [])
    return changedLines(linesOf(left), linesOf(right))
  }, [loaded])

  const resolve = async (keep: ConflictKeep) => {
    if (!loaded) return
    setBusy(true)
    setNotice(null)
    const { group } = loaded
    try {
      const result = await engine.resolveConflict(group, keep, loaded.expected)
      if (result.status === 'changed') {
        setNotice({ kind: 'info', text: L('Eine der beiden Fassungen hat sich inzwischen geändert. Die Vorschau ist neu geladen – vergleiche bitte noch einmal.', 'One of the versions changed in the meantime. The preview has been reloaded; please compare again.') })
        const next = await refresh()
        const again = next.find((candidate) => candidate.id === group.id)
        if (again) await loadVersions(again)
        else setSelectedId(null)
        return
      }
      setNotice({
        kind: 'success',
        text: keep === 'copy'
          ? L(`„${group.title}“: die Fassung von ${group.device ?? 'dem anderen Gerät'} gilt jetzt auf allen Geräten.`, `“${group.title}”: the version from ${group.device ?? 'the other device'} now applies on all devices.`)
          : keep === 'original'
            ? L(`„${group.title}“: die bisherige Fassung bleibt. Die Kopie wurde auf allen Geräten entfernt.`, `“${group.title}”: the current version stays. The copy was removed on all devices.`)
            : L(`„${group.title}“: beide Fassungen bleiben als eigene Dateien.`, `“${group.title}”: both versions stay as separate files.`),
      })
      setSelectedId(null)
      setLoaded(null)
      await refresh()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : L('Der Konflikt konnte nicht gelöst werden. Beide Fassungen sind noch da.', 'The conflict could not be resolved. Both versions are still there.') })
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  const noticeBanner = notice && (
    <div className={`conflict-notice is-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      {notice.kind === 'success' ? <CheckCircle2 size={15} /> : notice.kind === 'error' ? <TriangleAlert size={15} /> : <RefreshCw size={15} />}
      <span data-i18n-ignore>{notice.text}</span>
    </div>
  )

  const blocked = !signedIn
    ? L('Melde dich unter „Sync“ an, um Konflikte zu lösen. Bis dahin bleiben beide Fassungen erhalten.', 'Sign in under “Sync” to resolve conflicts. Until then both versions are kept.')
    : !online
      ? L('Offline. Konflikte lassen sich lösen, sobald die Verbindung zurück ist; die Entscheidung wird sofort hochgeladen.', 'Offline. Conflicts can be resolved once the connection is back; the decision is uploaded right away.')
      : null

  if (!selected || !loaded) {
    return (
      <div className="conflicts-page" data-i18n-ignore>
        {noticeBanner}
        <div className="setting-card conflicts-intro">
          <div className="setting-card-title"><ShieldCheck size={16} /><span>{L('So entstehen Konflikte', 'How conflicts happen')}</span></div>
          <p>{L(
            'Zwei Geräte haben dieselbe Datei geändert, bevor sie sich abgleichen konnten. Dann geht keine Fassung verloren: die eine behält den Namen, die andere liegt als „Konflikt“-Kopie daneben. Vergleiche beide und entscheide, welche gilt – die Wahl wird hochgeladen und auf allen Geräten übernommen.',
            'Two devices changed the same file before they could sync. No version is lost: one keeps the name, the other is kept next to it as a “Konflikt” copy. Compare them and choose which one applies; your choice is uploaded and applied on all devices.',
          )}</p>
        </div>
        {blocked && <div className="conflict-notice is-info"><CloudOff size={15} /><span>{blocked}</span></div>}
        <div className="setting-card">
          <div className="setting-card-title">
            <TriangleAlert size={16} />
            <span>{groups === null ? L('Konflikte werden gesucht …', 'Looking for conflicts …') : groups.length ? count(groups.length, ['offener Konflikt', 'open conflict'], ['offene Konflikte', 'open conflicts']) : L('Keine Konflikte', 'No conflicts')}</span>
            <button type="button" className="sync-card-action" onClick={() => void refresh()} disabled={groups === null}><RefreshCw size={13} /> {L('Neu suchen', 'Check again')}</button>
          </div>
          {listError && <p className="conflict-empty is-warning">{listError}</p>}
          {groups === null && <p className="conflict-empty"><LoaderCircle className="spin" size={14} /> {L('Der Vault wird durchsucht …', 'Searching the vault …')}</p>}
          {groups?.length === 0 && !listError && (
            <p className="conflict-empty is-done"><CheckCircle2 size={15} /> {L('Alle Dateien haben nur eine Fassung. Es gibt nichts zu entscheiden.', 'Every file has a single version. There is nothing to decide.')}</p>
          )}
          {groups && groups.length > 0 && (
            <ul className="conflict-list">
              {groups.map((group) => (
                <li key={group.id}>
                  <button type="button" onClick={() => { setNotice(null); setSelectedId(group.id) }}>
                    <span className="conflict-list-icon">{group.internal ? <PenLine size={16} /> : /\.pdf$/iu.test(group.path) ? <FileText size={16} /> : /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/iu.test(group.path) ? <ImageIcon size={16} /> : <FileText size={16} />}</span>
                    <span className="conflict-list-copy">
                      <strong>{group.internal ? L('Handschrift-Daten', 'Handwriting data') : group.title}</strong>
                      <small>
                        {[folderOf(group.path) || L('Vault', 'Vault'), group.device ? L(`Kopie von ${group.device}`, `copy from ${group.device}`) : null, formatWhen(group.at)].filter(Boolean).join(' · ')}
                      </small>
                    </span>
                    <span className="conflict-list-action">{L('Vergleichen', 'Compare')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {selectedId && loadingVersions && <p className="conflict-empty"><LoaderCircle className="spin" size={14} /> {L('Beide Fassungen werden geladen …', 'Loading both versions …')}</p>}
      </div>
    )
  }

  const { group, previews } = loaded
  const sides: Array<{ side: Side; keep: ConflictKeep; title: string; detail: string; preview: ConflictPreview; changed: Set<number> }> = [
    {
      side: 'original',
      keep: 'original',
      title: L('Bisherige Fassung', 'Current version'),
      detail: [L(`unter „${group.path.slice(group.path.lastIndexOf('/') + 1)}“`, `saved as “${group.path.slice(group.path.lastIndexOf('/') + 1)}”`), formatWhen(group.files?.[group.path]?.mtimeMs)].filter(Boolean).join(' · '),
      preview: previews.original,
      changed: diff.left,
    },
    {
      side: 'copy',
      keep: 'copy',
      title: group.device ? L(`Fassung von ${group.device}`, `Version from ${group.device}`) : L('Fassung aus der Konfliktkopie', 'Version from the conflict copy'),
      detail: [L('als Konfliktkopie gesichert', 'kept as a conflict copy'), formatWhen(group.at)].filter(Boolean).join(' · '),
      preview: previews.copy,
      changed: diff.right,
    },
  ]
  const textual = (preview: ConflictPreview) => preview.kind === 'note' || preview.kind === 'text'
  const identicalText = textual(previews.original) && textual(previews.copy) && diff.left.size === 0 && diff.right.size === 0
  const confirmText = confirm === 'copy'
    ? L(`Die Fassung von ${group.device ?? 'der Kopie'} wird hochgeladen und ersetzt „${group.title}“ auf allen Geräten. Die bisherige Fassung bleibt im Archiv des Sync-Servers${window.fanotes?.platform !== 'web' ? ' und landet auf diesem Computer im Papierkorb' : ''}.`, `The version from ${group.device ?? 'the copy'} is uploaded and replaces “${group.title}” on all devices. The current version stays in the sync server's archive${window.fanotes?.platform !== 'web' ? ' and goes to this computer’s trash' : ''}.`)
    : confirm === 'original'
      ? L(`„${group.title}“ bleibt, wie es ist. Die Konfliktkopie wird auf allen Geräten entfernt; sie bleibt im Archiv des Sync-Servers${window.fanotes?.platform !== 'web' ? ' und im Papierkorb dieses Computers' : ''}.`, `“${group.title}” stays as it is. The conflict copy is removed on all devices; it stays in the sync server's archive${window.fanotes?.platform !== 'web' ? ' and in this computer’s trash' : ''}.`)
      : L('Beide Fassungen bleiben. Die Kopie heisst danach „… (Fassung …)“ und ist eine normale Datei.', 'Both versions stay. The copy is renamed “… (Fassung …)” and becomes an ordinary file.')

  return (
    <div className="conflicts-page is-detail" data-i18n-ignore>
      <div className="conflict-detail-head">
        <button type="button" className="secondary-button" onClick={() => { setSelectedId(null); setConfirm(null) }} disabled={busy}><ArrowLeft size={14} /> {L('Alle Konflikte', 'All conflicts')}</button>
        <div>
          <h3>{group.internal ? L('Handschrift-Daten', 'Handwriting data') : group.title}</h3>
          <small>{group.pairs.map((pair) => pair.path).join(' · ')}</small>
        </div>
      </div>
      {noticeBanner}
      {blocked && <div className="conflict-notice is-info"><CloudOff size={15} /><span>{blocked}</span></div>}
      <div className="conflict-toolbar">
        <label className="conflict-toggle">
          <input type="checkbox" checked={highlight} onChange={(event) => setHighlight(event.target.checked)} />
          <span>{L('Unterschiede markieren', 'Highlight differences')}</span>
        </label>
        {identicalText && <small>{L('Der Text ist gleich. Die Fassungen unterscheiden sich in Handschrift, Feldern oder Formatierung.', 'The text is the same. The versions differ in handwriting, fields or formatting.')}</small>}
      </div>
      <div className="conflict-compare">
        {sides.map(({ side, keep, title, detail, preview, changed }) => (
          <section key={side} className={`conflict-version is-${side}`} aria-label={title}>
            <header>
              <span className="conflict-version-badge">{side === 'original' ? 'A' : 'B'}</span>
              <div>
                <strong>{title}</strong>
                <small>{detail}</small>
              </div>
            </header>
            <div className="conflict-facts">{facts(preview).map((fact) => <span key={fact}>{fact}</span>)}</div>
            <div className="conflict-preview" tabIndex={0} aria-label={L(`Vorschau: ${title}`, `Preview: ${title}`)}>
              <PreviewBody preview={preview} changed={changed} highlight={highlight} />
            </div>
            <button
              type="button"
              className={`primary-button conflict-keep ${confirm === keep ? 'is-armed' : ''}`}
              disabled={busy || Boolean(blocked) || preview.kind === 'missing' || preview.kind === 'damaged'}
              onClick={() => setConfirm(keep)}
            >
              <Check size={15} /> {L('Diese Fassung behalten', 'Keep this version')}
            </button>
          </section>
        ))}
      </div>
      <div className="conflict-both">
        <button type="button" className="secondary-button" disabled={busy || Boolean(blocked) || previews.copy.kind === 'missing'} onClick={() => setConfirm('both')}><Copy size={14} /> {L('Beide behalten', 'Keep both')}</button>
        <small>{L('Wenn beide Fassungen etwas Wichtiges enthalten.', 'When both versions contain something important.')}</small>
      </div>
      {confirm && (
        <div className="conflict-confirm" role="alertdialog" aria-label={L('Entscheidung bestätigen', 'Confirm your choice')}>
          <p>{confirmText}</p>
          <div>
            <button type="button" className="secondary-button" onClick={() => setConfirm(null)} disabled={busy}>{L('Abbrechen', 'Cancel')}</button>
            <button type="button" className="primary-button" onClick={() => void resolve(confirm)} disabled={busy}>
              {busy ? <><LoaderCircle className="spin" size={15} /> {L('Wird abgeglichen und hochgeladen …', 'Syncing and uploading …')}</> : <><Check size={15} /> {confirm === 'both' ? L('Beide behalten', 'Keep both') : L('So übernehmen', 'Apply')}</>}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default SyncConflictsPage
