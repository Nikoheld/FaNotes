import { type CSSProperties, useMemo } from 'react'
import {
  ArrowUpRight,
  Clock3,
  FilePlus2,
  FileText,
  Folder,
  X,
} from 'lucide-react'
import type { NoteTab, VaultEntry } from '../types'
import { getUiLocale } from '../i18n'

type MaybePromise = void | Promise<void>

export type VaultOverviewProps = {
  entries: VaultEntry[]
  openTabs: NoteTab[]
  onOpen: (path: string) => MaybePromise
  onCreateNote: () => MaybePromise
  onClose: () => void
}

type FolderRow = {
  id: string
  name: string
  depth: number
  notes: VaultEntry[]
  latest?: VaultEntry
  subfolders: number
  color?: string
  hue: number
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const dateFormatters = new Map<string, Intl.DateTimeFormat>()
const dateFormatter = () => {
  const locale = getUiLocale()
  let formatter = dateFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short' })
    dateFormatters.set(locale, formatter)
  }
  return formatter
}

const MAX_FOLDER_DEPTH = 2

function isMarkdown(entry: VaultEntry) {
  return (
    entry.kind === 'file' &&
    (['md', '.md', 'famd', '.famd', 'markdown'].includes(entry.extension?.toLowerCase() || '')
      || /\.(md|markdown|famd)$/i.test(entry.name))
  )
}

function noteTitle(entry: VaultEntry) {
  return entry.name.replace(/\.(md|markdown|famd)$/i, '') || 'Unbenannte Notiz'
}

function collectNotes(entries: VaultEntry[]): VaultEntry[] {
  return entries.flatMap((entry) => {
    if (isMarkdown(entry)) return [entry]
    return entry.kind === 'folder' ? collectNotes(entry.children ?? []) : []
  })
}

function modifiedTime(entry: VaultEntry) {
  if (!entry.modifiedAt) return 0
  const parsed = Date.parse(entry.modifiedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

function byNewest(left: VaultEntry, right: VaultEntry) {
  return modifiedTime(right) - modifiedTime(left) || collator.compare(left.name, right.name)
}

function formatModified(entry?: VaultEntry) {
  const time = entry ? modifiedTime(entry) : 0
  return time ? dateFormatter().format(new Date(time)) : '—'
}

function pathParent(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(0, -1).join(' / ') : 'Vault'
}

function subjectHue(index: number) {
  const palette = [257, 174, 211, 33, 296, 145, 12, 228, 92, 326]
  return palette[index % palette.length]
}

function collectFolderRows(entries: VaultEntry[], depth = 0, hueOffset = 0): FolderRow[] {
  const folders = entries
    .filter((entry) => entry.kind === 'folder')
    .sort((left, right) => collator.compare(left.name, right.name))

  return folders.flatMap((folder, index) => {
    const children = folder.children ?? []
    const notes = collectNotes(children).sort(byNewest)
    const row: FolderRow = {
      id: folder.relativePath,
      name: folder.name,
      depth,
      notes,
      latest: notes[0],
      subfolders: children.filter((child) => child.kind === 'folder').length,
      color: folder.color,
      hue: subjectHue(hueOffset + index),
    }
    if (depth >= MAX_FOLDER_DEPTH) return [row]
    return [row, ...collectFolderRows(children, depth + 1, hueOffset + index * 5 + 1)]
  })
}

function summarizeFolders(entries: VaultEntry[]): FolderRow[] {
  const rows = collectFolderRows(entries)
  const looseNotes = entries.filter(isMarkdown).sort(byNewest)
  if (looseNotes.length) {
    rows.push({
      id: '__root-notes__',
      name: 'Allgemein',
      depth: 0,
      notes: looseNotes,
      latest: looseNotes[0],
      subfolders: 0,
      hue: subjectHue(rows.length),
    })
  }
  return rows
}

const styles = `
.vault-overview {
  --vault-overview-card-radius: 12px;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  position: relative;
  overflow: auto;
  color: var(--text);
  background: var(--bg);
}
.vault-overview__shell {
  width: min(980px, calc(100% - 40px));
  margin: 0 auto;
  padding: 26px 0 44px;
  animation: vault-overview-enter .28s cubic-bezier(.22, 1, .36, 1) both;
}
.vault-overview__header {
  display: flex;
  align-items: flex-start;
  gap: 18px;
  margin-bottom: 18px;
}
.vault-overview__heading { min-width: 0; flex: 1; }
.vault-overview__heading h1 {
  margin: 0;
  color: var(--text);
  font-size: 22px;
  font-weight: 680;
  letter-spacing: -.03em;
  line-height: 1.15;
}
.vault-overview__heading p {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}
.vault-overview__header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 1px;
}
.vault-overview__new-note,
.vault-overview__close {
  height: 32px;
  border-radius: 8px;
  cursor: pointer;
}
.vault-overview__new-note {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 11px;
  border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border-strong));
  color: var(--on-accent);
  background: var(--accent);
  font-size: 10px;
  font-weight: 650;
}
.vault-overview__new-note:hover { filter: brightness(1.07); }
.vault-overview__close {
  width: 32px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--border);
  color: var(--text-muted);
  background: var(--panel);
}
.vault-overview__close:hover { color: var(--text); border-color: var(--border-strong); background: var(--panel-hover); }
.vault-overview__stats {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  color: var(--text-muted);
  font-size: 10px;
}
.vault-overview__stats strong { color: var(--text-soft); font-weight: 680; }
.vault-overview__stat-dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--border-strong);
}
.vault-overview__top-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 260px);
  gap: 12px;
  align-items: start;
}
.vault-overview__panel {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--vault-overview-card-radius);
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  overflow: hidden;
}
.vault-overview__section-head {
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
}
.vault-overview__section-title { min-width: 0; display: flex; align-items: center; gap: 7px; }
.vault-overview__section-title > svg { color: var(--text-muted); }
.vault-overview__section-title h2 {
  margin: 0;
  color: var(--text-soft);
  font-size: 10px;
  font-weight: 680;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.vault-overview__section-head small { color: var(--text-muted); font-size: 9px; }
.vault-overview__list-head,
.vault-overview__folder-row {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) 64px minmax(0, 1.15fr) 72px;
  align-items: center;
  gap: 10px;
}
.vault-overview__list-head {
  padding: 7px 12px 6px;
  color: var(--text-faint);
  font-size: 8px;
  font-weight: 720;
  letter-spacing: .06em;
  text-transform: uppercase;
}
.vault-overview__folders { display: flex; flex-direction: column; padding: 0 6px 6px; }
.vault-overview__folder-row {
  width: 100%;
  min-height: 38px;
  padding: 5px 8px;
  border: 0;
  border-radius: 8px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.vault-overview__folder-row:hover { background: var(--panel-hover); }
.vault-overview__folder-row.is-nested { color: var(--text-soft); }
.vault-overview__folder-main {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: calc(var(--vault-overview-depth, 0) * 16px);
}
.vault-overview__folder-icon {
  width: 22px;
  height: 22px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: hsl(var(--vault-overview-hue), 62%, 62%);
  background: hsla(var(--vault-overview-hue), 62%, 56%, .12);
}
.vault-overview__folder-icon.has-color {
  color: var(--vault-overview-color);
  background: color-mix(in srgb, var(--vault-overview-color) 16%, transparent);
}
.vault-overview__folder-copy { min-width: 0; }
.vault-overview__folder-copy strong,
.vault-overview__folder-copy span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vault-overview__folder-copy strong { color: var(--text); font-size: 12px; font-weight: 620; }
.vault-overview__folder-copy span { margin-top: 1px; color: var(--text-muted); font-size: 8px; }
.vault-overview__count {
  color: var(--text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.vault-overview__latest,
.vault-overview__date {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 10px;
}
.vault-overview__date { text-align: right; font-variant-numeric: tabular-nums; }
.vault-overview__empty {
  min-height: 180px;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
}
.vault-overview__empty strong { display: block; color: var(--text); font-size: 13px; }
.vault-overview__empty p { max-width: 320px; margin: 6px auto 14px; color: var(--text-muted); font-size: 10px; line-height: 1.55; }
.vault-overview__empty button {
  height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid rgba(var(--accent-rgb), .28);
  border-radius: 8px;
  color: var(--accent-readable);
  background: var(--panel-active);
  padding: 0 10px;
  cursor: pointer;
  font-size: 9px;
}
.vault-overview__recent-list { display: flex; flex-direction: column; padding: 6px; }
.vault-overview__recent-item {
  width: 100%;
  min-width: 0;
  min-height: 42px;
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border: 0;
  border-radius: 8px;
  color: var(--text-soft);
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.vault-overview__recent-item:hover { color: var(--text); background: var(--panel-hover); }
.vault-overview__recent-icon {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  color: var(--text-muted);
  background: var(--bg-elevated);
}
.vault-overview__recent-copy { min-width: 0; }
.vault-overview__recent-copy strong,
.vault-overview__recent-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vault-overview__recent-copy strong { font-size: 11px; font-weight: 610; }
.vault-overview__recent-copy span { margin-top: 2px; color: var(--text-muted); font-size: 8px; }
.vault-overview__recent-status { display: flex; align-items: center; gap: 5px; color: var(--text-muted); }
.vault-overview__dirty { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.vault-overview__recent-empty { min-height: 140px; display: grid; place-items: center; padding: 18px; color: var(--text-muted); text-align: center; }
.vault-overview__recent-empty > div { max-width: 200px; }
.vault-overview__recent-empty svg { margin-bottom: 8px; color: var(--text-muted); }
.vault-overview__recent-empty strong { display: block; color: var(--text-soft); font-size: 11px; }
.vault-overview__recent-empty p { margin: 5px 0 0; font-size: 9px; line-height: 1.5; }
@keyframes vault-overview-enter {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (max-width: 860px) {
  .vault-overview__shell { width: min(100% - 28px, 860px); padding-top: 20px; }
  .vault-overview__top-grid { grid-template-columns: 1fr; }
  .vault-overview__list-head, .vault-overview__folder-row { grid-template-columns: minmax(0, 1.4fr) 52px minmax(0, 1fr); }
  .vault-overview__date { display: none; }
}
@media (max-width: 640px) {
  .vault-overview__header { gap: 10px; }
  .vault-overview__new-note span { display: none; }
  .vault-overview__new-note { width: 32px; justify-content: center; padding: 0; }
  .vault-overview__list-head, .vault-overview__folder-row { grid-template-columns: minmax(0, 1fr) 48px; }
  .vault-overview__latest { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .vault-overview__shell { animation: none; }
}
`

export function VaultOverview({
  entries,
  openTabs,
  onOpen,
  onCreateNote,
  onClose,
}: VaultOverviewProps) {
  const folders = useMemo(() => summarizeFolders(entries), [entries])
  const allNotes = useMemo(() => collectNotes(entries), [entries])
  const noteDetails = useMemo(
    () => new Map(allNotes.map((entry) => [entry.relativePath, entry])),
    [allNotes],
  )
  const topFolders = useMemo(() => folders.filter((row) => row.depth === 0).length, [folders])
  const recentTabs = useMemo(() => {
    const seen = new Set<string>()
    return openTabs
      .slice()
      .reverse()
      .filter((tab) => {
        if (seen.has(tab.path)) return false
        seen.add(tab.path)
        return true
      })
      .slice(0, 8)
  }, [openTabs])

  const openAndClose = (path: string) => {
    void onOpen(path)
    onClose()
  }

  const createAndClose = () => {
    void onCreateNote()
    onClose()
  }

  return (
    <section className="vault-overview" aria-labelledby="vault-overview-title">
      <style>{styles}</style>
      <div className="vault-overview__shell">
        <header className="vault-overview__header">
          <div className="vault-overview__heading">
            <h1 id="vault-overview-title">Ordnerübersicht</h1>
            <p>Alle Ordner auf einen Blick. Tippe eine Zeile an, um die letzte Notiz zu öffnen.</p>
          </div>
          <div className="vault-overview__header-actions">
            <button className="vault-overview__new-note" type="button" onClick={createAndClose}>
              <FilePlus2 aria-hidden="true" size={14} />
              <span>Neue Notiz</span>
            </button>
            <button
              aria-label="Vault-Übersicht schließen"
              className="vault-overview__close"
              title="Schließen"
              type="button"
              onClick={onClose}
            >
              <X aria-hidden="true" size={16} />
            </button>
          </div>
        </header>

        <div className="vault-overview__stats" aria-label="Vault-Statistik">
          <span><strong>{topFolders}</strong> {topFolders === 1 ? 'Ordner' : 'Ordner'}</span>
          <i className="vault-overview__stat-dot" aria-hidden="true" />
          <span><strong>{allNotes.length}</strong> {allNotes.length === 1 ? 'Notiz' : 'Notizen'}</span>
        </div>

        <div className="vault-overview__top-grid">
          <section className="vault-overview__panel" aria-labelledby="vault-overview-subjects-title">
            <header className="vault-overview__section-head">
              <div className="vault-overview__section-title">
                <Folder aria-hidden="true" size={13} />
                <h2 id="vault-overview-subjects-title">Deine Ordner</h2>
              </div>
              <small>{folders.length ? `${folders.length} Einträge` : 'Bereit für dein erstes Fach'}</small>
            </header>

            {folders.length ? (
              <>
                <div className="vault-overview__list-head" aria-hidden="true">
                  <span>Ordner</span>
                  <span>Notizen</span>
                  <span>Zuletzt</span>
                  <span>Datum</span>
                </div>
                <div className="vault-overview__folders">
                  {folders.map((folder) => {
                    const style = {
                      '--vault-overview-hue': String(folder.hue),
                      '--vault-overview-depth': String(folder.depth),
                      ...(folder.color ? { '--vault-overview-color': folder.color } : {}),
                    } as CSSProperties
                    const canOpen = Boolean(folder.latest)
                    const actionLabel = canOpen
                      ? `${folder.name}: ${noteTitle(folder.latest!)} öffnen`
                      : `${folder.name}: erste Notiz erstellen`

                    return (
                      <button
                        aria-label={actionLabel}
                        className={`vault-overview__folder-row ${folder.depth ? 'is-nested' : ''}`}
                        key={folder.id}
                        style={style}
                        type="button"
                        onClick={() =>
                          folder.latest
                            ? openAndClose(folder.latest.relativePath)
                            : createAndClose()
                        }
                      >
                        <span className="vault-overview__folder-main">
                          <span className={`vault-overview__folder-icon ${folder.color ? 'has-color' : ''}`}>
                            <Folder aria-hidden="true" size={13} />
                          </span>
                          <span className="vault-overview__folder-copy">
                            <strong className="vault-overview__name">{folder.name}</strong>
                            {folder.subfolders > 0 && (
                              <span>
                                {folder.subfolders} {folder.subfolders === 1 ? 'Unterordner' : 'Unterordner'}
                              </span>
                            )}
                          </span>
                        </span>
                        <span className="vault-overview__count">{folder.notes.length}</span>
                        <span className="vault-overview__latest">
                          {folder.latest
                            ? <span className="vault-overview__name">{noteTitle(folder.latest)}</span>
                            : 'Erste Notiz anlegen'}
                        </span>
                        <time className="vault-overview__date">{formatModified(folder.latest)}</time>
                      </button>
                    )
                  })}
                </div>
              </>
            ) : (
              <div className="vault-overview__empty">
                <div>
                  <strong>Noch keine Ordner</strong>
                  <p>
                    Lege einen Fachordner an oder schreibe eine Notiz. Die Übersicht füllt sich automatisch.
                  </p>
                  <button type="button" onClick={createAndClose}>
                    <FilePlus2 aria-hidden="true" size={12} /> Erste Notiz erstellen
                  </button>
                </div>
              </div>
            )}
          </section>

          <aside className="vault-overview__panel" aria-labelledby="vault-overview-recent-title">
            <header className="vault-overview__section-head">
              <div className="vault-overview__section-title">
                <Clock3 aria-hidden="true" size={13} />
                <h2 id="vault-overview-recent-title">Zuletzt geöffnet</h2>
              </div>
              <small>{recentTabs.length ? `${recentTabs.length} im Verlauf` : 'Noch leer'}</small>
            </header>
            {recentTabs.length ? (
              <div className="vault-overview__recent-list">
                {recentTabs.map((tab) => {
                  const entry = noteDetails.get(tab.path)
                  const dirty = tab.content !== tab.savedContent
                  return (
                    <button
                      className="vault-overview__recent-item"
                      key={tab.path}
                      title={tab.path}
                      type="button"
                      onClick={() => openAndClose(tab.path)}
                    >
                      <span className="vault-overview__recent-icon">
                        <FileText aria-hidden="true" size={13} />
                      </span>
                      <span className="vault-overview__recent-copy">
                        <strong>{tab.title || noteTitle(entry ?? { name: tab.path, kind: 'file', relativePath: tab.path })}</strong>
                        <span>{pathParent(tab.path)}</span>
                      </span>
                      <span className="vault-overview__recent-status">
                        {dirty && <i className="vault-overview__dirty" title="Ungespeicherte Änderung" />}
                        <ArrowUpRight aria-hidden="true" size={11} />
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="vault-overview__recent-empty">
                <div>
                  <Clock3 aria-hidden="true" size={18} />
                  <strong>Noch keine offenen Notizen</strong>
                  <p>Geöffnete Dokumente bleiben hier griffbereit.</p>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </section>
  )
}

export default VaultOverview
