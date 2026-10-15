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
