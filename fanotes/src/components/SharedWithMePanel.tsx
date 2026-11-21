import { Check, ChevronDown, ChevronRight, FolderOpen, Share2, UserX, X } from 'lucide-react'
import { uiText } from '../i18n'
import { useState, useSyncExternalStore } from 'react'
import { userShares } from '../lib/sync/userShares'

type Props = {
  /** Reveal a vault path in the file tree (the received copy of an accepted share). */
  onReveal: (path: string) => void
  /** Open a note of the share in the editor. */
  onOpen: (path: string) => void
  toast: (message: string, kind?: 'info' | 'error' | 'success') => void
}

/**
 * "Mit mir geteilt": shares sent to this account. Requests from people the user has not shared with before wait here
 * for a decision. Accepted shares live as folders under "Mit mir geteilt" in the file tree.
 */
export function SharedWithMePanel({ onReveal, onOpen, toast }: Props) {
  const state = useSyncExternalStore(userShares.subscribe, userShares.getState, userShares.getState)
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const incoming = state.shares.filter((share) => share.role === 'recipient')
  if (!state.ready || incoming.length === 0) return null
  const pending = incoming.filter((share) => share.status === 'pending')
  const accepted = incoming.filter((share) => share.status === 'accepted')

  const act = async (id: string, task: () => Promise<void>, done?: string) => {
    setBusy(id)
    try {
      await task()
      if (done) toast(done, 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das hat nicht geklappt.', 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="shared-with-me" aria-label="Mit mir geteilt">
      <button type="button" className="shared-with-me__head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Share2 size={14} />
        <span>Mit mir geteilt</span>
        {pending.length > 0 && <em className="shared-with-me__badge" aria-label={`${pending.length} offen`}>{pending.length}</em>}
      </button>
      {open && (
        <ul className="shared-with-me__list">
          {pending.map((share) => (
            <li key={share.id} className="shared-with-me__request">
              <span data-i18n-ignore><strong>{share.peer}</strong>{share.permission === 'edit'
                ? uiText(` möchte „${share.name || 'eine Freigabe'}“ mit dir teilen (bearbeiten).`, ` wants to share “${share.name || 'a share'}” with you (edit).`)
                : uiText(` möchte „${share.name || 'eine Freigabe'}“ mit dir teilen (lesen).`, ` wants to share “${share.name || 'a share'}” with you (read).`)}</span>
              <span className="shared-with-me__actions">
                <button type="button" className="primary-button" disabled={busy === share.id} onClick={() => void act(share.id, () => userShares.respond(share.id, true), uiText(`„${share.name}“ von ${share.peer} ist jetzt da.`, `“${share.name}” from ${share.peer} is now here.`))}><Check size={13} /> Annehmen</button>
                <button type="button" className="secondary-button" disabled={busy === share.id} onClick={() => void act(share.id, () => userShares.respond(share.id, false))}><X size={13} /> Ablehnen</button>
                <button type="button" className="secondary-button" disabled={busy === share.id} title="Ablehnen und weitere Freigaben dieser Person blockieren" onClick={() => void act(share.id, () => userShares.respond(share.id, false, true), `${share.peer} ist blockiert.`)}><UserX size={13} /> Blockieren</button>
              </span>
            </li>
          ))}
          {accepted.map((share) => (
            <li key={share.id}>
              <button type="button" className="shared-with-me__item" disabled={!share.localRoot} onClick={() => {
                if (!share.localRoot) return
                // A shared note opens in the editor; a folder is revealed and expanded in the tree.
                const note = share.kind === 'note' ? userShares.firstNotePath(share.id) : null
                if (note) { onReveal(share.localRoot); onOpen(note) } else onReveal(share.localRoot)
              }} title={share.problem ?? undefined}>
                <FolderOpen size={14} />
                <span data-i18n-ignore>{share.name || 'Geteilte Freigabe ohne Titel'}</span>
                <small data-i18n-ignore>{share.peer}{share.permission === 'edit' ? '' : ' · nur lesen'}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
