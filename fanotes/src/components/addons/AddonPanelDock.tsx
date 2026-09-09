import { useCallback, useMemo, useState } from 'react'
import type { AddonPanelState, AddonRuntime } from '../../lib/addons/runtime'
import { SafeBoundary } from '../SafeBoundary'
import { AddonBlocks } from './AddonBlocks'

// Side dock that hosts add-on panels. One tab per open panel; the active one
// is rendered through AddonBlocks inside its own SafeBoundary so a rendering
// bug in one add-on's panel only blanks that tab.

const keyOf = (panel: AddonPanelState) => `${panel.addonId}/${panel.id}`

function PanelBody({ panel, runtime }: { panel: AddonPanelState; runtime: AddonRuntime }) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const onValue = useCallback((id: string, value: unknown) => setValues((current) => ({ ...current, [id]: value })), [])
  const events = useMemo(() => ({
    onAction: (actionId: string, itemId?: string) => runtime.panelAction(panel.addonId, panel.id, actionId, itemId, values),
    onInput: (inputId: string, value: unknown) => runtime.panelInput(panel.addonId, panel.id, inputId, value),
  }), [panel.addonId, panel.id, runtime, values])
  return <AddonBlocks blocks={panel.blocks} events={events} values={values} onValue={onValue} />
}

export function AddonPanelDock({ panels, activeKey, runtime, onClose }: {
  panels: AddonPanelState[]
  activeKey: string | null
  runtime: AddonRuntime
  onClose: () => void
}) {
  const active = panels.find((panel) => keyOf(panel) === activeKey) ?? panels[0] ?? null
  if (!active) return null
  return (
    <aside className="addon-dock" aria-label="Add-on-Panels">
      <header className="addon-dock__header">
        <div className="addon-dock__tabs" role="tablist">
          {panels.map((panel) => {
            const key = keyOf(panel)
            const selected = key === keyOf(active)
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`addon-dock__tab${selected ? ' is-active' : ''}`}
                title={`${panel.addonName} · ${panel.title}`}
                onClick={() => runtime.setActivePanel(key)}
                data-i18n-ignore
              >
                {panel.icon ? <span className="addon-dock__tab-icon" aria-hidden="true">{panel.icon}</span> : null}
                <span>{panel.title}</span>
              </button>
            )
          })}
        </div>
        <div className="addon-dock__actions">
          <button type="button" className="addon-dock__icon-btn" title="Panel schließen" aria-label="Panel schließen" onClick={() => runtime.closePanel(active.addonId, active.id)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
          <button type="button" className="addon-dock__icon-btn" title="Dock einklappen" aria-label="Dock einklappen" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
          </button>
        </div>
      </header>
      <div className="addon-dock__body">
        <SafeBoundary key={keyOf(active)} name={`Add-on-Panel ${active.addonName}`} fallbackTitle="Dieses Add-on-Panel ist abgestürzt">
          <PanelBody key={keyOf(active)} panel={active} runtime={runtime} />
        </SafeBoundary>
      </div>
      <footer className="addon-dock__footer" data-i18n-ignore>{active.addonName}</footer>
    </aside>
  )
}
