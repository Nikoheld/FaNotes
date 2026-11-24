// The vault as the page sees it: whether the signed-in account's vault is open, the student's own
// data read from it, and the changes the forms make. Mounted inside KantiProvider.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { deriveFromPassword, type SyncKdf } from '@sync/crypto'
import { SyncApi } from '@sync/api'
import { useKanti } from '../state'
import { MemoryBackend, type VaultBackend } from './backend'
import { VaultClient, VaultError } from './client'
import { pickKeyStore, type KeyStore } from './keystore'
import { emptyOwn, loadOwn, type OwnData } from './own'
import { isSlot, slotsInVault } from './files'
import { demoVaultFiles } from './demo'
import { createOwnActions, type OwnActions } from './actions'

/**
 * off: demo or signed out; pair: signed in by a pairing code (no password, so no vault);
 * starting: looking for stored access; locked: the account is signed in but the vault needs the password;
 * ready: open; unavailable: the sync service did not answer.
 */
export type VaultMode = 'off' | 'pair' | 'starting' | 'locked' | 'ready' | 'unavailable'

export interface Vault {
  mode: VaultMode
  own: OwnData
  /** The own data was read at least once. */
  loaded: boolean
  error: string
  /** The access survives a page reload (IndexedDB works). */
  persistent: boolean
  /** The vault is the demo's in-memory one. */
  backendDemo: boolean
  /** The vault slot of the shown connection ('' = the first one), or null when none is chosen. */
  slot: string | null
  slots: string[]
  setSlot: (slot: string | null) => void
  backend: VaultBackend | null
  actions: OwnActions
  /** Called by the sign-in form with what it derived; never throws. */
  open: (input: { email: string; authKey: string; wrappingKey: CryptoKey }) => Promise<void>
  /** The "Entsperren" form: derives the keys from the password again. Throws on a wrong password. */
  unlock: (email: string, password: string) => Promise<void>
  reload: () => Promise<void>
  /** Error text of a failed change (it was not saved). */
  lastWriteError: string
  clearWriteError: () => void
}

const noActions = createOwnActions(() => null, () => {}, () => emptyOwn())

const OFF: Vault = {
  mode: 'off', own: emptyOwn(), loaded: false, error: '', persistent: false, backendDemo: false, slot: null, slots: [], setSlot: () => {}, backend: null, actions: noActions,
  open: async () => {}, unlock: async () => {}, reload: async () => {}, lastWriteError: '', clearWriteError: () => {},
}

const VaultContext = createContext<Vault>(OFF)
export const useVault = () => useContext(VaultContext)

const SLOT_KEY = 'kanti-web:vault-slots'
const readSlots = (): Record<string, string> => {
  try { return JSON.parse(window.localStorage.getItem(SLOT_KEY) || '{}') as Record<string, string> } catch { return {} }
}
const saveSlots = (value: Record<string, string>) => { try { window.localStorage.setItem(SLOT_KEY, JSON.stringify(value)) } catch { /* kept for this page load only */ } }
const EMAIL_KEY = 'kanti-web:vault-email'

export const browserLabel = (agent = typeof navigator === 'undefined' ? '' : navigator.userAgent): string => {
  if (/Edg\//u.test(agent)) return 'Edge'
  if (/Firefox\//u.test(agent)) return 'Firefox'
  if (/Chrom(e|ium)\//u.test(agent)) return 'Chrome'
  if (/Safari\//u.test(agent)) return 'Safari'
  return 'Browser'
}

export const deviceName = () => `Kanti+ im Browser · ${browserLabel()}`

const refreshMs = 5 * 60 * 1000

export const VaultProvider = ({ children, backend: injected }: { children: ReactNode; backend?: VaultBackend }) => {
  const kanti = useKanti()
  const { phase, session, demo, connections, active } = kanti
  const [client, setClient] = useState<VaultClient | null>(null)
  const [starting, setStarting] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [own, setOwn] = useState<OwnData>(() => emptyOwn())
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [lastWriteError, setWriteError] = useState('')
  const [slotMap, setSlotMap] = useState<Record<string, string>>(() => (typeof window === 'undefined' ? {} : readSlots()))
  const [slots, setSlots] = useState<string[]>([])
  const storeRef = useRef<KeyStore | null>(null)
  const loadedAt = useRef(0)
  const ownRef = useRef(own)
  ownRef.current = own
  const demoBackend = useMemo(() => (demo ? new MemoryBackend(demoVaultFiles()) : null), [demo])
  const backend: VaultBackend | null = injected || demoBackend || client
  const fanotesAccount = session?.account === 'fanotes'

  const keyStore = useCallback(async () => {
    storeRef.current ||= await pickKeyStore()
    return storeRef.current
  }, [])
  const clientOptions = useCallback(async () => ({ origin: window.location.origin, store: await keyStore() }), [keyStore])

  // The first connection of the account is the app's original storage slot; others need a choice.
  const slot: string | null = !active ? null : active.id in slotMap ? (isSlot(slotMap[active.id]) ? slotMap[active.id] : null) : connections[0]?.id === active.id ? '' : null
  const setSlot = useCallback((value: string | null) => {
    if (!active) return
    setSlotMap((current) => {
      const next = { ...current }
      if (value === null) delete next[active.id]
      else next[active.id] = value
      saveSlots(next)
      return next
    })
  }, [active])

  // Look for access kept by an earlier page load.
  useEffect(() => {
    if (injected || demo) { setStarting(false); return undefined }
    let live = true
    void (async () => {
      try {
        const restored = await VaultClient.restore(await clientOptions())
        if (live && restored) setClient(restored)
      } catch { /* no stored access */ }
      if (live) setStarting(false)
    })()
    return () => { live = false }
  }, [injected, demo, clientOptions])

  // Ending the Kanti+ session ends the vault access with it: sync logout and wipe IndexedDB. This runs when the
  // phase becomes "signed out" (a sign-out, an expired session, or no session at page load), not while the
  // sign-in form is still open: it opens the vault before the Kanti+ session starts.
  const clientRef = useRef<VaultClient | null>(null)
  clientRef.current = client
  useEffect(() => {
    if (phase !== 'signedOut' || demo || injected) return
    const held = clientRef.current
    setClient(null)
    setOwn(emptyOwn())
    setLoaded(false)
    try { window.sessionStorage.removeItem(EMAIL_KEY) } catch { /* nothing kept */ }
    if (held) void held.logout()
    else void keyStore().then((store) => store.wipe())
  }, [phase, demo, injected, keyStore])

  const fail = useCallback((problem: unknown) => {
    if (problem instanceof VaultError && problem.code === 'unauthorized') {
      // The sync session is gone (changed password, removed device): ask for the password again.
      setClient((held) => { void held?.forget(); return null })
      setOwn(emptyOwn())
      setLoaded(false)
      return
    }
    if (problem instanceof VaultError && (problem.code === 'unavailable' || problem.code === 'offline')) setUnavailable(true)
    setError(problem instanceof Error ? problem.message : String(problem))
  }, [])

  const reload = useCallback(async () => {
    if (!backend) return
    try {
      const next = await loadOwn(backend, slot)
      setOwn(next)
      setLoaded(true)
      setError('')
      setUnavailable(false)
      loadedAt.current = Date.now()
      const paths = (await backend.list().catch(() => [])).map((entry) => entry.path)
      setSlots(slotsInVault(paths))
    } catch (problem) { fail(problem) }
  }, [backend, slot, fail])

  const ready = Boolean(backend) && (demo || phase === 'ready')
  useEffect(() => {
    if (!ready) return undefined
    void reload()
    const refreshIfStale = () => { if (document.visibilityState === 'visible' && Date.now() - loadedAt.current > 30_000) void reload() }
    const timer = window.setInterval(refreshIfStale, refreshMs)
    document.addEventListener('visibilitychange', refreshIfStale)
    window.addEventListener('focus', refreshIfStale)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshIfStale); window.removeEventListener('focus', refreshIfStale) }
  }, [ready, reload])

  const open = useCallback<Vault['open']>(async ({ email, authKey, wrappingKey }) => {
    try {
      const options = await clientOptions()
      const signedIn = await VaultClient.login({ email, authKey, wrappingKey, deviceName: deviceName() }, options)
      setUnavailable(false)
      setError('')
      setClient(signedIn)
      try { window.sessionStorage.setItem(EMAIL_KEY, email) } catch { /* the unlock form asks again */ }
    } catch (problem) { fail(problem) }
  }, [clientOptions, fail])

  const unlock = useCallback<Vault['unlock']>(async (email, password) => {
    const options = await clientOptions()
    const api = new SyncApi(options.origin)
    const { kdf } = await api.prelogin(email.trim())
    const { authKey, wrappingKey } = await deriveFromPassword(password, kdf as SyncKdf)
    const signedIn = await VaultClient.login({ email: email.trim(), authKey, wrappingKey, deviceName: deviceName() }, options)
    setUnavailable(false)
    setError('')
    setClient(signedIn)
    try { window.sessionStorage.setItem(EMAIL_KEY, email.trim()) } catch { /* ignore */ }
  }, [clientOptions])

  const onWriteFailure = useCallback((problem: unknown) => {
    if (problem instanceof VaultError && problem.code === 'unauthorized') { fail(problem); return }
    setWriteError(problem instanceof Error ? problem.message : String(problem))
  }, [fail])
  const actions = useMemo(() => createOwnActions(() => backend, (next) => { setOwn(next); setWriteError('') }, () => ownRef.current, { slot, onFailure: onWriteFailure }), [backend, slot, onWriteFailure])

  const mode: VaultMode = demo || injected ? 'ready'
    : phase !== 'ready' ? 'off'
      : !fanotesAccount ? 'pair'
        : client ? (unavailable && !loaded ? 'unavailable' : 'ready')
          : starting ? 'starting' : 'locked'

  const value = useMemo<Vault>(() => ({
    mode, own, loaded, error, persistent: demo ? false : (client?.persistent ?? false), backendDemo: demo, slot, slots, setSlot, backend: mode === 'ready' ? backend : null, actions,
    open, unlock, reload, lastWriteError, clearWriteError: () => setWriteError(''),
  }), [mode, own, loaded, error, demo, client, slot, slots, setSlot, backend, actions, open, unlock, reload, lastWriteError])
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
}

