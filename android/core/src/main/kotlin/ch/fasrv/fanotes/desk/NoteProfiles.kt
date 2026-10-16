package ch.fasrv.fanotes.desk

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
const val FIRST_RUN_PREVIEW_RADIUS_DP = 12
const val FIRST_RUN_PREVIEW_HEADER_DP = 32
const val FIRST_RUN_PREVIEW_ASIDE_DP = 118
const val FIRST_RUN_PREVIEW_ASIDE_NARROW_DP = 102
const val FIRST_RUN_PREVIEW_ASIDE_PAD_BLOCK_DP = 17
const val FIRST_RUN_PREVIEW_ASIDE_PAD_INLINE_DP = 10
const val FIRST_RUN_PREVIEW_ASIDE_PAD_INLINE_NARROW_DP = 7
const val FIRST_RUN_PREVIEW_SPLIT_DP = 760
const val FIRST_RUN_MEDIUM_DP = 980
/** `.first-run-preview-body > aside strong` is 7.5px. */
const val FIRST_RUN_PREVIEW_HEADING_SP = 7.5f
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
/**
 * `.first-run-preview-paper` is the cream sheet in the second column.
 * Margin is 18px 19px 0, padding is 25px 27px, and only the top corners are 11px.
 * Fill is #fbfaf7. Body ink is #26272c. Shadow is `0 10px 30px rgba(0,0,0,.14)`.
 */
const val FIRST_RUN_PREVIEW_PAPER_MARGIN_TOP_DP = 18
const val FIRST_RUN_PREVIEW_PAPER_MARGIN_INLINE_DP = 19
const val FIRST_RUN_PREVIEW_PAPER_PAD_BLOCK_DP = 25
const val FIRST_RUN_PREVIEW_PAPER_PAD_INLINE_DP = 27
const val FIRST_RUN_PREVIEW_PAPER_RADIUS_DP = 11
const val FIRST_RUN_PREVIEW_PAPER_ARGB = 0xFFFBFAF7.toInt()
const val FIRST_RUN_PREVIEW_PAPER_INK_ARGB = 0xFF26272C.toInt()
const val FIRST_RUN_PREVIEW_PAPER_SHADOW_Y_DP = 10
const val FIRST_RUN_PREVIEW_PAPER_SHADOW_ALPHA = 0.14f
/** `.first-run-preview-paper > small` is 6px, weight 700, #8d8d90, tracking 0.12em. */
const val FIRST_RUN_PREVIEW_KICKER_SP = 6
const val FIRST_RUN_PREVIEW_KICKER_ARGB = 0xFF8D8D90.toInt()
const val FIRST_RUN_PREVIEW_KICKER_TRACKING = 0.12f
/** `.first-run-preview-paper > h2` is 20px / 1.1, weight 650, tracking -0.035em, margin 9px 0 17px. */
const val FIRST_RUN_PREVIEW_TITLE_SP = 20
const val FIRST_RUN_PREVIEW_TITLE_LINE_SP = 22
const val FIRST_RUN_PREVIEW_TITLE_TRACKING = -0.035f
const val FIRST_RUN_PREVIEW_TITLE_MARGIN_TOP_DP = 9
const val FIRST_RUN_PREVIEW_TITLE_MARGIN_BOTTOM_DP = 17
/** `.first-run-preview-typed` is 8.5px / 1.5 and #54555a. */
const val FIRST_RUN_PREVIEW_TYPED_SP = 8.5f
const val FIRST_RUN_PREVIEW_TYPED_LINE_SP = 12.75f
const val FIRST_RUN_PREVIEW_TYPED_ARGB = 0xFF54555A.toInt()
/** `.first-run-preview-rule` is 1px #e7e5df with margin 11px 0 4px. */
const val FIRST_RUN_PREVIEW_RULE_ARGB = 0xFFE7E5DF.toInt()
const val FIRST_RUN_PREVIEW_RULE_MARGIN_TOP_DP = 11
const val FIRST_RUN_PREVIEW_RULE_MARGIN_BOTTOM_DP = 4
/** `.first-run-preview-ink` is 98px tall. The stroke is 3.4 user units of `color-mix(in srgb, var(--accent) 78%, #222)`. */
const val FIRST_RUN_PREVIEW_INK_HEIGHT_DP = 98
const val FIRST_RUN_PREVIEW_INK_WIDTH_DP = 3.4f
const val FIRST_RUN_PREVIEW_INK_MIX = 0.78f
const val FIRST_RUN_PREVIEW_INK_INTO_ARGB = 0xFF222222.toInt()
/** `.first-run-preview-search` is 27px tall, 7px type, 7px radius, gap 6px, padding 0 8px, #66676b on white, border #dfddd7. */
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
const val FIRST_RUN_PREVIEW_KICKER = "MATHEMATIK · ANALYSIS"
const val FIRST_RUN_PREVIEW_HEADING = "Ableitungen"
const val FIRST_RUN_PREVIEW_TYPED = "Die Änderungsrate beschreibt die Steigung."
const val FIRST_RUN_PREVIEW_QUERY = "„Änderungsrate“"
const val FIRST_RUN_PREVIEW_HITS = "1 Treffer"
const val FIRST_RUN_PREVIEW_INK = "Handschrift"
const val FIRST_RUN_PREVIEW_FOUND = "Sofort gefunden"
const val FIRST_RUN_PREVIEW_LABEL = "Vorschau von FaNotes"
const val FIRST_RUN_WRITING_PREVIEW_LABEL = "Vorschau einer Seite mit Text und Handschrift"
const val FIRST_RUN_WRITING_FILE = "Analysis.md"
const val FIRST_RUN_WRITING_DATE = "12. August · Mathematik"
const val FIRST_RUN_WRITING_HEADING = "Integralrechnung"
const val FIRST_RUN_WRITING_TYPED = "Der Flächeninhalt lässt sich mit dem bestimmten Integral berechnen."
const val FIRST_RUN_WRITING_RECOGNIZED = "Im Hintergrund erkannt"
const val FIRST_RUN_WRITING_FORMULA = "∫₀¹ (x + 2) dx = 2,5"
const val FIRST_RUN_WRITING_CONVERT = "Optional umwandeln"
val FIRST_RUN_PREVIEW_SUBJECTS = listOf("Mathematik", "Deutsch", "Französisch", "Physik", "Wirtschaft")

fun firstRunPreviewColumns(widthDp: Int): Int = if (widthDp <= FIRST_RUN_PREVIEW_SPLIT_DP) 1 else 2

/**
 * Subject column of `.first-run-preview-body`.
 * Desktop is 118px, and 102px from `max-width: 980px`. The 760px query stacks the welcome layout and leaves these columns alone.
 * [screenWidthDp] is the viewport, the same width as [firstRunPreviewColumns].
 */
fun firstRunPreviewAsideDp(screenWidthDp: Int): Int =
    if (screenWidthDp > FIRST_RUN_MEDIUM_DP) FIRST_RUN_PREVIEW_ASIDE_DP else FIRST_RUN_PREVIEW_ASIDE_NARROW_DP

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
