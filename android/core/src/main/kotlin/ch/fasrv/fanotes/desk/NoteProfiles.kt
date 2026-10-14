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
