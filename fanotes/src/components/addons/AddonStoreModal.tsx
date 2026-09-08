import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ADDON_CATEGORIES, ADDON_PERMISSION_LABELS, type AddonManifest, type AddonPermission } from '../../lib/addons/manifest'
import { addonIndexCache } from '../../lib/addons/indexCache'
import { compareAddonVersions } from '../../lib/addons/manifest'
import { searchAddonEntries, type AddonFetchText, type AddonIndexEntry, type AddonSource } from '../../lib/addons/registry'
import type { AddonRuntime, AddonRuntimeState, AddonStatus, InstalledAddonRecord } from '../../lib/addons/runtime'
import { MarkdownPreview } from '../MarkdownPreview'
import { SafeBoundary } from '../SafeBoundary'

// The Add-on Store: browse the GitHub registry, inspect permissions and
// README, install/update/remove, watch health and logs of installed add-ons,
// and side-load a local add-on while developing one.

type StoreTab = 'discover' | 'installed' | 'develop'

const CATEGORY_LABELS: Record<(typeof ADDON_CATEGORIES)[number], string> = {
  productivity: 'Produktivität',
  writing: 'Schreiben',
  handwriting: 'Handschrift',
  school: 'Schule',
  statistics: 'Statistik',
  export: 'Export',
  integration: 'Integration',
  appearance: 'Darstellung',
  fun: 'Spaß',
  developer: 'Entwickler',
}

const STATE_LABELS: Record<AddonStatus['state'], string> = {
  disabled: 'Deaktiviert',
  starting: 'Startet …',
  running: 'Läuft',
  stopped: 'Gestoppt',
  crashed: 'Abgestürzt',
  incompatible: 'Nicht kompatibel',
}

const ADDONS_DOCS_URL = 'https://github.com/Nikoheld/FaNotes-Addons#readme'

const formatDate = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('de-DE', { year: 'numeric', month: 'short', day: 'numeric' })
}

const initials = (name: string) => name.split(/\s+/u).map((part) => part[0] ?? '').join('').slice(0, 2).toUpperCase() || '?'

const iconCache = new Map<string, string | null>()
const iconInflight = new Set<string>()

const SAFE_SVG = (svg: string) => /<svg[\s>]/iu.test(svg) && !/<script|on[a-z]+\s*=|javascript:|<foreignObject|<iframe|<embed|<object|href\s*=\s*["']?(?!#)/iu.test(svg)

/** Loads an add-on icon once (installed copy first, then the registry) and keeps it as an inert data: image. */
function useAddonIcon(key: string, load: (() => Promise<string | null>) | null) {
  const [svg, setSvg] = useState<string | null>(() => iconCache.get(key) ?? null)
  useEffect(() => {
    if (iconCache.has(key) || iconInflight.has(key) || !load) return
    iconInflight.add(key)
    let cancelled = false
    load().then((text) => {
      const value = text && text.length <= 64_000 && SAFE_SVG(text) ? text : null
      iconCache.set(key, value)
      if (!cancelled) setSvg(value)
    }).catch(() => { iconCache.set(key, null) }).finally(() => { iconInflight.delete(key) })
    return () => { cancelled = true }
  }, [key, load])
  return svg
}

function AddonIcon({ manifest, load }: { manifest: AddonManifest; load?: (() => Promise<string | null>) | null }) {
  const svg = useAddonIcon(`${manifest.id}@${manifest.version}`, manifest.icon ? load ?? null : null)
  const [failed, setFailed] = useState(false)
  if (svg && !failed) return <img className="addon-card__icon" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt="" onError={() => setFailed(true)} />
  return <span className="addon-card__icon addon-card__icon--letters" aria-hidden="true">{initials(manifest.name)}</span>
}

function PermissionList({ permissions, hosts }: { permissions: AddonPermission[]; hosts: string[] }) {
  if (!permissions.length) return <p className="addon-detail__muted">Dieses Add-on braucht keine Berechtigungen.</p>
  return (
    <ul className="addon-permissions">
      {permissions.map((permission) => {
        const info = ADDON_PERMISSION_LABELS[permission]
        return (
          <li key={permission} className={`risk-${info.risk}`}>
            <b>{info.title}</b>
            <span>{info.detail}{permission === 'network' && hosts.length ? ` (${hosts.join(', ')})` : ''}</span>
          </li>
        )
      })}
    </ul>
  )
}

function StatusBadge({ status }: { status: AddonStatus | undefined }) {
  const state = status?.state ?? 'disabled'
  return <span className={`addon-status addon-status--${state}`} title={status?.error ?? undefined}>{STATE_LABELS[state]}</span>
}

type DetailTarget = { entry: AddonIndexEntry | null; record: InstalledAddonRecord | null }

export function AddonStoreModal({ open, onClose, runtime, runtimeState, source, fetchText, onOpenExternal, toast, sourceText, onChangeSource, autoUpdate, onChangeAutoUpdate }: {
  open: boolean
  onClose: () => void
  runtime: AddonRuntime
  runtimeState: AddonRuntimeState
  source: AddonSource
  fetchText: AddonFetchText | null
  onOpenExternal: (url: string) => void
  toast: (message: string, kind?: 'info' | 'success' | 'error') => void
  sourceText: string
  onChangeSource: (value: string) => void
  autoUpdate: boolean
  onChangeAutoUpdate: (value: boolean) => void
}) {
  const [tab, setTab] = useState<StoreTab>('discover')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailTarget | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [readme, setReadme] = useState<{ id: string; text: string | null; error: string | null } | null>(null)
  const [openLogs, setOpenLogs] = useState<string | null>(null)
  const [sourceDraft, setSourceDraft] = useState(sourceText)
  const cache = useSyncExternalStore(addonIndexCache.subscribe, addonIndexCache.getState, addonIndexCache.getState)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modalRef = useRef<HTMLElement>(null)

  useEffect(() => { setSourceDraft(sourceText) }, [sourceText])

  useEffect(() => {
    if (!open || !fetchText) return
    void addonIndexCache.load(source, fetchText)
  }, [fetchText, open, source])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (detail) setDetail(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail, onClose, open])

  const installedById = useMemo(() => new Map(runtimeState.installed.map((record) => [record.id, record])), [runtimeState.installed])
  const entries = useMemo(() => searchAddonEntries(cache.index?.entries ?? [], query, category), [cache.index, category, query])
  const updates = useMemo(() => runtime.updatesFor(cache.index), [cache.index, runtime, runtimeState.installed])
  const updateIds = useMemo(() => new Set(updates.map((update) => update.record.id)), [updates])
  // Store-installed add-ons the registry no longer lists (pulled by the maintainers or renamed): the user should know updates stopped.
  const withdrawnIds = useMemo(() => {
    const index = cache.index
    if (!index || index.origin !== 'index' || !index.entries.length) return new Set<string>()
    const listed = new Set(index.entries.map((entry) => entry.manifest.id))
    return new Set(runtimeState.installed.filter((record) => record.origin === 'store' && !listed.has(record.id)).map((record) => record.id))
  }, [cache.index, runtimeState.installed])

  const refresh = useCallback(() => {
    if (!fetchText) return
    void addonIndexCache.load(source, fetchText, { force: true })
  }, [fetchText, source])

  const install = useCallback(async (entry: AddonIndexEntry) => {
    if (!fetchText) return
    setBusy(entry.manifest.id)
    try {
      await runtime.install(entry, fetchText)
      toast(`${entry.manifest.name} wurde installiert.`, 'success')
    } catch (error) {
      toast(`${entry.manifest.name}: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setBusy(null)
    }
  }, [fetchText, runtime, toast])

  const uninstall = useCallback(async (record: InstalledAddonRecord) => {
    setBusy(record.id)
    try {
      await runtime.uninstall(record.id)
      toast(`${record.manifest.name} wurde entfernt.`, 'info')
      setDetail((current) => (current?.record?.id === record.id ? null : current))
    } finally {
      setBusy(null)
    }
  }, [runtime, toast])

  const updateAll = useCallback(async () => {
    for (const update of updates) await install(update.entry)
  }, [install, updates])

  const openDetail = useCallback(async (target: DetailTarget) => {
    setDetail(target)
    const id = target.entry?.manifest.id ?? target.record?.id ?? ''
    setReadme({ id, text: null, error: null })
    try {
      let text: string | null = null
      if (target.record) text = await runtime.readInstalledFile(target.record.id, 'README.md')
      if (!text && target.entry && fetchText) text = await fetchText(target.entry.readmeUrl)
      setReadme({ id, text: text ?? '', error: null })
    } catch (error) {
      setReadme({ id, text: '', error: error instanceof Error ? error.message : String(error) })
    }
  }, [fetchText, runtime])

  const iconLoader = useCallback((record: InstalledAddonRecord | null, entry: AddonIndexEntry | null) => {
    if (record?.manifest.icon) return () => runtime.readInstalledFile(record.id, 'icon.svg')
    if (entry?.iconUrl && fetchText) {
      const url = entry.iconUrl
      return () => fetchText(url)
    }
    return null
  }, [fetchText, runtime])

  const loadLocalFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return
    const byName = new Map<string, File>()
    for (const file of Array.from(files)) byName.set(file.name.toLowerCase(), file)
    const manifest = byName.get('manifest.json')
    const main = byName.get('main.js')
    if (!manifest || !main) {
      toast('Bitte manifest.json und main.js gemeinsam auswählen.', 'error')
      return
    }
    try {
      const record = await runtime.installLocal({
        manifest: await manifest.text(),
        main: await main.text(),
        readme: byName.has('readme.md') ? await byName.get('readme.md')!.text() : undefined,
      })
      toast(`${record.manifest.name} wurde lokal geladen.`, 'success')
      setTab('installed')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [runtime, toast])

  if (!open) return null

  const activeDetailStatus = detail?.record ? runtimeState.statuses[detail.record.id] : undefined

  const renderDetail = (target: DetailTarget) => {
    const manifest = target.record?.manifest ?? target.entry!.manifest
    const installed = installedById.get(manifest.id) ?? target.record
    const entry = target.entry ?? cache.index?.entries.find((candidate) => candidate.manifest.id === manifest.id) ?? null
    const canUpdate = installed && entry ? compareAddonVersions(entry.manifest.version, installed.manifest.version) > 0 : false
    const isBusy = busy === manifest.id
    return (
      <div className="addon-detail">
        <button type="button" className="addon-detail__back" onClick={() => setDetail(null)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
          Zurück zur Übersicht
        </button>
        <header className="addon-detail__header">
          <AddonIcon manifest={manifest} load={iconLoader(installed ?? null, entry)} />
          <div>
            <h3 data-i18n-ignore>{manifest.name}</h3>
            <p data-i18n-ignore>
              v{manifest.version} · {manifest.author.name}
              {manifest.license ? ` · ${manifest.license}` : ''}
              {installed ? ` · installiert am ${formatDate(installed.installedAt)}` : ''}
            </p>
            <p className="addon-detail__description" data-i18n-ignore>{manifest.description}</p>
          </div>
          <div className="addon-detail__actions">
            {installed ? (
              <>
                <label className="addon-toggle" title={installed.enabled ? 'Deaktivieren' : 'Aktivieren'}>
                  <input type="checkbox" checked={installed.enabled} onChange={(event) => void runtime.setEnabled(installed.id, event.target.checked)} />
                  <span>{installed.enabled ? 'Aktiv' : 'Aus'}</span>
                </label>
                {canUpdate && entry ? <button type="button" className="addon-btn addon-btn--primary" disabled={isBusy} onClick={() => void install(entry)}>Auf v{entry.manifest.version} aktualisieren</button> : null}
                <button type="button" className="addon-btn" disabled={isBusy} onClick={() => void runtime.restart(installed.id)}>Neu starten</button>
                <button type="button" className="addon-btn addon-btn--danger" disabled={isBusy} onClick={() => void uninstall(installed)}>Entfernen</button>
              </>
            ) : entry ? (
              <button type="button" className="addon-btn addon-btn--primary" disabled={isBusy || !fetchText} onClick={() => void install(entry)}>{isBusy ? 'Wird installiert …' : 'Installieren'}</button>
            ) : null}
          </div>
        </header>
        {installed ? (
          <div className="addon-detail__status">
            <StatusBadge status={activeDetailStatus ?? runtimeState.statuses[installed.id]} />
            {runtimeState.statuses[installed.id]?.error ? <span className="addon-detail__error" data-i18n-ignore>{runtimeState.statuses[installed.id]?.error}</span> : null}
            <span className="addon-detail__muted">{runtimeState.statuses[installed.id]?.calls ?? 0} API-Aufrufe · {runtimeState.statuses[installed.id]?.errorCount ?? 0} Fehler · {runtimeState.statuses[installed.id]?.restarts ?? 0} Neustarts</span>
          </div>
        ) : null}
        <section className="addon-detail__section">
          <h4>Berechtigungen</h4>
          <PermissionList permissions={manifest.permissions} hosts={manifest.networkHosts} />
          <p className="addon-detail__muted">Add-ons laufen in einem eigenen Worker ohne Zugriff auf Fenster, Dateien oder Netzwerk. Sie erreichen FaNotes nur über die oben genannten Berechtigungen; jeder Aufruf wird geprüft und begrenzt.</p>
        </section>
        <section className="addon-detail__section">
          <h4>Beschreibung</h4>
          {readme?.id === manifest.id && readme.text === null ? <p className="addon-detail__muted">README wird geladen …</p> : null}
          {readme?.id === manifest.id && readme.error ? <p className="addon-detail__muted">README konnte nicht geladen werden: {readme.error}</p> : null}
          {readme?.id === manifest.id && readme.text ? (
            <SafeBoundary name="Add-on-README" fallbackTitle="README konnte nicht dargestellt werden">
              <div data-i18n-ignore><MarkdownPreview content={readme.text} className="addon-detail__readme" onOpenLink={(href) => { if (/^https:\/\//iu.test(href)) onOpenExternal(href) }} /></div>
            </SafeBoundary>
          ) : null}
          {readme?.id === manifest.id && readme.text === '' && !readme.error ? <p className="addon-detail__muted">Dieses Add-on hat keine README.</p> : null}
        </section>
        <section className="addon-detail__section addon-detail__links">
          {entry?.pageUrl ? <button type="button" className="addon-link" onClick={() => onOpenExternal(entry.pageUrl!)}>Quellcode auf GitHub</button> : null}
          {manifest.homepage ? <button type="button" className="addon-link" onClick={() => onOpenExternal(manifest.homepage!)}>Homepage</button> : null}
          {manifest.author.url ? <button type="button" className="addon-link" onClick={() => onOpenExternal(manifest.author.url!)}>Autor</button> : null}
          <span className="addon-detail__muted" data-i18n-ignore>ID: {manifest.id}{manifest.keywords.length ? ` · ${manifest.keywords.join(', ')}` : ''}</span>
        </section>
        {installed ? (
          <section className="addon-detail__section">
            <div className="addon-detail__log-head">
              <h4>Protokoll</h4>
              <button type="button" className="addon-link" onClick={() => runtime.clearLogs(installed.id)}>Leeren</button>
            </div>
            <LogList status={runtimeState.statuses[installed.id]} />
          </section>
        ) : null}
      </div>
    )
  }

  const renderDiscover = () => (
    <>
      <div className="addon-store__filters">
        <button type="button" className={`addon-chip${category === null ? ' is-active' : ''}`} onClick={() => setCategory(null)}>Alle</button>
        {ADDON_CATEGORIES.map((item) => (
          <button key={item} type="button" className={`addon-chip${category === item ? ' is-active' : ''}`} onClick={() => setCategory(category === item ? null : item)}>{CATEGORY_LABELS[item]}</button>
        ))}
      </div>
      {!fetchText ? <p className="addon-store__notice">Der Add-on-Store steht in dieser Umgebung nicht zur Verfügung.</p> : null}
      {cache.loading && !cache.index ? <p className="addon-store__notice">Add-ons werden von GitHub geladen …</p> : null}
      {cache.error && !cache.index?.entries.length ? (
        <div className="addon-store__notice addon-store__notice--error">
          <b>Die Add-on-Liste konnte nicht geladen werden.</b>
          <span data-i18n-ignore>{cache.error}</span>
          <span>Prüfe die Internetverbindung oder die Quelle unter „Entwickeln“. Bereits installierte Add-ons funktionieren weiter.</span>
        </div>
      ) : null}
      {cache.index && !cache.index.entries.length && !cache.error ? <p className="addon-store__notice">Die Quelle enthält noch keine Add-ons. Sobald ein Pull Request in {source.label} gemerged wurde, erscheint das Add-on hier – ohne FaNotes-Update.</p> : null}
      {cache.index?.problems.length ? (
        <details className="addon-store__problems">
          <summary>{cache.index.problems.length} Einträge wurden übersprungen</summary>
          <ul data-i18n-ignore>{cache.index.problems.slice(0, 20).map((problem, index) => <li key={index}>{problem}</li>)}</ul>
        </details>
      ) : null}
      <div className="addon-grid">
        {entries.map((entry) => {
          const installed = installedById.get(entry.manifest.id)
          const isBusy = busy === entry.manifest.id
          return (
            <article key={entry.manifest.id} className="addon-card" onClick={() => void openDetail({ entry, record: installed ?? null })}>
              <AddonIcon manifest={entry.manifest} load={iconLoader(installed ?? null, entry)} />
              <div className="addon-card__body">
                <h3 data-i18n-ignore>{entry.manifest.name}</h3>
                <p className="addon-card__meta" data-i18n-ignore>v{entry.manifest.version} · {entry.manifest.author.name}</p>
                <p className="addon-card__description" data-i18n-ignore>{entry.manifest.description}</p>
                <div className="addon-card__tags">
                  {entry.manifest.categories.map((item) => <span key={item} className="addon-tag">{CATEGORY_LABELS[item]}</span>)}
                  {entry.manifest.permissions.length ? <span className="addon-tag addon-tag--muted">{entry.manifest.permissions.length} Berechtigungen</span> : <span className="addon-tag addon-tag--muted">Keine Berechtigungen</span>}
                </div>
              </div>
              <div className="addon-card__action" onClick={(event) => event.stopPropagation()}>
                {installed ? (
                  updateIds.has(installed.id)
                    ? <button type="button" className="addon-btn addon-btn--primary" disabled={isBusy} onClick={() => void install(entry)}>Aktualisieren</button>
                    : <span className="addon-card__installed">Installiert</span>
                ) : (
                  <button type="button" className="addon-btn addon-btn--primary" disabled={isBusy || !fetchText} onClick={() => void install(entry)}>{isBusy ? '…' : 'Installieren'}</button>
                )}
              </div>
            </article>
          )
        })}
      </div>
      {cache.index && entries.length === 0 && cache.index.entries.length > 0 ? <p className="addon-store__notice">Kein Add-on passt zu dieser Suche.</p> : null}
    </>
  )

  const renderInstalled = () => (
    <>
      {updates.length ? (
        <div className="addon-store__notice addon-store__notice--update">
          <span>{updates.length === 1 ? 'Ein Update ist verfügbar.' : `${updates.length} Updates sind verfügbar.`}</span>
          <button type="button" className="addon-btn addon-btn--primary" disabled={busy !== null} onClick={() => void updateAll()}>Alle aktualisieren</button>
        </div>
      ) : null}
      {runtimeState.installed.length === 0 ? (
        <div className="addon-store__empty">
          <b>Noch keine Add-ons installiert.</b>
          <span>Stöbere unter „Entdecken“ – jedes Add-on läuft isoliert und lässt sich jederzeit wieder entfernen.</span>
          <button type="button" className="addon-btn addon-btn--primary" onClick={() => setTab('discover')}>Add-ons entdecken</button>
        </div>
      ) : null}
      <div className="addon-list">
        {runtimeState.installed.map((record) => {
          const status = runtimeState.statuses[record.id]
          const panels = runtimeState.panels.filter((panel) => panel.addonId === record.id)
          const commands = runtimeState.commands.filter((command) => command.addonId === record.id)
          const logsOpen = openLogs === record.id
          return (
            <article key={record.id} className={`addon-row${status?.state === 'crashed' ? ' is-crashed' : ''}`}>
              <div className="addon-row__main" role="button" tabIndex={0} onClick={() => void openDetail({ entry: null, record })} onKeyDown={(event) => { if (event.key === 'Enter') void openDetail({ entry: null, record }) }}>
                <AddonIcon manifest={record.manifest} load={iconLoader(record, null)} />
                <div>
                  <h3 data-i18n-ignore>{record.manifest.name} <small>v{record.manifest.version}</small>{record.origin === 'local' ? <span className="addon-tag addon-tag--muted">lokal</span> : null}</h3>
                  <p data-i18n-ignore>{record.manifest.description}</p>
                  <div className="addon-row__facts">
                    <StatusBadge status={status} />
                    {updateIds.has(record.id) ? <span className="addon-tag addon-tag--update">Update verfügbar</span> : null}
                    {withdrawnIds.has(record.id) ? <span className="addon-tag addon-tag--warn" title="Das Add-on steht nicht mehr im Verzeichnis. Es läuft weiter, bekommt aber keine Updates mehr.">Nicht mehr im Verzeichnis</span> : null}
                    {commands.length ? <span className="addon-tag addon-tag--muted">{commands.length} Befehle</span> : null}
                    {panels.length ? <span className="addon-tag addon-tag--muted">{panels.length} Panels</span> : null}
                  </div>
                  {status?.error ? <p className="addon-row__error" data-i18n-ignore>{status.error}</p> : null}
                </div>
              </div>
              <div className="addon-row__actions">
                <label className="addon-toggle" title={record.enabled ? 'Deaktivieren' : 'Aktivieren'}>
                  <input type="checkbox" checked={record.enabled} onChange={(event) => void runtime.setEnabled(record.id, event.target.checked)} />
                  <span>{record.enabled ? 'Aktiv' : 'Aus'}</span>
                </label>
                {panels.length ? <button type="button" className="addon-btn" onClick={() => { runtime.setActivePanel(`${panels[0].addonId}/${panels[0].id}`); onClose() }}>Panel zeigen</button> : null}
                {status?.state === 'crashed' || status?.state === 'stopped' ? <button type="button" className="addon-btn" onClick={() => void runtime.restart(record.id)}>Neu starten</button> : null}
                <button type="button" className="addon-btn" onClick={() => setOpenLogs(logsOpen ? null : record.id)}>{logsOpen ? 'Protokoll ausblenden' : 'Protokoll'}</button>
                <button type="button" className="addon-btn addon-btn--danger" disabled={busy === record.id} onClick={() => void uninstall(record)}>Entfernen</button>
              </div>
              {logsOpen ? <div className="addon-row__logs"><LogList status={status} /></div> : null}
            </article>
          )
        })}
      </div>
    </>
  )

  const renderDevelop = () => (
    <div className="addon-develop">
      <section className="addon-detail__section">
        <h4>Eigenes Add-on veröffentlichen</h4>
        <ol className="addon-develop__steps">
          <li>Forke <b data-i18n-ignore>{source.label}</b> und lege einen Ordner <code>addons/&lt;deine-id&gt;/</code> mit <code>manifest.json</code>, <code>main.js</code> und <code>README.md</code> an.</li>
          <li>Teste es hier über „Lokal laden“ – FaNotes startet es sofort im isolierten Worker.</li>
          <li>Öffne einen Pull Request. Die Prüfung im Repository validiert Manifest, Größe und Syntax; nach dem Merge wird der Index automatisch neu gebaut und das Add-on erscheint bei allen Nutzern – ganz ohne FaNotes-Update.</li>
        </ol>
        <div className="addon-develop__actions">
          <button type="button" className="addon-btn addon-btn--primary" onClick={() => fileInputRef.current?.click()}>Lokal laden (manifest.json + main.js)</button>
          <input ref={fileInputRef} type="file" multiple accept=".json,.js,.md" hidden onChange={(event) => { void loadLocalFiles(event.target.files); event.target.value = '' }} />
          <button type="button" className="addon-btn" onClick={() => onOpenExternal(ADDONS_DOCS_URL)}>Dokumentation und Beispiele</button>
          {source.repoUrl ? <button type="button" className="addon-btn" onClick={() => onOpenExternal(source.repoUrl!)}>Repository öffnen</button> : null}
        </div>
      </section>
      <section className="addon-detail__section">
        <h4>Minimales Add-on</h4>
        <pre className="addon-develop__code" data-i18n-ignore>{`// main.js – läuft in einem Worker, "fanotes" ist global verfügbar
fanotes.commands.register({
  id: 'hello',
  title: 'Hallo sagen',
  run: async () => {
    const note = await fanotes.notes.active()
    await fanotes.ui.toast(note ? 'Hallo aus ' + note.title : 'Keine Notiz offen')
  },
})`}</pre>
        <pre className="addon-develop__code" data-i18n-ignore>{`// manifest.json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "description": "Sagt Hallo aus der Befehlspalette.",
  "author": { "name": "Dein Name" },
  "api": 1,
  "permissions": ["commands", "ui", "notes:read"],
  "categories": ["developer"]
}`}</pre>
      </section>
      <section className="addon-detail__section">
        <h4>Quelle</h4>
        <p className="addon-detail__muted">GitHub-Repository als <code>besitzer/repo</code>, optional <code>#branch</code>, oder die https-Adresse einer index.json. Standard: <code>Nikoheld/FaNotes-Addons#main</code>.</p>
        <div className="addon-develop__source">
          <input data-i18n-ignore type="text" value={sourceDraft} spellCheck={false} onChange={(event) => setSourceDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onChangeSource(sourceDraft.trim()) }} />
          <button type="button" className="addon-btn" disabled={sourceDraft.trim() === sourceText} onClick={() => onChangeSource(sourceDraft.trim())}>Übernehmen</button>
          <button type="button" className="addon-btn" onClick={() => { setSourceDraft('Nikoheld/FaNotes-Addons#main'); onChangeSource('Nikoheld/FaNotes-Addons#main') }}>Standard</button>
        </div>
        <label className="addon-toggle addon-toggle--row">
          <input type="checkbox" checked={autoUpdate} onChange={(event) => onChangeAutoUpdate(event.target.checked)} />
          <span>Installierte Add-ons beim Start automatisch aktualisieren</span>
        </label>
      </section>
    </div>
  )

  return (
    <div className="modal-backdrop addon-store-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={modalRef} className="addon-store" role="dialog" aria-modal="true" aria-label="Add-on-Store" onMouseDown={(event) => event.stopPropagation()}>
        <header className="addon-store__header">
          <div className="addon-store__title">
            <h2>Add-on-Store</h2>
            <p>
              Quelle: <button type="button" className="addon-link" data-i18n-ignore onClick={() => { if (source.repoUrl) onOpenExternal(source.repoUrl) }}>{source.label}</button>
              {cache.index?.origin === 'listing' ? ' · Ordnerliste (index.json fehlt noch)' : ''}
            </p>
          </div>
          <nav className="addon-store__tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'discover'} className={tab === 'discover' ? 'is-active' : ''} onClick={() => { setTab('discover'); setDetail(null) }}>Entdecken</button>
            <button type="button" role="tab" aria-selected={tab === 'installed'} className={tab === 'installed' ? 'is-active' : ''} onClick={() => { setTab('installed'); setDetail(null) }}>
              Installiert{runtimeState.installed.length ? <span className="addon-store__count">{runtimeState.installed.length}</span> : null}
              {updates.length ? <span className="addon-store__count addon-store__count--update" title="Updates verfügbar">{updates.length}</span> : null}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'develop'} className={tab === 'develop' ? 'is-active' : ''} onClick={() => { setTab('develop'); setDetail(null) }}>Entwickeln</button>
          </nav>
          <div className="addon-store__tools">
            {tab === 'discover' && !detail ? (
              <input
                data-i18n-ignore
                type="search"
                className="addon-store__search"
                placeholder="Add-ons durchsuchen …"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoFocus
              />
            ) : null}
            <button type="button" className="addon-dock__icon-btn" title="Liste neu laden" aria-label="Liste neu laden" disabled={cache.loading} onClick={refresh}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></svg>
            </button>
            <button type="button" className="addon-dock__icon-btn" title="Schließen" aria-label="Schließen" onClick={onClose}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        </header>
        <div className="addon-store__body">
          <SafeBoundary name="Add-on-Store" fallbackTitle="Der Add-on-Store ist abgestürzt">
            {detail ? renderDetail(detail) : tab === 'discover' ? renderDiscover() : tab === 'installed' ? renderInstalled() : renderDevelop()}
          </SafeBoundary>
        </div>
      </section>
    </div>
  )
}

function LogList({ status }: { status: AddonStatus | undefined }) {
  const logs = status?.logs ?? []
  if (!logs.length) return <p className="addon-detail__muted">Noch keine Einträge.</p>
  return (
    <ul className="addon-log" data-i18n-ignore>
      {logs.slice(-80).reverse().map((entry, index) => (
        <li key={`${entry.at}-${index}`} className={`level-${entry.level}`}>
          <time>{new Date(entry.at).toLocaleTimeString('de-DE')}</time>
          <span>{entry.text}</span>
        </li>
      ))}
    </ul>
  )
}
