import { useEffect, useState } from 'react'

/** Desktop (Tauri) only: "native sync engine (preview)". Renders nothing where the capability is missing. */
export function NativeSyncToggle() {
  const api = typeof window !== 'undefined' ? window.fanotes?.nativeSync : undefined
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    if (!api) return
    let live = true
    void api.enabled().then((value) => { if (live) setOn(value === true) }).catch(() => undefined)
    return () => { live = false }
  }, [api])
  if (!api || on === null) return null
  return (
    <div className="setting-row">
      <div className="setting-copy"><span>Nativer Sync (Vorschau)</span><small>Synchronisiert mit der Rust-Engine dieser Desktop-App. Gleiches Konto, gleicher Zustand; aus: die bisherige Engine.</small></div>
      <div className="setting-control"><button type="button" className={`toggle ${on ? 'is-on' : ''}`} role="switch" aria-checked={on} aria-label="Nativer Sync (Vorschau)" onClick={() => { void api.setEnabled(!on).then((value) => setOn(value === true)).catch(() => undefined) }}><span /></button></div>
    </div>
  )
}
