package ch.fasrv.fanotes.vault

/**
 * Writing-mode story projects (`Name.story/`), with the same rules as the
 * desktop host (`fanotes/electron/main.cjs`, STORY_FILE): reads and writes
 * only JSON or Markdown files up to three folders deep inside a `.story`
 * folder, at most 16 MiB each. Stories never delete files.
 */
object StoryFiles {
    const val MAX_FILE_BYTES = 16 * 1024 * 1024
    private val FILE = Regex("^(.+\\.story)/((?:[A-Za-z0-9_-]{1,64}/){0,3}[A-Za-z0-9_.-]{1,96}\\.(?:json|md))$", RegexOption.IGNORE_CASE)
    private val FOLDER = Regex("^(?:.+/)?[^/]+\\.story$", RegexOption.IGNORE_CASE)
    private val BAD_NAME = Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]")

    /** A normalized story file path, or an exception. */
    fun checkFile(path: String): String {
        val clean = normalize(path)
        val match = FILE.matchEntire(clean) ?: throw IllegalArgumentException("Kein Pfad in einem .story-Ordner.")
        if (match.groupValues[2].split('/').any { it.startsWith('.') }) throw IllegalArgumentException("Kein Pfad in einem .story-Ordner.")
        return clean
    }

    fun checkFolder(path: String): String {
        val clean = normalize(path)
        if (!FOLDER.matches(clean)) throw IllegalArgumentException("Kein .story-Ordner.")
        return clean
    }

    fun read(io: VaultIo, path: String): String? {
        val bytes = io.read(checkFile(path)) ?: return null
        if (bytes.size > MAX_FILE_BYTES) throw IllegalArgumentException("Die Datei ist zu gross.")
        return bytes.toString(Charsets.UTF_8)
    }

    fun write(io: VaultIo, path: String, content: String) {
        val clean = checkFile(path)
        val bytes = content.toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_FILE_BYTES) throw IllegalArgumentException("Der Inhalt ist zu gross.")
        io.write(clean, bytes)
    }

    /** Files inside a story folder, relative to it (JSON and Markdown, no dotfiles, four levels deep at most). */
    fun list(io: VaultIo, storyPath: String): List<String> {
        val folder = checkFolder(storyPath)
        val out = mutableListOf<String>()
        fun walk(directory: String, depth: Int) {
            if (depth > 4 || out.size > 20_000) return
            for (entry in io.list(directory)) {
                val name = entry.path.substringAfterLast('/')
                if (name.startsWith('.')) continue
                if (entry.directory) walk(entry.path, depth + 1)
                else if (name.endsWith(".json", ignoreCase = true) || name.endsWith(".md", ignoreCase = true)) out += entry.path.removePrefix("$folder/")
            }
        }
        walk(folder, 0)
        return out.sorted()
    }

    /** Creates an empty `Name.story` folder with a free name inside `parent` and returns its path. */
    fun create(io: VaultIo, parent: String, name: String): String {
        val folder = if (parent.isBlank()) "" else normalize(parent)
        var base = name.replace(BAD_NAME, " ").replace(Regex("\\s+"), " ").trim().removeSuffix(".story").trim()
        if (base.isEmpty() || base.startsWith('.')) base = "Geschichte"
        if (base.length > 120) base = base.take(120).trim()
        fun at(candidate: String) = if (folder.isEmpty()) candidate else "$folder/$candidate"
        var chosen = at("$base.story")
        var index = 2
        while (io.exists(chosen)) chosen = at("$base ${index++}.story")
        io.mkdir(chosen)
        return chosen
    }

    /** Whether a vault directory is a story project (shown as one document). */
    fun isStoryFolder(path: String) = FOLDER.matches(path.trim('/'))
}
