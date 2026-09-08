import type { SyncPublicState } from './engine'

/** Short status text shared by the status bar and the settings section. */
export const syncStatusLabel = (state: SyncPublicState) => {
  switch (state.status) {
    case 'syncing': return state.progress && state.progress.total ? `${state.progress.phase === 'pull' ? 'Holt' : state.progress.phase === 'push' ? 'Lädt hoch' : 'Prüft'} ${state.progress.done}/${state.progress.total}` : 'Synchronisiert …'
    case 'idle': return 'Synchron'
    case 'offline': return 'Offline – wartet auf Verbindung'
    case 'error': return 'Sync-Fehler'
    case 'paused': return 'Sync pausiert'
    case 'signed-out': return 'Nicht angemeldet'
    default: return 'Sync nicht verfügbar'
  }
}
