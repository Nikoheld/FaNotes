import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../lib/api'
import { deriveAuthKey, kdfSupported } from '../lib/auth'
import { useKanti } from '../state'
import { Banner, Button, Card, Icon, Logo, type IconName } from '../components/ui'

/** Shows a pairing code, waits for the app to approve it, then reports how many connections came. */
export const PairingPanel = ({ onDone }: { onDone: (added: number) => void | Promise<void> }) => {
  const { api, t } = useKanti()
  const [code, setCode] = useState('')
  const [expiresAt, setExpiresAt] = useState(0)
  const [state, setState] = useState<'idle' | 'waiting' | 'expired' | 'error'>('idle')
  const [failure, setFailure] = useState('')
  const [now, setNow] = useState(Date.now())
  const finished = useRef(false)

  const begin = async () => {
    try {
      const started = await api.startPairing()
      setCode(started.code)
      setExpiresAt(Date.parse(started.expiresAt))
      setState('waiting')
    } catch (error) {
      setFailure(error instanceof ApiError ? (error.status === 0 ? t.reasonOffline : t.failureReason(error.message, error.status)) : error instanceof Error ? error.message : t.error)
      setState('error')
    }
  }

  useEffect(() => { void begin() }, [])

  useEffect(() => {
    if (state !== 'waiting') return
    let stopped = false
    const tick = async () => {
      setNow(Date.now())
      try {
        const status = await api.pairingStatus()
        if (stopped) return
        if (status.status === 'approved' && !finished.current) {
          finished.current = true
          await onDone(status.added || 0)
          return
        }
        if (status.status === 'expired') { setState('expired'); return }
      } catch { /* try again on the next tick */ }
      if (!stopped) window.setTimeout(tick, 2000)
    }
    const timer = window.setTimeout(tick, 1500)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [state])

  useEffect(() => () => { if (!finished.current) void api.cancelPairing().catch(() => undefined) }, [])

  const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000))
  return (
    <div className="pairing">
      {state === 'waiting' || state === 'expired' ? (
        <>
          <p className="pairing-code tabular" aria-live="polite" aria-label={code.split('').join(' ')}>{code}</p>
          <p className="pairing-steps">{t.pairSteps}</p>
          {state === 'waiting' ? <p className="muted small"><span className="spinner" aria-hidden="true" /> {t.pairWaiting} · {t.pairExpires(minutes)}</p> : (
            <Banner tone="warning" icon="warning" action={<Button tone="outline" onClick={() => { setState('idle'); void begin() }}>{t.pairNew}</Button>}>{t.pairExpired}</Banner>
          )}
          <p className="muted small">{t.pairNeedsApp}</p>
        </>
      ) : state === 'error' ? (
        <Banner tone="danger" icon="warning" action={<Button tone="outline" onClick={() => void begin()}>{t.tryAgain}</Button>}>{failure || t.error}</Banner>
      ) : <p className="muted"><span className="spinner" aria-hidden="true" /></p>}
    </div>
  )
}

/** The other direction: the app shows a code, the user types it here. */
export const ClaimCode = ({ onDone }: { onDone: (added: number) => void | Promise<void> }) => {
  const { api, t } = useKanti()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const cleaned = code.toUpperCase().replace(/[^0-9A-Z]/gu, '')
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const claimed = await api.claimPairing(cleaned)
      setCode('')
      await onDone(claimed.added || 0)
    } catch (failure) {
      setError(failure instanceof ApiError ? (failure.status === 0 ? t.reasonOffline : failure.message) : failure instanceof Error ? failure.message : t.error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="form claim-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <label className="field">
        <span className="field-label">{t.claimTitle}</span>
        <input inputMode="text" autoCapitalize="characters" autoComplete="one-time-code" spellCheck={false} maxLength={11} placeholder={t.claimHint} value={code} onChange={(event) => setCode(event.target.value)} />
      </label>
      <p className="muted small">{t.claimSteps}</p>
      {error ? <Banner tone="danger" icon="warning">{error}</Banner> : null}
      <Button type="submit" icon="phone" disabled={busy || cleaned.length !== 8}>{t.claimButton}</Button>
    </form>
  )
}

const FaNotesLogin = () => {
  const kanti = useKanti()
  const { api, t } = kanti
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const { kdf } = await api.prelogin(email.trim())
      if (!kdfSupported(kdf)) throw new Error(t.error)
      const authKey = await deriveAuthKey(password, kdf)
      await api.login(email.trim(), authKey)
      setPassword('')
      await kanti.start()
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 401 ? t.wrongLogin : failure instanceof Error ? failure.message : t.error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <label className="field"><span className="field-label">{t.email}</span><input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label className="field"><span className="field-label">{t.password}</span><input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {error ? <Banner tone="danger" icon="warning">{error}</Banner> : null}
      <Button type="submit" icon="key" disabled={busy || !email || !password}>{busy ? t.signingIn : t.signIn}</Button>
    </form>
  )
}

const BENEFIT_ICONS: IconName[] = ['timetable', 'refresh', 'key']

export const SignIn = () => {
  const kanti = useKanti()
  const { t } = kanti
  const [pairing, setPairing] = useState(false)
  const [approved, setApproved] = useState(0)
  const paired = async (added: number) => { setApproved(added); setPairing(false); await kanti.start() }
  return (
    <div className="signin">
      <aside className="signin-brand">
        <div className="signin-brand-inner">
          <div className="signin-wordmark"><Logo size={44} /><span>Kanti+</span></div>
          <div className="signin-pitch">
            <h1>{t.signInTitle}</h1>
            <p className="lead">{t.signInLead}</p>
            <ul className="signin-benefits">
              {t.signInBenefits.map((benefit, index) => <li key={benefit}><span className="signin-benefit-icon"><Icon name={BENEFIT_ICONS[index] ?? 'check'} size={20} /></span><span>{benefit}</span></li>)}
            </ul>
          </div>
          <div className="signin-brand-actions">
            <Button tone="outline" icon="play" className="signin-demo" onClick={kanti.startDemo}>{t.demoTitle}</Button>
            <a className="signin-about" href="/about/">{t.aboutKanti}<Icon name="forward" size={16} /></a>
          </div>
          <p className="signin-brand-note">{t.demoBody}</p>
        </div>
      </aside>
      <main className="signin-main">
        <div className="signin-stack">
          {kanti.offline ? <Banner tone="warning" icon="warning">{t.offline}</Banner> : null}
          {approved ? <Banner icon="check">{t.pairApproved(approved)}</Banner> : null}
          <Card className="signin-card signin-primary">
            <div className="signin-card-head"><span className="signin-chip"><Icon name="phone" size={22} /></span><h2>{t.pairTitle}</h2></div>
            <p className="muted">{t.pairBody}</p>
            {pairing ? <PairingPanel onDone={paired} /> : <Button icon="phone" onClick={() => setPairing(true)}>{t.pairStart}</Button>}
          </Card>
          <p className="signin-or muted small"><span>{t.claimOr}</span></p>
          <div className="signin-secondary">
            <Card className="signin-card signin-claim">
              <div className="signin-card-head"><span className="signin-chip"><Icon name="keyboard" size={20} /></span><h2>{t.claimTitle}</h2></div>
              <ClaimCode onDone={paired} />
            </Card>
            <Card className="signin-card">
              <div className="signin-card-head"><span className="signin-chip"><Icon name="key" size={20} /></span><h2>{t.fanotesTitle}</h2></div>
              <p className="muted small">{t.fanotesBody}</p>
              <FaNotesLogin />
            </Card>
          </div>
          <details className="why">
            <summary>{t.whyPairing}</summary>
            <p>{t.whyPairingBody}</p>
          </details>
          <footer className="signin-foot">
            <a href="https://fanotes.fasrv.ch/kantiplus/datenschutz/" target="_blank" rel="noopener noreferrer">{t.privacy}</a>
            <a href="https://fanotes.fasrv.ch/kantiplus/konto-loeschen/" target="_blank" rel="noopener noreferrer">{t.deleteAccount}</a>
          </footer>
        </div>
      </main>
    </div>
  )
}
