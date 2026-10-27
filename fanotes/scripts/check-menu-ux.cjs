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
  [tree, 'file-tree__menu-label">Teilen', 'Teilen im Datei- und Ordner-Menü'],
  [app, 'onShare={shareVaultEntry}', 'Seitenleiste teilt die gewählte Notiz oder den Ordner'],
  [settings, "label: 'Aussehen & Schreiben'", 'übersichtliche Einstellungsgruppe für Aussehen und Schreiben'],
  [settings, "label: 'Stift & Arbeitsbereich'", 'übersichtliche Einstellungsgruppe für Stift und Arbeitsbereich'],
  [settings, "label: 'Bedienung'", 'eigene Gruppe für Bedienung'],
  [settings, "label: 'Dateien & Vault'", 'eigene Gruppe für Dateien und Vault'],
  [settings, "label: 'Sync'", 'eigene Gruppe für Sync'],
  [settings, "label: 'Profil'", 'eigene Gruppe für das öffentliche Profil'],
  [settings, "label: 'Teilen'", 'eigene Gruppe für Freigaben'],
  [settings, "label: 'Add-ons'", 'eigene Gruppe für Add-ons'],
  [settings, "label: 'Updates'", 'eigene Gruppe für Updates'],
  [settings, "label: 'Experimentell'", 'eigene Gruppe für Experimente'],
  [settings, "label: 'Erweitert'", 'eigene Gruppe für App-Daten und Ressourcen'],
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
  'Automatisch installieren', 'Bewegung reduzieren', 'Seitenleiste',
  'Informationsleiste', 'Vim-Modus',
]
for (const title of preservedSettings) {
  if (!settings.includes(`title="${title}"`)) throw new Error(`Die vorhandene Einstellung „${title}“ fehlt.`)
}

const settingTargets = settings.match(/id="settings-[a-z-]+"/gu) ?? []
if (settingTargets.length < 16) throw new Error(`Das Einstellungsmenü hat nur ${settingTargets.length} direkt anspringbare Bereiche.`)

if (settings.includes("label: 'FaNotes & System'") || settings.includes("sections: ['sync', 'share', 'addons', 'updates', 'accessibility', 'experimental', 'advanced']")) {
  throw new Error('Die alte Sammelgruppe FaNotes & System ist noch vorhanden.')
}

const sliceBetween = (start, end) => {
  const from = settings.indexOf(start)
  const to = end ? settings.indexOf(end, from + start.length) : settings.length
  if (from < 0 || to < 0 || to <= from) throw new Error(`Abschnitt ${start} fehlt.`)
  return settings.slice(from, to)
}
const drawingPage = sliceBetween("active === 'drawing'", "active === 'files'")
const filesPage = sliceBetween("active === 'files'", "active === 'sync'")
const syncPage = sliceBetween("active === 'sync'", "active === 'profile'")
const profilePage = sliceBetween("active === 'profile'", "active === 'share'")
const updatesPage = sliceBetween("active === 'updates'", "active === 'accessibility'")
const experimentalPage = sliceBetween("active === 'experimental'", "active === 'advanced'")
const advancedPage = sliceBetween("active === 'advanced'", '')
if (!drawingPage.includes('id="settings-enhanced-math"') || !drawingPage.includes('id="settings-qwen-vision"') || !drawingPage.includes('Präzises Formelmodell') || !drawingPage.includes('Qwen3-VL')) {
  throw new Error('Die Handschriftmodelle fehlen auf der Stift-Seite.')
}
if (drawingPage.includes('App-Daten zurücksetzen') || drawingPage.includes('id="settings-css"') || drawingPage.includes('id="settings-reset"')) {
  throw new Error('Die Stift-Seite enthält App-Daten oder eigenes CSS.')
}
if (advancedPage.includes('id="settings-enhanced-math"') || advancedPage.includes('id="settings-qwen-vision"') || advancedPage.includes('Präzises Formelmodell') || advancedPage.includes('Qwen3-VL')) {
  throw new Error('Die Erweitert-Seite zeigt noch Handschriftmodelle.')
}
if (!advancedPage.includes('id="settings-css"') || !advancedPage.includes('id="settings-reset"') || !advancedPage.includes('App-Daten zurücksetzen') || !advancedPage.includes('Eigenes CSS') || !advancedPage.includes('id="settings-bug-report"')) {
  throw new Error('Die Erweitert-Seite enthält nicht mehr CSS, Zurücksetzen und Fehler melden.')
}
if (!filesPage.includes('id="settings-backup"') || !filesPage.includes('id="settings-note-backup"') || !filesPage.includes('Server-Backup') || !filesPage.includes('Notiz-Backup') || !filesPage.includes('Experimentell') || !filesPage.includes('Standard aus')) {
  throw new Error('Beide Backups liegen nicht auf der Dateien-Seite.')
}
if (experimentalPage.includes('id="settings-note-backup"') || experimentalPage.includes('title="Notiz-Backup"')) {
  throw new Error('Notiz-Backup liegt noch unter Experimentell.')
}
if (syncPage.includes('ProfileSettingsCard') || syncPage.includes('id="settings-profile"')) {
  throw new Error('Das öffentliche Profil liegt noch in den Sync-Karten.')
}
if (!profilePage.includes('ProfileSettingsCard')) throw new Error('Die Profil-Seite zeigt das öffentliche Profil nicht.')
if (updatesPage.includes('id="settings-bug-report"') || updatesPage.includes('Fehler melden')) {
  throw new Error('Fehler melden liegt noch zwischen Update-Status und Automatisierung.')
}
const updateStatus = updatesPage.indexOf('update-hero')
const updateAutomation = updatesPage.indexOf('id="settings-update-automation"')
if (updateStatus < 0 || updateAutomation < updateStatus) throw new Error('Die Update-Automatisierung folgt nicht auf den Update-Status.')
const searchTargets = [
  ["label: 'Handschrift zu Text', detail: 'Experimentell', section: 'experimental', target: 'settings-experimental'"],
  ["label: 'Freigaben', detail: 'Teilen', section: 'share', target: 'settings-share'"],
  ["label: 'Öffentliche Aktivitätsübersicht', detail: 'Profil', section: 'profile', target: 'settings-profile'"],
  ["label: 'Präzises Formelmodell', detail: 'Stift & Erkennung', section: 'drawing', target: 'settings-enhanced-math'"],
  ["label: 'Empfohlen: Qwen3-VL Texterkennung (Intel NPU)', detail: 'Stift & Erkennung', section: 'drawing', target: 'settings-qwen-vision'"],
  ["label: 'Microsoft OneNote importieren', detail: 'Dateien & Vault', section: 'files', target: 'settings-onenote'"],
  ["label: 'Notiz-Backup', detail: 'Dateien & Vault', section: 'files', target: 'settings-note-backup'"],
  ["label: 'Stable-, Beta- oder Nightly-Kanal', detail: 'Updates', section: 'updates', target: 'settings-update-channel'"],
  ["label: 'Fehler melden', detail: 'Erweitert', section: 'advanced', target: 'settings-bug-report'"],
  ["label: 'App-Daten zurücksetzen', detail: 'Erweitert', section: 'advanced', target: 'settings-reset'"],
]
for (const needle of searchTargets) {
  if (!settings.includes(needle)) throw new Error(`Suchziel fehlt: ${needle}`)
}
if (!settings.includes('{`Anpassung · ${section.count} Optionen`}')) throw new Error('Die Optionszahl wird nicht mehr aus section.count gelesen.')

console.log(`Menüprüfung erfolgreich: Notizmenü, Datei-Kontextmenü, Zeichenstudio und ${preservedSettings.length} vorhandene Einstellungen sind gruppiert, durchsuchbar, zugänglich und responsiv.`)
console.log('Gruppen Aussehen & Schreiben|Bedienung|Stift & Arbeitsbereich|Dateien & Vault|Sync|Profil|Teilen|Add-ons|Updates|Experimentell|Erweitert')
console.log('Sammelgruppe FaNotes & System fehlt')
