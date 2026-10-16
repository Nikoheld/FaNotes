package ch.fasrv.fanotes.desk

import java.text.Normalizer
import java.util.Locale

/**
 * Settings the desktop dialog can find, limited to controls this tablet
 * actually shows. GlyphenWerk, OneNote import, and the other desktop-only
 * rows stay out of the list.
 */
data class SettingsSearchItem(
    val label: String,
    val detail: String,
    val section: String,
    val target: String,
    val keywords: String,
)

private val SEARCH_LOCALE = Locale.forLanguageTag("de-CH")

val SETTINGS_SEARCH_ITEMS: List<SettingsSearchItem> = listOf(
    SettingsSearchItem("Sync-Konto", "Sync", "sync", "settings-sync-account", "sync konto anmelden registrieren account login passwort e-mail cloud server geräte"),
    SettingsSearchItem("Angemeldete Geräte", "Sync", "sync", "settings-sync-devices", "sync geräte devices laptop tablet abmelden name"),
    SettingsSearchItem("Farbschema & Themes", "Darstellung", "appearance", "settings-surface", "theme dunkel hell system graphit klar mitternacht wald aurora sepia farbe"),
    SettingsSearchItem("Arbeitsflächen-Design", "Darstellung", "appearance", "settings-surface", "hintergrund verlauf mesh papier clean"),
    SettingsSearchItem("Akzentfarben", "Darstellung", "appearance", "settings-accent", "farbe primär sekundär eigene accent"),
    SettingsSearchItem("Kompakte Oberfläche", "Darstellung", "appearance", "settings-surface", "dichte platz klein kompakt"),
    SettingsSearchItem("Glas-Effekte", "Darstellung", "appearance", "settings-surface", "transparenz blur unschärfe glass"),
    SettingsSearchItem("Schriften & Textgrößen", "Darstellung", "appearance", "settings-typography", "typografie font editor schrift zeilenhöhe vorschau"),
    SettingsSearchItem("Inhaltsbreite & Zeilenlänge", "Editor", "editor", "settings-width", "breite lesen zeile word seite"),
    SettingsSearchItem("Zoom-Geschwindigkeit", "Editor", "editor", "settings-zoom", "zoom geschwindigkeit mausrad pinch trackpad"),
    SettingsSearchItem("Zoom-Limit", "Editor", "editor", "settings-zoom", "zoom limit maximum hinein 50 325 600 prozent"),
    SettingsSearchItem("Zeilennummern, Wortzahl & Gliederung", "Editor", "editor", "settings-editor", "statusleiste outline struktur markdown zeilennummern wortzahl"),
    SettingsSearchItem("Rechtschreibprüfung", "Editor", "editor", "settings-editor", "rechtschreibung sprache deutsch englisch rot unterstreichen fehler spellcheck vorschläge wörterbuch"),
    SettingsSearchItem("Papier & Stift", "Stift & Erkennung", "drawing", "settings-tablet", "tablet karos linien punkte gepunktet häuschen kästchen millimeter farbe breite druck glättung hintergrund handschrift stift"),
    SettingsSearchItem("Stifte- und Tablett-Tasten", "Stift & Erkennung", "drawing", "settings-tablet-buttons", "wacom tablett taste barrel radierer expresskey stift knopf mapping"),
    SettingsSearchItem("Durchkritzel-Empfindlichkeit", "Stift & Erkennung", "drawing", "settings-tablet", "löschen radierer scribble sensitivity"),
    SettingsSearchItem("Form-Erkennung", "Stift & Erkennung", "drawing", "settings-tablet", "form zirkel kreis linie rechteck dreieck glätten snap stillhalten empfindlichkeit"),
    SettingsSearchItem("Alte Notizen auf den aktuellen Standard", "Stift & Erkennung", "drawing", "settings-note-standard", "hidpi scharf qualität standard konvertieren alte notizen pixel"),
    SettingsSearchItem("Notiz-Backup", "Experimentell", "experimental", "settings-note-backup", "backup sichern wiederherstellen snapshot notiz"),
    SettingsSearchItem("Vault & Speicherort", "Dateien & Vault", "files", "settings-vault", "ordner wechseln pfad notizen markdown vault"),
    SettingsSearchItem("Automatisches Speichern", "Dateien & Vault", "files", "settings-save", "autosave verzögerung dateiverhalten speichern"),
    SettingsSearchItem("Standardordner & Tagesnotizen", "Dateien & Vault", "files", "settings-daily", "daily notes datum format folder tagesnotiz standardordner"),
    SettingsSearchItem("Automatische Updates", "Updates", "updates", "settings-updates", "download installieren starten prüfen version release"),
    SettingsSearchItem("Bewegung reduzieren", "Bedienung", "accessibility", "settings-comfort", "animation transition barrierefrei fokus bewegung"),
    SettingsSearchItem("Seitenleisten-Breite", "Bedienung", "accessibility", "settings-comfort", "sidebar informationsleiste panel breite layout"),
    SettingsSearchItem("Eigenes CSS", "Erweitert", "advanced", "settings-css", "custom style design code variablen css"),
)

/** Desktop `normalizeSearch`: accents fold away and ß becomes ss. */
fun normalizeSettingsSearch(value: String): String {
    val folded = Normalizer.normalize(value, Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "")
    return folded.replace("ß", "ss").lowercase(SEARCH_LOCALE).trim()
}

/**
 * Every typed word must appear in the label, the group, or the keywords.
 * A blank query lists nothing, the same way the desktop nav stays on sections.
 */
fun searchSettings(query: String, items: List<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS): List<SettingsSearchItem> {
    val terms = normalizeSettingsSearch(query).split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (terms.isEmpty()) return emptyList()
    return items.filter { item ->
        val haystack = normalizeSettingsSearch("${item.label} ${item.detail} ${item.keywords}")
        terms.all { term -> haystack.contains(term) }
    }
}

/** One row in the desktop settings navigation. [count] is the desktop option count in the eyebrow. */
data class SettingsNavItem(val id: String, val label: String, val detail: String, val group: String, val count: Int)

val SETTINGS_NAV: List<SettingsNavItem> = listOf(
    SettingsNavItem("appearance", "Darstellung", "Farben, Schriften und Dichte", "Aussehen & Schreiben", 12),
    SettingsNavItem("editor", "Editor", "Markdown und Schreiben", "Aussehen & Schreiben", 8),
    SettingsNavItem("drawing", "Stift & Erkennung", "Tablet, Papier und Handschrift", "Stift & Arbeitsbereich", 16),
    SettingsNavItem("files", "Dateien & Vault", "Import, Ordner und Speichern", "Stift & Arbeitsbereich", 7),
    SettingsNavItem("sync", "Sync", "Konto, Geräte und Verschlüsselung", "FaNotes & System", 6),
    SettingsNavItem("addons", "Add-ons", "Store, Quelle und Updates", "FaNotes & System", 3),
    SettingsNavItem("updates", "Updates", "Stable, Beta und Sicherheit", "FaNotes & System", 4),
    SettingsNavItem("accessibility", "Bedienung", "Bewegung und Lesbarkeit", "FaNotes & System", 3),
    SettingsNavItem("experimental", "Experimentell", "Unfertige Funktionen, standardmässig aus", "FaNotes & System", 5),
    SettingsNavItem("advanced", "Erweitert", "Ressourcen, Datenschutz und App-Daten", "FaNotes & System", 10),
)

/** Eyebrow above the section title: „Anpassung · 12 Optionen“. */
fun settingsEyebrow(count: Int) = "Anpassung · $count Optionen"

/** Groups in desktop order, each with its rows. */
fun settingsNavGroups(items: List<SettingsNavItem> = SETTINGS_NAV): List<Pair<String, List<SettingsNavItem>>> {
    val order = items.map { it.group }.distinct()
    return order.map { group -> group to items.filter { it.group == group } }
}

/** Nav metrics from `.settings-nav`. The later pass paints the active row as panel-active. */
const val SETTINGS_NAV_ROW_DP = 43
const val SETTINGS_NAV_RADIUS_DP = 9
const val SETTINGS_NAV_LABEL_WEIGHT = 650
const val SETTINGS_NAV_GROUP_WEIGHT = 750
const val SETTINGS_NAV_GROUP_TRACKING = 0.08f
/** `.settings-nav nav { gap: 9px }` stays after group headings hide. */
const val SETTINGS_NAV_GROUP_GAP_DP = 9
/** `.settings-nav-group { gap: 2px }`. */
const val SETTINGS_NAV_ITEM_GAP_DP = 2
/** Section icon on a nav button. Search hits stay at 15. */
const val SETTINGS_NAV_ICON_DP = 16

/** Settings content header and footer from `.settings-content`. */
const val SETTINGS_TITLE_SP = 21
const val SETTINGS_TITLE_TRACKING = -0.03f
const val SETTINGS_HEADER_PAD_TOP_DP = 18
const val SETTINGS_HEADER_PAD_X_DP = 25
const val SETTINGS_HEADER_PAD_BOTTOM_DP = 15
const val SETTINGS_FOOTER_DP = 47
const val SETTINGS_DONE = "Fertig"
const val SETTINGS_SAVED = "Änderungen werden automatisch lokal gespeichert."
const val SETTINGS_BRAND = "Einstellungen"
const val SETTINGS_BRAND_DETAIL = "FaNotes an dich anpassen"
const val SETTINGS_SEARCH_PLACEHOLDER = "Einstellungen suchen"
const val SETTINGS_SEARCH_LABEL = "Einstellungen durchsuchen"
const val SETTINGS_SEARCH_CLEAR = "Einstellungssuche leeren"
const val SETTINGS_SEARCH_HINT = "Versuche zum Beispiel „Schrift“, „Backup“ oder „Handschrift“."
const val SETTINGS_SEARCH_DP = 35
const val SETTINGS_SEARCH_RADIUS_DP = 9
const val SETTINGS_SEARCH_PAD_DP = 9
const val SETTINGS_SEARCH_GAP_DP = 7
const val SETTINGS_SEARCH_ICON_DP = 14
const val SETTINGS_SEARCH_CLEAR_DP = 22
const val SETTINGS_SEARCH_CLEAR_ICON_DP = 13
const val SETTINGS_SEARCH_CLEAR_RADIUS_DP = 6
const val SETTINGS_SEARCH_FILL_ALPHA = 0.72f
const val SETTINGS_SEARCH_FOCUS_ALPHA = 0.48f
const val SETTINGS_SEARCH_RING_ALPHA = 0.10f
const val SETTINGS_BRAND_DP = 32
const val SETTINGS_BRAND_RADIUS_DP = 10
const val SETTINGS_BRAND_GAP_DP = 11
const val SETTINGS_NAV_PAD_TOP_DP = 18
const val SETTINGS_NAV_PAD_X_DP = 13
const val SETTINGS_NAV_PAD_BOTTOM_DP = 12
const val SETTINGS_RESULT_GAP_DP = 3
/** Search-hit icon. Section rows use [SETTINGS_NAV_ICON_DP]. */
const val SETTINGS_RESULT_ICON_DP = 15
const val SETTINGS_EYEBROW_TRACKING = 0.12f

fun settingsSearchCount(count: Int) = if (count == 0) "Keine Treffer" else "$count Treffer"
const val SETTINGS_SCROLL_PAD_TOP_DP = 19
const val SETTINGS_SCROLL_PAD_X_DP = 25
const val SETTINGS_SCROLL_PAD_BOTTOM_DP = 34

/** Setting card after the later chrome pass: 12px corners and a 70% strong panel. */
const val SETTING_CARD_RADIUS_DP = 12
const val SETTING_CARD_MARGIN_DP = 14
const val SETTING_CARD_FILL_ALPHA = 0.70f
const val SETTING_TITLE_DP = 39
const val SETTING_TITLE_PAD_DP = 15
const val SETTING_TITLE_GAP_DP = 7
const val SETTING_TITLE_ICON_DP = 16
const val SETTING_TITLE_WEIGHT = 700
const val SETTING_TITLE_TRACKING = 0.06f
const val SETTING_ROW_MIN_DP = 58
const val SETTING_ROW_PAD_Y_DP = 10
const val SETTING_ROW_PAD_X_DP = 15
const val SETTING_ROW_GAP_DP = 22
const val SETTING_COPY_WEIGHT = 580
const val THEME_CHOICE_MIN_DP = 47
const val THEME_CHOICE_RADIUS_DP = 9
const val THEME_CHOICE_GAP_DP = 6
const val THEME_PREVIEW_W_DP = 43
const val THEME_PREVIEW_H_DP = 31
const val THEME_PREVIEW_RADIUS_DP = 7
const val SWATCH_DP = 23
const val SWATCH_GAP_DP = 6
