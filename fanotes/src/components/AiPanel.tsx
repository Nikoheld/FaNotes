import {
  BookOpenCheck,
  Bot,
  Check,
  CircleAlert,
  Cloud,
  Cpu,
  FileCheck2,
  KeyRound,
  Link2,
  Lightbulb,
  ListTree,
  LoaderCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  SpellCheck2,
  Terminal,
  WandSparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AiConnection, AiModel, AiProviderId, AiTransformResult, AppSettings, LmStudioAction } from '../types'
import { getUiLanguage, getUiLocale } from '../i18n'
import { MarkdownPreview } from './MarkdownPreview'

type ActiveNote = { title: string; relativePath: string; markdown: string }
type ActionDefinition = { id: LmStudioAction; title: string; description: string; icon: ReactNode; additive?: boolean }
type ProviderDefinition = { id: AiProviderId; title: string; short: string; description: string; kind: 'local' | 'cloud'; icon: ReactNode }

const PROVIDERS: ProviderDefinition[] = [
  { id: 'lmstudio', title: 'LM Studio', short: 'LM', description: 'Lokale OpenAI-kompatible Modelle', kind: 'local', icon: <Server size={15} /> },
  { id: 'ollama', title: 'Ollama', short: 'OL', description: 'Lokale und installierte Ollama-Modelle', kind: 'local', icon: <Cpu size={15} /> },
  { id: 'openai', title: 'OpenAI', short: 'OA', description: 'Responses API und verfügbare Modelle', kind: 'cloud', icon: <Cloud size={15} /> },
  { id: 'gemini', title: 'Gemini', short: 'GE', description: 'Google Gemini generateContent', kind: 'cloud', icon: <Sparkles size={15} /> },
  { id: 'anthropic', title: 'Anthropic', short: 'AN', description: 'Claude Messages API', kind: 'cloud', icon: <Bot size={15} /> },
  { id: 'opencode', title: 'OpenCode', short: 'OC', description: 'Konfigurierte OpenCode-Provider', kind: 'local', icon: <Terminal size={15} /> },
]

const ACTIONS: ActionDefinition[] = [
  { id: 'instruction', title: 'Freien Auftrag ausführen', description: 'Deine eigene Anweisung für diese Notiz ausführen.', icon: <WandSparkles size={17} /> },
  { id: 'spelling', title: 'Rechtschreibung korrigieren', description: 'Grammatik, Zeichensetzung und Tippfehler verbessern.', icon: <SpellCheck2 size={17} /> },
  { id: 'links', title: 'Notizen intelligent verlinken', description: 'Passende Seiten mit Wikilinks verbinden.', icon: <Link2 size={17} /> },
  { id: 'facts', title: 'Fakten prüfen & korrigieren', description: 'Sichere Fehler korrigieren und Unsicherheit markieren.', icon: <ShieldCheck size={17} /> },
  { id: 'style', title: 'Stil und Klarheit verbessern', description: 'Präziser formulieren und den persönlichen Ton erhalten.', icon: <FileCheck2 size={17} /> },
  { id: 'structure', title: 'Markdown strukturieren', description: 'Überschriften, Absätze und Listen sinnvoll ordnen.', icon: <ListTree size={17} /> },
  { id: 'expand', title: 'Wissen sinnvoll ergänzen', description: 'Passende Erklärungen und Beispiele ergänzen.', icon: <Lightbulb size={17} />, additive: true },
  { id: 'summary', title: 'Zusammenfassung ergänzen', description: 'Eine kompakte AI-Zusammenfassung anhängen.', icon: <BookOpenCheck size={17} />, additive: true },
  { id: 'study', title: 'Lernfragen erstellen', description: 'Verständnisfragen mit einklappbaren Antworten ergänzen.', icon: <Sparkles size={17} />, additive: true },
]

const connectionFromSettings = (provider: AiProviderId, settings: AppSettings): AiConnection => {
  if (provider === 'lmstudio') return { provider, baseUrl: settings.lmStudioBaseUrl, model: settings.lmStudioModel, apiKey: settings.lmStudioApiToken }
  if (provider === 'ollama') return { provider, baseUrl: settings.ollamaBaseUrl, model: settings.ollamaModel, apiKey: settings.ollamaApiToken }
  if (provider === 'openai') return { provider, baseUrl: '', model: settings.openAiModel, apiKey: settings.openAiApiKey }
  if (provider === 'gemini') return { provider, baseUrl: '', model: settings.geminiModel, apiKey: settings.geminiApiKey }
  if (provider === 'anthropic') return { provider, baseUrl: '', model: settings.anthropicModel, apiKey: settings.anthropicApiKey }
  return { provider, baseUrl: settings.openCodeBaseUrl, model: settings.openCodeModel, apiKey: settings.openCodePassword, username: settings.openCodeUsername }
}

const settingsForConnection = (connection: AiConnection, includeSecret: boolean): Partial<AppSettings> => {
  if (connection.provider === 'lmstudio') return { lmStudioBaseUrl: connection.baseUrl, lmStudioModel: connection.model, ...(includeSecret ? { lmStudioApiToken: connection.apiKey } : {}) }
  if (connection.provider === 'ollama') return { ollamaBaseUrl: connection.baseUrl, ollamaModel: connection.model, ...(includeSecret ? { ollamaApiToken: connection.apiKey } : {}) }
  if (connection.provider === 'openai') return { openAiModel: connection.model, ...(includeSecret ? { openAiApiKey: connection.apiKey } : {}) }
  if (connection.provider === 'gemini') return { geminiModel: connection.model, ...(includeSecret ? { geminiApiKey: connection.apiKey } : {}) }
  if (connection.provider === 'anthropic') return { anthropicModel: connection.model, ...(includeSecret ? { anthropicApiKey: connection.apiKey } : {}) }
  return { openCodeBaseUrl: connection.baseUrl, openCodeModel: connection.model, openCodeUsername: connection.username || 'opencode', ...(includeSecret ? { openCodePassword: connection.apiKey } : {}) }
}

const modelMeta = (entry: AiModel) => [entry.publisher, entry.params, entry.quantization, entry.maxContextLength ? `${Math.round(entry.maxContextLength / 1000)}k Kontext` : ''].filter(Boolean).join(' · ')

export function AiPanel({ settings, note, vaultNotes, onSettingsChange, onApply, onClose }: {
  settings: AppSettings
  note: ActiveNote | null
  vaultNotes: Array<{ title: string; relativePath: string }>
  onSettingsChange: (settings: Partial<AppSettings>) => void
  onApply: (markdown: string, relativePath: string) => void
  onClose: () => void
}) {
  const [provider, setProvider] = useState<AiProviderId>(settings.aiProvider)
  const [connections, setConnections] = useState<Record<AiProviderId, AiConnection>>(() => Object.fromEntries(PROVIDERS.map((entry) => [entry.id, connectionFromSettings(entry.id, settings)])) as Record<AiProviderId, AiConnection>)
  const [models, setModels] = useState<AiModel[]>([])
  const [actions, setActions] = useState<Set<LmStudioAction>>(() => new Set(['spelling']))
  const [instruction, setInstruction] = useState('')
  const [modelsLoading, setModelsLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AiTransformResult | null>(null)
  const [previewMode, setPreviewMode] = useState<'rendered' | 'source'>('rendered')
  const isWeb = window.fanotes.platform === 'web'
  const definition = PROVIDERS.find((entry) => entry.id === provider) ?? PROVIDERS[0]
  const connection = connections[provider]
  const cloudInWeb = definition.kind === 'cloud' && isWeb

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !running) onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, running])

  const persist = useCallback((next: AiConnection, includeSecret = true) => {
    onSettingsChange({ aiProvider: next.provider, ...settingsForConnection(next, includeSecret && !(isWeb && !['lmstudio', 'ollama', 'opencode'].includes(next.provider))) })
  }, [isWeb, onSettingsChange])

  const updateConnection = (changes: Partial<AiConnection>, persistNow = false, includeSecret = true) => {
    const next = { ...connection, ...changes }
    setConnections((current) => ({ ...current, [provider]: next }))
    setResult(null)
    if (persistNow) persist(next, includeSecret)
  }

  const chooseProvider = (nextProvider: AiProviderId) => {
    if (running) return
    setProvider(nextProvider)
    setModels([])
    setResult(null)
    setError('')
    onSettingsChange({ aiProvider: nextProvider })
  }

  const loadModels = async () => {
    setModelsLoading(true)
    setError('')
    setResult(null)
    try {
      const available = await window.fanotes.aiListModels(connection)
      setModels(available)
      if (!available.length) { updateConnection({ model: '' }, true, !cloudInWeb); setError(`${definition.title} ist erreichbar, hat aber kein verwendbares Textmodell gemeldet.`); return }
      const selected = available.some((candidate) => candidate.key === connection.model) ? connection.model : available.find((candidate) => candidate.loaded)?.key ?? available[0].key
      updateConnection({ model: selected }, true, !cloudInWeb)
    } catch (loadError) {
      setModels([])
      setError(loadError instanceof Error ? loadError.message : `${definition.title} konnte nicht erreicht werden.`)
    } finally { setModelsLoading(false) }
  }

  const selectedModel = useMemo(() => models.find((candidate) => candidate.key === connection.model) ?? null, [connection.model, models])
  const toggleAction = (action: LmStudioAction) => { setResult(null); setActions((current) => { const next = new Set(current); if (next.has(action)) next.delete(action); else next.add(action); return next }) }

  const run = async () => {
    if (!note) { setError('Öffne zuerst eine Markdown-Notiz.'); return }
    if (!connection.model) { setError('Wähle zuerst ein AI-Modell.'); return }
    if (!actions.size) { setError('Wähle mindestens eine Aktion.'); return }
    if (actions.has('instruction') && !instruction.trim()) { setError('Schreibe den freien Auftrag in das Textfeld.'); return }
    setRunning(true); setError(''); setResult(null)
    try {
      const transformed = await window.fanotes.aiTransform({ connection, title: note.title, relativePath: note.relativePath, markdown: note.markdown, actions: [...actions], instruction, vaultNotes })
      setResult(transformed)
      persist(connection, !cloudInWeb)
    } catch (runError) { setError(runError instanceof Error ? runError.message : 'Der AI-Auftrag ist fehlgeschlagen.') }
    finally { setRunning(false) }
  }

  const stats = result ? [result.stats.inputTokens !== undefined ? `${result.stats.inputTokens} Input-Tokens` : '', result.stats.outputTokens !== undefined ? `${result.stats.outputTokens} Output-Tokens` : '', result.stats.tokensPerSecond !== undefined ? `${result.stats.tokensPerSecond.toFixed(1)} Token/s` : ''].filter(Boolean).join(' · ') : ''
  const providerStatus = definition.kind === 'local'
    ? `${definition.title} verarbeitet die Notiz über ${connection.baseUrl || 'den lokalen Server'}`
    : cloudInWeb ? `Schlüssel wird nur für diese Sitzung über den FaNotes-Proxy an ${definition.title} weitergereicht` : `Direkte verschlüsselte Verbindung zu ${definition.title}`

  return (
    <div className="modal-backdrop lm-studio-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !running) onClose() }}>
      <section className="lm-studio-panel ai-panel" role="dialog" aria-modal="true" aria-labelledby="ai-panel-title">
        <header className="lm-studio-header"><span className="lm-studio-mark"><Bot size={22} /></span><div><span className="eyebrow">Ein Assistent · sechs Anbieter</span><h2 id="ai-panel-title">AI</h2><p>Anbieter und Modell wählen, Aufgaben kombinieren und jede Änderung vor dem Übernehmen prüfen.</p></div><button type="button" className="icon-button" onClick={onClose} disabled={running} aria-label="AI-Menü schließen"><X size={18} /></button></header>
        <div className="lm-studio-body">
          <aside className="lm-studio-config">
            <section className="lm-step ai-provider-step">
              <div className="lm-step-heading"><b>1</b><span><strong>Anbieter wählen</strong><small>Lokal oder Cloud · jederzeit wechselbar</small></span></div>
              <div className="ai-provider-grid" role="tablist" aria-label="AI-Anbieter">
                {PROVIDERS.map((entry) => <button type="button" role="tab" aria-selected={provider === entry.id} className={provider === entry.id ? 'is-selected' : ''} key={entry.id} onClick={() => chooseProvider(entry.id)}><span>{entry.icon}</span><span><strong>{entry.title}</strong><small>{entry.description}</small></span><em>{entry.kind === 'local' ? 'Lokal' : 'Cloud'}</em></button>)}
              </div>
              <div className="ai-connection-head"><span>{definition.icon}</span><div><strong>{getUiLanguage() === 'en' ? `Connect ${definition.title}` : `${definition.title} verbinden`}</strong><small>{definition.kind === 'local' ? 'Deine Notiz bleibt im lokalen Netzwerk.' : 'Die Notiz wird zur Verarbeitung an den gewählten Anbieter übertragen.'}</small></div></div>
              {definition.kind === 'local' && <label className="lm-field"><span>Server-Adresse</span><input value={connection.baseUrl} spellCheck={false} placeholder={provider === 'ollama' ? 'http://127.0.0.1:11434' : provider === 'opencode' ? 'http://127.0.0.1:4096' : 'http://127.0.0.1:1234'} onChange={(event) => updateConnection({ baseUrl: event.target.value })} onBlur={() => persist(connection)} /></label>}
              {provider === 'opencode' && <label className="lm-field"><span>Benutzername <i>Standard: opencode</i></span><input value={connection.username ?? ''} autoComplete="username" onChange={(event) => updateConnection({ username: event.target.value })} onBlur={() => persist(connection)} /></label>}
              <label className="lm-field"><span>{provider === 'opencode' ? 'Server-Passwort' : definition.kind === 'cloud' ? 'API-Schlüssel' : 'API-Token'} <i>{definition.kind === 'local' ? 'optional' : cloudInWeb ? 'nur diese Sitzung' : 'geschützt gespeichert'}</i></span><div className="ai-secret-field"><KeyRound size={13} /><input type="password" value={connection.apiKey} autoComplete="off" placeholder={definition.kind === 'cloud' ? `${definition.title}-Schlüssel eingeben` : 'Nur bei aktivierter Authentifizierung'} onChange={(event) => updateConnection({ apiKey: event.target.value })} onBlur={() => { if (!cloudInWeb) persist(connection) }} /></div></label>
              <div className="lm-model-row"><label className="lm-field"><span>Modell</span><select value={connection.model} disabled={modelsLoading || !models.length} onChange={(event) => updateConnection({ model: event.target.value }, true, !cloudInWeb)}><option value="">Modell auswählen …</option>{models.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.loaded ? '● ' : ''}{candidate.displayName}</option>)}</select></label><button type="button" className="lm-refresh" onClick={() => void loadModels()} disabled={modelsLoading} title="Verbindung prüfen und Modelle laden">{modelsLoading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button></div>
              {selectedModel && <div className="lm-model-card"><span className={selectedModel.loaded ? 'is-loaded' : ''} /><div><strong>{selectedModel.displayName}</strong><small>{modelMeta(selectedModel) || selectedModel.key}</small></div><b>{definition.kind === 'local' ? selectedModel.loaded ? 'bereit' : 'lädt bei Nutzung' : 'API'}</b></div>}
              {cloudInWeb && <div className="ai-privacy-note"><ShieldCheck size={14} /><span><strong>Nicht im Browser gespeichert</strong><small>Der Schlüssel wird vom FaNotes-Server weder protokolliert noch gesichert und verlässt diesen AI-Dialog nach dem Schließen.</small></span></div>}
              {provider === 'opencode' && <div className="ai-privacy-note"><ShieldCheck size={14} /><span><strong>Sicherer Vorschau-Modus</strong><small>Shell-, Datei-, Web- und Agentenwerkzeuge sind deaktiviert; die temporäre OpenCode-Sitzung wird danach gelöscht.</small></span></div>}
            </section>
            <section className="lm-step lm-actions-step"><div className="lm-step-heading"><b>2</b><span><strong>Aktionen kombinieren</strong><small>{actions.size} ausgewählt · Mehrfachauswahl möglich</small></span></div><div className="lm-action-grid">{ACTIONS.map((action) => <button type="button" key={action.id} className={actions.has(action.id) ? 'is-selected' : ''} aria-pressed={actions.has(action.id)} onClick={() => toggleAction(action.id)}><span className="lm-action-icon">{action.icon}</span><span><strong>{action.title}</strong><small>{action.description}</small></span><i>{actions.has(action.id) && <Check size={13} />}</i>{action.additive && <em>ergänzt</em>}</button>)}</div>{actions.has('instruction') && <label className="lm-field lm-instruction"><span>Dein freier Auftrag</span><textarea value={instruction} rows={4} placeholder="Zum Beispiel: Erkläre jeden Fachbegriff einfacher und ergänze pro Abschnitt ein Beispiel …" onChange={(event) => { setInstruction(event.target.value); setResult(null) }} /></label>}{actions.has('facts') && <div className="lm-fact-warning"><CircleAlert size={15} /><span>Die Faktenprüfung verwendet das Modellwissen. FaNotes aktiviert dafür keine Websuche und markiert Unsicherheit, statt Live-Quellen vorzutäuschen.</span></div>}</section>
          </aside>
          <main className="lm-studio-preview"><div className="lm-preview-toolbar"><div><span className="eyebrow">3 · Prüfen</span><strong>{result ? `${definition.title} · Ergebnis` : note ? note.title : 'Keine Notiz geöffnet'}</strong></div>{result && <div className="segmented"><button type="button" className={previewMode === 'rendered' ? 'active' : ''} onClick={() => setPreviewMode('rendered')}>Schön</button><button type="button" className={previewMode === 'source' ? 'active' : ''} onClick={() => setPreviewMode('source')}>Markdown</button></div>}</div>
            <div className="lm-preview-surface">{running ? <div className="lm-processing"><span><LoaderCircle className="spin" size={26} /></span><strong>{selectedModel?.displayName ?? connection.model} arbeitet …</strong><p>{definition.title} führt {actions.size} {actions.size === 1 ? 'Aktion' : 'Aktionen'} gemeinsam aus. Die geöffnete Notiz bleibt bis zur Bestätigung unverändert.</p></div> : result ? previewMode === 'rendered' ? <MarkdownPreview content={result.markdown} /> : <textarea className="lm-result-source" value={result.markdown} readOnly spellCheck={false} /> : <div className="lm-preview-empty"><span><Sparkles size={27} /></span><strong>Deine Notiz bleibt unverändert</strong><p>FaNotes erstellt zuerst eine Vorschau. Erst „Ergebnis übernehmen“ ersetzt den Inhalt der geöffneten Markdown-Datei.</p>{note && <div><small>Aktuelle Notiz</small><b>{note.relativePath}</b><em>{note.markdown.length.toLocaleString(getUiLocale())} Zeichen</em></div>}</div>}</div>
            {error && <div className="lm-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
            <footer className="lm-studio-footer"><div>{result ? <><span><Check size={13} /> Vorschau bereit</span>{stats && <small>{stats}</small>}</> : <><span><ShieldCheck size={13} /> {providerStatus}</span><small>{definition.kind === 'cloud' ? 'Es gelten Datenschutz und Kosten des gewählten Anbieters.' : 'Keine Cloud-Verbindung durch FaNotes.'}</small></>}</div><div>{result && <button type="button" className="secondary-button" onClick={() => setResult(null)}>Neu bearbeiten</button>}{result ? <button type="button" className="primary-button" onClick={() => { onApply(result.markdown, note?.relativePath ?? ''); onClose() }}><Check size={15} /> Ergebnis übernehmen</button> : <button type="button" className="primary-button lm-run" onClick={() => void run()} disabled={running || modelsLoading || !note || !connection.model || !actions.size}>{running ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} Vorschau erzeugen</button>}</div></footer>
          </main>
        </div>
      </section>
    </div>
  )
}

export default AiPanel
