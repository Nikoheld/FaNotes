import {
  Accessibility,
  Brush,
  Check,
  ChevronRight,
  Cloud,
  Code2,
  Copy,
  Cpu,
  Database,
  Download,
  FileInput,
  FileText,
  FolderOpen,
  Keyboard,
  KeyRound,
  LayoutTemplate,
  LoaderCircle,
  MemoryStick,
  NotebookTabs,
  Palette,
  RefreshCw,
  RotateCcw,
  Rocket,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TriangleAlert,
  UploadCloud,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getUiLocale } from '../i18n'
import { bestContrastText } from '../lib/colorContrast'
import type { AppSettings, OneNoteImportResult, ServerBackupState, UpdateState } from '../types'

type SettingsSection = 'appearance' | 'editor' | 'drawing' | 'files' | 'updates' | 'accessibility' | 'advanced'

export type SettingsModalProps = {
  platform?: string
  settings: AppSettings
  vaultPath: string
  onChange: (settings: AppSettings) => void
  onClose: () => void
  onSelectVault: () => void
  onOpenGlyphenWerk?: () => void
  onImportTraining?: (file: File) => Promise<void>
  onImportOneNote?: () => Promise<OneNoteImportResult | null>
  updateState: UpdateState
  onCheckUpdate: () => Promise<void>
  onDownloadUpdate: () => Promise<void>
  onInstallUpdate: () => Promise<void>
  onResetSettings: () => void
  onResetAppData: () => Promise<void>
}

const SECTIONS: { id: SettingsSection; label: string; description: string; icon: typeof Palette; count: number }[] = [
  { id: 'appearance', label: 'Darstellung', description: 'Farben, Schriften und Dichte', icon: Palette, count: 12 },
  { id: 'editor', label: 'Editor', description: 'Markdown und Schreiben', icon: FileText, count: 7 },
  { id: 'drawing', label: 'Stift & Erkennung', description: 'Tablet, Papier und Handschrift', icon: Brush, count: 14 },
  { id: 'files', label: 'Dateien & Vault', description: 'Import, Ordner und Speichern', icon: FolderOpen, count: 7 },
  { id: 'updates', label: 'Updates', description: 'Stable, Beta und Sicherheit', icon: RefreshCw, count: 4 },
  { id: 'accessibility', label: 'Bedienung', description: 'Bewegung und Lesbarkeit', icon: Accessibility, count: 3 },
  { id: 'advanced', label: 'Erweitert', description: 'Ressourcen, Datenschutz und App-Daten', icon: Code2, count: 9 },
]

const SECTION_GROUPS: Array<{ label: string; sections: SettingsSection[] }> = [
  { label: 'Aussehen & Schreiben', sections: ['appearance', 'editor'] },
  { label: 'Stift & Arbeitsbereich', sections: ['drawing', 'files'] },
  { label: 'FaNotes & System', sections: ['updates', 'accessibility', 'advanced'] },
]

type SettingsSearchItem = {
  label: string
  detail: string
  section: SettingsSection
  target: string
  keywords: string
}

const SETTINGS_SEARCH_ITEMS: SettingsSearchItem[] = [
  { label: 'App-Sprache', detail: 'Darstellung', section: 'appearance', target: 'settings-surface', keywords: 'sprache language system deutsch englisch english' },
  { label: 'Farbschema & Themes', detail: 'Darstellung', section: 'appearance', target: 'settings-surface', keywords: 'theme dunkel hell system graphit klar mitternacht wald aurora sepia farbe' },
  { label: 'Arbeitsflächen-Design', detail: 'Darstellung', section: 'appearance', target: 'settings-surface', keywords: 'hintergrund verlauf mesh papier clean' },
  { label: 'Akzentfarben', detail: 'Darstellung', section: 'appearance', target: 'settings-surface', keywords: 'farbe primär sekundär eigene accent' },
  { label: 'Kompakte Oberfläche', detail: 'Darstellung', section: 'appearance', target: 'settings-surface', keywords: 'dichte platz klein kompakt' },
  { label: 'Glas-Effekte', detail: 'Darstellung', section: 'appearance', target: 'settings-surface', keywords: 'transparenz blur unschärfe glass' },
  { label: 'Schriften & Textgrößen', detail: 'Darstellung', section: 'appearance', target: 'settings-typography', keywords: 'typografie font editor schrift zeilenhöhe vorschau' },
  { label: 'Inhaltsbreite & Zeilenlänge', detail: 'Editor', section: 'editor', target: 'settings-editor', keywords: 'breite lesen zeile word seite' },
  { label: 'Rechtschreibprüfung', detail: 'Editor', section: 'editor', target: 'settings-editor', keywords: 'rechtschreibung sprache deutsch englisch rot unterstreichen fehler spellcheck' },
  { label: 'Zeilennummern, Wortzahl & Gliederung', detail: 'Editor', section: 'editor', target: 'settings-editor', keywords: 'statusleiste outline struktur markdown' },
  { label: 'GlyphenWerk & Training', detail: 'Stift & Erkennung', section: 'drawing', target: 'settings-glyphenwerk', keywords: 'handschrift trainieren import zip symbole mathematik' },
  { label: 'Papier & Stift', detail: 'Stift & Erkennung', section: 'drawing', target: 'settings-tablet', keywords: 'tablet karos linien punkte farbe breite druck glättung' },
  { label: 'Durchkritzel-Empfindlichkeit', detail: 'Stift & Erkennung', section: 'drawing', target: 'settings-tablet', keywords: 'löschen radierer scribble sensitivity' },
  { label: 'Handschrifterkennung', detail: 'Stift & Erkennung', section: 'drawing', target: 'settings-recognition', keywords: 'ocr text mathematik automatisch sprache konvertieren suchindex' },
  { label: 'Vault & Speicherort', detail: 'Dateien & Vault', section: 'files', target: 'settings-vault', keywords: 'ordner wechseln pfad notizen markdown nas browser' },
  { label: 'Microsoft OneNote importieren', detail: 'Dateien & Vault', section: 'files', target: 'settings-onenote', keywords: 'one onetoc2 onepkg onedrive zip notizbuch migration' },
  { label: 'Server-Backup', detail: 'Dateien & Vault', section: 'files', target: 'settings-backup', keywords: 'sicherung cloud wiederherstellen recovery kopie' },
  { label: 'Automatisches Speichern', detail: 'Dateien & Vault', section: 'files', target: 'settings-files', keywords: 'autosave verzögerung dateiverhalten' },
  { label: 'Standardordner & Tagesnotizen', detail: 'Dateien & Vault', section: 'files', target: 'settings-files', keywords: 'daily notes datum format folder' },
  { label: 'Automatische Updates', detail: 'Updates', section: 'updates', target: 'settings-update-automation', keywords: 'download installieren starten prüfen version delta' },
  { label: 'Stable- oder Beta-Kanal', detail: 'Updates', section: 'updates', target: 'settings-update-channel', keywords: 'stable beta prerelease vorabversion kanal channel release' },
  { label: 'Update-Sicherheit', detail: 'Updates', section: 'updates', target: 'settings-update-security', keywords: 'signatur sha ed25519 integrität differenziell' },
  { label: 'Bewegung reduzieren', detail: 'Bedienung', section: 'accessibility', target: 'settings-comfort', keywords: 'animation transition barrierefrei fokus' },
  { label: 'Seitenleisten-Breite', detail: 'Bedienung', section: 'accessibility', target: 'settings-comfort', keywords: 'sidebar informationsleiste panel breite layout' },
  { label: 'RAM- und Leistungslimits', detail: 'Erweitert', section: 'advanced', target: 'settings-resources', keywords: 'ram speicher memory cpu kerne threads leistung performance energie hintergrund modell cache' },
  { label: 'Anonyme Nutzungsstatistik', detail: 'Erweitert', section: 'advanced', target: 'settings-privacy', keywords: 'datenschutz statistik anonym land app start downloads analytics privacy' },
  { label: 'Eigenes CSS', detail: 'Erweitert', section: 'advanced', target: 'settings-css', keywords: 'custom style design code variablen' },
  { label: 'Vim-Modus', detail: 'Erweitert', section: 'advanced', target: 'settings-vim', keywords: 'tastatur keyboard shortcuts' },
  { label: 'App-Daten zurücksetzen', detail: 'Erweitert', section: 'advanced', target: 'settings-reset', keywords: 'reset löschen cache ausgangszustand werkseinstellung' },
]

const normalizeSearch = (value: string) => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/gu, '')
  .replace(/ß/gu, 'ss')
  .toLocaleLowerCase('de-CH')
  .trim()

const ACCENTS = ['#8b7cff', '#6f8cff', '#45c9b7', '#ef7aa8', '#f09a5d', '#b878eb', '#d4b54c']
const THEMES: Array<{
  id: AppSettings['theme']
  label: string
  detail: string
  background: string
  surface: string
  accent: string
  secondary: string
}> = [
  { id: 'system', label: 'System', detail: 'Automatisch', background: 'linear-gradient(135deg,#171821 50%,#f4f3f7 50%)', surface: '#8b7cff', accent: '#8b7cff', secondary: '#45c9b7' },
  { id: 'dark', label: 'Graphit', detail: 'Ruhig & dunkel', background: '#0e0f14', surface: '#1d1e28', accent: '#8b7cff', secondary: '#45c9b7' },
  { id: 'light', label: 'Klar', detail: 'Hell & neutral', background: '#f4f3f7', surface: '#ffffff', accent: '#566ad7', secondary: '#2c8177' },
  { id: 'midnight', label: 'Mitternacht', detail: 'Tiefblau', background: '#080d1b', surface: '#121a2d', accent: '#6d8dff', secondary: '#44d6c6' },
  { id: 'forest', label: 'Wald', detail: 'Moos & Tinte', background: '#0d1512', surface: '#17231d', accent: '#52c98a', secondary: '#c9b85a' },
  { id: 'aurora', label: 'Aurora', detail: 'Violett & Cyan', background: '#100d1b', surface: '#211a31', accent: '#b078ff', secondary: '#4fd6d2' },
  { id: 'sepia', label: 'Studierzimmer', detail: 'Warm & papiernah', background: '#f2eadc', surface: '#fffaf0', accent: '#91562f', secondary: '#806326' },
]

const BACKGROUNDS: Array<{ id: AppSettings['workspaceBackground']; label: string }> = [
  { id: 'clean', label: 'Klar' },
  { id: 'gradient', label: 'Verlauf' },
  { id: 'mesh', label: 'Aurora' },
  { id: 'paper', label: 'Papier' },
]

const DISABLED_BACKUP_STATE: ServerBackupState = {
  supported: true,
  enabled: false,
  status: 'disabled',
  lastBackupAt: null,
  sizeBytes: 0,
  recoveryCode: null,
  automatic: false,
  error: null,
}

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '–'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${new Intl.NumberFormat(getUiLocale(), { maximumFractionDigits: exponent > 1 ? 1 : 0 }).format(bytes / 1024 ** exponent)} ${units[exponent]}`
}

const updateStatusText = (state: UpdateState, isWeb = false) => {
  if (isWeb && state.status === 'checking') return 'Web-Version wird geprüft …'
  if (isWeb && state.status === 'available') return `FaNotes Web ${state.latestVersion} ist verfügbar`
  if (isWeb && state.status === 'downloaded') return 'Neue Web-Version ist bereit'
  if (isWeb && state.status === 'installing') return 'Web-App wird neu geladen …'
  if (isWeb && state.status === 'up-to-date') return `FaNotes Web ${state.currentVersion} ist aktuell`
  if (isWeb && state.status === 'error') return 'Web-Version konnte nicht geprüft werden'
  if (isWeb) return 'Web-App lädt Aktualisierungen automatisch'
  if (!state.supported) return 'In der installierten Linux-App aktiv'
  if (state.status === 'checking') return 'Suche nach einer neuen Version …'
  if (state.status === 'available') return `FaNotes ${state.latestVersion} ist verfügbar`
  if (state.status === 'downloading') return `Update wird geladen · ${Math.round(state.progress * 100)} %`
  if (state.status === 'downloaded') return `FaNotes ${state.latestVersion} ist installationsbereit`
  if (state.status === 'installing') return 'Update wird beim Neustart installiert …'
  if (state.status === 'up-to-date') return `FaNotes ${state.currentVersion} ist aktuell`
  if (state.status === 'error') return 'Updateprüfung benötigt Aufmerksamkeit'
  return 'Automatische Updateprüfung ist bereit'
}

const SettingRow = ({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) => (
  <div className="setting-row">
    <div className="setting-copy">
      <span>{title}</span>
      {description && <small>{description}</small>}
    </div>
    <div className="setting-control">{children}</div>
  </div>
)

const Toggle = ({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) => (
  <button
    type="button"
    className={`toggle ${checked ? 'is-on' : ''}`}
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
  >
    <span />
  </button>
)

const Range = ({
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
}: {
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onChange: (value: number) => void
}) => (
  <div className="range-setting">
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    />
    <output>{value}{suffix}</output>
  </div>
)

export function SettingsModal({
  platform,
  settings,
  vaultPath,
  onChange,
  onClose,
  onSelectVault,
  onOpenGlyphenWerk,
  onImportTraining,
  onImportOneNote,
  updateState,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
  onResetSettings,
  onResetAppData,
}: SettingsModalProps) {
  const isWeb = platform === 'web'
  const [active, setActive] = useState<SettingsSection>('appearance')
  const [searchQuery, setSearchQuery] = useState('')
  const [trainingImportBusy, setTrainingImportBusy] = useState(false)
  const [trainingImportStatus, setTrainingImportStatus] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [oneNoteImportBusy, setOneNoteImportBusy] = useState(false)
  const [oneNoteImportStatus, setOneNoteImportStatus] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [backupState, setBackupState] = useState<ServerBackupState>(DISABLED_BACKUP_STATE)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupNotice, setBackupNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [backupEnrollmentCode, setBackupEnrollmentCode] = useState('')
  const [recoveryInput, setRecoveryInput] = useState('')
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false)
  const [deleteBackupConfirmOpen, setDeleteBackupConfirmOpen] = useState(false)
  const trainingInputRef = useRef<HTMLInputElement>(null)
  const modalRef = useRef<HTMLElement>(null)
  const section = useMemo(() => SECTIONS.find((candidate) => candidate.id === active)!, [active])
  const ActiveSectionIcon = section.icon
  const searchResults = useMemo(() => {
    const terms = normalizeSearch(searchQuery).split(/\s+/u).filter(Boolean)
    if (!terms.length) return []
    return SETTINGS_SEARCH_ITEMS.filter((item) => {
      const haystack = normalizeSearch(`${item.label} ${item.detail} ${item.keywords}`)
      return terms.every((term) => haystack.includes(term))
    })
  }, [searchQuery])
  const openSearchResult = (result: SettingsSearchItem) => {
    setActive(result.section)
    setSearchQuery('')
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      modalRef.current?.querySelector<HTMLElement>(`#${result.target}`)?.scrollIntoView({ block: 'start', behavior: settings.reduceMotion ? 'auto' : 'smooth' })
    }))
  }
  useEffect(() => {
    if (!isWeb || !window.fanotes.getServerBackupState) return
    let activeRequest = true
    window.fanotes.getServerBackupState().then((state) => { if (activeRequest) setBackupState(state) }).catch((error) => {
      if (activeRequest) setBackupNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Der Backup-Status konnte nicht gelesen werden.' })
    })
    return () => { activeRequest = false }
  }, [isWeb])
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    onChange({ ...settings, [key]: value })
  }
  const handleTrainingFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file || !onImportTraining) return
    setTrainingImportBusy(true)
    setTrainingImportStatus(null)
    try {
      await onImportTraining(file)
      setTrainingImportStatus({ kind: 'success', text: 'Training wurde importiert und ist sofort aktiv.' })
    } catch (error) {
      setTrainingImportStatus({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Training konnte nicht importiert werden.',
      })
    } finally {
      setTrainingImportBusy(false)
      input.value = ''
    }
  }
  const handleOneNoteImport = async () => {
    if (!onImportOneNote || oneNoteImportBusy) return
    setOneNoteImportBusy(true)
    setOneNoteImportStatus(null)
    try {
      const result = await onImportOneNote()
      if (!result) return
      setOneNoteImportStatus({
        kind: 'success',
        text: `${result.pageCount} ${result.pageCount === 1 ? 'Seite wurde' : 'Seiten wurden'} in „${result.rootFolder}“ übernommen${result.attachmentCount ? ` · ${result.attachmentCount} Anlagen sicher verwahrt` : ''}.`,
      })
    } catch (error) {
      setOneNoteImportStatus({ kind: 'error', text: error instanceof Error ? error.message : 'Das OneNote-Notizbuch konnte nicht importiert werden.' })
    } finally {
      setOneNoteImportBusy(false)
    }
  }
  const handleAppDataReset = async () => {
    setResetBusy(true)
    setResetError(null)
    try {
      await onResetAppData()
    } catch (error) {
      setResetError(error instanceof Error ? error.message : 'Die App-Daten konnten nicht zurückgesetzt werden.')
      setResetBusy(false)
    }
  }
  const runBackupAction = async (action: () => Promise<ServerBackupState>, success: string) => {
    setBackupBusy(true)
    setBackupNotice(null)
    try {
      const next = await action()
      setBackupState(next)
      setBackupNotice({ kind: 'success', text: success })
      return next
    } catch (error) {
      setBackupNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Der Backup-Vorgang ist fehlgeschlagen.' })
      const localState = await window.fanotes.getServerBackupState?.().catch(() => null)
      if (localState) setBackupState(localState)
      return null
    } finally {
      setBackupBusy(false)
    }
  }
  const enableBackup = async () => {
    if (!window.fanotes.enableServerBackup) return
    const next = await runBackupAction(() => window.fanotes.enableServerBackup!(backupEnrollmentCode), 'Das erste, vollständig geprüfte Server-Backup wurde gespeichert.')
    if (next) setBackupEnrollmentCode('')
    if (next?.recoveryCode) setRecoveryInput(next.recoveryCode)
  }
  const copyRecoveryCode = async () => {
    if (!backupState.recoveryCode) return
    try {
      await navigator.clipboard.writeText(backupState.recoveryCode)
      setBackupNotice({ kind: 'success', text: 'Wiederherstellungscode wurde kopiert. Bewahre ihn außerhalb dieses Browsers sicher auf.' })
    } catch {
      setBackupNotice({ kind: 'error', text: 'Der Browser hat den Zwischenablagezugriff blockiert. Markiere und kopiere den Code manuell.' })
    }
  }

  return (
    <div className="modal-backdrop settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={modalRef} className="settings-modal" role="dialog" aria-modal="true" aria-label="Einstellungen" onMouseDown={(event) => event.stopPropagation()}>
        <aside className="settings-nav">
          <div className="settings-brand">
            <span className="brand-glyph"><Settings2 size={17} /></span>
            <div><strong>Einstellungen</strong><small>FaNotes an dich anpassen</small></div>
          </div>
          <label className="settings-search">
            <Search size={14} />
            <input
              type="search"
              value={searchQuery}
              placeholder="Einstellungen suchen"
              aria-label="Einstellungen durchsuchen"
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            {searchQuery && <button type="button" onClick={() => setSearchQuery('')} aria-label="Einstellungssuche leeren"><X size={13} /></button>}
          </label>
          <nav aria-label="Einstellungsbereiche">
            {searchQuery ? (
              <div className="settings-search-results" aria-live="polite">
                <small>{searchResults.length ? `${searchResults.length} Treffer` : 'Keine Treffer'}</small>
                {searchResults.map((result) => {
                  const Icon = SECTIONS.find((item) => item.id === result.section)?.icon ?? Settings2
                  return (
                    <button key={`${result.section}-${result.label}`} type="button" onClick={() => openSearchResult(result)}>
                      <Icon size={15} />
                      <span><b>{result.label}</b><small>{result.detail}</small></span>
                      <ChevronRight size={14} />
                    </button>
                  )
                })}
                {!searchResults.length && <p>Versuche zum Beispiel „Schrift“, „Backup“ oder „Handschrift“.</p>}
              </div>
            ) : SECTION_GROUPS.map((group) => (
              <div className="settings-nav-group" key={group.label}>
                <small>{group.label}</small>
                {group.sections.map((sectionId) => {
                  const item = SECTIONS.find((candidate) => candidate.id === sectionId)!
                  const Icon = item.icon
                  return (
                    <button key={item.id} type="button" className={active === item.id ? 'active' : ''} onClick={() => setActive(item.id)}>
                      <Icon size={16} />
                      <span><b>{item.label}</b><small>{item.description}</small></span>
                      <ChevronRight size={14} />
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>
          <button type="button" className="reset-settings" onClick={onResetSettings}><RotateCcw size={15} /> Standard wiederherstellen</button>
        </aside>

        <div className="settings-content">
          <header>
            <div className="settings-heading">
              <span className="settings-heading-icon"><ActiveSectionIcon size={17} /></span>
              <div><span className="eyebrow">Anpassung · {section.count} Optionen</span><h2>{section.label}</h2><p>{section.description}</p></div>
            </div>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Schließen"><X size={19} /></button>
          </header>

          <div className="settings-scroll">
            {active === 'appearance' && (
              <>
                <div id="settings-surface" className="setting-card visual-theme-card">
                  <div className="setting-card-title"><LayoutTemplate size={16} /><span>Oberfläche</span></div>
                  <SettingRow title="App-Sprache" description="Folgt automatisch der System- oder Browsersprache oder bleibt fest eingestellt.">
                    <div className="segmented compact language-options" role="group" aria-label="App-Sprache auswählen">
                      <button type="button" className={settings.uiLanguage === 'system' ? 'active' : ''} onClick={() => update('uiLanguage', 'system')}>System</button>
                      <button type="button" className={settings.uiLanguage === 'de' ? 'active' : ''} onClick={() => update('uiLanguage', 'de')}>Deutsch</button>
                      <button type="button" className={settings.uiLanguage === 'en' ? 'active' : ''} onClick={() => update('uiLanguage', 'en')}>English</button>
                    </div>
                  </SettingRow>
                  <SettingRow title="Farbschema" description="Kann automatisch dem System folgen.">
                    <div className="theme-grid">
                      {THEMES.map((theme) => (
                        <button
                          type="button"
                          key={theme.id}
                          className={`theme-choice ${settings.theme === theme.id ? 'active' : ''}`}
                          onClick={() => onChange({
                            ...settings,
                            theme: theme.id,
                            ...(theme.id === 'system' ? {} : {
                              accent: theme.accent,
                              accentSecondary: theme.secondary,
                            }),
                          })}
                        >
                          <span className="theme-choice-preview" style={{ background: theme.background }}>
                            <i style={{ background: theme.surface }} />
                            <b style={{ background: theme.accent }} />
                          </span>
                          <span><strong>{theme.label}</strong><small>{theme.detail}</small></span>
                          {settings.theme === theme.id && <Check size={13} />}
                        </button>
                      ))}
                    </div>
                  </SettingRow>
                  <SettingRow title="Arbeitsflächen-Design" description="Dekoriert den Hintergrund dezent, ohne vom Inhalt abzulenken.">
                    <div className="segmented compact background-options">
                      {BACKGROUNDS.map((background) => (
                        <button type="button" key={background.id} className={settings.workspaceBackground === background.id ? 'active' : ''} onClick={() => update('workspaceBackground', background.id)}>
                          {background.label}
                        </button>
                      ))}
                    </div>
                  </SettingRow>
                  <SettingRow title="Akzentfarbe" description="Färbt Auswahl, Fokus und interaktive Elemente.">
                    <div className="color-swatches">
                      {ACCENTS.map((color) => (
                        <button
                          type="button"
                          key={color}
                          aria-label={`Akzent ${color}`}
                          className={settings.accent === color ? 'active' : ''}
                          style={{ '--swatch': color, '--swatch-contrast': bestContrastText(color) } as React.CSSProperties}
                          onClick={() => update('accent', color)}
                        >{settings.accent === color && <Check size={13} />}</button>
                      ))}
                      <input aria-label="Eigene Akzentfarbe" type="color" value={settings.accent} onChange={(event) => update('accent', event.target.value)} />
                    </div>
                  </SettingRow>
                  <SettingRow title="Zweite Akzentfarbe" description="Für Verläufe und mathematische Auszeichnungen.">
                    <input className="color-input" type="color" value={settings.accentSecondary} onChange={(event) => update('accentSecondary', event.target.value)} />
                  </SettingRow>
                  <SettingRow title="Kompakte Oberfläche" description="Mehr Inhalt auf kleineren Displays.">
                    <Toggle label="Kompakte Oberfläche" checked={settings.compactMode} onChange={(value) => update('compactMode', value)} />
                  </SettingRow>
                  <SettingRow title="Glas-Effekte" description="Transparente Ebenen und weiche Unschärfe.">
                    <Toggle label="Glas-Effekte" checked={settings.glassEffects} onChange={(value) => update('glassEffects', value)} />
                  </SettingRow>
                </div>

                <div id="settings-typography" className="setting-card">
                  <div className="setting-card-title"><Keyboard size={16} /><span>Typografie</span></div>
                  <SettingRow title="Oberflächen-Schrift">
                    <select value={settings.uiFont} onChange={(event) => update('uiFont', event.target.value)}>
                      <option value="'DM Sans', ui-sans-serif, system-ui">DM Sans</option>
                      <option value="Inter, ui-sans-serif, system-ui">Inter / System</option>
                      <option value="'IBM Plex Sans', ui-sans-serif, system-ui">IBM Plex Sans</option>
                      <option value="'Source Sans 3', ui-sans-serif, system-ui">Source Sans 3</option>
                      <option value="Atkinson Hyperlegible, ui-sans-serif, system-ui">Atkinson Hyperlegible</option>
                    </select>
                  </SettingRow>
                  <SettingRow title="Editor-Schrift">
                    <select value={settings.editorFont} onChange={(event) => update('editorFont', event.target.value)}>
                      <option value="'JetBrains Mono', ui-monospace, monospace">JetBrains Mono</option>
                      <option value="'Fira Code', ui-monospace, monospace">Fira Code</option>
                      <option value="'IBM Plex Mono', ui-monospace, monospace">IBM Plex Mono</option>
                      <option value="ui-monospace, SFMono-Regular, monospace">System Mono</option>
                    </select>
                  </SettingRow>
                  <SettingRow title="Editor-Schriftgröße"><Range value={settings.editorFontSize} min={12} max={26} suffix=" px" onChange={(value) => update('editorFontSize', value)} /></SettingRow>
                  <SettingRow title="KI-Vorschau-Schriftgröße"><Range value={settings.previewFontSize} min={13} max={28} suffix=" px" onChange={(value) => update('previewFontSize', value)} /></SettingRow>
                  <SettingRow title="Zeilenhöhe"><Range value={settings.lineHeight} min={1.3} max={2.2} step={0.05} onChange={(value) => update('lineHeight', value)} /></SettingRow>
                </div>
              </>
            )}

            {active === 'editor' && (
              <>
                <div id="settings-editor" className="setting-card">
                  <div className="setting-card-title"><FileText size={16} /><span>Markdown-Arbeitsbereich</span></div>
                  <SettingRow title="Live-Ansicht" description="Markdown wird direkt auf der Seite bearbeitet und formatiert – ohne getrennte Vorschau."><span>Immer aktiv</span></SettingRow>
                  <SettingRow title="Lesbare Zeilenlänge" description="Begrenzt lange Textzeilen für angenehmes Lesen.">
                    <Toggle label="Lesbare Zeilenlänge" checked={settings.readableLineLength} onChange={(value) => update('readableLineLength', value)} />
                  </SettingRow>
                  <SettingRow title="Maximale Inhaltsbreite"><Range value={settings.contentWidth} min={560} max={1200} step={20} suffix=" px" onChange={(value) => update('contentWidth', value)} /></SettingRow>
                  <SettingRow title="Zeilennummern"><Toggle label="Zeilennummern" checked={settings.showLineNumbers} onChange={(value) => update('showLineNumbers', value)} /></SettingRow>
                  <SettingRow title="Rechtschreibprüfung" description="Unterstreicht Tippfehler lokal rot und erkennt Deutsch oder Englisch automatisch. Mathematik und Code bleiben unberührt."><Toggle label="Rechtschreibprüfung" checked={settings.spellcheck} onChange={(value) => update('spellcheck', value)} /></SettingRow>
                  <SettingRow title="Wortzahl in Statusleiste"><Toggle label="Wortzahl" checked={settings.showWordCount} onChange={(value) => update('showWordCount', value)} /></SettingRow>
                  <SettingRow title="Gliederung anzeigen"><Toggle label="Gliederung" checked={settings.showOutline} onChange={(value) => update('showOutline', value)} /></SettingRow>
                </div>
              </>
            )}

            {active === 'drawing' && (
              <>
                <div id="settings-glyphenwerk" className="setting-callout">
                  <span><Sparkles size={18} /></span>
                  <div><strong>GlyphenWerk ist in FaNotes integriert</strong><p>Trainiere Zeichen und mathematische Layouts, teste ganze Ausdrücke und verwalte deinen Datensatz direkt in FaNotes.</p></div>
                  <div className="setting-callout-actions">
                    {onOpenGlyphenWerk && <button type="button" className="primary-button" onClick={onOpenGlyphenWerk}>
                      <Database size={15} /> GlyphenWerk öffnen
                    </button>}
                    {onImportTraining && <>
                    <button type="button" className="secondary-button" onClick={() => trainingInputRef.current?.click()} disabled={trainingImportBusy}>
                      {trainingImportBusy ? <LoaderCircle className="spin" size={15} /> : <FileInput size={15} />}
                      {trainingImportBusy ? 'Importiert …' : 'ZIP importieren'}
                    </button>
                    <input ref={trainingInputRef} type="file" accept=".zip,application/zip" hidden onChange={(event) => void handleTrainingFile(event)} />
                    </>}
                  </div>
                </div>
                {trainingImportStatus && <div className={`setting-import-status is-${trainingImportStatus.kind}`} role="status">
                  {trainingImportStatus.kind === 'success' ? <Check size={15} /> : <X size={15} />}
                  <span>{trainingImportStatus.text}</span>
                </div>}
                <div id="settings-tablet" className="setting-card">
                  <div className="setting-card-title"><Brush size={16} /><span>Grafiktablett</span></div>
                  <SettingRow title="Papier">
                    <select value={settings.paperStyle} onChange={(event) => update('paperStyle', event.target.value as AppSettings['paperStyle'])}>
                      <option value="blank">Leer</option><option value="dots">Punktraster</option><option value="grid">Karos</option><option value="lines">Liniert</option>
                    </select>
                  </SettingRow>
                  <SettingRow title="Stiftfarbe"><input className="color-input" type="color" value={settings.penColor} onChange={(event) => update('penColor', event.target.value)} /></SettingRow>
                  <SettingRow title="Stiftbreite"><Range value={settings.penWidth} min={1} max={18} step={0.5} suffix=" px" onChange={(value) => update('penWidth', value)} /></SettingRow>
                  <SettingRow title="Druckempfindlichkeit" description="Nutzt den Druckwert deines Stifts."><Toggle label="Druckempfindlichkeit" checked={settings.pressureEnabled} onChange={(value) => update('pressureEnabled', value)} /></SettingRow>
                  <SettingRow title="Strichglättung"><Range value={settings.smoothing} min={0} max={1} step={0.05} onChange={(value) => update('smoothing', value)} /></SettingRow>
                  <SettingRow title="Durchkritzel-Empfindlichkeit" description="Niedrig verlangt mehr Überkreuzungen; hoch löscht schon nach einem kürzeren, eindeutigen Durchkritzeln."><Range value={settings.scribbleEraseSensitivity} min={0} max={100} step={5} suffix=" %" onChange={(value) => update('scribbleEraseSensitivity', value)} /></SettingRow>
                </div>
                <div id="settings-recognition" className="setting-card">
                  <div className="setting-card-title"><Sparkles size={16} /><span>Handschrifterkennung</span></div>
                  <SettingRow title="Erkennungsmodus" description="Automatisch vergleicht Text- und Mathematikerkennung und merkt sich unklare Fälle.">
                    <div className="segmented compact"><button type="button" className={settings.recognitionMode === 'auto' ? 'active' : ''} onClick={() => update('recognitionMode', 'auto')}>Automatisch</button><button type="button" className={settings.recognitionMode === 'text' ? 'active' : ''} onClick={() => onChange({ ...settings, recognitionMode: 'text', lastRecognitionMode: 'text' })}>Text</button><button type="button" className={settings.recognitionMode === 'math' ? 'active' : ''} onClick={() => onChange({ ...settings, recognitionMode: 'math', lastRecognitionMode: 'math' })}>Mathematik</button></div>
                  </SettingRow>
                  <SettingRow title="Textsprache" description="Steuert Wörter und Buchstabenfolgen bei der Texterkennung.">
                    <div className="segmented compact">
                      <button type="button" className={settings.recognitionLanguage === 'de' ? 'active' : ''} onClick={() => update('recognitionLanguage', 'de')}>Deutsch</button>
                      <button type="button" className={settings.recognitionLanguage === 'en' ? 'active' : ''} onClick={() => update('recognitionLanguage', 'en')}>Englisch</button>
                    </div>
                  </SettingRow>
                  <SettingRow title="Lokales Kontextlernen" description="Löst unsichere Buchstaben anhand plausibler Wörter auf und übernimmt ausschließlich sichere Entscheidungen als begrenzte persönliche Trainingsbeispiele."><span>Automatisch aktiv</span></SettingRow>
                  <SettingRow title="Unsichtbarer Suchindex" description="Die Seite bleibt Handschrift. Nur die Vault-Suche nutzt im Hintergrund eine lokale Transkription."><span>Immer lokal aktiv</span></SettingRow>
                  <SettingRow title="Zeichnung nach Einfügen behalten"><Toggle label="Zeichnung behalten" checked={settings.keepDrawingAfterInsert} onChange={(value) => update('keepDrawingAfterInsert', value)} /></SettingRow>
                </div>
              </>
            )}

            {active === 'files' && (
              <>
                <div id="settings-vault" className="setting-card vault-card">
                  <div className="setting-card-title"><FolderOpen size={16} /><span>Aktueller Vault</span></div>
                  <div className="vault-path"><code>{vaultPath}</code><button type="button" className="secondary-button" onClick={onSelectVault}>{isWeb ? 'Vault neu laden' : 'Ordner wechseln'}</button></div>
                  <p>{isWeb ? 'Notizen, Handschrift und Arbeitsblätter werden dauerhaft im privaten Browser-Speicher dieses Geräts abgelegt. Einzelne Notizen kannst du über die Download-Schaltfläche als Markdown exportieren.' : 'Alle Notizen sind normale Markdown-Dateien. Du kannst den Ordner jederzeit mit Git, Syncthing oder deinem NAS synchronisieren.'}</p>
                </div>
                <div id="settings-onenote" className="setting-card onenote-import-card">
                  <div className="setting-card-title"><NotebookTabs size={16} /><span>Microsoft OneNote Import</span><small className="settings-feature-badge">Layoutgetreu</small></div>
                  <div className="onenote-import-intro">
                    <span><NotebookTabs size={20} /></span>
                    <div><strong>Ein Notizbuch, vollständig in deinem Vault</strong><p>FaNotes übernimmt Abschnitte, Seitenhierarchie, freie Anordnung, Formatierung, Bilder, Freihand, Mathematik und den durchsuchbaren Text. Die Originaldarstellung bleibt als sichere, skriptfreie Seite erhalten.</p></div>
                  </div>
                  <div className="onenote-preservation-grid">
                    <div><b>Struktur</b><small>Notizbuch · Gruppen · Abschnitte · Seiten</small></div>
                    <div><b>Seitenbild</b><small>Positionen · Tabellen · Ink · Formeln · Bilder</small></div>
                    <div><b>Sicher</b><small>Anlagen bytegenau, aber niemals ausführbar</small></div>
                  </div>
                  <div className="onenote-import-actions">
                    <div><strong>.one · .onetoc2 · .onepkg · OneDrive-ZIP</strong><small>Für aktuelle OneNote- und OneDrive-Exporte unter Linux und Windows.</small></div>
                    <button type="button" className="primary-button" disabled={isWeb || !onImportOneNote || oneNoteImportBusy} onClick={() => void handleOneNoteImport()}>
                      {oneNoteImportBusy ? <LoaderCircle className="spin" size={15} /> : <FileInput size={15} />}
                      {oneNoteImportBusy ? 'Wird sicher übernommen …' : isWeb ? 'In der Desktop-App' : 'OneNote importieren'}
                    </button>
                  </div>
                  {oneNoteImportStatus && <div className={`setting-import-status is-${oneNoteImportStatus.kind}`} role={oneNoteImportStatus.kind === 'error' ? 'alert' : 'status'}>
                    {oneNoteImportStatus.kind === 'success' ? <Check size={15} /> : <X size={15} />}
                    <span>{oneNoteImportStatus.text}</span>
                  </div>}
                </div>
                {isWeb && <div id="settings-backup" className="setting-card server-backup-card">
                  <div className="setting-card-title"><Cloud size={16} /><span>Optionales Server-Backup</span><small className={`backup-state-badge is-${backupState.status}`}>{backupState.status === 'syncing' ? 'Sichert …' : backupState.enabled ? backupState.automatic ? 'Automatisch' : 'Verbunden' : 'Aus'}</small></div>
                  {!backupState.enabled ? <div className="server-backup-body">
                    <div className="server-backup-intro">
                      <span><ShieldCheck size={19} /></span>
                      <div><strong>Zusätzliche Kopie auf diesem FaNotes-Server</strong><p>Bleibt standardmäßig ausgeschaltet. Medien werden auf Malware geprüft und serverseitig neu aufgebaut; aktive PDF-Inhalte, fremde Dateitypen und unsichere Pfade werden blockiert.</p></div>
                    </div>
                    <div className="backup-enrollment-field"><label htmlFor="server-backup-enrollment"><KeyRound size={14} /> Privater Einrichtungs-Code</label><div><input id="server-backup-enrollment" type="password" autoComplete="off" spellCheck={false} value={backupEnrollmentCode} placeholder="Code vom Server-Administrator" onChange={(event) => setBackupEnrollmentCode(event.target.value)} /><button type="button" className="primary-button" disabled={backupBusy || !backupEnrollmentCode.trim()} onClick={() => void enableBackup()}>{backupBusy ? <LoaderCircle className="spin" size={15} /> : <UploadCloud size={15} />} {backupBusy ? 'Wird eingerichtet …' : 'Aktivieren'}</button></div><small>Der Code verhindert, dass Fremde diesen Server als anonymen Dateispeicher missbrauchen. Er wird nicht im Browser gespeichert.</small></div>
                    <div className="backup-recovery-connect">
                      <label htmlFor="server-backup-recovery"><KeyRound size={14} /> Vorhandenes Backup wiederherstellen</label>
                      <div><input id="server-backup-recovery" type="password" autoComplete="off" spellCheck={false} value={recoveryInput} placeholder="fanotes1_…" onChange={(event) => setRecoveryInput(event.target.value)} /><button type="button" className="secondary-button" disabled={backupBusy || !recoveryInput.trim() || !window.fanotes.connectServerBackup} onClick={() => void runBackupAction(() => window.fanotes.connectServerBackup!(recoveryInput), 'Backup-Schlüssel geprüft. Du kannst die Daten nun wiederherstellen.')}>Verbinden</button></div>
                    </div>
                  </div> : <div className="server-backup-body">
                    <div className="server-backup-summary">
                      <div><small>Letzte Sicherung</small><strong>{backupState.lastBackupAt ? new Intl.DateTimeFormat(getUiLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(backupState.lastBackupAt)) : 'Noch keine'}</strong></div>
                      <div><small>Gesicherter Umfang</small><strong>{formatBytes(backupState.sizeBytes)}</strong></div>
                      <div><small>Synchronisation</small><strong>{backupState.automatic ? 'Nach Änderungen automatisch' : 'Wartet auf Wiederherstellung'}</strong></div>
                    </div>
                    <div className="backup-recovery-code">
                      <div><KeyRound size={15} /><span><strong>Wiederherstellungscode</strong><small>Nur dieser Code öffnet dein Backup. FaNotes kann ihn nicht zurücksetzen.</small></span></div>
                      <div><input readOnly spellCheck={false} value={backupState.recoveryCode ?? ''} aria-label="Wiederherstellungscode" /><button type="button" className="secondary-button" onClick={() => void copyRecoveryCode()}><Copy size={14} /> Kopieren</button></div>
                    </div>
                    <div className="server-backup-actions">
                      <button type="button" className="secondary-button" disabled={backupBusy || !window.fanotes.syncServerBackup} onClick={() => void runBackupAction(() => window.fanotes.syncServerBackup!(), 'Der aktuelle Vault wurde vollständig geprüft und gesichert.')}><UploadCloud size={14} /> Jetzt sichern</button>
                      {!restoreConfirmOpen ? <button type="button" className="secondary-button" disabled={backupBusy || !backupState.lastBackupAt} onClick={() => setRestoreConfirmOpen(true)}><RefreshCw size={14} /> Wiederherstellen</button> : <div className="backup-inline-confirm" role="alert"><span>Lokalen Web-Vault durch dieses Backup ersetzen?</span><button type="button" className="secondary-button" onClick={() => setRestoreConfirmOpen(false)}>Abbrechen</button><button type="button" className="primary-button" disabled={backupBusy || !window.fanotes.restoreServerBackup} onClick={() => void runBackupAction(() => window.fanotes.restoreServerBackup!(), 'Backup wird wiederhergestellt …')}>Ja, wiederherstellen</button></div>}
                      {!deleteBackupConfirmOpen ? <button type="button" className="backup-delete-button" disabled={backupBusy} onClick={() => setDeleteBackupConfirmOpen(true)}><Trash2 size={14} /> Server-Kopie löschen</button> : <div className="backup-inline-confirm is-danger" role="alert"><span>Server-Kopie und Schlüssel endgültig löschen?</span><button type="button" className="secondary-button" onClick={() => setDeleteBackupConfirmOpen(false)}>Abbrechen</button><button type="button" className="danger-button" disabled={backupBusy || !window.fanotes.deleteServerBackup} onClick={() => void runBackupAction(() => window.fanotes.deleteServerBackup!(), 'Die Server-Kopie und der lokale Schlüssel wurden gelöscht.')}>Endgültig löschen</button></div>}
                    </div>
                  </div>}
                  {backupNotice && <div className={`backup-notice is-${backupNotice.kind}`} role={backupNotice.kind === 'error' ? 'alert' : 'status'}>{backupNotice.kind === 'success' ? <Check size={14} /> : <TriangleAlert size={14} />}<span>{backupNotice.text}</span></div>}
                  {backupState.error && backupNotice?.text !== backupState.error && <div className="backup-notice is-error" role="alert"><TriangleAlert size={14} /><span>{backupState.error}</span></div>}
                </div>}
                <div id="settings-files" className="setting-card">
                  <div className="setting-card-title"><SlidersHorizontal size={16} /><span>Dateiverhalten</span></div>
                  <SettingRow title="Automatisch speichern"><Range value={settings.autosaveDelay} min={250} max={3000} step={250} suffix=" ms" onChange={(value) => update('autosaveDelay', value)} /></SettingRow>
                  <SettingRow title="Standardordner"><input value={settings.defaultFolder} placeholder="z. B. Eingang" onChange={(event) => update('defaultFolder', event.target.value)} /></SettingRow>
                  <SettingRow title="Tagesnotizen"><input value={settings.dailyNotesFolder} placeholder="Tagesnotizen" onChange={(event) => update('dailyNotesFolder', event.target.value)} /></SettingRow>
                  <SettingRow title="Datumsformat"><input value={settings.dateFormat} placeholder="YYYY-MM-DD" onChange={(event) => update('dateFormat', event.target.value)} /></SettingRow>
                </div>
              </>
            )}

            {active === 'updates' && (
              <>
                <div className={`update-hero is-${updateState.status}`}>
                  <span className="update-hero-icon">
                    {updateState.status === 'downloading' || updateState.status === 'checking'
                      ? <LoaderCircle className="spin" size={22} />
                      : updateState.status === 'downloaded' || updateState.status === 'up-to-date'
                        ? <ShieldCheck size={22} />
                        : <RefreshCw size={22} />}
                  </span>
                  <div>
                    <small>{isWeb ? 'Automatisch aktualisierte Web-App' : settings.updateChannel === 'beta' ? 'Signierter Beta-Kanal' : 'Signierter Stable-Kanal'}</small>
                    <strong>{updateStatusText(updateState, isWeb)}</strong>
                    <p>{isWeb ? 'Web-Version' : 'Installiert'}: {updateState.currentVersion}{updateState.latestVersion && updateState.latestVersion !== updateState.currentVersion ? ` · Neu: ${updateState.latestVersion}` : ''}</p>
                  </div>
                  <div className="update-actions">
                    <button type="button" className="secondary-button" disabled={updateState.status === 'checking' || updateState.status === 'downloading' || updateState.status === 'installing'} onClick={() => void onCheckUpdate()}>
                      <RefreshCw className={updateState.status === 'checking' ? 'spin' : ''} size={15} /> Jetzt prüfen
                    </button>
                    {updateState.status === 'available' && <button type="button" className="primary-button" onClick={() => void onDownloadUpdate()}><Download size={15} /> {isWeb ? 'Vorbereiten' : 'Herunterladen'}</button>}
                    {updateState.status === 'downloaded' && <button type="button" className="primary-button" onClick={() => void onInstallUpdate()}><Rocket size={15} /> {isWeb ? 'Neu laden' : 'Neu starten'}</button>}
                  </div>
                </div>

                {(updateState.status === 'downloading' || updateState.status === 'downloaded') && (
                  <div className="update-progress" role="status" aria-live="polite">
                    <div><span>{updateState.status === 'downloaded' ? 'Download geprüft' : 'Update wird automatisch heruntergeladen'}</span><b>{formatBytes(updateState.downloadedBytes)} / {formatBytes(updateState.totalBytes)}</b></div>
                    <progress value={updateState.progress} max={1}>{Math.round(updateState.progress * 100)} %</progress>
                    <small>{updateState.installationKind.startsWith('differential-') ? 'Nur geänderte Binärblöcke werden übertragen; unveränderte Daten kommen aus der installierten Version.' : 'Der Download kann nach einem Verbindungsabbruch fortgesetzt werden.'}</small>
                  </div>
                )}

                {updateState.error && <div className="setting-import-status is-error" role="alert"><X size={15} /><span>{updateState.error}</span></div>}

                <div id="settings-update-automation" className="setting-card">
                  <div className="setting-card-title"><RefreshCw size={16} /><span>Automatisierung</span></div>
                  {isWeb ? <>
                    <SettingRow title="Automatische Web-Updates" description="Neue FaNotes-Versionen werden im Hintergrund vorgeladen und beim nächsten Öffnen aktiv."><span>Immer aktiv</span></SettingRow>
                    <SettingRow title="Offline verfügbar" description="Die installierbare Web-App behält Oberfläche, Schriften, Mathematik und Erkennungsengine sicher im lokalen Cache."><span>Service Worker</span></SettingRow>
                  </> : <>
                    <SettingRow title="Update-Kanal" description={settings.updateChannel === 'beta' ? 'Beta erhält neue Funktionen früher. Vorabversionen können noch Fehler enthalten; der nächste Stable-Stand wird automatisch bevorzugt, sobald er neuer ist.' : 'Stable bündelt gründlich geprüfte Änderungen in zwei bis höchstens vier Releases pro Monat.'}>
                      <select id="settings-update-channel" value={settings.updateChannel} disabled={updateState.status === 'downloading' || updateState.status === 'installing'} onChange={(event) => update('updateChannel', event.target.value as AppSettings['updateChannel'])}>
                        <option value="stable">Stable · empfohlen</option>
                        <option value="beta">Beta · neue Funktionen früher</option>
                      </select>
                    </SettingRow>
                    <SettingRow title="Automatisch nach Updates suchen" description={settings.updateChannel === 'beta' ? 'Prüft kurz nach dem Start und danach alle sechs Stunden den signierten Beta-Kanal.' : 'Prüft kurz nach dem Start und danach alle sechs Stunden den signierten Stable-Kanal.'}><Toggle label="Automatisch nach Updates suchen" checked={settings.autoCheckUpdates} onChange={(value) => update('autoCheckUpdates', value)} /></SettingRow>
                    <SettingRow title="Updates automatisch herunterladen" description="Lädt nur geänderte, signierte Binärblöcke im Hintergrund und setzt abgebrochene Übertragungen fort."><Toggle label="Updates automatisch herunterladen" checked={settings.autoDownloadUpdates} onChange={(value) => update('autoDownloadUpdates', value)} /></SettingRow>
                    <SettingRow title="Beim Beenden installieren" description="Installiert ein fertig geprüftes Update nach dem sicheren Speichern aller Notizen."><Toggle label="Update beim Beenden installieren" checked={settings.installUpdatesOnQuit} onChange={(value) => update('installUpdatesOnQuit', value)} /></SettingRow>
                  </>}
                </div>

                <div id="settings-update-security" className="setting-card update-security-card">
                  <div className="setting-card-title"><ShieldCheck size={16} /><span>Integrität und Installation</span></div>
                  <div className="update-security-grid">
                    <div><strong>{isWeb ? 'Gleicher Ursprung' : 'Ed25519-signiert'}</strong><small>{isWeb ? 'Programmcode wird ausschließlich verschlüsselt von fanotes.fasrv.ch geladen.' : 'Manipulierte Manifeste werden vor jedem Download blockiert.'}</small></div>
                    <div><strong>{isWeb ? 'Privater Browser-Vault' : 'SHA-256-geprüft'}</strong><small>{isWeb ? 'Notizen und Handschrift verlassen dein Gerät nicht durch FaNotes.' : 'Die App prüft das Paket nach dem Download und nochmals vor dem Neustart.'}</small></div>
                    <div><strong>{isWeb ? 'Offline-Cache' : 'Differentieller Download'}</strong><small>{isWeb ? 'Gehashte App-Ressourcen werden versionsgebunden gespeichert und atomar ausgetauscht.' : 'FaNotes übernimmt unveränderte Blöcke lokal und lädt ausschließlich Änderungen.'}</small></div>
                    <div>
                      <strong>{isWeb ? 'Neu laden ohne Datenverlust' : updateState.installationKind.startsWith('differential-') ? 'Atomarer Delta-Wechsel' : updateState.installationKind === 'windows-installer' ? 'Windows-Installer' : updateState.installationKind === 'appimage' ? 'AppImage direkt' : 'Verwaltete Installation'}</strong>
                      <small>{isWeb ? 'Der Web-Vault liegt getrennt vom Programmcache und bleibt bei Aktualisierungen vollständig erhalten.' : updateState.installationKind.startsWith('differential-') ? 'Die neue Datei wird lokal rekonstruiert, vollständig geprüft und erst beim Neustart ausgetauscht.' : updateState.installationKind === 'windows-installer' ? 'Das geprüfte Update ersetzt die Benutzerinstallation und startet FaNotes danach neu.' : updateState.installationKind === 'appimage' ? 'Der vorhandene AppImage-Pfad bleibt erhalten.' : 'FaNotes installiert Updates benutzersicher unter ~/.local.'}</small>
                    </div>
                  </div>
                </div>

                {updateState.releaseNotes.length > 0 && (
                  <div className="setting-card update-notes-card">
                    <div className="setting-card-title"><Rocket size={16} /><span>Neu in FaNotes {updateState.latestVersion}</span></div>
                    <ul>{updateState.releaseNotes.map((note, index) => <li key={`${index}-${note}`}>{note.replaceAll('**', '').replaceAll('`', '')}</li>)}</ul>
                  </div>
                )}
              </>
            )}

            {active === 'accessibility' && (
              <div id="settings-comfort" className="setting-card">
                <div className="setting-card-title"><Accessibility size={16} /><span>Komfort & Fokus</span></div>
                <SettingRow title="Bewegung reduzieren" description="Deaktiviert dekorative Übergänge und Animationen."><Toggle label="Bewegung reduzieren" checked={settings.reduceMotion} onChange={(value) => update('reduceMotion', value)} /></SettingRow>
                <SettingRow title="Seitenleiste"><Range value={settings.sidebarWidth} min={210} max={430} step={10} suffix=" px" onChange={(value) => update('sidebarWidth', value)} /></SettingRow>
                <SettingRow title="Informationsleiste"><Range value={settings.rightPanelWidth} min={220} max={430} step={10} suffix=" px" onChange={(value) => update('rightPanelWidth', value)} /></SettingRow>
              </div>
            )}

            {active === 'advanced' && (
              <>
                <div id="settings-resources" className="setting-card">
                  <div className="setting-card-title"><Cpu size={16} /><span>RAM & Leistung</span></div>
                  {!isWeb ? (
                    <SettingRow title="RAM-Limit pro Renderer" description="Begrenzt den JavaScript-Heap jedes Renderer-Prozesses. ONNX/WASM und Grafikdaten benötigen zusätzlich eigenen Speicher; zu kleine Werte können grosse Seiten abbrechen.">
                      <select value={settings.memoryBudgetMb} onChange={(event) => update('memoryBudgetMb', Number(event.target.value))}>
                        <option value={0}>Automatisch</option>
                        <option value={1536}>1,5 GB</option>
                        <option value={2048}>2 GB</option>
                        <option value={3072}>3 GB</option>
                        <option value={4096}>4 GB</option>
                        <option value={6144}>6 GB</option>
                        <option value={8192}>8 GB</option>
                      </select>
                    </SettingRow>
                  ) : (
                    <SettingRow title="RAM-Limit" description="Im Web bestimmt der Browser das Prozesslimit. Die Modellhaltezeit unten steuert weiterhin, wie schnell FaNotes den grossen OCR-Speicher freigibt."><span>Vom Browser verwaltet</span></SettingRow>
                  )}
                  <SettingRow title="OCR-Rechenkerne" description={isWeb ? 'Begrenzt die CPU-Threads der lokalen WASM-Erkennung. Im Browser verwendet FaNotes maximal zwei Kerne.' : 'Begrenzt die CPU-Threads der nativen ONNX-Erkennung. Automatisch nutzt höchstens die Hälfte der logischen Kerne und maximal vier.'}>
                    <select value={settings.ocrThreadLimit} onChange={(event) => update('ocrThreadLimit', Number(event.target.value))}>
                      <option value={0}>Automatisch</option>
                      <option value={1}>1 Kern · sparsam</option>
                      <option value={2}>2 Kerne</option>
                      <option value={3}>3 Kerne</option>
                      <option value={4}>4 Kerne · schnell</option>
                    </select>
                  </SettingRow>
                  {!isWeb && <SettingRow title="Desktop-Erkennungsmodell" description="Kompakt verwendet nur das schnelle native 21-MB-Zeilenmodell. Erweitert ergänzt es bei schwierigen Zeilen mit dem grösseren Kontextmodell; Training, Segmentierung und Korrekturen bleiben identisch.">
                    <select value={settings.desktopOcrModel} onChange={(event) => update('desktopOcrModel', event.target.value as AppSettings['desktopOcrModel'])}>
                      <option value="compact">Kompakt · weniger RAM</option>
                      <option value="extended">Erweitert · beste Genauigkeit</option>
                    </select>
                  </SettingRow>}
                  <SettingRow title="OCR-Modell im RAM behalten" description="Kürzere Zeiten geben den grossen lokalen Erkennungsworker früher frei; die nächste Konvertierung muss das Modell dann neu laden.">
                    <select value={settings.ocrModelKeepAliveSeconds} onChange={(event) => update('ocrModelKeepAliveSeconds', Number(event.target.value))}>
                      <option value={0}>Nach der Konvertierung freigeben</option>
                      <option value={30}>30 Sekunden</option>
                      <option value={120}>2 Minuten · Standard</option>
                      <option value={300}>5 Minuten</option>
                      <option value={600}>10 Minuten</option>
                    </select>
                  </SettingRow>
                  {!isWeb && <SettingRow title="Parallele Hintergrundaufgaben" description="Begrenzt gleichzeitige Vault- und Dateisystemarbeiten. Ein kleiner Wert reduziert Lastspitzen, kann grosse Ordner aber langsamer aktualisieren.">
                    <select value={settings.backgroundTaskLimit} onChange={(event) => update('backgroundTaskLimit', Number(event.target.value))}>
                      <option value={0}>Automatisch</option>
                      <option value={1}>1 Aufgabe</option>
                      <option value={2}>2 Aufgaben</option>
                      <option value={4}>4 Aufgaben</option>
                      <option value={8}>8 Aufgaben</option>
                      <option value={16}>16 Aufgaben</option>
                      <option value={24}>24 Aufgaben · Maximum</option>
                    </select>
                  </SettingRow>}
                  <div className="settings-resource-note"><MemoryStick size={14} /><span>{isWeb ? 'OCR-Limits wirken ab der nächsten Konvertierung.' : 'OCR- und Hintergrundlimits wirken sofort; das RAM-Limit wird beim nächsten App-Start aktiv.'}</span></div>
                </div>
                <div id="settings-privacy" className="setting-card">
                  <div className="setting-card-title"><ShieldCheck size={16} /><span>Anonyme Nutzungsstatistik</span></div>
                  <SettingRow title="Tägliche Summen" description="FaNotes zählt Website-Sitzungen, Downloads und App-Starts nach Land, Plattform und Version. Es werden keine IP-Adressen, Cookies, Gerätekennungen oder einzelnen Rohereignisse in der Statistik gespeichert."><span>Keine Kennung</span></SettingRow>
                </div>
                <div id="settings-css" className="setting-card custom-css-card">
                  <div className="setting-card-title"><Code2 size={16} /><span>Eigenes CSS</span></div>
                  <p>Wird nur innerhalb der Oberfläche angewandt. Damit kannst du Abstände, Farben und Markdown-Elemente weiter personalisieren.</p>
                  <textarea spellCheck={false} value={settings.customCss} placeholder={":root {\n  --radius: 14px;\n}"} onChange={(event) => update('customCss', event.target.value)} />
                </div>
                <div id="settings-vim" className="setting-card">
                  <SettingRow title="Vim-Modus" description="Vorbereitet für eine optionale Vim-Tastenbelegung."><Toggle label="Vim-Modus" checked={settings.vimMode} onChange={(value) => update('vimMode', value)} /></SettingRow>
                </div>
                <div id="settings-reset" className="setting-card danger-zone">
                  <div className="setting-card-title"><TriangleAlert size={16} /><span>App-Daten zurücksetzen</span></div>
                  <div className="danger-zone-body">
                    <div>
                      <strong>FaNotes auf den Ausgangszustand setzen</strong>
                      <p>Löscht Einstellungen, das persönliche Handschrifttraining, lokale Browserdaten, Caches und heruntergeladene Updates. Deine Markdown-Notizen, Bilder, PDFs und Zeichnungen im Vault bleiben erhalten.</p>
                    </div>
                    {!resetConfirmOpen ? (
                      <button type="button" className="danger-button" onClick={() => { setResetConfirmOpen(true); setResetError(null) }}><Trash2 size={15} /> App-Daten zurücksetzen</button>
                    ) : (
                      <div className="reset-confirm" role="alert">
                        <span><TriangleAlert size={15} /> FaNotes wird danach automatisch {isWeb ? 'neu geladen' : 'neu gestartet'}.</span>
                        <div>
                          <button type="button" className="secondary-button" disabled={resetBusy} onClick={() => { setResetConfirmOpen(false); setResetError(null) }}>Abbrechen</button>
                          <button type="button" className="danger-button" disabled={resetBusy} onClick={() => void handleAppDataReset()}>{resetBusy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{resetBusy ? 'Wird zurückgesetzt …' : 'Endgültig zurücksetzen'}</button>
                        </div>
                      </div>
                    )}
                    {resetError && <div className="reset-error"><TriangleAlert size={14} /> {resetError}</div>}
                  </div>
                </div>
              </>
            )}
          </div>

          <footer><span><Check size={14} /> Änderungen werden automatisch lokal gespeichert.</span><button type="button" className="primary-button" onClick={onClose}>Fertig</button></footer>
        </div>
      </section>
    </div>
  )
}
