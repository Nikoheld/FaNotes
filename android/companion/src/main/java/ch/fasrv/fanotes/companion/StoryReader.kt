package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson

/** What a block of a read-only story is. */
enum class StoryBlockKind { PART, CHAPTER, SCENE, PARAGRAPH }

/** One heading or paragraph. [style] is the writing mode's paragraph style id (`body`, `quote`, `heading` ...). */
data class StoryBlock(val kind: StoryBlockKind, val text: String, val style: String = "body")

data class StoryText(val title: String, val subtitle: String, val author: String, val blocks: List<StoryBlock>, val truncated: Boolean = false)

private const val STORY_FORMAT = "fanotes-story-v1"
private const val SCENE_FORMAT = "fanotes-story-scene-v1"
private val STORY_ID = Regex("^[0-9a-z]{6,40}$")
private const val MAX_STORY_CHARS = 4_000_000
private const val MAX_BINDER_DEPTH = 6

/**
 * The text of a story project in reading order, the way the desktop walks it (`scenesInOrder` in
 * `src/writing/binder.ts`): the binder top to bottom, scene by scene, with chapter and part titles as headings.
 * Nodes marked as excluded from the manuscript (and everything inside them, such as the trash folder) are
 * left out, and so are deleted paragraphs. [read] returns a story-relative file's text, or null when it is missing.
 * Returns null when `story.json` is missing or is no story manifest.
 */
fun readStoryText(read: (String) -> String?): StoryText? {
    val manifest = parseObject(read("story.json")) ?: return null
    if (manifest.string("format") != STORY_FORMAT) return null
    val blocks = ArrayList<StoryBlock>()
    var chars = 0
    var truncated = false
    val seen = HashSet<String>()

    fun walk(nodes: List<JsonValue>, depth: Int) {
        if (depth > MAX_BINDER_DEPTH) return
        for (entry in nodes.take(5000)) {
            val node = entry as? JsonValue.Obj ?: continue
            val id = node.string("id") ?: continue
            if (!STORY_ID.matches(id) || !seen.add(id)) continue
            if (node.bool("exclude") == true) continue
            val title = node.string("title").orEmpty().trim()
            when (node.string("kind")) {
                "scene" -> {
                    if (chars > MAX_STORY_CHARS) { truncated = true; return }
                    if (title.isNotEmpty()) blocks += StoryBlock(StoryBlockKind.SCENE, title, "heading")
                    for (paragraph in sceneParagraphs(parseObject(read("scenes/$id.json")), id)) {
                        chars += paragraph.text.length
                        blocks += paragraph
                    }
                }
                "part" -> {
                    if (title.isNotEmpty()) blocks += StoryBlock(StoryBlockKind.PART, title, "chapter")
                    walk(node.array("children")?.items.orEmpty(), depth + 1)
                }
                "chapter" -> {
                    if (title.isNotEmpty()) blocks += StoryBlock(StoryBlockKind.CHAPTER, title, "chapter")
                    walk(node.array("children")?.items.orEmpty(), depth + 1)
                }
                "folder" -> walk(node.array("children")?.items.orEmpty(), depth + 1)
            }
        }
    }
    walk(manifest.array("binder")?.items.orEmpty(), 0)
    return StoryText(
        title = manifest.string("title").orEmpty().trim(),
        subtitle = manifest.string("subtitle").orEmpty().trim(),
        author = manifest.string("author").orEmpty().trim(),
        blocks = blocks,
        truncated = truncated,
    )
}

private fun parseObject(text: String?): JsonValue.Obj? =
    if (text.isNullOrBlank()) null else runCatching { parseJson(text) as? JsonValue.Obj }.getOrNull()

/** Paragraphs of one scene in their stored order (order key, then id); deleted and empty ones are skipped. */
private fun sceneParagraphs(scene: JsonValue.Obj?, expectedId: String): List<StoryBlock> {
    if (scene == null || scene.string("format") != SCENE_FORMAT) return emptyList()
    val id = scene.string("id")
    if (id != null && id != expectedId) return emptyList()
    data class Entry(val key: String, val id: String, val index: Int, val block: StoryBlock)
    val entries = ArrayList<Entry>()
    for ((index, raw) in scene.array("paragraphs")?.items.orEmpty().take(50_000).withIndex()) {
        val paragraph = raw as? JsonValue.Obj ?: continue
        if (paragraph.bool("deleted") == true) continue
        val text = paragraph.array("runs")?.items.orEmpty().joinToString("") { ((it as? JsonValue.Obj)?.string("text")).orEmpty() }
            .replace("\r\n", "\n").replace('\r', '\n').trim()
        if (text.isEmpty()) continue
        val style = paragraph.string("style")?.takeIf { Regex("^[a-z0-9-]{1,40}$").matches(it) } ?: "body"
        entries += Entry(paragraph.string("key").orEmpty(), paragraph.string("id").orEmpty(), index, StoryBlock(StoryBlockKind.PARAGRAPH, text, style))
    }
    // Keys sort as strings. Paragraphs without a key keep their stored order (the desktop re-keys them in order).
    val keyed = entries.all { it.key.isNotEmpty() }
    return (if (keyed) entries.sortedWith(compareBy<Entry>({ it.key }, { it.id })) else entries).map { it.block }
}
