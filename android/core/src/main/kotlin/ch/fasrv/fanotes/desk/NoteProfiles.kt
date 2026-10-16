package ch.fasrv.fanotes.desk

import kotlin.math.abs
import kotlin.math.ceil
import java.util.Locale
import kotlin.math.roundToInt

/** Starter folders and note templates from the desktop first-run profile. */
data class ProfileFolder(val name: String, val color: String)
data class NoteTemplate(val id: String, val profile: String, val title: String, val fileName: String, val markdown: String)

const val TEMPLATES_FOLDER = "Vorlagen"

val NOTE_TEMPLATES = listOf(
    NoteTemplate(
        "protocol",
        "school",
        "Protokoll",
        "Protokoll",
        """
        |# Protokoll
        |
        |**Fach:**
        |**Datum:**
        |**Versuch:**
        |
        |## Aufbau
        |
        |## Beobachtung
        |
        |## Ergebnis
        |
        |## Frage
        |
        """.trimMargin(),
    ),
    NoteTemplate(
        "proof",
        "university",
        "Beweis",
        "Beweis",
        """
        |# Beweis
        |
        |**Satz.**
        |
        |## Voraussetzungen
        |
        |## Beweis
        |
        |1.
        |
        |## Bemerkung
        |
        """.trimMargin(),
    ),
    NoteTemplate(
        "cornell",
        "school",
        "Cornell",
        "Cornell",
        """
        |# Cornell
        |
        || Stichworte | Notizen |
        || --- | --- |
        ||  |  |
        |
        |## Zusammenfassung
        |
        """.trimMargin(),
    ),
    NoteTemplate(
        "vocabulary",
        "school",
        "Vokabeln",
        "Vokabeln",
        """
        |# Vokabeln
        |
        || Wort | Übersetzung | Beispiel |
        || --- | --- | --- |
        ||  |  |  |
        |
        """.trimMargin(),
    ),
    NoteTemplate(
        "journal",
        "private",
        "Tagebuch",
        "Tagebuch",
        """
        |# Tagebuch
        |
        |## Was passiert ist
        |
        |## Was ich mitnehme
        |
        """.trimMargin(),
    ),
    NoteTemplate(
        "meeting",
        "work",
        "Besprechung",
        "Besprechung",
        """
        |# Besprechung
        |
        |**Datum:**
        |**Teilnehmende:**
        |
        |## Beschlüsse
        |
        |- [ ]
        |
        |## Offene Punkte
        |
        |- [ ]
        |
        """.trimMargin(),
    ),
)

fun templatesForProfile(profile: String): List<NoteTemplate> = NOTE_TEMPLATES.filter { template ->
    template.profile == profile || (template.profile == "school" && profile == "university")
}

fun templatePath(template: NoteTemplate) = "$TEMPLATES_FOLDER/${template.fileName}.md"

/** Seed only while the template folder is still absent. */
fun templatesToSeed(existingPaths: List<String>, profile: String): List<NoteTemplate> {
    if (existingPaths.any { it == TEMPLATES_FOLDER || it.startsWith("$TEMPLATES_FOLDER/") }) return emptyList()
    return templatesForProfile(profile)
}

fun profileFolders(profile: String): List<ProfileFolder> = when (profile) {
    "university" -> listOf(
        ProfileFolder("Vorlesungen", "#2a6f97"),
        ProfileFolder("Seminare", "#9065b0"),
        ProfileFolder("Forschung", "#0f7b6c"),
        ProfileFolder("Prüfungen", "#c4554d"),
        ProfileFolder("Literatur", "#ba9b4a"),
    )
    "private" -> listOf(
        ProfileFolder("Persönlich", "#c4554d"),
        ProfileFolder("Ideen", "#9065b0"),
        ProfileFolder("Projekte", "#337ea9"),
        ProfileFolder("Tagebuch", "#448361"),
        ProfileFolder("Dokumente", "#ba9b4a"),
    )
    "work" -> listOf(
        ProfileFolder("Projekte", "#337ea9"),
        ProfileFolder("Meetings", "#9065b0"),
        ProfileFolder("Aufgaben", "#c4554d"),
        ProfileFolder("Wissen", "#0f7b6c"),
        ProfileFolder("Archiv", "#ba9b4a"),
    )
    else -> listOf(
        ProfileFolder("Mathematik", "#2a6f97"),
        ProfileFolder("AMAT", "#9065b0"),
        ProfileFolder("Deutsch", "#c4554d"),
        ProfileFolder("Englisch", "#0f7b6c"),
        ProfileFolder("Französisch", "#1d5f86"),
        ProfileFolder("Physik", "#7c6a9a"),
        ProfileFolder("Chemie", "#d9730d"),
        ProfileFolder("Biologie", "#448361"),
        ProfileFolder("Geschichte", "#ba9b4a"),
        ProfileFolder("Informatik", "#337ea9"),
        ProfileFolder("Wirtschaft", "#c47d4e"),
    )
}

data class FirstRunProfile(val id: String, val title: String, val description: String)

data class FirstRunDraft(
    val step: Int = 0,
    val profile: String = "school",
    val selected: Set<String> = emptySet(),
)

val FIRST_RUN_STEPS = listOf("Willkommen", "Profil", "Deine Seite", "Deine Ordner")

fun firstRunProfiles() = listOf(
    FirstRunProfile("school", "Schule", "Fächer, Aufgaben und Prüfungen klar organisieren."),
    FirstRunProfile("university", "UNI", "Vorlesungen, Forschung und Literatur zusammenhalten."),
    FirstRunProfile("private", "Privat", "Ideen, Tagebuch, Projekte und wichtige Dokumente."),
    FirstRunProfile("work", "Arbeit", "Meetings, Aufgaben und Wissen an einem ruhigen Ort."),
)

fun firstRunStart(): FirstRunDraft {
    val folders = profileFolders("school").map { it.name }.toSet()
    return FirstRunDraft(step = 0, profile = "school", selected = folders)
}

fun firstRunStep(draft: FirstRunDraft, step: Int): FirstRunDraft =
    draft.copy(step = step.coerceIn(0, FIRST_RUN_STEPS.lastIndex))

fun firstRunChooseProfile(draft: FirstRunDraft, profile: String): FirstRunDraft {
    val known = firstRunProfiles().any { it.id == profile }
    val id = if (known) profile else "school"
    return draft.copy(profile = id, selected = profileFolders(id).map { it.name }.toSet())
}

fun firstRunToggleFolder(draft: FirstRunDraft, name: String): FirstRunDraft {
    val allowed = profileFolders(draft.profile).map { it.name }.toSet()
    if (name !in allowed) return draft
    val next = if (name in draft.selected) draft.selected - name else draft.selected + name
    return draft.copy(selected = next)
}

fun firstRunToggleAll(draft: FirstRunDraft): FirstRunDraft {
    val names = profileFolders(draft.profile).map { it.name }
    val next = if (names.all { it in draft.selected }) emptySet() else names.toSet()
    return draft.copy(selected = next)
}

fun firstRunChosenFolders(draft: FirstRunDraft): List<ProfileFolder> =
    profileFolders(draft.profile).filter { it.name in draft.selected }

fun firstRunPlanLine(count: Int): String =
    if (count == 0) "Nur Eingang wird angelegt." else "$count Ordner + Eingang wird angelegt."

fun firstRunSelectionLine(selected: Int, total: Int): String = "$selected von $total ausgewählt"

private val FOLDER_BLURBS = mapOf(
    "Mathematik" to ("∑" to "Algebra, Geometrie & Analysis"),
    "AMAT" to ("f(x)" to "Anwendungen der Mathematik"),
    "Deutsch" to ("Aa" to "Sprache, Literatur & Aufsätze"),
    "Englisch" to ("Ab" to "Vocabulary, texts & grammar"),
    "Französisch" to ("Fr" to "Grammatik, Texte & Vokabeln"),
    "Physik" to ("λ" to "Mechanik, Elektrizität & Wellen"),
    "Chemie" to ("H₂" to "Stoffe, Reaktionen & Formeln"),
    "Biologie" to ("DNA" to "Leben, Umwelt & Genetik"),
    "Geschichte" to ("Ⅰ" to "Epochen, Quellen & Zusammenhänge"),
    "Informatik" to ("</>" to "Code, Systeme & Algorithmen"),
    "Wirtschaft" to ("%" to "Betriebe, Märkte & Finanzen"),
    "Vorlesungen" to ("Vo" to "Organisierter Startordner"),
    "Persönlich" to ("Pe" to "Organisierter Startordner"),
)

fun firstRunFolderMark(name: String): String = FOLDER_BLURBS[name]?.first ?: name.take(2)

const val FIRST_RUN_SUBJECT_FILL = 0.13f
const val FIRST_RUN_SUBJECT_LINE = 0.61f
const val FIRST_RUN_SUBJECT_INK = 0.80f

/** Opaque ARGB for a `#rrggbb` folder color. */
fun firstRunFolderArgb(hex: String): Int {
    val rgb = hex.trim().removePrefix("#").toInt(16) and 0xFFFFFF
    return (0xFF shl 24) or rgb
}

/**
 * CSS `color-mix(in srgb, source share, into)`.
 * Alpha is mixed in premultiplied form, the same way the browser mixes `--border`.
 */
fun cssColorMix(source: Int, into: Int, sourceShare: Float): Int {
    val share = sourceShare.coerceIn(0f, 1f)
    fun channel(color: Int, shift: Int): Int = (color ushr shift) and 0xFF
    val p1 = share * (channel(source, 24) / 255f)
    val p2 = (1f - share) * (channel(into, 24) / 255f)
    val alpha = p1 + p2
    if (alpha <= 0f) return 0
    fun mixed(shift: Int): Int =
        ((channel(source, shift) * p1 + channel(into, shift) * p2) / alpha).roundToInt().coerceIn(0, 255)
    val a = (alpha * 255f).roundToInt().coerceIn(0, 255)
    return (a shl 24) or (mixed(16) shl 16) or (mixed(8) shl 8) or mixed(0)
}

/** `color-mix` of [source] into [into] by [sourceShare]. */
fun mixArgb(source: Int, into: Int, sourceShare: Float): Int {
    val share = sourceShare.coerceIn(0f, 1f)
    fun channel(shift: Int): Int {
        val from = (source ushr shift) and 0xFF
        val to = (into ushr shift) and 0xFF
        return (from * share + to * (1f - share)).roundToInt().coerceIn(0, 255)
    }
    return (0xFF shl 24) or (channel(16) shl 16) or (channel(8) shl 8) or channel(0)
}

/** Mark ink: 80% folder color mixed into the theme text. */
fun firstRunSubjectInk(colorHex: String, textArgb: Int): Int =
    mixArgb(firstRunFolderArgb(colorHex), textArgb, FIRST_RUN_SUBJECT_INK)

fun firstRunFolderBlurb(name: String): String = FOLDER_BLURBS[name]?.second ?: "Organisierter Startordner"

/** First-run shell after the later chrome pass: inverted 8px mark, 12px profile cards. */
const val FIRST_RUN_MAX_DP = 1180
const val FIRST_RUN_GUTTER_DP = 36
const val FIRST_RUN_LOGO_DP = 39
const val FIRST_RUN_LOGO_RADIUS_DP = 8
const val FIRST_RUN_LOGO_ICON_DP = 18
const val FIRST_RUN_STEP_DP = 22
const val FIRST_RUN_PROFILE_RADIUS_DP = 12
const val FIRST_RUN_PROFILE_MIN_DP = 150
const val FIRST_RUN_PICKER_RADIUS_DP = 12
const val FIRST_RUN_SUBJECT_RADIUS_DP = 11
const val FIRST_RUN_CONTINUE_DP = 39
const val FIRST_RUN_CONTINUE_RADIUS_DP = 6
const val FIRST_RUN_TITLE_SP = 36
const val FIRST_RUN_BRAND = "FaNotes"
const val FIRST_RUN_BRAND_DETAIL = "Dein persönlicher Denkraum"
const val FIRST_RUN_LOCAL = "Bleibt lokal"
const val FIRST_RUN_GO = "Los geht’s"
const val FIRST_RUN_SKIP = "Einsatzprofil auswählen"
const val FIRST_RUN_NEXT = "Weiter"
const val FIRST_RUN_BACK = "Zurück"
const val FIRST_RUN_CHOOSE_FOLDERS = "Ordner auswählen"
const val FIRST_RUN_FINISH = "FaNotes einrichten"
const val FIRST_RUN_TITLE_WELCOME = "Alles, was dir wichtig ist."
const val FIRST_RUN_TITLE_EMPHASIS = "An einem ruhigen Ort."
const val FIRST_RUN_BODY_WELCOME = "Schreibe mit Tastatur oder Stift, ordne deine Themen und finde jeden Gedanken wieder – in Schule, UNI, Privatleben oder Arbeit."
const val FIRST_RUN_PROFILE_TITLE = "Wofür möchtest du FaNotes verwenden?"
const val FIRST_RUN_PROFILE_BODY = "Deine Auswahl bestimmt nur die vorgeschlagenen Startordner. Alle Funktionen bleiben in jedem Profil verfügbar und später frei anpassbar."
const val FIRST_RUN_WRITING_TITLE = "Eine Seite. Zwei Arten zu schreiben."
const val FIRST_RUN_WRITING_BODY = "Tippe und schreibe frei auf derselben Seite. Handschrift bleibt Handschrift, bis du sie bewusst umwandelst."
const val FIRST_RUN_FOLDER_TITLE = "Welche Ordner möchtest du verwenden?"
const val FIRST_RUN_INBOX = "Eingang ist immer dabei"
const val FIRST_RUN_INBOX_DETAIL = "Der schnelle Sammelplatz für neue Notizen und Ideen."
const val FIRST_RUN_PREPARED = "Sauber vorbereitet"
const val FIRST_RUN_PREPARED_DETAIL = "jeder Ordner erhält eine eigene Farbe und erscheint direkt in der Seitenleiste."
/** `.first-run-preview-window` border-radius is 18px. */
const val FIRST_RUN_PREVIEW_RADIUS_DP = 18
const val FIRST_RUN_PREVIEW_HEADER_DP = 32
/** `.first-run-preview-window > header b` is 7px at weight 600. Dots are 6px, the row gap is 5px, and the side padding is 12px. */
const val FIRST_RUN_PREVIEW_HEADER_TITLE_SP = 7
const val FIRST_RUN_PREVIEW_HEADER_TITLE_WEIGHT = 600
const val FIRST_RUN_PREVIEW_HEADER_DOT_DP = 6
const val FIRST_RUN_PREVIEW_HEADER_GAP_DP = 5
const val FIRST_RUN_PREVIEW_HEADER_PAD_DP = 12
/** `.first-run-preview-body > aside` gap is 5px. The heading is a bold `strong` with a 12px book icon, gap 6px, and `margin: 0 4px 8px`. */
const val FIRST_RUN_PREVIEW_ASIDE_GAP_DP = 5
const val FIRST_RUN_PREVIEW_SUBJECTS_HEADING = "Meine Fächer"
const val FIRST_RUN_PREVIEW_HEADING_WEIGHT = 700
const val FIRST_RUN_PREVIEW_HEADING_MARGIN_INLINE_DP = 4
const val FIRST_RUN_PREVIEW_HEADING_MARGIN_BOTTOM_DP = 8
const val FIRST_RUN_PREVIEW_HEADING_ICON_DP = 12
const val FIRST_RUN_PREVIEW_HEADING_ICON_GAP_DP = 6
/** Header fill is `color-mix(in srgb, var(--panel) 92%, transparent)`. */
const val FIRST_RUN_PREVIEW_HEADER_FILL_ALPHA = 0.92f
/** Close dot is `color-mix(in srgb, var(--danger) 68%, var(--border))`. The middle dot is `#d8a643`. */
const val FIRST_RUN_PREVIEW_HEADER_CLOSE_MIX = 0.68f
const val FIRST_RUN_PREVIEW_HEADER_MIDDLE_DOT = 0xFFD8A643.toInt()
/** `--border` is white at 9% on dark themes, `#37352f` at 9% on light, and `#37352f` at 10% on sepia. */
const val FIRST_RUN_PREVIEW_BORDER_ALPHA = 0.09f
const val FIRST_RUN_PREVIEW_BORDER_SEPIA_ALPHA = 0.10f
const val FIRST_RUN_PREVIEW_BORDER_LIGHT_RGB = 0x37352F
/**
 * Window edge is `color-mix(in srgb, var(--border-strong) 90%, transparent)`.
 * The shadow is `0 34px 95px rgba(0,0,0,.25)` plus a 1px ring at `rgba(255,255,255,.025)`.
 */
const val FIRST_RUN_PREVIEW_WINDOW_BORDER_MIX = 0.90f
const val FIRST_RUN_PREVIEW_WINDOW_SHADOW_X_DP = 0
const val FIRST_RUN_PREVIEW_WINDOW_SHADOW_Y_DP = 34
const val FIRST_RUN_PREVIEW_WINDOW_SHADOW_BLUR_DP = 95
const val FIRST_RUN_PREVIEW_WINDOW_SHADOW_ALPHA = 0.25f
const val FIRST_RUN_PREVIEW_WINDOW_RING = 0x06FFFFFF
/**
 * `.first-run-preview-glow` is an ellipse inset 12% from the top and bottom and 8% from the sides.
 * The fill is the accent at 22%, then the whole glow is at 70% opacity, blurred by 65px.
 * The desktop pulse is not played.
 */
const val FIRST_RUN_PREVIEW_GLOW_INSET_BLOCK = 0.12f
const val FIRST_RUN_PREVIEW_GLOW_INSET_INLINE = 0.08f
const val FIRST_RUN_PREVIEW_GLOW_BLUR_DP = 65
const val FIRST_RUN_PREVIEW_GLOW_COLOR_ALPHA = 0.22f
const val FIRST_RUN_PREVIEW_GLOW_OPACITY = 0.7f
const val FIRST_RUN_PREVIEW_ASIDE_DP = 118
const val FIRST_RUN_PREVIEW_ASIDE_NARROW_DP = 102
const val FIRST_RUN_PREVIEW_ASIDE_PAD_BLOCK_DP = 17
const val FIRST_RUN_PREVIEW_ASIDE_PAD_INLINE_DP = 10
const val FIRST_RUN_PREVIEW_ASIDE_PAD_INLINE_NARROW_DP = 7
const val FIRST_RUN_PREVIEW_SPLIT_DP = 760
const val FIRST_RUN_MEDIUM_DP = 980
/** `.first-run-preview-body > aside strong` is 7.5px. The column fill is `--bg` mixed 76% into `--panel`. */
const val FIRST_RUN_PREVIEW_HEADING_SP = 7.5f
const val FIRST_RUN_PREVIEW_ASIDE_FILL_MIX = 0.76f
/** `.first-run-preview-body > aside > span` is 7px, with 7px padding, a 6px radius, and a 7px gap. */
const val FIRST_RUN_PREVIEW_SUBJECT_SP = 7
const val FIRST_RUN_PREVIEW_SUBJECT_PAD_DP = 7
const val FIRST_RUN_PREVIEW_SUBJECT_RADIUS_DP = 6
const val FIRST_RUN_PREVIEW_SUBJECT_GAP_DP = 7
/** `.first-run-preview-body > aside i` is 6px with a 2px radius. */
const val FIRST_RUN_PREVIEW_MARK_DP = 6
const val FIRST_RUN_PREVIEW_MARK_RADIUS_DP = 2
/** `.first-run-preview-body` min-height is 360px, or 325px at `max-height: 680px` and `min-width: 761px`. */
const val FIRST_RUN_PREVIEW_BODY_MIN_DP = 360
const val FIRST_RUN_PREVIEW_BODY_MIN_SHORT_DP = 325
const val FIRST_RUN_PREVIEW_SHORT_HEIGHT_DP = 680
const val FIRST_RUN_PREVIEW_KICKER = "MATHEMATIK · ANALYSIS"
const val FIRST_RUN_PREVIEW_HEADING = "Ableitungen"
const val FIRST_RUN_PREVIEW_TYPED = "Die Änderungsrate beschreibt die Steigung."
/**
 * `.first-run-preview-paper` still wins. No later rule, including the 18px window radius, changes this sheet.
 * Margin is 18px 19px 0. Padding is 25px 27px. Top corners are 11px and the bottom corners stay 0.
 */
const val FIRST_RUN_PREVIEW_PAPER_MARGIN_TOP_DP = 18
const val FIRST_RUN_PREVIEW_PAPER_MARGIN_INLINE_DP = 19
const val FIRST_RUN_PREVIEW_PAPER_MARGIN_BOTTOM_DP = 0
const val FIRST_RUN_PREVIEW_PAPER_PAD_BLOCK_DP = 25
const val FIRST_RUN_PREVIEW_PAPER_PAD_INLINE_DP = 27
const val FIRST_RUN_PREVIEW_PAPER_RADIUS_TOP_DP = 11
const val FIRST_RUN_PREVIEW_PAPER_RADIUS_BOTTOM_DP = 0
/** Sheet text `#26272c` on `#fbfaf7`. */
const val FIRST_RUN_PREVIEW_PAPER_INK = 0xFF26272C.toInt()
const val FIRST_RUN_PREVIEW_PAPER_FILL = 0xFFFBFAF7.toInt()
/** `.first-run-preview-paper > small` is 6px, weight 700, tracking .12em, `#8d8d90`. */
const val FIRST_RUN_PREVIEW_KICKER_SP = 6
const val FIRST_RUN_PREVIEW_KICKER_WEIGHT = 700
const val FIRST_RUN_PREVIEW_KICKER_TRACKING_EM = 0.12f
const val FIRST_RUN_PREVIEW_KICKER_INK = 0xFF8D8D90.toInt()
/** `.first-run-preview-paper > h2` is `650 20px/1.1`, tracking -.035em, margin `9px 0 17px`. */
const val FIRST_RUN_PREVIEW_PAPER_TITLE_SP = 20
const val FIRST_RUN_PREVIEW_PAPER_TITLE_WEIGHT = 650
const val FIRST_RUN_PREVIEW_PAPER_TITLE_LINE = 1.1f
const val FIRST_RUN_PREVIEW_PAPER_TITLE_TRACKING_EM = -0.035f
const val FIRST_RUN_PREVIEW_PAPER_TITLE_MARGIN_TOP_DP = 9
const val FIRST_RUN_PREVIEW_PAPER_TITLE_MARGIN_BOTTOM_DP = 17
/** `.first-run-preview-typed` is `8.5px/1.5` in `#54555a`. Shown in full; the desktop type-on animation is not played. */
const val FIRST_RUN_PREVIEW_TYPED_SP = 8.5f
const val FIRST_RUN_PREVIEW_TYPED_LINE = 1.5f
const val FIRST_RUN_PREVIEW_TYPED_INK = 0xFF54555A.toInt()
/** `box-shadow: 0 10px 30px rgba(0,0,0,.14)`. */
const val FIRST_RUN_PREVIEW_PAPER_SHADOW_X_DP = 0
const val FIRST_RUN_PREVIEW_PAPER_SHADOW_Y_DP = 10
const val FIRST_RUN_PREVIEW_PAPER_SHADOW_BLUR_DP = 30
const val FIRST_RUN_PREVIEW_PAPER_SHADOW_ALPHA = 0.14f
/** `.first-run-preview-rule` is 1px `#e7e5df` with margin `11px 0 4px`. */
const val FIRST_RUN_PREVIEW_RULE_ARGB = 0xFFE7E5DF.toInt()
const val FIRST_RUN_PREVIEW_RULE_MARGIN_TOP_DP = 11
const val FIRST_RUN_PREVIEW_RULE_MARGIN_BOTTOM_DP = 4
/**
 * `.first-run-preview-ink` is 98px tall on a `0 0 330 98` viewBox.
 * The stroke is 3.4 user units of `color-mix(in srgb, var(--accent) 78%, #222)`.
 */
const val FIRST_RUN_PREVIEW_INK_VIEW_WIDTH = 330
const val FIRST_RUN_PREVIEW_INK_VIEW_HEIGHT = 98
const val FIRST_RUN_PREVIEW_INK_HEIGHT_DP = 98
const val FIRST_RUN_PREVIEW_INK_WIDTH_DP = 3.4f
const val FIRST_RUN_PREVIEW_INK_MIX = 0.78f
const val FIRST_RUN_PREVIEW_INK_INTO_ARGB = 0xFF222222.toInt()
/** `.first-run-preview-search` is 27px tall, 7px type, 7px radius, gap 6px, padding `0 8px`, `#66676b` on white, border `#dfddd7`. */
const val FIRST_RUN_PREVIEW_SEARCH_HEIGHT_DP = 27
const val FIRST_RUN_PREVIEW_SEARCH_SP = 7
const val FIRST_RUN_PREVIEW_SEARCH_RADIUS_DP = 7
const val FIRST_RUN_PREVIEW_SEARCH_GAP_DP = 6
const val FIRST_RUN_PREVIEW_SEARCH_PAD_DP = 8
const val FIRST_RUN_PREVIEW_SEARCH_ICON_DP = 11
const val FIRST_RUN_PREVIEW_SEARCH_ARGB = 0xFF66676B.toInt()
const val FIRST_RUN_PREVIEW_SEARCH_BORDER_ARGB = 0xFFDFDDD7.toInt()
const val FIRST_RUN_PREVIEW_SEARCH_FILL_ARGB = 0xFFFFFFFF.toInt()
const val FIRST_RUN_PREVIEW_SEARCH_SHADOW_Y_DP = 5
const val FIRST_RUN_PREVIEW_SEARCH_SHADOW_ALPHA = 0.06f
/** `.first-run-preview-search b` is 6.5px and `color-mix(in srgb, var(--accent) 78%, #333)`. */
const val FIRST_RUN_PREVIEW_HITS_SP = 6.5f
const val FIRST_RUN_PREVIEW_HITS_INTO_ARGB = 0xFF333333.toInt()
const val FIRST_RUN_PREVIEW_QUERY = "„Änderungsrate“"
const val FIRST_RUN_PREVIEW_HITS = "1 Treffer"
const val FIRST_RUN_PREVIEW_INK = "Handschrift"
const val FIRST_RUN_PREVIEW_FOUND = "Sofort gefunden"
const val FIRST_RUN_PREVIEW_LABEL = "Vorschau von FaNotes"
/**
 * `.first-run-preview-float` sits on `.first-run-app-preview`, not under the window.
 * Padding is `8px 10px`, gap 6px, radius 9px, 8px type at weight 600, icon 15px.
 * Tag one is `top: 24%` and `right: -25px`, or `right: -8px` at 760px and below.
 * Tag two is `right: 28px` and `bottom: -16px`.
 */
const val FIRST_RUN_PREVIEW_FLOAT_PAD_BLOCK_DP = 8
const val FIRST_RUN_PREVIEW_FLOAT_PAD_INLINE_DP = 10
const val FIRST_RUN_PREVIEW_FLOAT_GAP_DP = 6
const val FIRST_RUN_PREVIEW_FLOAT_RADIUS_DP = 9
const val FIRST_RUN_PREVIEW_FLOAT_SP = 8
const val FIRST_RUN_PREVIEW_FLOAT_WEIGHT = 600
const val FIRST_RUN_PREVIEW_FLOAT_ICON_DP = 15
const val FIRST_RUN_PREVIEW_FLOAT_ONE_TOP = 0.24f
const val FIRST_RUN_PREVIEW_FLOAT_ONE_RIGHT_DP = -25
const val FIRST_RUN_PREVIEW_FLOAT_ONE_RIGHT_NARROW_DP = -8
const val FIRST_RUN_PREVIEW_FLOAT_TWO_RIGHT_DP = 28
const val FIRST_RUN_PREVIEW_FLOAT_TWO_BOTTOM_DP = -16
/** `color-mix(in srgb, var(--panel-strong) 93%, transparent)`. */
const val FIRST_RUN_PREVIEW_FLOAT_FILL_ALPHA = 0.93f
/** `--border-strong` is white at 16% on dark themes and `#37352f` at 16% on light themes. */
const val FIRST_RUN_PREVIEW_FLOAT_BORDER_ALPHA = 0.16f
const val FIRST_RUN_PREVIEW_FLOAT_BORDER_LIGHT_RGB = 0x37352F
/** `box-shadow: 0 13px 35px rgba(0,0,0,.2)`. */
const val FIRST_RUN_PREVIEW_FLOAT_SHADOW_X_DP = 0
const val FIRST_RUN_PREVIEW_FLOAT_SHADOW_Y_DP = 13
const val FIRST_RUN_PREVIEW_FLOAT_SHADOW_BLUR_DP = 35
const val FIRST_RUN_PREVIEW_FLOAT_SHADOW_ALPHA = 0.2f
const val FIRST_RUN_WRITING_PREVIEW_LABEL = "Vorschau einer Seite mit Text und Handschrift"
const val FIRST_RUN_WRITING_FILE = "Analysis.md"
const val FIRST_RUN_WRITING_DATE = "12. August · Mathematik"
const val FIRST_RUN_WRITING_HEADING = "Integralrechnung"
const val FIRST_RUN_WRITING_TYPED = "Der Flächeninhalt lässt sich mit dem bestimmten Integral berechnen."
const val FIRST_RUN_WRITING_RECOGNIZED = "Im Hintergrund erkannt"
const val FIRST_RUN_WRITING_FORMULA = "∫₀¹ (x + 2) dx = 2,5"
const val FIRST_RUN_WRITING_CONVERT = "Optional umwandeln"
/**
 * `.first-run-writing-preview` starts at 19px, then the shared chrome rule sets it to 12px.
 * The toolbar and `0 32px 90px rgba(0,0,0,.2)` shadow are unchanged.
 */
const val FIRST_RUN_WRITING_FRAME_RADIUS_DP = 12
const val FIRST_RUN_WRITING_FRAME_PAD_TOP_DP = 31
const val FIRST_RUN_WRITING_FRAME_PAD_WIDE_DP = 34
const val FIRST_RUN_WRITING_FRAME_PAD_MEDIUM_DP = 24
const val FIRST_RUN_WRITING_FRAME_PAD_SHORT_DP = 28
const val FIRST_RUN_WRITING_FRAME_SHADOW_Y_DP = 32
const val FIRST_RUN_WRITING_FRAME_SHADOW_ALPHA = 0.2f
const val FIRST_RUN_WRITING_FRAME_PANEL_ALPHA = 0.91f
const val FIRST_RUN_WRITING_FRAME_ELEVATED_ALPHA = 0.80f
/** `.first-run-paper-toolbar` is 31px, gap 7px, padding `0 12px`. The marks are 13px with a 4px radius; the live one holds a 5px accent dot. */
const val FIRST_RUN_WRITING_TOOLBAR_DP = 31
const val FIRST_RUN_WRITING_TOOLBAR_GAP_DP = 7
const val FIRST_RUN_WRITING_TOOLBAR_PAD_DP = 12
const val FIRST_RUN_WRITING_TOOLBAR_MARK_DP = 13
const val FIRST_RUN_WRITING_TOOLBAR_MARK_RADIUS_DP = 4
const val FIRST_RUN_WRITING_TOOLBAR_DOT_DP = 5
const val FIRST_RUN_WRITING_TOOLBAR_DOT_ALPHA = 0.10f
const val FIRST_RUN_WRITING_FILE_SP = 7
/**
 * `.first-run-paper-sheet` is `#fbfaf7` with `#28292d` type, top radius 11px, and `0 10px 35px rgba(0,0,0,.15)`.
 * Padding is 36px 44px, inline 34px from 980px, and block 27px when the window is short and wider than 760px.
 * Min height is 407px, or 354px on that short wide window.
 */
const val FIRST_RUN_WRITING_SHEET_RADIUS_DP = 11
const val FIRST_RUN_WRITING_SHEET_FILL = 0xFFFBFAF7.toInt()
const val FIRST_RUN_WRITING_SHEET_INK = 0xFF28292D.toInt()
const val FIRST_RUN_WRITING_SHEET_PAD_BLOCK_DP = 36
const val FIRST_RUN_WRITING_SHEET_PAD_BLOCK_SHORT_DP = 27
const val FIRST_RUN_WRITING_SHEET_PAD_INLINE_DP = 44
const val FIRST_RUN_WRITING_SHEET_PAD_INLINE_NARROW_DP = 34
const val FIRST_RUN_WRITING_SHEET_MIN_DP = 407
const val FIRST_RUN_WRITING_SHEET_MIN_SHORT_DP = 354
const val FIRST_RUN_WRITING_SHEET_SHADOW_Y_DP = 10
const val FIRST_RUN_WRITING_SHEET_SHADOW_ALPHA = 0.15f
/** `.first-run-paper-sheet > small` is 6.5px, weight 600, `#929195`, tracking .08em, uppercased. */
const val FIRST_RUN_WRITING_DATE_SP = 6.5f
const val FIRST_RUN_WRITING_DATE_WEIGHT = 600
const val FIRST_RUN_WRITING_DATE_TRACKING_EM = 0.08f
const val FIRST_RUN_WRITING_DATE_INK = 0xFF929195.toInt()
/** `.first-run-paper-sheet h2` is `650 23px/1.1`, tracking -.035em, margin `10px 0 14px`. */
const val FIRST_RUN_WRITING_TITLE_SP = 23
const val FIRST_RUN_WRITING_TITLE_WEIGHT = 650
const val FIRST_RUN_WRITING_TITLE_LINE = 1.1f
const val FIRST_RUN_WRITING_TITLE_TRACKING_EM = -0.035f
const val FIRST_RUN_WRITING_TITLE_MARGIN_TOP_DP = 10
const val FIRST_RUN_WRITING_TITLE_MARGIN_BOTTOM_DP = 14
/** `.first-run-paper-type` is `8.5px/1.5` in `#55565b`. */
const val FIRST_RUN_WRITING_TYPED_SP = 8.5f
const val FIRST_RUN_WRITING_TYPED_LINE = 1.5f
const val FIRST_RUN_WRITING_TYPED_INK = 0xFF55565B.toInt()
/** `.first-run-paper-ink` is 150px, or 127px when short and wide. ViewBox is `0 0 420 150`. Stroke is 3.3 of accent mixed 78% into `#24252a`. */
const val FIRST_RUN_WRITING_INK_VIEW_WIDTH = 420
const val FIRST_RUN_WRITING_INK_VIEW_HEIGHT = 150
const val FIRST_RUN_WRITING_INK_HEIGHT_DP = 150
const val FIRST_RUN_WRITING_INK_HEIGHT_SHORT_DP = 127
const val FIRST_RUN_WRITING_INK_MARGIN_TOP_DP = 7
const val FIRST_RUN_WRITING_INK_WIDTH_DP = 3.3f
const val FIRST_RUN_WRITING_INK_MIX = 0.78f
const val FIRST_RUN_WRITING_INK_INTO = 0xFF24252A.toInt()
/** `.first-run-paper-transcript` is at least 43px: columns 23 / 1fr / 18, gap 7, padding 7px 9px, radius 8. */
const val FIRST_RUN_WRITING_TRANSCRIPT_MIN_DP = 43
const val FIRST_RUN_WRITING_TRANSCRIPT_LEAD_DP = 23
const val FIRST_RUN_WRITING_TRANSCRIPT_TRAIL_DP = 18
const val FIRST_RUN_WRITING_TRANSCRIPT_GAP_DP = 7
const val FIRST_RUN_WRITING_TRANSCRIPT_PAD_BLOCK_DP = 7
const val FIRST_RUN_WRITING_TRANSCRIPT_PAD_INLINE_DP = 9
const val FIRST_RUN_WRITING_TRANSCRIPT_RADIUS_DP = 8
const val FIRST_RUN_WRITING_TRANSCRIPT_ICON_DP = 12
const val FIRST_RUN_WRITING_TRANSCRIPT_CHECK_DP = 13
const val FIRST_RUN_WRITING_TRANSCRIPT_SP = 6.5f
const val FIRST_RUN_WRITING_TRANSCRIPT_LINE = 1.3f
const val FIRST_RUN_WRITING_TRANSCRIPT_WEIGHT = 600
const val FIRST_RUN_WRITING_TRANSCRIPT_DETAIL_WEIGHT = 500
const val FIRST_RUN_WRITING_TRANSCRIPT_DETAIL_GAP_DP = 2
const val FIRST_RUN_WRITING_TRANSCRIPT_DETAIL_INK = 0xFF87878A.toInt()
const val FIRST_RUN_WRITING_TRANSCRIPT_CHECK_INK = 0xFF4F9970.toInt()
const val FIRST_RUN_WRITING_TRANSCRIPT_BORDER_MIX = 0.24f
const val FIRST_RUN_WRITING_TRANSCRIPT_BORDER_INTO = 0xFFDDDDDD.toInt()
const val FIRST_RUN_WRITING_TRANSCRIPT_FILL_MIX = 0.05f
const val FIRST_RUN_WRITING_TRANSCRIPT_SPARK_MIX = 0.75f
const val FIRST_RUN_WRITING_TRANSCRIPT_SPARK_INTO = 0xFF333333.toInt()
const val FIRST_RUN_WRITING_TRANSCRIPT_SHADOW_Y_DP = 7
const val FIRST_RUN_WRITING_TRANSCRIPT_SHADOW_ALPHA = 0.06f
/** `.first-run-paper-selection` sits at left 37, right 31, top 119, height 145, radius 8. The label is 6px, 21px above the top right. */
const val FIRST_RUN_WRITING_SELECTION_START_DP = 37
const val FIRST_RUN_WRITING_SELECTION_END_DP = 31
const val FIRST_RUN_WRITING_SELECTION_TOP_DP = 119
const val FIRST_RUN_WRITING_SELECTION_HEIGHT_DP = 145
const val FIRST_RUN_WRITING_SELECTION_RADIUS_DP = 8
const val FIRST_RUN_WRITING_SELECTION_ALPHA = 0.60f
const val FIRST_RUN_WRITING_SELECTION_HANDLE_DP = 4
const val FIRST_RUN_WRITING_SELECTION_HANDLE_OUTSET_DP = 3
const val FIRST_RUN_WRITING_SELECTION_LABEL_RISE_DP = 21
const val FIRST_RUN_WRITING_SELECTION_LABEL_SP = 6
const val FIRST_RUN_WRITING_SELECTION_LABEL_WEIGHT = 600
const val FIRST_RUN_WRITING_SELECTION_LABEL_PAD_BLOCK_DP = 4
const val FIRST_RUN_WRITING_SELECTION_LABEL_PAD_INLINE_DP = 6
const val FIRST_RUN_WRITING_SELECTION_LABEL_RADIUS_DP = 5
const val FIRST_RUN_WRITING_SELECTION_LABEL_MIX = 0.82f
const val FIRST_RUN_WRITING_SELECTION_LABEL_INTO = 0xFF222222.toInt()
val FIRST_RUN_PREVIEW_SUBJECTS = listOf("Mathematik", "Deutsch", "Französisch", "Physik", "Wirtschaft")

/** Top, end, bottom, and start padding. */
data class FirstRunWritingPad(val top: Int, val end: Int, val bottom: Int, val start: Int)

/** True for `@media (max-height: 680px) and (min-width: 761px)`. */
fun firstRunWritingShort(screenWidthDp: Int, screenHeightDp: Int): Boolean =
    screenHeightDp <= FIRST_RUN_PREVIEW_SHORT_HEIGHT_DP && screenWidthDp > FIRST_RUN_PREVIEW_SPLIT_DP

/**
 * Padding of `.first-run-writing-preview`.
 * Base is `31px 34px 0`. At `max-width: 980px` the inline padding becomes 24px.
 * A short window wider than 760px then sets inline padding to 28px, including wide windows.
 */
fun firstRunWritingFramePad(screenWidthDp: Int, screenHeightDp: Int): FirstRunWritingPad {
    val inline = when {
        firstRunWritingShort(screenWidthDp, screenHeightDp) -> FIRST_RUN_WRITING_FRAME_PAD_SHORT_DP
        screenWidthDp <= FIRST_RUN_MEDIUM_DP -> FIRST_RUN_WRITING_FRAME_PAD_MEDIUM_DP
        else -> FIRST_RUN_WRITING_FRAME_PAD_WIDE_DP
    }
    return FirstRunWritingPad(
        top = FIRST_RUN_WRITING_FRAME_PAD_TOP_DP,
        end = inline,
        bottom = 0,
        start = inline,
    )
}

/**
 * Padding of `.first-run-paper-sheet`.
 * Base is 36px 44px. From 980px down, inline padding is 34px.
 * A short window wider than 760px sets the block padding to 27px and leaves the inline padding.
 */
fun firstRunWritingSheetPad(screenWidthDp: Int, screenHeightDp: Int): FirstRunWritingPad {
    val inline = if (screenWidthDp <= FIRST_RUN_MEDIUM_DP) FIRST_RUN_WRITING_SHEET_PAD_INLINE_NARROW_DP else FIRST_RUN_WRITING_SHEET_PAD_INLINE_DP
    val block = if (firstRunWritingShort(screenWidthDp, screenHeightDp)) FIRST_RUN_WRITING_SHEET_PAD_BLOCK_SHORT_DP else FIRST_RUN_WRITING_SHEET_PAD_BLOCK_DP
    return FirstRunWritingPad(top = block, end = inline, bottom = block, start = inline)
}

/** Min height of `.first-run-paper-sheet`: 407px, or 354px when short and wider than 760px. */
fun firstRunWritingSheetMinDp(screenWidthDp: Int, screenHeightDp: Int): Int =
    if (firstRunWritingShort(screenWidthDp, screenHeightDp)) FIRST_RUN_WRITING_SHEET_MIN_SHORT_DP else FIRST_RUN_WRITING_SHEET_MIN_DP

/** Height of `.first-run-paper-ink`: 150px, or 127px when short and wider than 760px. */
fun firstRunWritingInkHeightDp(screenWidthDp: Int, screenHeightDp: Int): Int =
    if (firstRunWritingShort(screenWidthDp, screenHeightDp)) FIRST_RUN_WRITING_INK_HEIGHT_SHORT_DP else FIRST_RUN_WRITING_INK_HEIGHT_DP

/** The date line is uppercased by `text-transform: uppercase`. */
fun firstRunWritingDateLabel(): String = FIRST_RUN_WRITING_DATE.uppercase(Locale.GERMAN)

/** Stroke of `.first-run-paper-ink path`: accent mixed 78% into `#24252a`. */
fun firstRunWritingInkStroke(accentArgb: Int): Int =
    mixArgb(accentArgb, FIRST_RUN_WRITING_INK_INTO, FIRST_RUN_WRITING_INK_MIX)

/** Transcript border: accent mixed 24% into `#ddd`. */
fun firstRunWritingTranscriptBorder(accentArgb: Int): Int =
    mixArgb(accentArgb, FIRST_RUN_WRITING_TRANSCRIPT_BORDER_INTO, FIRST_RUN_WRITING_TRANSCRIPT_BORDER_MIX)

/** Transcript fill: accent mixed 5% into white. */
fun firstRunWritingTranscriptFill(accentArgb: Int): Int =
    mixArgb(accentArgb, 0xFFFFFFFF.toInt(), FIRST_RUN_WRITING_TRANSCRIPT_FILL_MIX)

/** Sparkle icon: accent mixed 75% into `#333`. */
fun firstRunWritingSparkle(accentArgb: Int): Int =
    mixArgb(accentArgb, FIRST_RUN_WRITING_TRANSCRIPT_SPARK_INTO, FIRST_RUN_WRITING_TRANSCRIPT_SPARK_MIX)

/** Selection label: accent mixed 82% into `#222`. */
fun firstRunWritingSelectionLabel(accentArgb: Int): Int =
    mixArgb(accentArgb, FIRST_RUN_WRITING_SELECTION_LABEL_INTO, FIRST_RUN_WRITING_SELECTION_LABEL_MIX)

fun firstRunPreviewColumns(widthDp: Int): Int = if (widthDp <= FIRST_RUN_PREVIEW_SPLIT_DP) 1 else 2

/**
 * Subject column of `.first-run-preview-body`.
 * Desktop is 118px, and 102px from `max-width: 980px`. The 760px query stacks the welcome layout and leaves these columns alone.
 * [screenWidthDp] is the viewport, the same width as [firstRunPreviewColumns].
 */
fun firstRunPreviewAsideDp(screenWidthDp: Int): Int =
    if (screenWidthDp > FIRST_RUN_MEDIUM_DP) FIRST_RUN_PREVIEW_ASIDE_DP else FIRST_RUN_PREVIEW_ASIDE_NARROW_DP

/** Subject-column fill: `--bg` mixed 76% into `--panel`. */
fun firstRunPreviewAsideFill(backgroundArgb: Int, panelArgb: Int): Int =
    cssColorMix(backgroundArgb, panelArgb, FIRST_RUN_PREVIEW_ASIDE_FILL_MIX)

/** Top, end, bottom, and start padding of the welcome-preview subject column. */
data class FirstRunPreviewAsidePad(val top: Int, val end: Int, val bottom: Int, val start: Int)

/**
 * Padding of `.first-run-preview-body > aside`.
 * Desktop is `padding: 17px 10px`. At `max-width: 980px`, `padding-inline: 7px` replaces the horizontal padding and leaves the 17px block padding.
 * The 760px query does not set aside padding, so 7px inline and 17px block remain.
 * [screenWidthDp] is the viewport, the same width as [firstRunPreviewAsideDp].
 */
fun firstRunPreviewAsidePad(screenWidthDp: Int): FirstRunPreviewAsidePad {
    val inline = if (screenWidthDp > FIRST_RUN_MEDIUM_DP) FIRST_RUN_PREVIEW_ASIDE_PAD_INLINE_DP else FIRST_RUN_PREVIEW_ASIDE_PAD_INLINE_NARROW_DP
    return FirstRunPreviewAsidePad(
        top = FIRST_RUN_PREVIEW_ASIDE_PAD_BLOCK_DP,
        end = inline,
        bottom = FIRST_RUN_PREVIEW_ASIDE_PAD_BLOCK_DP,
        start = inline,
    )
}

/**
 * Color marks of `.first-run-preview-body > aside i`.
 * The heading is a `strong`, so `span:nth-of-type` counts the subject rows in order:
 * Mathematik keeps `var(--accent)`, Deutsch is #c76868, Französisch #3d8be0, Physik #5e9abd, Wirtschaft #cf9a48.
 * [accentArgb] is the theme accent for Mathematik.
 */
/** Stroke of `.first-run-preview-ink path`: accent mixed 78% into #222. */
fun firstRunPreviewInkStroke(accentArgb: Int): Int =
    mixArgb(accentArgb, FIRST_RUN_PREVIEW_INK_INTO_ARGB, FIRST_RUN_PREVIEW_INK_MIX)

/**
 * Default SVG placement, `xMidYMid meet`.
 * The formula and the integral keep their shape. A wide sheet letterboxes them
 * instead of stretching the strokes, and a 127px writing box does not squash the 150-unit viewBox.
 */
data class PreviewInkMeet(val scale: Float, val offsetX: Float, val offsetY: Float)

fun previewInkMeet(widthPx: Float, heightPx: Float, viewWidth: Float, viewHeight: Float): PreviewInkMeet? {
    if (widthPx <= 0f || heightPx <= 0f || viewWidth <= 0f || viewHeight <= 0f) return null
    val scale = minOf(widthPx / viewWidth, heightPx / viewHeight)
    if (!scale.isFinite() || scale <= 0f) return null
    return PreviewInkMeet(
        scale = scale,
        offsetX = (widthPx - viewWidth * scale) / 2f,
        offsetY = (heightPx - viewHeight * scale) / 2f,
    )
}

/** A preview stroke is in viewBox units, so the meet scale is its pixel width. */
fun previewInkStrokePx(strokeUnits: Float, scale: Float): Float = strokeUnits * scale

/** Hit count on `.first-run-preview-search b`: accent mixed 78% into #333. */
fun firstRunPreviewSearchHits(accentArgb: Int): Int =
    mixArgb(accentArgb, FIRST_RUN_PREVIEW_HITS_INTO_ARGB, FIRST_RUN_PREVIEW_INK_MIX)

fun firstRunPreviewMarkColors(accentArgb: Int): List<Int> = listOf(
    accentArgb,
    0xFFC76868.toInt(),
    0xFF3D8BE0.toInt(),
    0xFF5E9ABD.toInt(),
    0xFFCF9A48.toInt(),
)

/**
 * Min height of `.first-run-preview-body`.
 * Desktop is 360px, and 325px when the viewport is at most 680px tall and wider than 760px.
 * A tall window stays 360, including a tall narrow one. A short window that is 760px wide or narrower also stays 360.
 * [screenWidthDp] and [screenHeightDp] are the viewport from `LocalConfiguration`.
 */
fun firstRunPreviewBodyMinDp(screenWidthDp: Int, screenHeightDp: Int): Int =
    if (screenHeightDp <= FIRST_RUN_PREVIEW_SHORT_HEIGHT_DP && screenWidthDp > FIRST_RUN_PREVIEW_SPLIT_DP) {
        FIRST_RUN_PREVIEW_BODY_MIN_SHORT_DP
    } else {
        FIRST_RUN_PREVIEW_BODY_MIN_DP
    }

/**
 * Border-box min height of the stretched `.first-run-preview-paper`.
 * The body min-height is the grid area. Margin sits inside that area, and the bottom margin is 0,
 * so the sheet meets the floor of the preview window.
 */
fun firstRunPreviewPaperMinDp(screenWidthDp: Int, screenHeightDp: Int): Int {
    val body = firstRunPreviewBodyMinDp(screenWidthDp, screenHeightDp)
    return (body - FIRST_RUN_PREVIEW_PAPER_MARGIN_TOP_DP - FIRST_RUN_PREVIEW_PAPER_MARGIN_BOTTOM_DP).coerceAtLeast(0)
}

data class FirstRunPreviewPaperShadow(
    val xDp: Int,
    val yDp: Int,
    val blurDp: Int,
    val alpha: Float,
)

/** Desktop shadow for the welcome sheet. The same literal applies in every theme. */
fun firstRunPreviewPaperShadow() = FirstRunPreviewPaperShadow(
    FIRST_RUN_PREVIEW_PAPER_SHADOW_X_DP,
    FIRST_RUN_PREVIEW_PAPER_SHADOW_Y_DP,
    FIRST_RUN_PREVIEW_PAPER_SHADOW_BLUR_DP,
    FIRST_RUN_PREVIEW_PAPER_SHADOW_ALPHA,
)

/** Black at 14%, packed ARGB. */
fun firstRunPreviewPaperShadowColor(alpha: Float = FIRST_RUN_PREVIEW_PAPER_SHADOW_ALPHA): Int {
    val channel = (alpha.coerceIn(0f, 1f) * 255f).roundToInt().coerceIn(0, 255)
    return channel shl 24
}

/**
 * Software-bitmap placement of the sheet rectangle shifted by the desktop offset.
 * [padPx] is the bitmap inset of the unshifted sheet origin, large enough for the blur.
 * Top corners follow the 11px sheet radius. The bottom corners stay square.
 */
data class FirstRunPreviewPaperShadowFrame(
    val bitmapWidthPx: Int,
    val bitmapHeightPx: Int,
    val padPx: Float,
    val shapeLeftPx: Float,
    val shapeTopPx: Float,
    val shapeRightPx: Float,
    val shapeBottomPx: Float,
    val topRadiusPx: Float,
    val blurPx: Float,
    val color: Int,
)

fun firstRunPreviewPaperShadowFrame(widthPx: Float, heightPx: Float, density: Float): FirstRunPreviewPaperShadowFrame? {
    if (widthPx < 1f || heightPx < 1f || density <= 0f) return null
    val shadow = firstRunPreviewPaperShadow()
    if (shadow.blurDp <= 0) return null
    val blurPx = shadow.blurDp * density
    if (blurPx <= 0.5f) return null
    val offsetX = shadow.xDp * density
    val offsetY = shadow.yDp * density
    val pad = blurPx * 2f + abs(offsetX) + abs(offsetY) + 2f
    val bitmapWidth = ceil(widthPx + pad * 2f).toInt()
    val bitmapHeight = ceil(heightPx + pad * 2f).toInt()
    if (bitmapWidth < 1 || bitmapHeight < 1) return null
    return FirstRunPreviewPaperShadowFrame(
        bitmapWidthPx = bitmapWidth,
        bitmapHeightPx = bitmapHeight,
        padPx = pad,
        shapeLeftPx = pad + offsetX,
        shapeTopPx = pad + offsetY,
        shapeRightPx = pad + offsetX + widthPx,
        shapeBottomPx = pad + offsetY + heightPx,
        topRadiusPx = FIRST_RUN_PREVIEW_PAPER_RADIUS_TOP_DP * density,
        blurPx = blurPx,
        color = firstRunPreviewPaperShadowColor(shadow.alpha),
    )
}

/**
 * A floating tag anchored to `.first-run-app-preview`.
 * [fromTop] uses [topFraction] of the preview height. Otherwise [bottomDp] is the CSS `bottom`.
 * [rightDp] is the CSS `right`, negative when the tag hangs past the window.
 */
data class FirstRunPreviewFloatAnchor(
    val fromTop: Boolean,
    val topFraction: Float,
    val rightDp: Int,
    val bottomDp: Int,
)

/** Handschrift tag. The 760px query only changes its right edge. */
fun firstRunPreviewFloatOne(screenWidthDp: Int) = FirstRunPreviewFloatAnchor(
    fromTop = true,
    topFraction = FIRST_RUN_PREVIEW_FLOAT_ONE_TOP,
    rightDp = if (screenWidthDp <= FIRST_RUN_PREVIEW_SPLIT_DP) {
        FIRST_RUN_PREVIEW_FLOAT_ONE_RIGHT_NARROW_DP
    } else {
        FIRST_RUN_PREVIEW_FLOAT_ONE_RIGHT_DP
    },
    bottomDp = 0,
)

/** Sofort gefunden tag. Its place does not change with the viewport. */
fun firstRunPreviewFloatTwo() = FirstRunPreviewFloatAnchor(
    fromTop = false,
    topFraction = 0f,
    rightDp = FIRST_RUN_PREVIEW_FLOAT_TWO_RIGHT_DP,
    bottomDp = FIRST_RUN_PREVIEW_FLOAT_TWO_BOTTOM_DP,
)

/**
 * Offset from the preview's top-end or bottom-end corner.
 * Positive x moves right and positive y moves down, which is how Compose applies `offset`.
 * [yFraction] is only used for the top tag and is a fraction of the preview height.
 */
data class FirstRunPreviewFloatOffset(val xDp: Int, val yFraction: Float, val yDp: Int)

fun firstRunPreviewFloatOffset(anchor: FirstRunPreviewFloatAnchor): FirstRunPreviewFloatOffset = if (anchor.fromTop) {
    FirstRunPreviewFloatOffset(xDp = -anchor.rightDp, yFraction = anchor.topFraction, yDp = 0)
} else {
    FirstRunPreviewFloatOffset(xDp = -anchor.rightDp, yFraction = 0f, yDp = -anchor.bottomDp)
}

/** Icon on `.first-run-preview-float svg` is `--accent-readable`. */
fun firstRunPreviewFloatIcon(dark: Boolean): Int = noteTabAccentArgb(dark)

/** Chip fill: panel-strong at 93% over a transparent backdrop. */
fun firstRunPreviewFloatFill(panelStrongArgb: Int): Int {
    val alpha = (FIRST_RUN_PREVIEW_FLOAT_FILL_ALPHA * 255f).roundToInt().coerceIn(0, 255)
    return (alpha shl 24) or (panelStrongArgb and 0xFFFFFF)
}

/** `--border-strong` for the floating tags. */
fun firstRunPreviewFloatBorder(dark: Boolean): Int {
    val rgb = if (dark) 0xFFFFFF else FIRST_RUN_PREVIEW_FLOAT_BORDER_LIGHT_RGB
    val alpha = (FIRST_RUN_PREVIEW_FLOAT_BORDER_ALPHA * 255f).roundToInt().coerceIn(0, 255)
    return (alpha shl 24) or rgb
}

/** Header bar fill: `--panel` at 92% over a transparent backdrop. */
fun firstRunPreviewHeaderFill(panelArgb: Int): Int {
    val alpha = (FIRST_RUN_PREVIEW_HEADER_FILL_ALPHA * 255f).roundToInt().coerceIn(0, 255)
    return (alpha shl 24) or (panelArgb and 0xFFFFFF)
}

/** `--border` for the welcome preview, including the sepia 10% rule. */
fun firstRunPreviewBorder(themeId: String, systemDark: Boolean = false): Int {
    val palette = themePalette(themeId, systemDark)
    val alpha = if (palette.id == "sepia") FIRST_RUN_PREVIEW_BORDER_SEPIA_ALPHA else FIRST_RUN_PREVIEW_BORDER_ALPHA
    val rgb = if (palette.dark) 0xFFFFFF else FIRST_RUN_PREVIEW_BORDER_LIGHT_RGB
    val channel = (alpha * 255f).roundToInt().coerceIn(0, 255)
    return (channel shl 24) or rgb
}

/** Close traffic light: danger mixed 68% into `--border`. */
fun firstRunPreviewHeaderClose(dangerArgb: Int, borderArgb: Int): Int =
    cssColorMix(dangerArgb, borderArgb, FIRST_RUN_PREVIEW_HEADER_CLOSE_MIX)

/** Window border: `--border-strong` mixed 90% into transparent. */
fun firstRunPreviewWindowBorder(themeId: String, systemDark: Boolean = false): Int {
    val dark = themePalette(themeId, systemDark).dark
    return cssColorMix(firstRunPreviewFloatBorder(dark), 0, FIRST_RUN_PREVIEW_WINDOW_BORDER_MIX)
}

/** Black at the welcome-window shadow alpha. */
fun firstRunPreviewWindowShadowColor(alpha: Float = FIRST_RUN_PREVIEW_WINDOW_SHADOW_ALPHA): Int {
    val channel = (alpha.coerceIn(0f, 1f) * 255f).roundToInt().coerceIn(0, 255)
    return channel shl 24
}

/** Accent painted in the glow: 22% color times 70% opacity. */
fun firstRunPreviewGlowColor(accentArgb: Int): Int {
    val alpha = (FIRST_RUN_PREVIEW_GLOW_COLOR_ALPHA * FIRST_RUN_PREVIEW_GLOW_OPACITY * 255f).roundToInt().coerceIn(0, 255)
    return (alpha shl 24) or (accentArgb and 0xFFFFFF)
}

/**
 * Software-bitmap placement of the glow ellipse.
 * [padPx] leaves room for the 65dp blur around the preview.
 */
data class FirstRunPreviewGlowFrame(
    val bitmapWidthPx: Int,
    val bitmapHeightPx: Int,
    val padPx: Float,
    val ovalLeftPx: Float,
    val ovalTopPx: Float,
    val ovalRightPx: Float,
    val ovalBottomPx: Float,
    val blurPx: Float,
    val color: Int,
)

fun firstRunPreviewGlowFrame(widthPx: Float, heightPx: Float, density: Float, accentArgb: Int): FirstRunPreviewGlowFrame? {
    if (widthPx < 1f || heightPx < 1f || density <= 0f) return null
    val blurPx = FIRST_RUN_PREVIEW_GLOW_BLUR_DP * density
    if (blurPx <= 0.5f) return null
    val pad = blurPx * 2f + 2f
    val left = widthPx * FIRST_RUN_PREVIEW_GLOW_INSET_INLINE
    val top = heightPx * FIRST_RUN_PREVIEW_GLOW_INSET_BLOCK
    val right = widthPx * (1f - FIRST_RUN_PREVIEW_GLOW_INSET_INLINE)
    val bottom = heightPx * (1f - FIRST_RUN_PREVIEW_GLOW_INSET_BLOCK)
    if (right - left < 1f || bottom - top < 1f) return null
    val bitmapWidth = ceil(widthPx + pad * 2f).toInt()
    val bitmapHeight = ceil(heightPx + pad * 2f).toInt()
    if (bitmapWidth < 1 || bitmapHeight < 1) return null
    return FirstRunPreviewGlowFrame(
        bitmapWidthPx = bitmapWidth,
        bitmapHeightPx = bitmapHeight,
        padPx = pad,
        ovalLeftPx = pad + left,
        ovalTopPx = pad + top,
        ovalRightPx = pad + right,
        ovalBottomPx = pad + bottom,
        blurPx = blurPx,
        color = firstRunPreviewGlowColor(accentArgb),
    )
}

/** Black at the floating-tag shadow alpha. */
fun firstRunPreviewFloatShadowColor(alpha: Float = FIRST_RUN_PREVIEW_FLOAT_SHADOW_ALPHA): Int {
    val channel = (alpha.coerceIn(0f, 1f) * 255f).roundToInt().coerceIn(0, 255)
    return channel shl 24
}

/** Copy and panel weights from the desktop first-run grids above 980dp. */
fun firstRunColumnWeights(step: Int): Pair<Float, Float> = firstRunColumnWeights(step, FIRST_RUN_MAX_DP)

/** Weights after the 980px and 760px desktop media queries. */
fun firstRunColumnWeights(step: Int, widthDp: Int): Pair<Float, Float> = when {
    widthDp <= FIRST_RUN_MEDIUM_DP && step >= 3 -> 0.72f to 1.28f
    widthDp <= FIRST_RUN_MEDIUM_DP -> 0.78f to 1.22f
    step == 0 -> 0.87f to 1.13f
    step == 1 -> 0.75f to 1.25f
    step == 2 -> 0.78f to 1.22f
    else -> 0.82f to 1.18f
}

/**
 * Column gap in dp.
 * At 760 and below every step uses 30. From 761 to 980 the gap is 28, or 35 on the folder step.
 * Above 980 it follows the desktop clamp: round(7% of [widthDp]), held to 45–100 on steps 0–2 and 45–105 on the folder step.
 * [widthDp] is the viewport (CSS 7vw and the 760/980 media queries), not the capped content column.
 */
fun firstRunColumnGap(step: Int, widthDp: Int): Int = when {
    widthDp <= FIRST_RUN_PREVIEW_SPLIT_DP -> 30
    widthDp <= FIRST_RUN_MEDIUM_DP && step >= 3 -> 35
    widthDp <= FIRST_RUN_MEDIUM_DP -> 28
    else -> (widthDp.toLong() * 7 / 100.0).roundToInt().coerceIn(45, if (step >= 3) 105 else 100)
}

val FIRST_RUN_BENEFITS = listOf("Lokal & privat", "Stift & Tastatur", "Markdown inklusive")

val FIRST_RUN_WRITING = listOf(
    "Einfach losschreiben" to "Markdown wird direkt schön dargestellt – ohne Ansichtswechsel.",
    "Natürlich mit dem Stift" to "Ganze handschriftliche Seiten oder Ergänzungen zwischen Text.",
    "Trotzdem alles finden" to "Unsichtbare Transkription macht auch unkonvertierte Handschrift durchsuchbar.",
)

fun firstRunEyebrow(step: Int): String = when (step.coerceIn(0, FIRST_RUN_STEPS.lastIndex)) {
    0 -> "Willkommen bei FaNotes"
    1 -> "Dein Startprofil"
    2 -> "Deine natürliche Arbeitsweise"
    else -> "Fast geschafft · 4 von 4"
}

fun firstRunFolderIntro(profileTitle: String): String =
    "FaNotes schlägt passende Ordner für das Profil $profileTitle vor. Du kannst später jederzeit weitere Ordner ergänzen, umbenennen oder löschen."
