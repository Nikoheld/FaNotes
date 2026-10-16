package ch.fasrv.fanotes.desk

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
const val FIRST_RUN_PREVIEW_SPLIT_DP = 760
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

/** Copy and panel weights from the desktop first-run grids. */
fun firstRunColumnWeights(step: Int): Pair<Float, Float> = when (step) {
    0 -> 0.87f to 1.13f
    1 -> 0.75f to 1.25f
    2 -> 0.78f to 1.22f
    else -> 0.82f to 1.18f
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
