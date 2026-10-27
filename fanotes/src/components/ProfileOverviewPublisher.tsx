import { useEffect, useRef } from 'react'
import {
  createFetchProfilePort,
  isProfileOwnerId,
  loadProfileNotes,
  normalizeUsername,
  profileAppearanceFromSettings,
  refreshPublicOverview,
} from '../lib/sync/profile'
import type { AppSettings } from '../types'

const readVaultNotes = async () => {
  const fanotes = typeof window !== 'undefined' ? window.fanotes : undefined
  if (!fanotes?.getTree || !fanotes.readNotePageStats) return []
  return loadProfileNotes(await fanotes.getTree(), (path) => fanotes.readNotePageStats!(path))
}

/**
 * Keeps an already-public overview in step with this device. The settings
 * switch still opens the page immediately; this only refreshes it.
 */
export function ProfileOverviewPublisher({ settings }: { settings: AppSettings }) {
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const { profilePublic, profileUsername, profileOwnerId, theme, accent, accentSecondary } = settings

  useEffect(() => {
    if (!profilePublic || !normalizeUsername(profileUsername) || !isProfileOwnerId(profileOwnerId)) return undefined
    let cancelled = false
    const timer = window.setTimeout(() => {
      const current = settingsRef.current
      if (cancelled || !current.profilePublic) return
      void refreshPublicOverview({
        username: current.profileUsername,
        ownerId: current.profileOwnerId,
        loadNotes: readVaultNotes,
        appearance: profileAppearanceFromSettings(current),
        port: createFetchProfilePort(),
        stillEnabled: () => !cancelled && settingsRef.current.profilePublic && settingsRef.current.profileUsername === current.profileUsername,
      }).catch(() => undefined)
    }, 800)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [accent, accentSecondary, profileOwnerId, profilePublic, profileUsername, theme])

  return null
}
