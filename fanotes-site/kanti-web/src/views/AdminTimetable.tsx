import { useMemo, useRef, useState } from 'react'
import { ApiError, createAdminApi } from '../lib/api'
import { dateLabel, pickLanguage, STRINGS } from '../lib/i18n'
import type { AdminIndex, AdminUploadResult } from '../lib/timetables'
import { Banner, Button, Card, Logo } from '../components/ui'

/**
 * The operator's page for the school's timetable PDF. Reachable by URL only, works without a
 * Kanti+ session. The token lives in this component's memory and is never stored.
 */
export const AdminTimetable = ({ admin }: { admin?: ReturnType<typeof createAdminApi> }) => {
  const api = useMemo(() => admin || createAdminApi(), [admin])
  const language = pickLanguage('system', typeof navigator === 'undefined' ? [] : navigator.languages || [navigator.language])
  const t = STRINGS[language]
  const [token, setToken] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AdminUploadResult | null>(null)
  const [index, setIndex] = useState<AdminIndex | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const fail = (cause: unknown) => setError(cause instanceof ApiError ? (cause.status === 0 ? t.offline : cause.message) : t.error)
  const show = async () => {
    if (!token.trim()) { setError(t.adminNeedToken); return }
    setBusy(true); setError('')
    try { setIndex(await api.index(token)) } catch (cause) { fail(cause) } finally { setBusy(false) }
  }
  const upload = async () => {
    if (!token.trim()) { setError(t.adminNeedToken); return }
    if (!file) { setError(t.adminNeedFile); return }
    setBusy(true); setError(''); setResult(null)
    try {
      setResult(await api.upload(token, file))
      setIndex(await api.index(token))
      setFile(null)
      if (input.current) input.current.value = ''
    } catch (cause) { fail(cause) } finally { setBusy(false) }
  }

  return (
    <div className="admin-page">
      <header className="admin-head"><Logo size={36} /><h1>{t.adminTitle}</h1></header>
      <Card>
        <p className="muted">{t.adminLead}</p>
        <form className="admin-form" onSubmit={(event) => { event.preventDefault(); void upload() }}>
          <label className="field">
            <span>{t.adminToken}</span>
            <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} spellCheck={false} />
          </label>
          <label className="field">
            <span>{t.adminFile}</span>
            <input ref={input} type="file" accept="application/pdf" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          </label>
          <div className="toolbar-group">
            <Button type="submit" disabled={busy}>{busy ? t.adminUploading : t.adminUpload}</Button>
            <Button type="button" tone="outline" disabled={busy} onClick={() => void show()}>{t.adminShow}</Button>
          </div>
        </form>
        {error ? <Banner tone="danger" icon="warning">{error}</Banner> : null}
        {result ? (
          <Banner icon="info">
            {t.adminDone(result.classes, result.rooms)}
            {result.warnings.length ? <> {t.adminWarnings(result.warningCount ?? result.warnings.length)}: <ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></> : null}
          </Banner>
        ) : null}
      </Card>
      {index ? (
        <Card>
          <h2>{t.adminCurrent}</h2>
          {index.available ? (
            <>
              <p>{t.adminUploadedAt}: {dateLabel((index.uploadedAt || '').slice(0, 10), language)}{index.semester ? ` · ${index.semester}` : ''}</p>
              <p>{t.classesTab}: {index.classes?.length ?? 0} · {t.roomsTab}: {index.rooms ?? 0}</p>
              <p className="muted small">{(index.classes || []).map((item) => item.code).join(', ')}</p>
            </>
          ) : <p className="muted">{t.adminNone}</p>}
        </Card>
      ) : null}
    </div>
  )
}
