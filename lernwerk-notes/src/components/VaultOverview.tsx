import { type CSSProperties, useMemo } from 'react'
import {
  ArrowUpRight,
  BookOpen,
  Clock3,
  FilePlus2,
  FileText,
  Folder,
  Network,
  Sparkles,
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

type SubjectSummary = {
  id: string
  name: string
  notes: VaultEntry[]
  latest?: VaultEntry
  hue: number
}

type GraphNode = {
  id: string
  label: string
  kind: 'root' | 'folder' | 'note'
  x: number
  y: number
  parentId?: string
  hue?: number
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const dateFormatters = new Map<string, Intl.DateTimeFormat>()
const dateFormatter = () => {
  const locale = getUiLocale()
  let formatter = dateFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' })
    dateFormatters.set(locale, formatter)
  }
  return formatter
}

const GRAPH_WIDTH = 760
const GRAPH_HEIGHT = 270

function isMarkdown(entry: VaultEntry) {
  return (
    entry.kind === 'file' &&
    (entry.extension?.toLowerCase() === '.md' || entry.name.toLowerCase().endsWith('.md'))
  )
}

function noteTitle(entry: VaultEntry) {
  return entry.name.replace(/\.md$/i, '') || 'Unbenannte Notiz'
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
  return time ? dateFormatter().format(new Date(time)) : 'Noch nicht bearbeitet'
}

function pathParent(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(0, -1).join(' / ') : 'Vault'
}

function shorten(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`
}

function subjectHue(index: number) {
  const palette = [257, 174, 211, 33, 296, 145, 12, 228, 92, 326]
  return palette[index % palette.length]
}

function summarizeSubjects(entries: VaultEntry[]): SubjectSummary[] {
  const folders: SubjectSummary[] = entries
    .filter((entry) => entry.kind === 'folder')
    .sort((left, right) => collator.compare(left.name, right.name))
    .map((folder, index) => {
      const notes = collectNotes(folder.children ?? []).sort(byNewest)
      return {
        id: folder.relativePath,
        name: folder.name,
        notes,
        latest: notes[0],
        hue: subjectHue(index),
      }
    })

  const looseNotes = entries.filter(isMarkdown).sort(byNewest)
  if (looseNotes.length) {
    folders.push({
      id: '__root-notes__',
      name: 'Allgemein',
      notes: looseNotes,
      latest: looseNotes[0],
      hue: subjectHue(folders.length),
    })
  }

  return folders
}

function buildGraph(subjects: SubjectSummary[]): { nodes: GraphNode[]; hiddenSubjects: number } {
  const visibleSubjects = subjects.slice(0, 9)
  const nodes: GraphNode[] = [
    { id: '__vault__', label: 'Mein Vault', kind: 'root', x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 },
  ]

  visibleSubjects.forEach((subject, index) => {
    const count = visibleSubjects.length
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(count, 1)
    const radiusX = count === 1 ? 0 : count === 2 ? 160 : 245
    const radiusY = count <= 2 ? 64 : 82
    const folderX = GRAPH_WIDTH / 2 + Math.cos(angle) * radiusX
    const folderY = GRAPH_HEIGHT / 2 + Math.sin(angle) * radiusY
    const folderId = `folder:${subject.id}`

    nodes.push({
      id: folderId,
      label: subject.name,
      kind: 'folder',
      x: folderX,
      y: folderY,
      parentId: '__vault__',
      hue: subject.hue,
    })

    const visibleNotes = subject.notes
      .slice()
      .sort((left, right) => collator.compare(left.relativePath, right.relativePath))
      .slice(0, count > 6 ? 1 : 2)

    visibleNotes.forEach((note, noteIndex) => {
      const spread = visibleNotes.length === 1 ? 0 : (noteIndex - 0.5) * 0.62
      const outwardAngle = angle + spread
      const distanceX = count === 1 ? 75 : 49
      const distanceY = count === 1 ? 38 : 34
      nodes.push({
        id: `note:${note.relativePath}`,
        label: noteTitle(note),
        kind: 'note',
        x: Math.min(720, Math.max(40, folderX + Math.cos(outwardAngle) * distanceX)),
        y: Math.min(247, Math.max(23, folderY + Math.sin(outwardAngle) * distanceY)),
        parentId: folderId,
        hue: subject.hue,
      })
    })
  })

  return { nodes, hiddenSubjects: Math.max(0, subjects.length - visibleSubjects.length) }
}

const styles = `
.vault-overview {
  --vault-overview-card-radius: 15px;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  position: relative;
  overflow: auto;
  color: var(--text);
  background:
    radial-gradient(circle at 12% 0%, rgba(var(--accent-rgb), .105), transparent 31%),
    radial-gradient(circle at 92% 20%, color-mix(in srgb, var(--accent-secondary) 8%, transparent), transparent 28%),
    var(--bg);
}
.vault-overview::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  pointer-events: none;
  background: linear-gradient(90deg, transparent 10%, rgba(var(--accent-rgb), .32), transparent 90%);
}
.vault-overview__shell {
  width: min(1120px, calc(100% - 48px));
  margin: 0 auto;
  padding: 34px 0 52px;
  animation: vault-overview-enter .28s ease-out both;
}
.vault-overview__header {
  display: flex;
  align-items: flex-start;
  gap: 24px;
  margin-bottom: 27px;
}
.vault-overview__heading { min-width: 0; flex: 1; }
.vault-overview__eyebrow {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 8px;
  color: var(--accent-readable);
  font-size: 10px;
  font-weight: 720;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.vault-overview__heading h1 {
  margin: 0;
  color: var(--text);
  font-size: clamp(25px, 3vw, 36px);
  font-weight: 720;
  letter-spacing: -.045em;
  line-height: 1.08;
}
.vault-overview__heading p {
  max-width: 570px;
  margin: 9px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.65;
}
.vault-overview__header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 3px;
}
.vault-overview__new-note,
.vault-overview__close {
  height: 34px;
  border-radius: 9px;
  cursor: pointer;
}
.vault-overview__new-note {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border-strong));
  color: var(--on-accent);
  background: var(--accent);
  box-shadow: 0 8px 24px rgba(var(--accent-rgb), .2);
  font-size: 10px;
  font-weight: 650;
}
.vault-overview__new-note:hover { filter: brightness(1.07); transform: translateY(-1px); }
.vault-overview__close {
  width: 34px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--border);
  color: var(--text-muted);
  background: color-mix(in srgb, var(--panel-strong) 82%, transparent);
}
.vault-overview__close:hover { color: var(--text); border-color: var(--border-strong); background: var(--panel-hover); }
.vault-overview__stats {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 17px;
}
.vault-overview__stat {
  min-height: 25px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--panel) 66%, transparent);
  font-size: 9px;
}
.vault-overview__stat strong { color: var(--text-soft); font-size: 10px; }
.vault-overview__top-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(250px, .75fr);
  gap: 14px;
  align-items: stretch;
}
.vault-overview__panel {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--vault-overview-card-radius);
  background: color-mix(in srgb, var(--panel) 84%, transparent);
  box-shadow: 0 18px 55px rgba(0, 0, 0, .09);
  overflow: hidden;
}
.vault-overview__section-head {
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}
.vault-overview__section-title { min-width: 0; display: flex; align-items: center; gap: 8px; }
.vault-overview__section-title > svg { color: var(--accent-readable); }
.vault-overview__section-title h2 {
  margin: 0;
  color: var(--text-soft);
  font-size: 11px;
  font-weight: 680;
  letter-spacing: .015em;
}
.vault-overview__section-head small { color: var(--text-muted); font-size: 9px; }
.vault-overview__subjects {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
  padding: 11px;
}
.vault-overview__subject-card {
  min-width: 0;
  min-height: 126px;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  background:
    radial-gradient(circle at 100% 0%, hsla(var(--vault-overview-hue), 78%, 62%, .09), transparent 52%),
    color-mix(in srgb, var(--panel-strong) 76%, transparent);
  cursor: pointer;
  text-align: left;
  overflow: hidden;
  transition: transform .16s ease, border-color .16s ease, background .16s ease;
}
.vault-overview__subject-card:hover {
  transform: translateY(-2px);
  border-color: hsla(var(--vault-overview-hue), 78%, 65%, .35);
  background:
    radial-gradient(circle at 100% 0%, hsla(var(--vault-overview-hue), 78%, 62%, .15), transparent 58%),
    var(--panel-strong);
}
.vault-overview__subject-top { display: flex; align-items: flex-start; gap: 9px; }
.vault-overview__subject-icon {
  width: 31px;
  height: 31px;
  flex: none;
  display: grid;
  place-items: center;
  border: 1px solid hsla(var(--vault-overview-hue), 75%, 65%, .18);
  border-radius: 9px;
  color: hsl(var(--vault-overview-hue), 72%, 69%);
  background: hsla(var(--vault-overview-hue), 72%, 58%, .1);
}
.vault-overview__subject-name { min-width: 0; flex: 1; padding-top: 1px; }
.vault-overview__subject-name strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-size: 12px;
  font-weight: 670;
}
.vault-overview__subject-name span { display: block; margin-top: 3px; color: var(--text-muted); font-size: 9px; }
.vault-overview__subject-arrow { color: var(--text-muted); opacity: .5; transition: transform .16s ease, opacity .16s ease; }
.vault-overview__subject-card:hover .vault-overview__subject-arrow { opacity: 1; transform: translate(1px, -1px); color: hsl(var(--vault-overview-hue), 72%, 69%); }
.vault-overview__subject-latest {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: auto;
  padding-top: 12px;
  color: var(--text-muted);
  font-size: 8px;
}
.vault-overview__subject-latest > span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vault-overview__subject-latest time { flex: none; color: color-mix(in srgb, var(--text-muted) 82%, transparent); }
.vault-overview__empty {
  min-height: 245px;
  display: grid;
  place-items: center;
  padding: 28px;
  text-align: center;
}
.vault-overview__empty-symbol {
  width: 55px;
  height: 55px;
  display: grid;
  place-items: center;
  margin: 0 auto 13px;
  border: 1px solid rgba(var(--accent-rgb), .18);
  border-radius: 17px;
  color: var(--accent-readable);
  background: var(--panel-active);
  box-shadow: 0 12px 35px rgba(var(--accent-rgb), .09);
}
.vault-overview__empty strong { display: block; color: var(--text); font-size: 13px; }
.vault-overview__empty p { max-width: 300px; margin: 6px auto 14px; color: var(--text-muted); font-size: 10px; line-height: 1.55; }
.vault-overview__empty button {
  height: 31px;
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
  min-height: 49px;
  display: grid;
  grid-template-columns: 29px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 6px 7px;
  border: 0;
  border-radius: 9px;
  color: var(--text-soft);
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.vault-overview__recent-item:hover { color: var(--text); background: var(--panel-hover); }
.vault-overview__recent-icon {
  width: 29px;
  height: 29px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--accent-readable);
  background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
}
.vault-overview__recent-copy { min-width: 0; }
.vault-overview__recent-copy strong,
.vault-overview__recent-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vault-overview__recent-copy strong { font-size: 10px; font-weight: 610; }
.vault-overview__recent-copy span { margin-top: 3px; color: var(--text-muted); font-size: 8px; }
.vault-overview__recent-status { display: flex; align-items: center; gap: 5px; color: var(--text-muted); }
.vault-overview__dirty { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px rgba(var(--accent-rgb), .6); }
.vault-overview__recent-empty { min-height: 245px; display: grid; place-items: center; padding: 24px; color: var(--text-muted); text-align: center; }
.vault-overview__recent-empty > div { max-width: 230px; }
.vault-overview__recent-empty svg { margin-bottom: 10px; color: var(--accent-readable); }
.vault-overview__recent-empty strong { display: block; color: var(--text-soft); font-size: 11px; }
.vault-overview__recent-empty p { margin: 5px 0 0; font-size: 9px; line-height: 1.55; }
.vault-overview__graph-panel { margin-top: 14px; }
.vault-overview__graph-wrap {
  position: relative;
  min-height: 245px;
  padding: 4px 10px 11px;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 50%, rgba(var(--accent-rgb), .045), transparent 34%),
    linear-gradient(color-mix(in srgb, var(--text) 3%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--text) 3%, transparent) 1px, transparent 1px);
  background-size: auto, 24px 24px, 24px 24px;
}
.vault-overview__graph {
  width: 100%;
  height: clamp(230px, 28vw, 280px);
  display: block;
  overflow: visible;
}
.vault-overview__graph-line { stroke: color-mix(in srgb, var(--text-muted) 22%, transparent); stroke-width: 1; }
.vault-overview__graph-line--primary { stroke: rgba(var(--accent-rgb), .28); stroke-width: 1.2; }
.vault-overview__graph-orbit { fill: none; stroke: rgba(var(--accent-rgb), .08); stroke-width: 1; stroke-dasharray: 3 8; }
.vault-overview__graph-root-halo { fill: rgba(var(--accent-rgb), .08); }
.vault-overview__graph-root { fill: var(--accent); stroke: color-mix(in srgb, var(--on-accent) 38%, transparent); stroke-width: 1; filter: url(#vault-overview-glow); }
.vault-overview__graph-folder-halo { fill: hsla(var(--vault-overview-node-hue), 72%, 58%, .09); }
.vault-overview__graph-folder { fill: color-mix(in srgb, var(--panel-strong) 88%, hsl(var(--vault-overview-node-hue), 65%, 58%)); stroke: hsla(var(--vault-overview-node-hue), 78%, 70%, .72); stroke-width: 1.2; }
.vault-overview__graph-note { fill: hsl(var(--vault-overview-node-hue), 72%, 68%); stroke: color-mix(in srgb, var(--bg) 70%, transparent); stroke-width: 2.5; }
.vault-overview__graph-root-text { fill: var(--on-accent); font-size: 9px; font-weight: 760; letter-spacing: .04em; text-anchor: middle; }
.vault-overview__graph-label { fill: var(--text-soft); font-size: 8px; font-weight: 620; text-anchor: middle; }
.vault-overview__graph-note-label { fill: var(--text-muted); font-size: 6.8px; }
.vault-overview__graph-legend { display: flex; align-items: center; gap: 13px; color: var(--text-muted); font-size: 8px; }
.vault-overview__legend-item { display: inline-flex; align-items: center; gap: 5px; }
.vault-overview__legend-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px rgba(var(--accent-rgb), .28); }
.vault-overview__legend-dot--note { width: 5px; height: 5px; background: var(--accent-secondary); }
.vault-overview__graph-empty-copy {
  position: absolute;
  left: 50%;
  bottom: 21px;
  transform: translateX(-50%);
  width: max-content;
  max-width: calc(100% - 32px);
  color: var(--text-muted);
  font-size: 9px;
  text-align: center;
}
@keyframes vault-overview-enter {
  from { opacity: 0; transform: translateY(7px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (max-width: 1040px) {
  .vault-overview__shell { width: min(100% - 30px, 940px); padding-top: 25px; }
  .vault-overview__top-grid { grid-template-columns: minmax(0, 1fr) 245px; }
  .vault-overview__subjects { grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); }
  .vault-overview__subject-card { min-height: 116px; }
}
@media (max-width: 760px) {
  .vault-overview__header { gap: 12px; }
  .vault-overview__new-note span { display: none; }
  .vault-overview__new-note { width: 34px; justify-content: center; padding: 0; }
  .vault-overview__top-grid { grid-template-columns: 1fr; }
  .vault-overview__subjects { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) {
  .vault-overview__shell { animation: none; }
  .vault-overview__subject-card, .vault-overview__new-note { transition: none; }
}
`

export function VaultOverview({
  entries,
  openTabs,
  onOpen,
  onCreateNote,
  onClose,
}: VaultOverviewProps) {
  const subjects = useMemo(() => summarizeSubjects(entries), [entries])
  const allNotes = useMemo(() => collectNotes(entries), [entries])
  const noteDetails = useMemo(
    () => new Map(allNotes.map((entry) => [entry.relativePath, entry])),
    [allNotes],
  )
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
      .slice(0, 6)
  }, [openTabs])
  const graph = useMemo(() => buildGraph(subjects), [subjects])
  const graphNodes = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  )

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
            <div className="vault-overview__eyebrow">
              <Sparkles aria-hidden="true" size={12} />
              Wissensraum
            </div>
            <h1 id="vault-overview-title">Dein Vault auf einen Blick</h1>
            <p>Fächer, Notizen und die Verbindungen dazwischen – vollständig lokal und als offene Markdown-Dateien gespeichert.</p>
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
          <span className="vault-overview__stat">
            <Folder aria-hidden="true" size={11} />
            <strong>{subjects.length}</strong> {subjects.length === 1 ? 'Fach' : 'Fächer'}
          </span>
          <span className="vault-overview__stat">
            <FileText aria-hidden="true" size={11} />
            <strong>{allNotes.length}</strong> {allNotes.length === 1 ? 'Notiz' : 'Notizen'}
          </span>
          <span className="vault-overview__stat">
            <Network aria-hidden="true" size={11} /> lokal verbunden
          </span>
        </div>

        <div className="vault-overview__top-grid">
          <section className="vault-overview__panel" aria-labelledby="vault-overview-subjects-title">
            <header className="vault-overview__section-head">
              <div className="vault-overview__section-title">
                <BookOpen aria-hidden="true" size={14} />
                <h2 id="vault-overview-subjects-title">Deine Fächer</h2>
              </div>
              <small>{subjects.length ? 'Zuletzt bearbeitete Notiz öffnen' : 'Bereit für dein erstes Fach'}</small>
            </header>

            {subjects.length ? (
              <div className="vault-overview__subjects">
                {subjects.map((subject) => {
                  const cardStyle = {
                    '--vault-overview-hue': String(subject.hue),
                  } as CSSProperties
                  const canOpen = Boolean(subject.latest)
                  const actionLabel = canOpen
                    ? `${subject.name}: ${noteTitle(subject.latest!)} öffnen`
                    : `${subject.name}: erste Notiz erstellen`

                  return (
                    <button
                      aria-label={actionLabel}
                      className="vault-overview__subject-card"
                      key={subject.id}
                      style={cardStyle}
                      type="button"
                      onClick={() =>
                        subject.latest
                          ? openAndClose(subject.latest.relativePath)
                          : createAndClose()
                      }
                    >
                      <span className="vault-overview__subject-top">
                        <span className="vault-overview__subject-icon">
                          <Folder aria-hidden="true" size={15} />
                        </span>
                        <span className="vault-overview__subject-name">
                          <strong>{subject.name}</strong>
                          <span>
                            {subject.notes.length} {subject.notes.length === 1 ? 'Notiz' : 'Notizen'}
                          </span>
                        </span>
                        <ArrowUpRight
                          aria-hidden="true"
                          className="vault-overview__subject-arrow"
                          size={14}
                        />
                      </span>
                      <span className="vault-overview__subject-latest">
                        <Clock3 aria-hidden="true" size={10} />
                        <span>{subject.latest ? noteTitle(subject.latest) : 'Erste Notiz anlegen'}</span>
                        {subject.latest && <time>{formatModified(subject.latest)}</time>}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="vault-overview__empty">
                <div>
                  <span className="vault-overview__empty-symbol">
                    <BookOpen aria-hidden="true" size={23} />
                  </span>
                  <strong>Dein Wissensraum wartet</strong>
                  <p>
                    Beginne mit einer Markdown-Notiz. Sobald du Fachordner anlegst, erscheinen
                    sie hier als eigene Bereiche.
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
                <Clock3 aria-hidden="true" size={14} />
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
                  <Clock3 aria-hidden="true" size={22} />
                  <strong>Noch keine offenen Notizen</strong>
                  <p>Geöffnete Dokumente bleiben hier griffbereit, solange du an ihnen arbeitest.</p>
                </div>
              </div>
            )}
          </aside>
        </div>

        <section className="vault-overview__panel vault-overview__graph-panel" aria-labelledby="vault-overview-graph-title">
          <header className="vault-overview__section-head">
            <div className="vault-overview__section-title">
              <Network aria-hidden="true" size={14} />
              <h2 id="vault-overview-graph-title">Wissensgraph</h2>
            </div>
            <div className="vault-overview__graph-legend" aria-hidden="true">
              <span className="vault-overview__legend-item">
                <i className="vault-overview__legend-dot" /> Fach
              </span>
              <span className="vault-overview__legend-item">
                <i className="vault-overview__legend-dot vault-overview__legend-dot--note" /> Notiz
              </span>
              {graph.hiddenSubjects > 0 && <span>+ {graph.hiddenSubjects} weitere</span>}
            </div>
          </header>
          <div className="vault-overview__graph-wrap">
            <svg
              aria-label={`Visueller Wissensgraph mit ${subjects.length} Fächern und ${allNotes.length} Notizen`}
              className="vault-overview__graph"
              preserveAspectRatio="xMidYMid meet"
              role="img"
              viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
            >
              <defs>
                <linearGradient id="vault-overview-root-gradient" x1="0" x2="1" y1="0" y2="1">
                  <stop offset="0" stopColor="var(--accent)" />
                  <stop offset="1" stopColor="var(--accent-secondary)" />
                </linearGradient>
                <filter id="vault-overview-glow" height="220%" width="220%" x="-60%" y="-60%">
                  <feGaussianBlur result="blur" stdDeviation="4" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              <ellipse
                className="vault-overview__graph-orbit"
                cx={GRAPH_WIDTH / 2}
                cy={GRAPH_HEIGHT / 2}
                rx="245"
                ry="82"
              />
              {graph.nodes.map((node) => {
                if (!node.parentId) return null
                const parent = graphNodes.get(node.parentId)
                if (!parent) return null
                return (
                  <line
                    className={`vault-overview__graph-line ${
                      node.kind === 'folder' ? 'vault-overview__graph-line--primary' : ''
                    }`}
                    key={`line:${node.id}`}
                    x1={parent.x}
                    x2={node.x}
                    y1={parent.y}
                    y2={node.y}
                  />
                )
              })}
              {graph.nodes.map((node) => {
                if (node.kind === 'root') {
                  return (
                    <g key={node.id}>
                      <circle className="vault-overview__graph-root-halo" cx={node.x} cy={node.y} r="28" />
                      <circle className="vault-overview__graph-root" cx={node.x} cy={node.y} r="18" />
                      <text className="vault-overview__graph-root-text" x={node.x} y={node.y + 3}>LW</text>
                    </g>
                  )
                }

                const nodeStyle = {
                  '--vault-overview-node-hue': String(node.hue ?? 257),
                } as CSSProperties

                if (node.kind === 'folder') {
                  return (
                    <g key={node.id} style={nodeStyle}>
                      <title>{node.label}</title>
                      <circle className="vault-overview__graph-folder-halo" cx={node.x} cy={node.y} r="20" />
                      <circle className="vault-overview__graph-folder" cx={node.x} cy={node.y} r="11" />
                      <text className="vault-overview__graph-label" x={node.x} y={node.y + 25}>
                        {shorten(node.label, 18)}
                      </text>
                    </g>
                  )
                }

                return (
                  <g key={node.id} style={nodeStyle}>
                    <title>{node.label}</title>
                    <circle className="vault-overview__graph-note" cx={node.x} cy={node.y} r="5" />
                    <text className="vault-overview__graph-note-label" x={node.x + 9} y={node.y + 2.5}>
                      {shorten(node.label, 13)}
                    </text>
                  </g>
                )
              })}
            </svg>
            {!subjects.length && (
              <div className="vault-overview__graph-empty-copy">
                Lege Fächer und Notizen an – dein Graph wächst automatisch mit.
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  )
}

export default VaultOverview
