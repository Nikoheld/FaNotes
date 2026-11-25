// Renders the dialogs that cannot be opened in a fresh profile (Fehler & Wünsche needs a sync account and a server
// capability, the add-on prompt needs a running add-on) with the app's real stylesheet. Loaded by
// scripts/check-dialog-shell-desktop.mjs inside Electron: `#work-requests` or `#addon-prompt`, `?theme=light|dark`.
import { createRoot } from 'react-dom/client'
import '../../src/styles.css'
import { AddonPromptDialog } from '../../src/components/addons/AddonPromptDialog'
import { WorkRequestsPanel } from '../../src/components/WorkRequestsPanel'
import type { WorkRequestsClient } from '../../src/lib/workRequests'

const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'
document.body.classList.add(`app-theme-${theme}`)
document.documentElement.dataset.theme = theme
document.documentElement.style.colorScheme = theme

const client = {
  list: async () => [
    { id: 'a', kind: 'bug', title: 'Stift springt beim Schreiben nach oben', status: 'working', cancelled: false },
    { id: 'b', kind: 'feature', title: 'Eine sehr lange Anfrage, die in der Liste abgeschnitten werden muss und trotzdem lesbar bleibt', status: 'merged', cancelled: false },
  ],
  detail: async () => { throw new Error('not used') },
  subscribe: () => () => {},
  create: async () => ({ id: 'c' }),
  capabilities: async () => true,
} as unknown as WorkRequestsClient

const view = location.hash.replace('#', '')
const tab = new URLSearchParams(location.search).get('tab')
const root = createRoot(document.getElementById('root')!)
root.render(
  view === 'addon-prompt'
    ? <AddonPromptDialog request={{ title: 'Name der Vorlage', message: 'Wie soll die neue Vorlage heissen?\nSie erscheint danach im Menü.', placeholder: 'Vorlage', value: '', resolve: () => {} }} />
    : <WorkRequestsPanel client={client} version="0.0.0" platform="linux" onClose={() => {}} />,
)
if (view === 'work-requests' && tab === 'mine') setTimeout(() => document.querySelectorAll<HTMLButtonElement>('.wr-tabs button')[1]?.click(), 50)
document.body.setAttribute('data-harness-ready', '1')
