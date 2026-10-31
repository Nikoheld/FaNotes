package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.ink.importGlyphArchive
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.vault.WIKI_LINK_COPIED
import ch.fasrv.fanotes.vault.stampToInsert
import ch.fasrv.fanotes.vault.wikiLinkForNote
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.time.LocalDate
import java.util.zip.ZipInputStream

/**
 * Desktop command palette outcomes. Android aliases map onto the same effects.
 * `quit` and runtime `addon:` commands are ignored. A missing feature does not
 * report itself as unavailable.
 */

data class DeskNote(val path: String, val markdown: String)

data class DeskExport(val name: String, val mime: String, val text: String)

data class InstalledAddon(val id: String, val name: String, val version: String)

data class DeskWork(
    val notes: List<DeskNote> = emptyList(),
    val folders: List<String> = emptyList(),
    val openPath: String? = null,
    val markdown: String = "",
    val cursorLine: Int = 0,
    val destination: String = "notes",
    val penOpen: Boolean = false,
    val bookOpen: Boolean = false,
    val splitPath: String? = null,
    val splitRows: Boolean = false,
    val focus: Boolean = false,
    val sidebar: Boolean = true,
    val inspector: Boolean = false,
    val overlays: Set<String> = emptySet(),
    val clipboard: String = "",
    val tabs: List<String> = emptyList(),
    val closedTabs: List<String> = emptyList(),
    val trail: NoteTrail = EMPTY_NOTE_TRAIL,
    val message: String? = null,
    val exports: List<DeskExport> = emptyList(),
    val glyphLabels: List<String> = emptyList(),
    val installedAddons: List<InstalledAddon> = emptyList(),
    val linkPlacing: Boolean = false,
    val textFieldPlacing: Boolean = false,
    val saveGeneration: Int = 0,
    val syncGeneration: Int = 0,
    val settingsSection: String? = null,
    val paletteMode: String = "commands",
    val pinned: Set<String> = emptySet(),
    val dailyFolder: String = "Tagesnotizen",
    val platform: String? = null,
)

data class CommandExtras(
    val pdfName: String? = null,
    val onenoteBytes: ByteArray? = null,
    val glyphBytes: ByteArray? = null,
    val addonManifest: String? = null,
    val today: LocalDate = LocalDate.of(2026, 10, 31),
    val stampDate: String = "31.10.2026",
    val stampDateTime: String = "31.10.2026 12:00",
    val onenoteName: String? = null,
    val one2htmlPath: String? = null,
    val sevenZipPath: String? = null,
)

const val ONE_NOTE_EMPTY = "Im OneNote-Export wurden keine lesbaren Seiten gefunden."
const val TEXT_FIELD_NEEDS_NOTE = "Öffne zuerst eine Notiz, um ein Textfeld einzufügen."

private val ADDON_ID = Regex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")

fun sampleDeskWork(): DeskWork {
    val open = DeskNote("Schule/Notiz.md", "# Notiz\n\n- [ ] Aufgabe\n")
    val second = DeskNote("Schule/Zweite.md", "# Zweite\n")
    val closed = DeskNote("Schule/Geschlossen.md", "# Geschlossen\n")
    return DeskWork(
        notes = listOf(open, second, closed),
        folders = listOf("Schule"),
        openPath = open.path,
        markdown = open.markdown,
        cursorLine = 2,
        splitPath = second.path,
        tabs = listOf(open.path, second.path),
        closedTabs = listOf(closed.path),
        trail = NoteTrail(listOf(closed.path, open.path, second.path), 1),
        inspector = true,
        sidebar = true,
    )
}

fun normalizeDesktopCommand(id: String): String = when (id) {
    "import-pdf" -> "import-pdf-note"
    "subfolder" -> "new-subfolder"
    "pen" -> "drawing"
    "duplicate" -> "duplicate-note"
    "book" -> "subject-book"
    "ai" -> "ai-assistant"
    "cards" -> "flashcards"
    "tasks" -> "homework"
    "split-orient" -> "split-orientation"
    "sync" -> "sync-now"
    else -> id
}

fun commandReportsUnavailable(message: String?): Boolean {
    val text = message?.lowercase().orEmpty()
    return text.contains("not available") || text.contains("nicht verfügbar") || text.contains("nicht verfuegbar")
}

fun applyDesktopCommand(before: DeskWork, rawId: String, extras: CommandExtras = CommandExtras()): DeskWork {
    val id = normalizeDesktopCommand(rawId.trim())
    if (id == "quit" || id.startsWith("addon:")) return before
    return dispatch(before, id, extras)
}

private fun dispatch(work: DeskWork, id: String, extras: CommandExtras): DeskWork = when (id) {
    "new-note" -> addNote(work, parentOf(work.openPath), "Unbenannte Notiz", "# Unbenannte Notiz\n\n")
    "import-pdf-note" -> importPdf(work, extras)
    "new-folder" -> addFolder(work, "", "Neuer Ordner")
    "new-subfolder" -> addFolder(work, parentOf(work.openPath), "Neuer Ordner")
    "save" -> work.copy(saveGeneration = work.saveGeneration + 1, message = null)
    "search" -> work.copy(destination = "search", overlays = work.overlays + "search", message = null)
    "drawing" -> work.copy(penOpen = !work.penOpen, message = null)
    "note-link" -> work.copy(linkPlacing = true, textFieldPlacing = false, overlays = work.overlays + "link", message = null)
    "text-field" -> placeTextField(work)
    "subject-book" -> work.copy(bookOpen = !work.bookOpen, message = null)
    "worksheet" -> work.copy(platform = "worksheet", overlays = work.overlays + "worksheet", message = null)
    "onenote-import" -> importOneNote(work, extras)
    "ai-assistant" -> work.copy(overlays = work.overlays + "ai", message = null)
    "glyphenwerk" -> openGlyphenWerk(work, extras)
    "overview" -> work.copy(destination = "overview", message = null)
    "study" -> work.copy(destination = "study", message = null)
    "flashcards" -> work.copy(overlays = work.overlays + "flashcards", destination = "notes", message = null)
    "homework" -> work.copy(destination = "homework", message = null)
    "calendar" -> work.copy(destination = "calendar", message = null)
    "daily" -> openDaily(work, extras.today, extras)
    "daily-previous" -> openAdjacentDaily(work, extras, -1)
    "daily-next" -> openAdjacentDaily(work, extras, 1)
    "duplicate-note" -> duplicate(work)
    "copy-wiki-link" -> copyWiki(work)
    "insert-date" -> insertStamp(work, extras.stampDate)
    "insert-date-time" -> insertStamp(work, extras.stampDateTime)
    "toggle-task" -> toggleOpenTask(work)
    "export-pdf" -> exportCurrent(work, "pdf", "application/pdf")
    "export-latex" -> exportLatex(work)
    "history" -> work.copy(overlays = work.overlays + "history", message = null)
    "quick-open" -> work.copy(paletteMode = "notes", overlays = work.overlays + "palette", message = null)
    "nav-back" -> navigate(work, -1)
    "nav-forward" -> navigate(work, 1)
    "reopen-tab" -> reopen(work)
    "split" -> toggleSplit(work)
    "split-swap" -> swapSplit(work)
    "split-orientation" -> work.copy(splitRows = !work.splitRows, message = null)
    "focus" -> work.copy(focus = !work.focus, message = null)
    "sidebar" -> work.copy(sidebar = !work.sidebar, message = null)
    "inspector" -> work.copy(inspector = !work.inspector, message = null)
    "settings" -> work.copy(overlays = work.overlays + "settings", settingsSection = null, message = null)
    "sync-now" -> work.copy(syncGeneration = work.syncGeneration + 1, message = null)
    "sync-settings" -> work.copy(overlays = work.overlays + "settings", settingsSection = "sync", message = null)
    "addon-store" -> installAddon(work, extras)
    "reveal" -> reveal(work)
    "bug-report" -> work.copy(overlays = work.overlays + "bug", message = null)
    "note-here" -> addNote(work, parentOf(work.openPath), "Unbenannte Notiz", "# Unbenannte Notiz\n\n")
    "download-note" -> exportCurrent(work, "md", "text/markdown")
    "trash" -> work.copy(destination = "trash", overlays = work.overlays + "trash", message = null)
    "pin-tab" -> pinTab(work)
    "close-others" -> closeTabs(work, others = true)
    "close-right" -> closeTabs(work, others = false)
    "cycle-tab" -> cycleTab(work)
    "text-hand" -> work.copy(overlays = work.overlays + "text-hand", message = null)
    "notes" -> work.copy(destination = "notes", message = null)
    "books" -> work.copy(destination = "books", message = null)
    else -> if (id.startsWith("template-")) applyTemplate(work, id.removePrefix("template-")) else work.copy(message = null)
}

private fun parentOf(path: String?): String {
    if (path.isNullOrBlank() || !path.contains('/')) return ""
    return path.substringBeforeLast('/')
}

private fun taken(work: DeskWork): Set<String> =
    (work.notes.map { it.path } + work.folders).toSet()

private fun uniquePath(work: DeskWork, folder: String, leaf: String, extension: String): String {
    val dir = folder.trim().trim('/')
    val base = leaf.trim().ifBlank { "Notiz" }
    fun join(name: String) = if (dir.isEmpty()) "$name$extension" else "$dir/$name$extension"
    if (join(base) !in taken(work)) return join(base)
    var index = 2
    while (join("$base $index") in taken(work)) index += 1
    return join("$base $index")
}

private fun addNote(work: DeskWork, folder: String, title: String, markdown: String): DeskWork {
    val path = uniquePath(work, folder, title, ".md")
    val note = DeskNote(path, markdown)
    return work.copy(
        notes = work.notes + note,
        openPath = path,
        markdown = markdown,
        cursorLine = 0,
        destination = "notes",
        tabs = if (path in work.tabs) work.tabs else work.tabs + path,
        trail = visitNote(work.trail, path),
        message = null,
    )
}

private fun addFolder(work: DeskWork, parent: String, name: String): DeskWork {
    val path = uniquePath(work, parent, name, "")
    return work.copy(folders = work.folders + path, message = null)
}

private fun importPdf(work: DeskWork, extras: CommandExtras): DeskWork {
    val name = extras.pdfName?.trim().orEmpty()
    if (name.isEmpty()) return work.copy(platform = "import-pdf", overlays = work.overlays + "import-pdf", message = null)
    val title = name.substringAfterLast('/').substringBeforeLast('.')
    val markdown = "# $title\n\n<!-- fanotes-pdf:$name -->\n"
    return addNote(work, parentOf(work.openPath), title, markdown).copy(platform = null)
}

private fun placeTextField(work: DeskWork): DeskWork {
    if (work.openPath.isNullOrBlank()) return work.copy(message = TEXT_FIELD_NEEDS_NOTE)
    return work.copy(textFieldPlacing = !work.textFieldPlacing, linkPlacing = false, message = null)
}

private fun replaceOpen(work: DeskWork, markdown: String): DeskWork {
    val path = work.openPath
    val notes = if (path == null) work.notes else work.notes.map { note ->
        if (note.path == path) note.copy(markdown = markdown) else note
    }
    return work.copy(notes = notes, markdown = markdown, message = null)
}

private fun importOneNote(work: DeskWork, extras: CommandExtras): DeskWork {
    val bytes = extras.onenoteBytes ?: return work.copy(
        platform = "onenote-picker",
        overlays = work.overlays + "onenote-import",
        message = null,
    )
    val read = readOneNotePages(
        bytes,
        extras.onenoteName,
        extras.one2htmlPath,
        extras.sevenZipPath,
        parentOf(work.openPath).ifBlank { "OneNote" },
        taken(work),
    )
    if (read.notes.isEmpty()) {
        return work.copy(overlays = work.overlays + "onenote-import", message = read.message ?: ONE_NOTE_EMPTY)
    }
    val notes = work.notes + read.notes
    val open = read.notes.first()
    return work.copy(
        notes = notes,
        openPath = open.path,
        markdown = open.markdown,
        destination = "notes",
        tabs = work.tabs + read.notes.map { it.path },
        trail = visitNote(work.trail, open.path),
        overlays = work.overlays + "onenote-import",
        message = null,
    )
}

fun oneNoteNotes(bytes: ByteArray, folder: String, taken: Set<String> = emptySet()): List<DeskNote> =
    notesFromPages(htmlPages(bytes), folder, taken, bytes)

internal fun notesFromPages(
    pages: List<HtmlPage>,
    folder: String,
    taken: Set<String>,
    digestSource: ByteArray,
): List<DeskNote> {
    if (pages.isEmpty()) return emptyList()
    val digest = sha256Hex(digestSource).take(24)
    val used = taken.toMutableSet()
    return pages.mapIndexed { index, page ->
        val title = page.title.ifBlank { "OneNote ${index + 1}" }
        val safe = title.replace(Regex("""[\\/:*?"<>|]"""), " ").replace(Regex("""\s+"""), " ").trim().ifBlank { "OneNote ${index + 1}" }
        var leaf = safe
        var path = joinPath(folder, "$leaf.md")
        var suffix = 2
        while (path in used) {
            leaf = "$safe $suffix"
            path = joinPath(folder, "$leaf.md")
            suffix += 1
        }
        used += path
        val id = "onenote-$index-${digest.take(8)}"
        val markdown = "# $leaf\n\n<!-- fanotes-onenote:$digest -->\n<!-- fanotes-worksheet:$id -->\n"
        DeskNote(path, markdown)
    }
}

internal data class HtmlPage(val title: String, val html: String)

private fun htmlPages(bytes: ByteArray): List<HtmlPage> {
    // A .one section contains raw '<' bytes. Those are not an HTML export.
    if (isOneNoteBinary(bytes)) return emptyList()
    if (bytes.size >= 2 && bytes[0] == 0x50.toByte() && bytes[1] == 0x4b.toByte()) {
        val pages = ArrayList<HtmlPage>()
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                val name = entry.name.replace('\\', '/')
                if (!entry.isDirectory && (name.endsWith(".html", true) || name.endsWith(".htm", true))) {
                    val text = zip.readBytes().toString(Charsets.UTF_8)
                    if (text.isNotBlank()) pages += HtmlPage(htmlTitle(text, name), text)
                }
                zip.closeEntry()
                entry = zip.nextEntry
            }
        }
        return pages
    }
    val text = bytes.toString(Charsets.UTF_8)
    if (text.contains('<')) return listOf(HtmlPage(htmlTitle(text, "Seite"), text))
    return emptyList()
}

internal fun htmlTitle(html: String, fallbackName: String): String {
    val match = Regex("<title>(.*?)</title>", RegexOption.IGNORE_CASE).find(html)
    val raw = match?.groupValues?.get(1)?.trim().orEmpty()
    if (raw.isNotEmpty()) return raw
    return fallbackName.substringAfterLast('/').substringBeforeLast('.')
}

private fun joinPath(folder: String, leaf: String): String {
    val dir = folder.trim().trim('/')
    return if (dir.isEmpty()) leaf else "$dir/$leaf"
}

internal fun sha256Hex(bytes: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    return digest.joinToString("") { "%02x".format(it) }
}

private fun openGlyphenWerk(work: DeskWork, extras: CommandExtras): DeskWork {
    val bytes = extras.glyphBytes ?: return work.copy(overlays = work.overlays + "glyphenwerk", message = null)
    val imported = runCatching { importGlyphArchive(bytes) }.getOrElse { error ->
        return work.copy(overlays = work.overlays + "glyphenwerk", message = error.message)
    }
    return work.copy(
        overlays = work.overlays + "glyphenwerk",
        glyphLabels = work.glyphLabels + imported.samples.map { it.label },
        message = null,
    )
}

private fun openDaily(work: DeskWork, day: LocalDate, extras: CommandExtras): DeskWork {
    val path = dailyNotePath(work.dailyFolder, day)
    val existing = work.notes.firstOrNull { it.path == path }
    if (existing != null) {
        return work.copy(openPath = path, markdown = existing.markdown, destination = "notes", trail = visitNote(work.trail, path), message = null)
    }
    val title = path.substringAfterLast('/').removeSuffix(".md")
    return addNote(work, work.dailyFolder, title, "# $title\n")
}

private fun openAdjacentDaily(work: DeskWork, extras: CommandExtras, direction: Int): DeskWork {
    val open = work.openPath
    val folder = work.dailyFolder.trim().trim('/')
    val inDaily = open != null && open.substringBeforeLast('/') == folder
    if (!inDaily) return work.copy(message = NOT_A_DAILY_NOTE)
    return openDaily(work, extras.today.plusDays(direction.toLong()), extras)
}

private fun duplicate(work: DeskWork): DeskWork {
    val path = work.openPath ?: return work.copy(message = "Öffne zuerst eine Notiz.")
    val note = work.notes.firstOrNull { it.path == path } ?: DeskNote(path, work.markdown)
    val title = path.substringAfterLast('/').substringBeforeLast('.')
    return addNote(work, parentOf(path), "$title Kopie", note.markdown)
}

private fun copyWiki(work: DeskWork): DeskWork {
    val path = work.openPath ?: return work.copy(message = "Öffne zuerst eine Notiz.")
    return work.copy(clipboard = wikiLinkForNote(path), platform = "clipboard", message = WIKI_LINK_COPIED)
}

private fun insertStamp(work: DeskWork, stamp: String): DeskWork {
    if (work.openPath == null) return work.copy(message = "Öffne zuerst eine Notiz.")
    val inserted = stampToInsert("", stamp)
    val lines = work.markdown.replace("\r\n", "\n").split('\n').toMutableList()
    val index = work.cursorLine.coerceIn(0, lines.lastIndex.coerceAtLeast(0))
    if (lines.isEmpty()) lines += inserted else lines[index] = lines[index] + inserted
    return replaceOpen(work, lines.joinToString("\n"))
}

private fun toggleOpenTask(work: DeskWork): DeskWork {
    if (work.openPath == null) return work.copy(message = "Öffne zuerst eine Notiz.")
    return replaceOpen(work, toggleTask(work.markdown, work.cursorLine))
}

private fun exportCurrent(work: DeskWork, extension: String, mime: String): DeskWork {
    val path = work.openPath ?: return work.copy(message = "Öffne zuerst eine Notiz.")
    val title = path.substringAfterLast('/').substringBeforeLast('.')
    val name = noteExportBaseName(title) + ".$extension"
    val export = DeskExport(name, mime, work.markdown)
    val platform = if (extension == "pdf") "export-pdf" else "download"
    return work.copy(exports = work.exports + export, platform = platform, message = null)
}

private fun exportLatex(work: DeskWork): DeskWork {
    val path = work.openPath ?: return work.copy(message = "Öffne zuerst eine Notiz.")
    val title = path.substringAfterLast('/').substringBeforeLast('.')
    val name = noteExportBaseName(title) + ".tex"
    val export = DeskExport(name, "application/x-tex", exportNoteLatex(work.markdown, title))
    return work.copy(exports = work.exports + export, platform = "share-latex", message = null)
}

private fun navigate(work: DeskWork, direction: Int): DeskWork {
    val known = work.notes.map { it.path }.toSet()
    val step = stepNoteHistory(work.trail, direction) { it in known }
    val path = step.path ?: return work.copy(message = null)
    val note = work.notes.firstOrNull { it.path == path }
    return work.copy(
        trail = step.history,
        openPath = path,
        markdown = note?.markdown ?: work.markdown,
        destination = "notes",
        message = null,
    )
}

private fun reopen(work: DeskWork): DeskWork {
    val known = work.notes.map { it.path }.toSet()
    val path = work.closedTabs.firstOrNull { it in known && it !in work.tabs }
        ?: return work.copy(message = "Kein kürzlich geschlossener Tab.")
    val note = work.notes.first { it.path == path }
    return work.copy(
        closedTabs = work.closedTabs.filterNot { it == path },
        tabs = work.tabs + path,
        openPath = path,
        markdown = note.markdown,
        destination = "notes",
        message = null,
    )
}

private fun toggleSplit(work: DeskWork): DeskWork {
    if (work.splitPath != null) return work.copy(splitPath = null, message = null)
    val other = work.notes.firstOrNull { it.path != work.openPath }?.path ?: work.openPath
    return work.copy(splitPath = other, message = null)
}

private fun swapSplit(work: DeskWork): DeskWork {
    val split = work.splitPath ?: return work.copy(message = null)
    val open = work.openPath ?: return work.copy(splitPath = null, openPath = split, message = null)
    val splitNote = work.notes.firstOrNull { it.path == split }
    return work.copy(
        openPath = split,
        splitPath = open,
        markdown = splitNote?.markdown ?: work.markdown,
        message = null,
    )
}

private fun installAddon(work: DeskWork, extras: CommandExtras): DeskWork {
    val json = extras.addonManifest
    if (json.isNullOrBlank()) return work.copy(overlays = work.overlays + "addon-store", message = null)
    val addon = parseAddonInstall(json)
        ?: return work.copy(overlays = work.overlays + "addon-store", message = "Das Add-on-Manifest ist ungültig.")
    val installed = work.installedAddons.filterNot { it.id == addon.id } + addon
    return work.copy(installedAddons = installed, overlays = work.overlays + "addon-store", message = null)
}

fun parseAddonInstall(json: String): InstalledAddon? {
    val root = runCatching { parseJson(json) as? JsonValue.Obj }.getOrNull() ?: return null
    val id = root.string("id")?.trim().orEmpty()
    val name = root.string("name")?.trim().orEmpty()
    val version = root.string("version")?.trim().orEmpty()
    if (!ADDON_ID.matches(id) || name.isEmpty() || version.isEmpty()) return null
    return InstalledAddon(id, name, version)
}

private fun reveal(work: DeskWork): DeskWork {
    if (work.openPath.isNullOrBlank()) return work.copy(message = "Öffne zuerst eine Notiz.")
    return work.copy(platform = "reveal", message = null)
}

private fun pinTab(work: DeskWork): DeskWork {
    val path = work.openPath ?: return work
    val pinned = if (path in work.pinned) work.pinned - path else work.pinned + path
    return work.copy(pinned = pinned, message = null)
}

private fun closeTabs(work: DeskWork, others: Boolean): DeskWork {
    val path = work.openPath ?: return work
    val keep = if (others) {
        work.tabs.filter { it == path || it in work.pinned }
    } else {
        val index = work.tabs.indexOf(path)
        if (index < 0) work.tabs else work.tabs.take(index + 1)
    }
    val closed = work.tabs.filter { it !in keep }
    return work.copy(tabs = keep, closedTabs = closed + work.closedTabs, message = null)
}

private fun cycleTab(work: DeskWork): DeskWork {
    if (work.tabs.size < 2) return work.copy(message = null)
    val index = work.tabs.indexOf(work.openPath).coerceAtLeast(0)
    val path = work.tabs[(index + 1) % work.tabs.size]
    val note = work.notes.firstOrNull { it.path == path }
    return work.copy(openPath = path, markdown = note?.markdown ?: work.markdown, destination = "notes", message = null)
}

private fun applyTemplate(work: DeskWork, id: String): DeskWork {
    val template = NOTE_TEMPLATES.firstOrNull { it.id == id } ?: return work.copy(message = null)
    return addNote(work, parentOf(work.openPath), template.fileName, template.markdown)
}

fun exportNoteLatex(note: String, title: String = "FaNotes"): String {
    val source = note
    val body = StringBuilder()
    var last = 0
    for (match in MATH_SPAN.findAll(source)) {
        body.append(escapeLatexText(source.substring(last, match.range.first)))
        body.append(match.value)
        last = match.range.last + 1
    }
    body.append(escapeLatexText(source.substring(last)))
    val safeTitle = escapeLatexText(title).replace(Regex("\\s+"), " ").trim().ifBlank { "FaNotes" }
    return "\\documentclass{article}\n" +
        "\\usepackage[utf8]{inputenc}\n" +
        "\\usepackage[T1]{fontenc}\n" +
        "\\usepackage{amsmath}\n" +
        "\\title{$safeTitle}\n" +
        "\\begin{document}\n" +
        body.toString() +
        "\\end{document}\n"
}

fun noteExportBaseName(title: String): String {
    val cleaned = title.replace(Regex("""[\\/:*?"<>|\u0000-\u001f]+"""), " ").replace(Regex("\\s+"), " ").trim()
    return (cleaned.ifBlank { "FaNotes" }).take(80)
}

private val MATH_SPAN = Regex("""\$\$[\s\S]*?\$\$|(?<!\$)\$(?!\$)(?:\\.|[^$\n])+?\$(?!\$)""")

private fun escapeLatexText(value: String): String = buildString {
    for (character in value) {
        append(
            when (character) {
                '\\' -> "\\textbackslash{}"
                '{' -> "\\{"
                '}' -> "\\}"
                '$' -> "\\$"
                '%' -> "\\%"
                '&' -> "\\&"
                '#' -> "\\#"
                '_' -> "\\_"
                '^' -> "\\textasciicircum{}"
                '~' -> "\\textasciitilde{}"
                else -> character.toString()
            },
        )
    }
}
