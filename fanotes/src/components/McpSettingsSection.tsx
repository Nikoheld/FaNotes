import { Bot, Check, Copy, Eye, EyeOff, KeyRound, RefreshCw, ShieldCheck, TerminalSquare } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { AppSettings, LocalMcpInfo } from '../types'

type Props = {
  settings: AppSettings
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
}

const REVEAL_MS = 15_000

type Launch = { command: string; args: string[]; env: Record<string, string> }

/** How a client starts the stdio server for this installation. */
export const mcpLaunch = (info: LocalMcpInfo): Launch => {
  const { stdio } = info
  if (stdio.appImage) return { command: stdio.appImage, args: ['--mcp'], env: {} }
  if (stdio.packaged) return { command: stdio.execPath, args: [stdio.entryPath], env: { ELECTRON_RUN_AS_NODE: '1' } }
  return { command: 'node', args: [stdio.entryPath], env: {} }
}

const quote = (value: string) => (/^[\w./:@=+-]+$/u.test(value) ? value : `"${value.replace(/(["\\$`])/gu, '\\$1')}"`)

export const mcpSnippets = (info: LocalMcpInfo, token: string) => {
  const launch = mcpLaunch(info)
  const envEntry = Object.keys(launch.env).length ? { env: launch.env } : {}
  const stdioJson = JSON.stringify({ mcpServers: { fanotes: { command: launch.command, args: launch.args, ...envEntry } } }, null, 2)
  const envFlags = Object.entries(launch.env).map(([key, value]) => `-e ${key}=${value}`).join(' ')
  const claudeCode = `claude mcp add fanotes${envFlags ? ` ${envFlags}` : ''} -- ${[launch.command, ...launch.args].map(quote).join(' ')}`
  const httpJson = JSON.stringify({ mcpServers: { fanotes: { type: 'http', url: info.httpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
  const claudeCodeHttp = `claude mcp add --transport http fanotes ${info.httpUrl} --header "Authorization: Bearer ${token}"`
  return { stdioJson, claudeCode, httpJson, claudeCodeHttp }
}

function Snippet({ label, text, display, getText }: { label: string; text: string; display: string; getText?: () => Promise<string> }) {
  const [copied, setCopied] = useState(false)
  const id = useId()
  return (
    <div className="setting-row">
      <div className="setting-copy"><span id={`${id}-label`}>{label}</span></div>
      <div className="setting-control" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <textarea data-i18n-ignore readOnly rows={Math.min(10, display.split('\n').length + 1)} value={display} aria-label={label} style={{ fontFamily: 'var(--mono-font, monospace)', fontSize: 12 }} />
        <button
          type="button"
          id={`${id}-copy`}
          className="secondary-button"
          aria-labelledby={`${id}-copy ${id}-label`}
          onClick={() => {
            // A snippet with a token fetches it for this one copy only.
            void (getText ? getText() : Promise.resolve(text))
              .then((value) => navigator.clipboard?.writeText(value))
              .then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) })
              .catch(() => undefined)
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Kopiert' : 'Kopieren'}
        </button>
        <span className="sr-only" role="status">{copied ? 'Kopiert' : ''}</span>
      </div>
    </div>
  )
}

export function McpSettingsSection({ settings, update }: Props) {
  const api = typeof window !== 'undefined' ? window.fanotes : undefined
  const [info, setInfo] = useState<LocalMcpInfo | null>(null)
  // The token is held only while the user keeps it visible and is dropped after REVEAL_MS.
  const [revealed, setRevealed] = useState('')
  const [tokenCopied, setTokenCopied] = useState(false)
  const tokenId = useId()
  const [error, setError] = useState('')
  const available = typeof api?.mcpLocal === 'function'

  const fetchToken = useCallback(async () => {
    if (!api?.mcpLocal) throw new Error('unavailable')
    return (await api.mcpLocal({ action: 'reveal' })).token
  }, [api])

  useEffect(() => {
    if (!revealed) return undefined
    const timer = window.setTimeout(() => setRevealed(''), REVEAL_MS)
    return () => { window.clearTimeout(timer); setRevealed('') }
  }, [revealed])

  const load = useCallback(async (action: 'info' | 'regenerate') => {
    if (!api?.mcpLocal) return
    try {
      if (action === 'regenerate') setRevealed('')
      setInfo(await api.mcpLocal({ action }))
      setError('')
    } catch {
      setError('Die Verbindungsdaten konnten nicht geladen werden.')
    }
  }, [api])

  // The HTTP server starts after the settings are saved; ask again shortly after a toggle.
  useEffect(() => {
    void load('info')
    const timer = window.setTimeout(() => void load('info'), 700)
    return () => window.clearTimeout(timer)
  }, [load, settings.mcpEnabled, settings.mcpHttpEnabled])

  const snippets = useMemo(() => (info ? mcpSnippets(info, revealed || '<TOKEN>') : null), [info, revealed])
  const masked = useMemo(() => (info ? mcpSnippets(info, '<TOKEN>') : null), [info])

  if (!available) {
    return (
      <div className="setting-card">
        <div className="setting-card-title"><Bot size={16} /><span>KI-Zugriff (MCP)</span></div>
        <div className="setting-row"><div className="setting-copy"><span>Der lokale MCP-Server gehört zur Desktop-App.</span><small>Im Browser und auf dem Handy ist er nicht verfügbar.</small></div></div>
      </div>
    )
  }

  const toggle = (key: 'mcpEnabled' | 'mcpWriteAccess' | 'mcpHttpEnabled', label: string) => (
    <button type="button" className={`toggle ${settings[key] ? 'is-on' : ''}`} role="switch" aria-checked={settings[key]} aria-label={label} onClick={() => update(key, !settings[key])}><span /></button>
  )

  return (
    <>
      <div id="settings-mcp-local" className="setting-card">
        <div className="setting-card-title"><Bot size={16} /><span>KI-Zugriff (MCP)</span></div>
        <div className="setting-row">
          <div className="setting-copy"><span>KI-Zugriff erlauben</span><small>Ein lokaler MCP-Server liest deinen Vault direkt von dieser Festplatte. KI-Programme wie Claude, Cursor oder ChatGPT können dann Notizen, Aufgaben, Kalender, Karteikarten und Geschichten ansehen. Nichts wird hochgeladen, bis dein KI-Programm es abruft.</small></div>
          <div className="setting-control">{toggle('mcpEnabled', 'KI-Zugriff erlauben')}</div>
        </div>
        <div className="setting-row">
          <div className="setting-copy"><span>Schreibzugriff</span><small>Aus: die KI darf nur lesen. An: sie darf Notizen anlegen, Text an Notizen anhängen sowie Aufgaben hinzufügen und abhaken. Bestehende Notizen werden nie überschrieben.</small></div>
          <div className="setting-control">{toggle('mcpWriteAccess', 'Schreibzugriff')}</div>
        </div>
        <div className="setting-row">
          <div className="setting-copy"><span>Ausgeschlossene Ordner</span><small>Ein Ordner je Zeile, zum Beispiel Privat. Diese Ordner sind für die KI unsichtbar. Das interne Verzeichnis .fanotes ist es immer.</small></div>
          <div className="setting-control"><textarea value={settings.mcpExcludedFolders} rows={3} aria-label="Für die KI ausgeschlossene Ordner" onChange={(event) => update('mcpExcludedFolders', event.target.value)} /></div>
        </div>
        <div className="setting-callout"><ShieldCheck size={15} /> Der Server antwortet nur dir selbst: über stdio nur dem Programm, das ihn startet, über HTTP nur auf 127.0.0.1 mit Token.</div>
      </div>

      <div className="setting-card">
        <div className="setting-card-title"><TerminalSquare size={16} /><span>Verbinden über stdio</span></div>
        {error && <div className="setting-callout" role="alert">{error}</div>}
        {snippets && masked && (
          <>
            <Snippet label="Claude Desktop (claude_desktop_config.json)" text={masked.stdioJson} display={masked.stdioJson} />
            <Snippet label="Claude Code" text={masked.claudeCode} display={masked.claudeCode} />
            <Snippet label="Cursor, ChatGPT Desktop, Grok Build und andere (mcpServers-JSON)" text={masked.stdioJson} display={masked.stdioJson} />
          </>
        )}
      </div>

      <div className="setting-card">
        <div className="setting-card-title"><KeyRound size={16} /><span>Verbinden über HTTP</span></div>
        <div className="setting-row">
          <div className="setting-copy"><span>Lokalen HTTP-Server starten</span><small>Für Programme, die keinen Befehl starten können. Er lauscht nur auf 127.0.0.1 und braucht das Token. Er läuft, solange FaNotes offen ist.</small></div>
          <div className="setting-control">{toggle('mcpHttpEnabled', 'Lokalen HTTP-Server starten')}</div>
        </div>
        {info && settings.mcpEnabled && settings.mcpHttpEnabled && (
          <>
            <div className="setting-row">
              <div className="setting-copy"><span>Adresse</span><small role="status">{info.httpRunning ? 'Der Server läuft.' : info.httpError ? 'Der Server konnte nicht starten.' : 'Der Server startet …'}</small></div>
              <div className="setting-control"><input data-i18n-ignore readOnly value={info.httpUrl} aria-label="Adresse" /></div>
            </div>
            <div className="setting-row">
              <div className="setting-copy"><span id={`${tokenId}-label`}>Token</span><small>Wie ein Passwort behandeln. Neu erzeugen sperrt alle Programme, die das alte Token nutzen.</small></div>
              <div className="setting-control">
                <input id={tokenId} data-i18n-ignore readOnly type={revealed ? 'text' : 'password'} value={revealed || info.httpTokenHint} aria-label="Token" />
                <button type="button" className="secondary-button" aria-controls={tokenId} onClick={() => { if (revealed) setRevealed(''); else void fetchToken().then(setRevealed).catch(() => setError('Das Token konnte nicht geladen werden.')) }}>{revealed ? <EyeOff size={14} /> : <Eye size={14} />} {revealed ? 'Token verbergen' : 'Token anzeigen'}</button>
                <button type="button" id={`${tokenId}-copy`} className="secondary-button" aria-labelledby={`${tokenId}-copy ${tokenId}-label`} onClick={() => void fetchToken().then((token) => navigator.clipboard?.writeText(token)).then(() => { setTokenCopied(true); window.setTimeout(() => setTokenCopied(false), 1500) }).catch(() => undefined)}>{tokenCopied ? <Check size={14} /> : <Copy size={14} />} {tokenCopied ? 'Kopiert' : 'Token kopieren'}</button>
                <span className="sr-only" role="status">{tokenCopied ? 'Kopiert' : ''}</span>
                <button type="button" className="secondary-button" onClick={() => void load('regenerate')}><RefreshCw size={14} /> Neu erzeugen</button>
              </div>
            </div>
            {snippets && masked && (
              <>
                <Snippet label="Claude Code (HTTP)" text={snippets.claudeCodeHttp} display={revealed ? snippets.claudeCodeHttp : masked.claudeCodeHttp} getText={async () => mcpSnippets(info, await fetchToken()).claudeCodeHttp} />
                <Snippet label="Generisches mcpServers-JSON (HTTP)" text={snippets.httpJson} display={revealed ? snippets.httpJson : masked.httpJson} getText={async () => mcpSnippets(info, await fetchToken()).httpJson} />
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}
