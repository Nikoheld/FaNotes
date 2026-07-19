import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/dm-sans/latin-400.css'
import '@fontsource/dm-sans/latin-600.css'
import './styles.css'
import App from './App'
import { initializeUiLocalization, translateUiText } from './i18n'
import type { BootstrapData } from './types'

const renderApp = (startupBootstrap?: Promise<BootstrapData>) => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App startupBootstrap={startupBootstrap} />
  </StrictMode>,
)

if (!window.requestIdleCallback) {
  window.requestIdleCallback = (callback) => window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 8 }), 1)
  window.cancelIdleCallback = (handle) => window.clearTimeout(handle)
}

const registerWebApp = () => {
  document.documentElement.dataset.runtime = 'web'
  window.setTimeout(() => {
    try {
      if (sessionStorage.getItem('fanotes-analytics-web-app-session-v1') === '1') return
      sessionStorage.setItem('fanotes-analytics-web-app-session-v1', '1')
    } catch {
      // Private modes can deny session storage. No persistent identifier is
      // required for this anonymous, daily aggregate.
    }
    void fetch('/api/v1/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'web_app_open' }),
      credentials: 'omit',
      cache: 'no-store',
      keepalive: true,
    }).catch(() => undefined)
  }, 1200)
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    const register = () => { void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => undefined) }
    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
  }
}

const desktopBootstrap = window.fanotes?.bootstrap()
// Attach a rejection handler immediately: localization may still be loading
// when a damaged config rejects. App awaits the original promise and renders
// the localized fatal screen, while the browser never reports a transient
// unhandled rejection.
void desktopBootstrap?.catch(() => undefined)

void initializeUiLocalization().then(() => {
  if (window.fanotes) {
    renderApp(desktopBootstrap)
  } else if (import.meta.env.DEV && !new URLSearchParams(location.search).has('web')) {
    void import('./lib/browserPreview').then(({ createBrowserPreviewApi }) => {
      window.fanotes = createBrowserPreviewApi()
      renderApp()
    })
  } else {
    void import('./lib/browserApi').then(({ createBrowserApi }) => {
      window.fanotes = createBrowserApi()
      registerWebApp()
      renderApp()
    }).catch((error: unknown) => {
    const root = document.getElementById('root')
    if (root) {
      root.replaceChildren()
      const surface = document.createElement('main')
      const card = document.createElement('div')
      const mark = document.createElement('div')
      const title = document.createElement('strong')
      const detail = document.createElement('small')
      surface.className = 'boot-surface'
      card.className = 'boot-card'
      mark.className = 'boot-mark'
      mark.textContent = '!'
      title.textContent = translateUiText('FaNotes Web konnte nicht gestartet werden')
      detail.textContent = translateUiText(error instanceof Error ? error.message : 'Unbekannter Browserfehler')
      card.append(mark, title, detail)
      surface.append(card)
      root.append(surface)
    }
    })
  }
})
