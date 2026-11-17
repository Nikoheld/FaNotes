// Test-only page: renders the real WorkRequestsPanel against a fake sync session. Used by check-work-requests-browser.mjs.
import { createRoot } from 'react-dom/client'
import '../../src/styles.css'
import { WorkRequestsPanel } from '../../src/components/WorkRequestsPanel'
import { WorkRequestsClient } from '../../src/lib/workRequests'

const w = window as unknown as { fanotes?: Record<string, unknown> }
w.fanotes = { platform: 'web', captureWindow: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }
const client = new WorkRequestsClient({
  origin: window.location.origin,
  getSession: () => ({ accountId: 'acc-test', deviceId: 'dev', token: 'test-token', expiresAt: '', email: 'test@example.invalid' }),
})
createRoot(document.getElementById('root')!).render(<WorkRequestsPanel client={client} version="test" platform="web" onClose={() => undefined} />)
