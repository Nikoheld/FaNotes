import { useCallback, useEffect, useState } from 'react'
import { FileWarning, Info, RefreshCw, X } from 'lucide-react'
import type { OfficeSourceStatus } from '../types'

type Props = {
  /** The open PDF note. The notice only appears when it was converted from a Word/PowerPoint file. */
  path: string
  onReconvert: (sourcePath: string) => void
}

const hintKey = (path: string) => `fanotes.officeHint.v1:${path}`
const readDismissed = (path: string) => {
  try { return window.localStorage.getItem(hintKey(path)) === '1' } catch { return false }
}

/** Small, non-blocking notice above a PDF note that came from an Office file. */
export function OfficeSourceNotice({ path, onReconvert }: Props) {
  const [status, setStatus] = useState<OfficeSourceStatus | null>(null)
  const [hintHidden, setHintHidden] = useState(() => readDismissed(path))
  const [changedHidden, setChangedHidden] = useState(false)

  const refresh = useCallback(async () => {
    const read = window.fanotes.readOfficeSource
    if (!read) return
    try { setStatus(await read(path)) } catch { setStatus(null) }
  }, [path])

  useEffect(() => {
    setStatus(null)
    setHintHidden(readDismissed(path))
    setChangedHidden(false)
    void refresh()
    // The original can change while the note stays open (it is edited in Word next to FaNotes).
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [path, refresh])

  if (!status) return null
  if (status.changed && !changedHidden) {
    return (
      <div className="office-notice is-changed" role="status">
        <FileWarning size={15} aria-hidden="true" />
        <span>Original geändert – neu umwandeln?</span>
        <button type="button" onClick={() => onReconvert(status.sourcePath)}><RefreshCw size={13} aria-hidden="true" /> Neu umwandeln</button>
        <button type="button" className="office-notice__close" aria-label="Hinweis schließen" onClick={() => setChangedHidden(true)}><X size={13} /></button>
      </div>
    )
  }
  if (status.fallback && !hintHidden) {
    return (
      <div className="office-notice is-hint" role="status">
        <Info size={14} aria-hidden="true" />
        <span>Mit der eingebauten Umwandlung erstellt – das Layout kann vom Original abweichen.</span>
        <button
          type="button"
          className="office-notice__close"
          aria-label="Hinweis schließen"
          onClick={() => {
            setHintHidden(true)
            try { window.localStorage.setItem(hintKey(path), '1') } catch { /* the hint just comes back next time */ }
          }}
        ><X size={13} /></button>
      </div>
    )
  }
  return null
}
