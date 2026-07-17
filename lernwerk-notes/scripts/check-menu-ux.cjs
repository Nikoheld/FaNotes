'use strict'

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const drawing = fs.readFileSync(path.join(root, 'src', 'components', 'DrawingBoard.tsx'), 'utf8')
const app = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8')
const tree = fs.readFileSync(path.join(root, 'src', 'components', 'FileTree.tsx'), 'utf8')
const settings = fs.readFileSync(path.join(root, 'src', 'components', 'SettingsModal.tsx'), 'utf8')
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')

const requirements = [
  [drawing, "type ArtStudioTab = 'brushes' | 'colors' | 'symbols'", 'drei eindeutige Zeichenstudio-Bereiche'],
  [drawing, 'role="tablist" aria-label="Bereiche des Zeichenstudios"', 'zugängliche Zeichenstudio-Navigation'],
  [drawing, "artStudioTab === 'brushes' && <section", 'nur der gewählte Pinselbereich wird dargestellt'],
  [drawing, "artStudioTab === 'colors' && <section", 'nur der gewählte Farbbereich wird dargestellt'],
  [drawing, "artStudioTab === 'symbols' && <section", 'nur der gewählte Piktogrammbereich wird dargestellt'],
  [app, 'className="editor-more-menu" role="menu"', 'gruppiertes Notizmenü'],
  [app, 'editor-menu-label">Ansicht', 'Ansichtsgruppe im Notizmenü'],
  [app, 'editor-menu-label">Datei', 'Dateigruppe im Notizmenü'],
  [app, 'aria-haspopup="menu" aria-expanded={editorMenuOpen}', 'semantischer Menüschalter'],
  [tree, 'className="file-tree__menu-head"', 'Kontextmenü mit erkennbarem Objektkopf'],
  [tree, 'file-tree__menu-label">Erstellen', 'Erstellen-Gruppe im Ordner-Menü'],
  [tree, 'file-tree__menu-label">Verwalten', 'Verwalten-Gruppe im Datei-Menü'],
  [settings, "label: 'Aussehen & Schreiben'", 'übersichtliche Einstellungsgruppe für Aussehen und Schreiben'],
  [settings, "label: 'Stift & Arbeitsbereich'", 'übersichtliche Einstellungsgruppe für Stift und Arbeitsbereich'],
  [settings, "label: 'FaNotes & System'", 'übersichtliche Einstellungsgruppe für FaNotes und System'],
  [settings, 'placeholder="Einstellungen suchen"', 'durchsuchbares Einstellungsmenü'],
  [settings, 'className="settings-search-results" aria-live="polite"', 'zugängliche Einstellungssuche'],
  [settings, 'id="settings-onenote"', 'direkt anspringbarer OneNote-Import'],
  [styles, '@keyframes editor-menu-in', 'ruhige Menüanimation'],
  [styles, '@media (prefers-reduced-motion: reduce)', 'respektierte reduzierte Bewegung'],
]

for (const [source, needle, label] of requirements) {
  if (!source.includes(needle)) throw new Error(`Menüprüfung fehlgeschlagen: ${label}.`)
}

const tabs = drawing.match(/role="tab" id="lw-art-tab-/gu) ?? []
if (tabs.length !== 3) throw new Error(`Das Zeichenstudio besitzt ${tabs.length} statt 3 Tabs.`)

const preservedSettings = [
  'Farbschema', 'Arbeitsflächen-Design', 'Akzentfarbe', 'Zweite Akzentfarbe',
  'Kompakte Oberfläche', 'Glas-Effekte', 'Oberflächen-Schrift', 'Editor-Schrift',
  'Editor-Schriftgröße', 'KI-Vorschau-Schriftgröße', 'Zeilenhöhe', 'Live-Ansicht',
  'Lesbare Zeilenlänge', 'Maximale Inhaltsbreite', 'Zeilennummern',
  'Rechtschreibprüfung', 'Wortzahl in Statusleiste', 'Gliederung anzeigen', 'Papier',
  'Stiftfarbe', 'Stiftbreite', 'Druckempfindlichkeit', 'Strichglättung',
  'Durchkritzel-Empfindlichkeit', 'Erkennungsmodus', 'Textsprache',
  'Lokales Kontextlernen', 'Unsichtbarer Suchindex', 'Zeichnung nach Einfügen behalten',
  'Automatisch speichern', 'Standardordner', 'Tagesnotizen', 'Datumsformat',
  'Automatisch nach Updates suchen', 'Updates automatisch herunterladen',
  'Beim Beenden installieren', 'Bewegung reduzieren', 'Seitenleiste',
  'Informationsleiste', 'Vim-Modus',
]
for (const title of preservedSettings) {
  if (!settings.includes(`title="${title}"`)) throw new Error(`Die vorhandene Einstellung „${title}“ fehlt.`)
}

const settingTargets = settings.match(/id="settings-[a-z-]+"/gu) ?? []
if (settingTargets.length < 16) throw new Error(`Das Einstellungsmenü hat nur ${settingTargets.length} direkt anspringbare Bereiche.`)

console.log(`Menüprüfung erfolgreich: Notizmenü, Datei-Kontextmenü, Zeichenstudio und ${preservedSettings.length} vorhandene Einstellungen sind gruppiert, durchsuchbar, zugänglich und responsiv.`)
