package ch.fasrv.fanotes.desk

import java.text.Normalizer
import java.util.Locale

/**
 * Settings the desktop dialog can find, limited to controls this tablet
 * actually shows. GlyphenWerk, spellcheck dictionaries, OneNote import, and
 * the other desktop-only rows stay out of the list.
 */
data class SettingsSearchItem(
    val label: String,
    val detail: String,
    val section: String,
    val keywords: String,
)

private val SEARCH_LOCALE = Locale.forLanguageTag("de-CH")

val SETTINGS_SEARCH_ITEMS: List<SettingsSearchItem> = listOf(
    SettingsSearchItem("Sync-Konto", "Sync", "sync", "sync konto anmelden registrieren account login passwort e-mail cloud server geräte"),
    SettingsSearchItem("Angemeldete Geräte", "Sync", "sync", "sync geräte devices laptop tablet abmelden name"),
    SettingsSearchItem("Farbschema & Themes", "Darstellung", "appearance", "theme dunkel hell system graphit klar mitternacht wald aurora sepia farbe"),
    SettingsSearchItem("Arbeitsflächen-Design", "Darstellung", "appearance", "hintergrund verlauf mesh papier clean"),
    SettingsSearchItem("Akzentfarben", "Darstellung", "appearance", "farbe primär sekundär eigene accent"),
    SettingsSearchItem("Kompakte Oberfläche", "Darstellung", "appearance", "dichte platz klein kompakt"),
    SettingsSearchItem("Glas-Effekte", "Darstellung", "appearance", "transparenz blur unschärfe glass"),
    SettingsSearchItem("Schriften & Textgrößen", "Darstellung", "appearance", "typografie font editor schrift zeilenhöhe vorschau"),
    SettingsSearchItem("Inhaltsbreite & Zeilenlänge", "Editor", "editor", "breite lesen zeile word seite"),
    SettingsSearchItem("Zoom-Geschwindigkeit", "Editor", "editor", "zoom geschwindigkeit mausrad pinch trackpad"),
    SettingsSearchItem("Zoom-Limit", "Editor", "editor", "zoom limit maximum hinein 50 325 600 prozent"),
    SettingsSearchItem("Zeilennummern, Wortzahl & Gliederung", "Editor", "editor", "statusleiste outline struktur markdown zeilennummern wortzahl"),
    SettingsSearchItem("Papier & Stift", "Stift & Erkennung", "drawing", "tablet karos linien punkte gepunktet häuschen kästchen millimeter farbe breite druck glättung hintergrund handschrift stift"),
    SettingsSearchItem("Stifte- und Tablett-Tasten", "Stift & Erkennung", "drawing", "wacom tablett taste barrel radierer expresskey stift knopf mapping"),
    SettingsSearchItem("Durchkritzel-Empfindlichkeit", "Stift & Erkennung", "drawing", "löschen radierer scribble sensitivity"),
    SettingsSearchItem("Form-Erkennung", "Stift & Erkennung", "drawing", "form zirkel kreis linie rechteck dreieck glätten snap stillhalten empfindlichkeit"),
    SettingsSearchItem("Notiz-Backup", "Experimentell", "experimental", "backup sichern wiederherstellen snapshot notiz"),
    SettingsSearchItem("Vault & Speicherort", "Dateien & Vault", "files", "ordner wechseln pfad notizen markdown vault"),
    SettingsSearchItem("Automatisches Speichern", "Editor", "editor", "autosave verzögerung dateiverhalten speichern"),
    SettingsSearchItem("Standardordner & Tagesnotizen", "Editor", "editor", "daily notes datum format folder tagesnotiz standardordner"),
    SettingsSearchItem("Automatische Updates", "Updates", "updates", "download installieren starten prüfen version release"),
    SettingsSearchItem("Bewegung reduzieren", "Bedienung", "accessibility", "animation transition barrierefrei fokus bewegung"),
    SettingsSearchItem("Seitenleisten-Breite", "Bedienung", "accessibility", "sidebar informationsleiste panel breite layout"),
    SettingsSearchItem("Eigenes CSS", "Erweitert", "advanced", "custom style design code variablen css"),
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
