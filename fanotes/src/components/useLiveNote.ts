import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { userShares } from '../lib/sync/userShares'
import type { LiveNote, LivePerson } from '../lib/collab/liveNotes'
import type { LiveStatus } from '../lib/collab/liveChannel'

export type LiveNoteState = {
  note: LiveNote | null
  /** A shared note is being joined: typing waits for the shared text so nothing is overwritten. */
  connecting: boolean
  status: LiveStatus | 'plain'
  people: readonly LivePerson[]
}

const NO_PEOPLE: readonly LivePerson[] = []
const subscribeNothing = () => () => undefined
const RETRY_OFFLINE_MS = 30_000

/**
 * Joins the open note for live co-editing when it belongs to an accepted share. Everything
 * else (Yjs, the editor binding) is loaded on demand, so unshared notes pay nothing.
 */
export function useLiveNote(path: string | null, content: string, onDiverged?: (copyPath: string) => void): LiveNoteState {
  const sharesState = useSyncExternalStore(userShares.subscribe, userShares.getState)
  void sharesState
  const info = path ? userShares.liveInfoFor(path) : null
  const key = path && info ? `${path}\n${info.shareId}\n${info.canWrite ? 'w' : 'r'}` : ''
  const contentRef = useRef(content)
  contentRef.current = content
  const divergedRef = useRef(onDiverged)
  divergedRef.current = onDiverged
  const [note, setNote] = useState<LiveNote | null>(null)
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    if (!key || !path || !info) { setNote(null); setSettled(false); return }
    let cancelled = false
    let current: LiveNote | null = null
    let timer: number | null = null
    let unwait: (() => void) | null = null
    setSettled(false)
    const attempt = async () => {
      unwait?.()
      unwait = null
      let outcome: Awaited<ReturnType<typeof userShares.openLive>>
      try {
        outcome = await userShares.openLive(path, contentRef.current)
      } catch (error) {
        console.warn('[live] could not join the note', error)
        outcome = { note: null, reason: 'offline' }
      }
      if (cancelled) {
        if (outcome.note) void outcome.note.close()
        return
      }
      if (outcome.note) {
        current = outcome.note
        const joined = outcome.note
        // Closed from outside (the room's key was rotated, the share changed): join again.
        joined.onClosed(() => { if (!cancelled && current === joined) { current = null; setNote(null); setSettled(false); void attempt() } })
        setNote(outcome.note)
        setSettled(true)
        if (outcome.note.diverged !== null) {
          void userShares.keepDivergedCopy(path, outcome.note.diverged).then((copy) => { if (copy) divergedRef.current?.(copy) }).catch(() => undefined)
        }
        return
      }
      // The note stays a plain, normally synced file for now. Try again when there is news.
      setNote(null)
      setSettled(true)
      unwait = userShares.waitForLive(info.shareId, () => { if (!cancelled) void attempt() })
      if (outcome.reason === 'offline') timer = window.setTimeout(() => { if (!cancelled) void attempt() }, RETRY_OFFLINE_MS)
    }
    void attempt()
    return () => {
      cancelled = true
      unwait?.()
      if (timer !== null) window.clearTimeout(timer)
      const closing = current
      current = null
      setNote(null)
      if (closing) void closing.close()
    }
    // `info` is derived from `key`; the path and permission are in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const people = useSyncExternalStore(note ? note.onPeople.bind(note) : subscribeNothing, note ? note.people : () => NO_PEOPLE)
  const status = useSyncExternalStore(
    (listener) => (note ? note.channel.onStatus(listener) : () => undefined),
    () => (note ? note.status : 'plain'),
  )
  return { note, connecting: Boolean(key) && !settled, status, people }
}
