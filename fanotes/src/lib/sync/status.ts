import type { SyncPublicState } from './engine'

/** 24-hour HH:MM of a point in time, in the device's time zone. The same text in every UI language. */
const clockTime = (ms: number) => {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Changes from other devices that wait for a note to be saved or readable. They are not "in sync" yet. */
const heldLabel = (count: number) => (count === 1 ? '1 Änderung von einem anderen Gerät wartet' : `${count} Änderungen von anderen Geräten warten`)

/** Files that stayed on this device although they should be on the server. */
export const failedLabel = (count: number) => (count === 1 ? '1 Datei nicht hochgeladen' : `${count} Dateien nicht hochgeladen`)

/** Short status text shared by the status bar and the settings section. */
export const syncStatusLabel = (state: SyncPublicState) => {
  const held = state.heldRemote > 0 ? ` · ${heldLabel(state.heldRemote)}` : ''
  switch (state.status) {
    case 'syncing': return state.progress && state.progress.total ? `${state.progress.phase === 'pull' ? 'Holt' : state.progress.phase === 'push' ? 'Lädt hoch' : 'Prüft'} ${state.progress.done}/${state.progress.total}` : 'Synchronisiert …'
    case 'idle': return state.failed.length ? `${failedLabel(state.failed.length)}${held}` : `Synchron${held}`
    case 'offline': return 'Offline – wartet auf Verbindung'
    case 'error': return 'Sync-Fehler'
    case 'paused': return `${state.pausedUntil ? `Sync pausiert – geht um ${clockTime(state.pausedUntil)} weiter` : 'Sync pausiert'}${held}`
    case 'signed-out': return 'Nicht angemeldet'
    default: return 'Sync nicht verfügbar'
  }
}
