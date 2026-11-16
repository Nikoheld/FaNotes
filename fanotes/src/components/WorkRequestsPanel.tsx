import { Bug, Camera, Check, ExternalLink, Lightbulb, LoaderCircle, MessageSquare, Send, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { diagnosticLog } from '../lib/bugReport'
import {
  WORK_REQUEST_DESCRIPTION_MAX, WORK_REQUEST_MESSAGE_MAX, WORK_REQUEST_TITLE_MAX, WorkRequestError, canApprove, canCancel, canMessage,
  ciLabel, describeEvent, draftProblemText, progressPercent, statusInfo, validateDraft,
  type WorkRequest, type WorkRequestDetail, type WorkRequestKind, type WorkRequestPriority, type WorkRequestsClient,
} from '../lib/workRequests'

type Props = {
  client: WorkRequestsClient
  version: string
  platform: string
  onClose: () => void
  onSent?: () => void
}

const errorText = (error: unknown) => error instanceof WorkRequestError || error instanceof Error ? error.message : 'Das hat nicht geklappt.'
const timeText = (at: number) => { const d = new Date(at); return Number.isNaN(d.getTime()) || !at ? '' : d.toLocaleTimeString('de-CH', { timeStyle: 'short' }) }

function StatusChip({ request }: { request: WorkRequest }) {
  const info = statusInfo(request.status, request.cancelled)
  return <span className={`wr-chip is-${info.tone}`} data-status={request.status}>{info.label}</span>
}

export function WorkRequestsPanel({ client, version, platform, onClose, onSent }: Props) {
  const [tab, setTab] = useState<'new' | 'mine'>('new')
  const [hidden, setHidden] = useState(false)
  const [kind, setKind] = useState<WorkRequestKind>('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<WorkRequestPriority>('normal')
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [withLogs, setWithLogs] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requests, setRequests] = useState<WorkRequest[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const canCapture = typeof window !== 'undefined' && typeof window.fanotes?.captureWindow === 'function'

  const loadList = useCallback(async () => {
    try { setRequests(await client.list()) } catch (err) { setError(errorText(err)) }
  }, [client])

  useEffect(() => {
    if (tab !== 'mine' || selected) return undefined
    void loadList()
    const timer = setInterval(() => void loadList(), 5000)
    return () => clearInterval(timer)
  }, [tab, selected, loadList])

  const capture = async () => {
    setError(null)
    setHidden(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 160))
      setScreenshot(await window.fanotes.captureWindow!())
    } catch { setError('Der Screenshot konnte nicht aufgenommen werden.') } finally { setHidden(false) }
  }

  const send = async () => {
    const draft = { kind, title, description, priority, screenshot, logs: withLogs ? diagnosticLog.snapshot() : null, version, platform }
    const problem = validateDraft(draft)
    if (problem) { setError(draftProblemText(problem)); return }
    setBusy(true)
    setError(null)
    try {
      const created = await client.create(draft)
      setTitle(''); setDescription(''); setScreenshot(null); setWithLogs(false)
      onSent?.()
      setSelected(created.id || null)
      setTab('mine')
    } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }

  return (
    <div className="modal-backdrop" onPointerDown={onClose} style={hidden ? { visibility: 'hidden' } : undefined}>
      <section className="settings-modal bug-report-modal work-requests-modal" role="dialog" aria-modal="true" aria-label="Fehler & Wünsche" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
        <header className="settings-header">
          <div className="settings-heading">
            <Bug size={18} />
            <div>
              <strong>Fehler &amp; Wünsche</strong>
              <small>Beschreibe einen Fehler oder eine Funktion. Claude arbeitet daran und zeigt dir hier den Fortschritt.</small>
            </div>
          </div>
          <button type="button" className="icon-button" aria-label="Schließen" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="wr-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? 'is-active' : ''} onClick={() => { setTab('new'); setError(null) }}>Neu</button>
          <button type="button" role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'is-active' : ''} onClick={() => { setTab('mine'); setSelected(null); setError(null) }}>Meine Anfragen</button>
        </div>
        <div className="settings-body bug-report-body">
          {tab === 'new' ? (
            <>
              <div className="wr-kind" role="radiogroup" aria-label="Art der Anfrage">
                <button type="button" role="radio" aria-checked={kind === 'bug'} className={kind === 'bug' ? 'is-active' : ''} onClick={() => setKind('bug')}><Bug size={14} />Fehler</button>
                <button type="button" role="radio" aria-checked={kind === 'feature'} className={kind === 'feature' ? 'is-active' : ''} onClick={() => setKind('feature')}><Lightbulb size={14} />Funktion</button>
              </div>
              <label className="bug-report-label" htmlFor="wr-title">Titel</label>
              <input id="wr-title" className="wr-input" value={title} maxLength={WORK_REQUEST_TITLE_MAX} onChange={(event) => setTitle(event.target.value)} placeholder="Kurz in einem Satz" />
              <label className="bug-report-label" htmlFor="wr-description">{kind === 'bug' ? 'Was ist passiert?' : 'Was soll FaNotes können?'}</label>
              <textarea id="wr-description" value={description} rows={5} maxLength={WORK_REQUEST_DESCRIPTION_MAX} onChange={(event) => setDescription(event.target.value)} placeholder="So genau wie möglich: wo, wann, was du erwartet hast." />
              <div className="wr-row">
                <label className="bug-report-label" htmlFor="wr-priority">Priorität</label>
                <select id="wr-priority" className="wr-input" value={priority} onChange={(event) => setPriority(event.target.value as WorkRequestPriority)}>
                  <option value="low">Niedrig</option><option value="normal">Normal</option><option value="high">Hoch</option>
                </select>
              </div>
              <div className="wr-attach">
                {canCapture && (screenshot
                  ? <span className="wr-attached"><img src={screenshot} alt="Screenshot-Vorschau" /><button type="button" className="secondary-button" onClick={() => setScreenshot(null)}>Screenshot entfernen</button></span>
                  : <button type="button" className="secondary-button" onClick={() => void capture()}><Camera size={14} />Screenshot anhängen</button>)}
                <label className="wr-check"><input type="checkbox" checked={withLogs} onChange={(event) => setWithLogs(event.target.checked)} />Protokoll der letzten fünf Minuten anhängen</label>
              </div>
              {error && <div className="settings-inline-error" role="alert">{error}</div>}
              <div className="bug-report-actions">
                <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Schließen</button>
                <button type="button" className="primary-button" disabled={busy || !title.trim() || !description.trim()} onClick={() => void send()}>
                  {busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}{busy ? 'Wird gesendet …' : 'Anfrage senden'}
                </button>
              </div>
            </>
          ) : selected ? (
            <RequestDetail client={client} id={selected} onBack={() => { setSelected(null); void loadList() }} />
          ) : (
            <>
              {error && <div className="settings-inline-error" role="alert">{error}</div>}
              {requests === null ? <div className="wr-empty"><LoaderCircle className="spin" size={16} /> Wird geladen …</div>
                : requests.length === 0 ? <div className="wr-empty">Noch keine Anfragen.</div>
                : <ul className="wr-list">{requests.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="wr-item" onClick={() => setSelected(item.id)}>
                      {item.kind === 'feature' ? <Lightbulb size={15} /> : <Bug size={15} />}
                      <span className="wr-item-title">{item.title}</span>
                      <StatusChip request={item} />
                    </button>
                  </li>))}</ul>}
            </>
          )}
        </div>
      </section>
    </div>
  )
}

function RequestDetail({ client, id, onBack }: { client: WorkRequestsClient; id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<WorkRequestDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [messageOpen, setMessageOpen] = useState(false)
  const endRef = useRef<HTMLLIElement | null>(null)

  useEffect(() => client.subscribe(id, (next) => { setDetail(next); setError(null) }, (err) => setError(errorText(err))), [client, id])
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'nearest' }) }, [detail?.events.length])

  const act = async (run: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await run(); const fresh = await client.detail(id); setDetail((current) => current ? { ...current, request: fresh } : current) } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }

  if (!detail) return <div className="wr-empty">{error ? <span role="alert">{error}</span> : <><LoaderCircle className="spin" size={16} /> Wird geladen …</>}</div>
  const { request, events } = detail
  const shown = events.map((event) => ({ event, text: describeEvent(event) })).filter((entry): entry is { event: typeof entry.event; text: string } => entry.text !== null)
  const percent = progressPercent(request, events)
  return (
    <div className="wr-detail">
      <button type="button" className="secondary-button wr-back" onClick={onBack}>Zurück</button>
      <div className="wr-detail-head">
        <strong>{request.title}</strong>
        <StatusChip request={request} />
      </div>
      <p className="wr-desc">{request.description}</p>
      {percent !== null && (
        <div className="wr-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>
      )}
      {request.approved && request.status === 'waiting_for_you' && <div className="wr-note" role="status">Freigegeben. Claude übernimmt die Änderung, sobald die Prüfung bestanden ist.</div>}
      {request.reason && <div className="settings-inline-error" role="status">{request.reason}</div>}
      {request.pr && (
        <a className="wr-pr" href={request.pr.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} />Änderung #{request.pr.number}{ciLabel(request.pr.ci) ? ` · Prüfung: ${ciLabel(request.pr.ci)}` : ''}</a>
      )}
      <ol className="wr-timeline" aria-label="Fortschritt">
        {shown.map(({ event, text }) => (
          <li key={event.seq}><time>{timeText(event.at)}</time><span>{text}</span>{event.percent !== null && <em>{event.percent} %</em>}</li>
        ))}
        <li ref={endRef} aria-hidden="true" className="wr-end" />
      </ol>
      {error && <div className="settings-inline-error" role="alert">{error}</div>}
      {messageOpen && canMessage(request.status) && (
        <div className="wr-message">
          <textarea value={note} rows={3} maxLength={WORK_REQUEST_MESSAGE_MAX} aria-label="Nachricht an Claude" placeholder="Zusätzlicher Hinweis für Claude" onChange={(event) => setNote(event.target.value)} />
          <button type="button" className="primary-button" disabled={busy || !note.trim()} onClick={() => void act(async () => { await client.message(id, note); setNote(''); setMessageOpen(false) })}><Send size={14} />Senden</button>
        </div>
      )}
      <div className="bug-report-actions">
        {canCancel(request.status) && <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(() => client.cancel(id))}>Abbrechen</button>}
        {canMessage(request.status) && <button type="button" className="secondary-button" disabled={busy} onClick={() => setMessageOpen((open) => !open)}><MessageSquare size={14} />Nachricht</button>}
        {canApprove(request.status, request.approved) && <button type="button" className="primary-button" disabled={busy} onClick={() => void act(() => client.approve(id))}><Check size={14} />Übernehmen</button>}
      </div>
    </div>
  )
}
