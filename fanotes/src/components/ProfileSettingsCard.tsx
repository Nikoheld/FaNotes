import { Globe } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  claimUsername,
  createFetchProfilePort,
  createProfileOwnerId,
  enableProfileOverview,
  loadProfileNotes,
  normalizeUsername,
  profileHistoryReader,
  profileAppearanceFromSettings,
  ProfileRequestError,
  profilePath,
  resolveProfileOrigin,
  setProfileVisibility as profileVisibilityControl,
  type ProfilePort,
} from '../lib/sync/profile'
import type { AppSettings } from '../types'

/** The public-overview switch. The same function turns the published page off. */
export { profileVisibilityControl }

const readVaultNotes = async () => {
  const fanotes = typeof window !== 'undefined' ? window.fanotes : undefined
  if (!fanotes?.getTree || !fanotes.readNotePageStats) return []
  return loadProfileNotes(
    await fanotes.getTree(),
    (path) => fanotes.readNotePageStats!(path),
    profileHistoryReader(fanotes.listNoteHistory),
  )
}

export function ProfileSettingsCard({
  settings,
  onChange,
  port,
  origin,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
  port?: ProfilePort
  origin?: string
}) {
  const profilePort = port ?? createFetchProfilePort()
  const profileOrigin = origin ?? resolveProfileOrigin()
  const [draft, setDraft] = useState(settings.profileUsername)
  const [busy, setBusy] = useState<'claim' | 'toggle' | null>(null)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const savedName = normalizeUsername(settings.profileUsername)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const toggleGeneration = useRef(0)

  useEffect(() => {
    setDraft(settings.profileUsername)
  }, [settings.profileUsername])

  const claim = async () => {
    setBusy('claim')
    setNotice(null)
    const ownerId = settings.profileOwnerId || createProfileOwnerId()
    try {
      const claimed = await claimUsername({
        username: draft,
        ownerId,
        loadNotes: readVaultNotes,
        port: profilePort,
        origin: profileOrigin,
      })
      onChange({
        ...settings,
        profileOwnerId: ownerId,
        profileUsername: claimed.username,
        profilePublic: claimed.public,
      })
      setNotice({ kind: 'success', text: 'Der Benutzername ist gespeichert.' })
    } catch (error) {
      const text = error instanceof ProfileRequestError && error.taken
        ? 'Dieser Benutzername ist schon vergeben.'
        : error instanceof ProfileRequestError && error.status === 400
          ? 'Der Benutzername ist ungültig. Drei bis vierundzwanzig Zeichen, beginnend mit einem Buchstaben oder einer Ziffer.'
          : 'Die Übersicht konnte nicht gespeichert werden.'
      setNotice({ kind: 'error', text })
    } finally {
      setBusy(null)
    }
  }

  const toggle = (enabled: boolean) => {
    if (enabled && !savedName) {
      setNotice({ kind: 'error', text: 'Zuerst einen Benutzernamen festlegen.' })
      return
    }
    const token = ++toggleGeneration.current
    const current = settingsRef.current
    setBusy('toggle')
    setNotice(null)
    void (async () => {
      try {
        if (!enabled) {
          await profileVisibilityControl({
            enabled: false,
            username: current.profileUsername,
            ownerId: current.profileOwnerId,
            port: profilePort,
            origin: profileOrigin,
          })
          if (toggleGeneration.current !== token) return
          onChange({ ...settingsRef.current, profilePublic: false })
          setNotice({ kind: 'success', text: 'Die öffentliche Aktivitätsübersicht ist ausgeschaltet.' })
          return
        }
        await enableProfileOverview({
          username: current.profileUsername,
          ownerId: current.profileOwnerId,
          loadNotes: readVaultNotes,
          appearance: profileAppearanceFromSettings(current),
          port: profilePort,
          origin: profileOrigin,
          stillEnabled: () => toggleGeneration.current === token,
          onPublic: () => {
            if (toggleGeneration.current !== token) return
            onChange({ ...settingsRef.current, profilePublic: true })
            setNotice({ kind: 'success', text: 'Die öffentliche Aktivitätsübersicht ist eingeschaltet.' })
            setBusy(null)
          },
        })
      } catch (error) {
        if (toggleGeneration.current !== token) return
        const text = error instanceof ProfileRequestError && error.status === 400
          ? 'Zuerst einen Benutzernamen festlegen.'
          : 'Die Übersicht konnte nicht gespeichert werden.'
        setNotice({ kind: 'error', text })
      } finally {
        if (toggleGeneration.current === token) setBusy(null)
      }
    })()
  }

  return (
    <div id="settings-profile" className="setting-card">
      <div className="setting-card-title"><Globe size={16} /><span>Öffentliche Aktivitätsübersicht</span></div>
      <div className="setting-row">
        <div className="setting-copy">
          <span>Öffentlicher Benutzername</span>
          <small>Ein eindeutiger Benutzername gehört zu deinem Konto. Die Übersicht darunter zeigt Beitritt, Notizanzahl, Zeit in FaNotes und die aktiven Tage, sobald du sie einschaltest.</small>
        </div>
        <div className="setting-control">
          <input
            data-i18n-ignore
            type="text"
            spellCheck={false}
            autoComplete="off"
            maxLength={24}
            aria-label="Öffentlicher Benutzername"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-copy">
          <span>Öffentliche Adresse</span>
          <small>{savedName ? <span data-i18n-ignore>{profilePath(savedName)}</span> : 'Noch kein Benutzername festgelegt.'}</small>
        </div>
        <div className="setting-control">
          <button type="button" className="primary-button" disabled={busy !== null || !draft.trim()} onClick={() => { void claim() }}>
            {busy === 'claim' ? 'Benutzername wird gespeichert …' : 'Benutzername festlegen'}
          </button>
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-copy">
          <span>Die öffentliche Aktivitätsübersicht zeigen</span>
          <small>Ohne festgelegten Benutzernamen bleibt diese Übersicht aus.</small>
        </div>
        <div className="setting-control">
          <button
            type="button"
            className={`toggle ${settings.profilePublic && savedName ? 'is-on' : ''}`}
            role="switch"
            aria-checked={Boolean(settings.profilePublic && savedName)}
            aria-label="Die öffentliche Aktivitätsübersicht zeigen"
            disabled={busy !== null || !savedName}
            onClick={() => { void toggle(!settings.profilePublic) }}
          >
            <span />
          </button>
        </div>
      </div>
      {notice && <div className={`backup-notice is-${notice.kind}`} role="status"><span>{notice.text}</span></div>}
    </div>
  )
}
