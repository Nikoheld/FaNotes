import {
  BookOpenCheck,
  Bot,
  Check,
  CircleAlert,
  FileCheck2,
  Link2,
  Lightbulb,
  ListTree,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  SpellCheck2,
  WandSparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppSettings, LmStudioAction, LmStudioModel, LmStudioTransformResult } from '../types'
import { getUiLocale } from '../i18n'
import { MarkdownPreview } from './MarkdownPreview'

type ActiveNote = {
  title: string
  relativePath: string
  markdown: string
}

type ActionDefinition = {
  id: LmStudioAction
  title: string
  description: string
  icon: ReactNode
  additive?: boolean
}

const ACTIONS: ActionDefinition[] = [
  {
    id: 'instruction',
    title: 'Freien Auftrag ausführen',
    description: 'Alles, was du unten eingibst, wird als Anweisung für diese Notiz ausgeführt.',
    icon: <WandSparkles size={17} />,
  },
  {
    id: 'spelling',
    title: 'Rechtschreibung korrigieren',
    description: 'Grammatik, Zeichensetzung und Tippfehler verbessern, Inhalt erhalten.',
    icon: <SpellCheck2 size={17} />,
  },
  {
    id: 'links',
    title: 'Notizen intelligent verlinken',
    description: 'Passende existierende Seiten mit Wikilinks verbinden.',
    icon: <Link2 size={17} />,
  },
  {
    id: 'facts',
    title: 'Fakten prüfen & korrigieren',
    description: 'Sichere Fehler korrigieren und unsichere Aussagen sichtbar markieren.',
    icon: <ShieldCheck size={17} />,
  },
  {
    id: 'style',
    title: 'Stil und Klarheit verbessern',
    description: 'Präziser und verständlicher formulieren, ohne den persönlichen Ton zu verlieren.',
    icon: <FileCheck2 size={17} />,
  },
  {
    id: 'structure',
    title: 'Markdown strukturieren',
    description: 'Überschriften, Absätze, Listen und Hervorhebungen sinnvoll ordnen.',
    icon: <ListTree size={17} />,
  },
  {
    id: 'expand',
    title: 'Wissen sinnvoll ergänzen',
    description: 'Passende Erklärungen und Hintergrundwissen hinzufügen, ohne Lücken zu erfinden.',
    icon: <Lightbulb size={17} />,
    additive: true,
  },
  {
    id: 'summary',
    title: 'Zusammenfassung ergänzen',
    description: 'Eine kompakte KI-Zusammenfassung am Ende der Notiz hinzufügen.',
    icon: <BookOpenCheck size={17} />,
    additive: true,
  },
  {
    id: 'study',
    title: 'Lernfragen erstellen',
    description: 'Verständnisfragen mit kurzen, einklappbaren Antworten ergänzen.',
    icon: <Sparkles size={17} />,
    additive: true,
  },
]

const modelMeta = (model: LmStudioModel) => [
  model.publisher,
  model.params,
  model.quantization,
  model.maxContextLength ? `${Math.round(model.maxContextLength / 1_000)}k Kontext` : '',
].filter(Boolean).join(' · ')

export function LmStudioPanel({
  settings,
  note,
  vaultNotes,
  onSettingsChange,
  onApply,
  onClose,
}: {
  settings: Pick<AppSettings, 'lmStudioBaseUrl' | 'lmStudioModel' | 'lmStudioApiToken'>
  note: ActiveNote | null
  vaultNotes: Array<{ title: string; relativePath: string }>
  onSettingsChange: (settings: Partial<AppSettings>) => void
  onApply: (markdown: string, relativePath: string) => void
  onClose: () => void
}) {
  const [baseUrl, setBaseUrl] = useState(settings.lmStudioBaseUrl)
  const [apiToken, setApiToken] = useState(settings.lmStudioApiToken)
  const [models, setModels] = useState<LmStudioModel[]>([])
  const [model, setModel] = useState(settings.lmStudioModel)
  const [actions, setActions] = useState<Set<LmStudioAction>>(() => new Set(['spelling']))
  const [instruction, setInstruction] = useState('')
  const [modelsLoading, setModelsLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<LmStudioTransformResult | null>(null)
  const [previewMode, setPreviewMode] = useState<'rendered' | 'source'>('rendered')

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, running])

  const loadModels = useCallback(async () => {
    setModelsLoading(true)
    setError('')
    setResult(null)
    try {
      const available = await window.lernwerk.lmStudioListModels(baseUrl, apiToken)
      setModels(available)
      if (!available.length) {
        setModel('')
        setError('LM Studio ist erreichbar, aber es wurde kein Sprachmodell gefunden. Lade zuerst ein LLM in LM Studio herunter.')
        return
      }
      const selected = available.some((candidate) => candidate.key === model)
        ? model
        : available.find((candidate) => candidate.loaded)?.key ?? available[0].key
      setModel(selected)
      onSettingsChange({ lmStudioBaseUrl: baseUrl, lmStudioApiToken: apiToken, lmStudioModel: selected })
    } catch (loadError) {
      setModels([])
      setError(loadError instanceof Error ? loadError.message : 'LM Studio konnte nicht erreicht werden.')
    } finally {
      setModelsLoading(false)
    }
  }, [apiToken, baseUrl, model, onSettingsChange])

  useEffect(() => { void loadModels() }, []) // Verbindung beim Öffnen einmal automatisch prüfen.

  const selectedModel = useMemo(() => models.find((candidate) => candidate.key === model) ?? null, [model, models])

  const toggleAction = (action: LmStudioAction) => {
    setResult(null)
    setActions((current) => {
      const next = new Set(current)
      if (next.has(action)) next.delete(action)
      else next.add(action)
      return next
    })
  }

  const run = async () => {
    if (!note) { setError('Öffne zuerst eine Markdown-Notiz.'); return }
    if (!model) { setError('Wähle zuerst ein LM-Studio-Modell.'); return }
    if (!actions.size) { setError('Wähle mindestens eine Aktion.'); return }
    if (actions.has('instruction') && !instruction.trim()) { setError('Schreibe den freien Auftrag in das Textfeld.'); return }
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const transformed = await window.lernwerk.lmStudioTransform({
        baseUrl,
        apiToken,
        model,
        title: note.title,
        relativePath: note.relativePath,
        markdown: note.markdown,
        actions: [...actions],
        instruction,
        vaultNotes,
      })
      setResult(transformed)
      onSettingsChange({ lmStudioBaseUrl: baseUrl, lmStudioApiToken: apiToken, lmStudioModel: model })
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Der LM-Studio-Auftrag ist fehlgeschlagen.')
    } finally {
      setRunning(false)
    }
  }

  const stats = result ? [
    result.stats.inputTokens !== undefined ? `${result.stats.inputTokens} Input-Tokens` : '',
    result.stats.outputTokens !== undefined ? `${result.stats.outputTokens} Output-Tokens` : '',
    result.stats.tokensPerSecond !== undefined ? `${result.stats.tokensPerSecond.toFixed(1)} Token/s` : '',
  ].filter(Boolean).join(' · ') : ''

  return (
    <div className="modal-backdrop lm-studio-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !running) onClose() }}>
      <section className="lm-studio-panel" role="dialog" aria-modal="true" aria-labelledby="lm-studio-title">
        <header className="lm-studio-header">
          <span className="lm-studio-mark"><Bot size={22} /></span>
          <div>
            <span className="eyebrow">Lokale KI · deine Notizen bleiben bei dir</span>
            <h2 id="lm-studio-title">LM Studio</h2>
            <p>Modell wählen, mehrere Aufgaben kombinieren und das Ergebnis vor dem Übernehmen prüfen.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={running} aria-label="LM-Studio-Menü schließen"><X size={18} /></button>
        </header>

        <div className="lm-studio-body">
          <aside className="lm-studio-config">
            <section className="lm-step">
              <div className="lm-step-heading"><b>1</b><span><strong>Verbindung & Modell</strong><small>LM Studio muss als lokaler Server laufen.</small></span></div>
              <label className="lm-field"><span>Server-Adresse</span><input value={baseUrl} spellCheck={false} placeholder="http://127.0.0.1:1234" onChange={(event) => { setBaseUrl(event.target.value); setResult(null) }} onBlur={() => onSettingsChange({ lmStudioBaseUrl: baseUrl })} /></label>
              <label className="lm-field"><span>API-Token <i>optional</i></span><input type="password" value={apiToken} autoComplete="off" placeholder="Nur bei aktivierter Authentifizierung" onChange={(event) => setApiToken(event.target.value)} onBlur={() => onSettingsChange({ lmStudioApiToken: apiToken })} /></label>
              <div className="lm-model-row">
                <label className="lm-field"><span>Lokales Modell</span><select value={model} disabled={modelsLoading || !models.length} onChange={(event) => { setModel(event.target.value); setResult(null); onSettingsChange({ lmStudioModel: event.target.value }) }}><option value="">Modell auswählen …</option>{models.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.loaded ? '● ' : ''}{candidate.displayName}</option>)}</select></label>
                <button type="button" className="lm-refresh" onClick={() => void loadModels()} disabled={modelsLoading} title="Verbindung prüfen und Modelle neu laden">{modelsLoading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button>
              </div>
              {selectedModel && <div className="lm-model-card"><span className={selectedModel.loaded ? 'is-loaded' : ''} /><div><strong>{selectedModel.displayName}</strong><small>{modelMeta(selectedModel) || selectedModel.key}</small></div><b>{selectedModel.loaded ? 'geladen' : 'wird bei Start geladen'}</b></div>}
            </section>

            <section className="lm-step lm-actions-step">
              <div className="lm-step-heading"><b>2</b><span><strong>Aktionen kombinieren</strong><small>{actions.size} ausgewählt · Mehrfachauswahl möglich</small></span></div>
              <div className="lm-action-grid">
                {ACTIONS.map((action) => <button type="button" key={action.id} className={actions.has(action.id) ? 'is-selected' : ''} aria-pressed={actions.has(action.id)} onClick={() => toggleAction(action.id)}><span className="lm-action-icon">{action.icon}</span><span><strong>{action.title}</strong><small>{action.description}</small></span><i>{actions.has(action.id) && <Check size={13} />}</i>{action.additive && <em>ergänzt</em>}</button>)}
              </div>
              {actions.has('instruction') && <label className="lm-field lm-instruction"><span>Dein freier Auftrag</span><textarea value={instruction} rows={4} placeholder="Zum Beispiel: Erkläre jeden Fachbegriff einfacher und ergänze zu jedem Abschnitt ein kurzes Beispiel …" onChange={(event) => { setInstruction(event.target.value); setResult(null) }} /></label>}
              {actions.has('facts') && <div className="lm-fact-warning"><CircleAlert size={15} /><span>Faktenprüfung nutzt das Wissen des gewählten lokalen Modells und hat ohne aktivierte LM-Studio-Werkzeuge keinen Live-Internetzugriff.</span></div>}
            </section>
          </aside>

          <main className="lm-studio-preview">
            <div className="lm-preview-toolbar">
              <div><span className="eyebrow">3 · Prüfen</span><strong>{result ? 'KI-Ergebnis' : note ? note.title : 'Keine Notiz geöffnet'}</strong></div>
              {result && <div className="segmented"><button type="button" className={previewMode === 'rendered' ? 'active' : ''} onClick={() => setPreviewMode('rendered')}>Schön</button><button type="button" className={previewMode === 'source' ? 'active' : ''} onClick={() => setPreviewMode('source')}>Markdown</button></div>}
            </div>

            <div className="lm-preview-surface">
              {running ? <div className="lm-processing"><span><LoaderCircle className="spin" size={26} /></span><strong>{selectedModel?.displayName ?? model} arbeitet lokal …</strong><p>Das Modell führt {actions.size} {actions.size === 1 ? 'Aktion' : 'Aktionen'} gemeinsam aus. Größere Modelle können einige Minuten benötigen.</p></div>
                : result ? previewMode === 'rendered' ? <MarkdownPreview content={result.markdown} /> : <textarea className="lm-result-source" value={result.markdown} readOnly spellCheck={false} />
                  : <div className="lm-preview-empty"><span><Sparkles size={27} /></span><strong>Deine Notiz bleibt unverändert</strong><p>LM Studio erstellt zuerst eine Vorschau. Erst „Ergebnis übernehmen“ ersetzt den Inhalt der geöffneten Markdown-Datei.</p>{note && <div><small>Aktuelle Notiz</small><b>{note.relativePath}</b><em>{note.markdown.length.toLocaleString(getUiLocale())} Zeichen</em></div>}</div>}
            </div>

            {error && <div className="lm-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
            <footer className="lm-studio-footer">
              <div>{result ? <><span><Check size={13} /> Vorschau bereit</span>{stats && <small>{stats}</small>}</> : <span><ShieldCheck size={13} /> Verarbeitung über {baseUrl || 'lokales LM Studio'}</span>}</div>
              <div>
                {result && <button type="button" className="secondary-button" onClick={() => setResult(null)}>Neu bearbeiten</button>}
                {result ? <button type="button" className="primary-button" onClick={() => { onApply(result.markdown, note?.relativePath ?? ''); onClose() }}><Check size={15} /> Ergebnis übernehmen</button>
                  : <button type="button" className="primary-button lm-run" onClick={() => void run()} disabled={running || modelsLoading || !note || !model || !actions.size}>{running ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} Vorschau erzeugen</button>}
              </div>
            </footer>
          </main>
        </div>
      </section>
    </div>
  )
}

export default LmStudioPanel
