// Renders the dialogs that cannot be opened in a fresh profile (Fehler & Wünsche needs a sync account and a server
// capability, the add-on prompt needs a running add-on) with the app's real stylesheet. Loaded by
// scripts/check-dialog-shell-desktop.mjs inside Electron: `#work-requests` or `#addon-prompt`, `?theme=light|dark`.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/styles.css'
import { AddonPromptDialog } from '../../src/components/addons/AddonPromptDialog'
import { WorkRequestsPanel } from '../../src/components/WorkRequestsPanel'
import { OneNoteImportDialog } from '../../src/components/OneNoteImportDialog'
import { ShareWithUserDialog } from '../../src/components/ShareWithUserDialog'
import { SharePresence } from '../../src/components/SharePresence'
import { PenQuickMenu } from '../../src/components/PenQuickMenu'
import { MathCorrectionPopover, MathSolverPopover } from '../../src/components/MathPopovers'
import type { MathCheckResult } from '../../src/lib/mathChecker'
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

// What the OneNote dialog reads from the main process: a small notebook, no file dialog.
const scan = {
  sessionId: 'harness', notebookName: 'Biologie 10a', sourceName: 'Biologie.onepkg', pageCount: 5, inkPageCount: 2, warnings: [],
  sections: [
    { path: ['Zelle'], name: 'Zelle', pages: [
      { id: 'p1', title: 'Zellaufbau', depth: 0, hasInk: true, imageCount: 2, alreadyImported: false },
      { id: 'p2', title: 'Mitose und Meiose im Vergleich, mit einer sehr langen Überschrift die umbrechen muss', depth: 1, hasInk: false, imageCount: 0, alreadyImported: false },
      { id: 'p3', title: 'Organellen', depth: 0, hasInk: true, imageCount: 0, alreadyImported: true },
    ] },
    { path: ['Genetik'], name: 'Genetik', pages: [
      { id: 'p4', title: 'Mendel', depth: 0, hasInk: false, imageCount: 1, alreadyImported: false },
      { id: 'p5', title: 'DNA', depth: 0, hasInk: false, imageCount: 0, alreadyImported: false },
    ] },
  ],
}
;(window as unknown as { fanotes: unknown }).fanotes = {
  platform: 'linux',
  importOneNote: async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return scan },
  closeOneNote: async () => ({ closed: true }),
  cancelOneNoteImport: async () => ({ cancelled: true }),
  onOneNoteProgress: () => () => {},
}

const view = location.hash.replace('#', '')
const tab = new URLSearchParams(location.search).get('tab')
const toast = () => {}
// Every view closes itself through its own close handler, so Escape and the close button can be asserted.
// The drawing board's math popovers need handwriting recognition; here they get synthetic recognition results.
function MathHost({ kind, state }: { kind: 'solver' | 'correction'; state: string }) {
  const [open, setOpen] = useState(true)
  const close = () => { setOpen(false); document.body.setAttribute('data-harness-closed', '1') }
  const [input, setInput] = useState('2x + 3 = 11')
  const [variable, setVariable] = useState('x')
  const [placement, setPlacement] = useState('auto')
  const [lines, setLines] = useState([{ id: 'a', input: '2x + 3 = 11', confidence: 94 }, { id: 'b', input: '2x = 8', confidence: 88 }, { id: 'c', input: 'x = 3', confidence: 71 }])
  const result = { status: 'incorrect', message: 'Zwischen Zeile 2 und 3 passt die Umformung nicht.', suggestion: 'x = 4', lines: [{ status: 'start', message: '' }, { status: 'correct', message: 'Äquivalent' }, { status: 'incorrect', message: '2x = 8 ergibt x = 4' }] } as unknown as MathCheckResult
  const status = state === 'recognizing' ? 'recognizing' : state === 'error' ? 'error' : 'ready'
  const noop = () => {}
  return <div id="math-stage" style={{ position: 'relative', width: 900, height: 600, margin: 16, border: '1px dashed var(--border-strong)' }}>
    <button type="button" id="harness-opener" autoFocus>Seite</button>
    {open && (kind === 'solver'
      ? <MathSolverPopover style={{ left: '8%', top: '12%' }} status={status} error="Keine Handschrift erkannt." confidence={status === 'ready' ? 58 : 0} input={input} onInput={setInput} preview="" validation={input.includes('?') ? 'Der Ausdruck ist nicht gültig.' : ''} variables={['x']} variable={variable} onVariable={setVariable} placement={placement} onPlacement={setPlacement} solving={false} actions={(['step', 'simplify', 'solve', 'expand', 'factor', 'calculate'] as const).map((action) => ({ action, disabled: action === 'calculate' }))} actionLabel={(action) => ({ step: 'Nächster Schritt', simplify: 'Term vereinfachen', solve: 'Nach x lösen', expand: 'Ausmultiplizieren', factor: 'Faktorisieren', calculate: 'Ausrechnen' })[action]} onRun={noop} showTraining onTraining={noop} onClose={close} />
      : <MathCorrectionPopover style={{ left: '30%', top: '6%' }} status={status === 'ready' ? 'ready' : status} error="Keine Handschrift erkannt." lines={status === 'ready' ? lines : []} result={status === 'ready' ? result : undefined} onLine={(id, value) => setLines((all) => all.map((line) => (line.id === id ? { ...line, input: value } : line)))} onRecheck={noop} onReselect={noop} showTraining onTraining={noop} onClose={close} />)}
  </div>
}

function Host() {
  const [open, setOpen] = useState(true)
  const close = () => { setOpen(false); document.body.setAttribute('data-harness-closed', '1') }
  if (!open) return <button type="button" id="harness-opener">opener</button>
  if (view === 'addon-prompt') return <AddonPromptDialog request={{ title: 'Name der Vorlage', message: 'Wie soll die neue Vorlage heissen?\nSie erscheint danach im Menü.', placeholder: 'Vorlage', value: '', resolve: () => {} }} />
  if (view === 'math-solver' || view === 'math-correction') return <MathHost kind={view === 'math-solver' ? 'solver' : 'correction'} state={tab ?? 'ready'} />
  if (view === 'onenote') return <OneNoteImportDialog folders={['Biologie', 'Chemie/Labor']} onClose={close} onImported={() => {}} />
  if (view === 'share-user') return <ShareWithUserDialog target={{ path: 'Biologie/Zelle.md', kind: 'note', name: 'Zelle' }} signedIn={false} onClose={close} onOpenAccountSettings={() => {}} toast={toast} />
  if (view === 'share-presence') return <div style={{ position: 'fixed', top: 12, right: 24 }}><SharePresence people={{ self: 'Ich', present: ['Ich', 'Anna', 'Ben'], editors: ['Ich', 'Anna', 'Ben', 'Clara'] }} /></div>
  if (view === 'pen-quick') {
    const icons = ['Stift', 'Marker', 'Radierer', 'Lasso', 'Form']
    return <PenQuickMenu x={420} y={320} pointerId={-1} tools={icons.map((label, index) => ({ id: label, label, icon: <b>{label[0]}</b>, active: index === 0 }))} colors={['#111111', '#b3402f', '#1d6fa5', '#1c7a4f', '#9a5b00', '#7b4bb7']} activeColor="#111111" onTool={close} onColor={close} onClose={close} />
  }
  return <WorkRequestsPanel client={client} version="0.0.0" platform="linux" onClose={close} />
}
const root = createRoot(document.getElementById('root')!)
root.render(<Host />)
if (view === 'work-requests' && tab === 'mine') setTimeout(() => document.querySelectorAll<HTMLButtonElement>('.wr-tabs button')[1]?.click(), 50)
if (view === 'share-presence') setTimeout(() => document.querySelector<HTMLButtonElement>('.share-presence-button')?.click(), 80)
document.body.setAttribute('data-harness-ready', '1')
