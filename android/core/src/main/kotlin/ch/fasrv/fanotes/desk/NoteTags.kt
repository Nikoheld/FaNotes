package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.VaultNode
import java.util.Locale

/**
 * Note tags shared with the desktop (`noteTags.ts`): a `fanotes-tags` marker
 * plus hashtags in the prose. The marker is what the tag chips write back.
 */

private val TAG_MARKER = Regex("""<!--\s*fanotes-tags:\s*([^\n]*?)\s*-->""", RegexOption.IGNORE_CASE)
private val HASHTAG = Regex("""(?:^|[\s(\[{'"])#([\p{L}\p{N}_-]{1,40})""")
private val SWISS = Locale.forLanguageTag("de-CH")

fun normalizeTag(value: String): String = value
    .trim()
    .replace(Regex("^#"), "")
    .replace(Regex("\\s+"), "-")
    .take(40)
    .lowercase(SWISS)

fun parseDeclaredTags(content: String): List<String> {
    val match = TAG_MARKER.find(content) ?: return emptyList()
    return uniqueTags(match.groupValues[1].split(Regex("[,;]+")))
}

fun parseHashtags(content: String): List<String> {
    val body = TAG_MARKER.replaceFirst(maskMarkdownCode(content), "")
    return uniqueTags(HASHTAG.findAll(body).map { it.groupValues[1] }.toList())
}

fun parseNoteTags(content: String): List<String> = uniqueTags(parseDeclaredTags(content) + parseHashtags(content))

fun applyNoteTags(content: String, tags: List<String>): String {
    val next = uniqueTags(tags)
    val marker = if (next.isEmpty()) "" else "<!-- fanotes-tags: ${next.joinToString(", ")} -->"
    val existing = TAG_MARKER.find(content)
    if (existing != null) {
        return content.replaceRange(existing.range, marker).replace(Regex("""^\n+"""), "")
    }
    if (marker.isEmpty()) return content
    return "$marker\n${content.removePrefix("\uFEFF")}"
}

fun collectVaultTags(contents: List<String>): List<String> = uniqueTags(contents.flatMap { parseNoteTags(it) })

/** Keep notes that carry [tag], and folders that still contain such a note. */
fun filterVaultByTag(nodes: List<VaultNode>, tag: String?, index: Map<String, List<String>>): List<VaultNode> {
    if (tag.isNullOrEmpty()) return nodes
    val wanted = normalizeTag(tag)
    fun keep(node: VaultNode): VaultNode? {
        if (node.kind != NoteKind.FOLDER) {
            return if (index[node.path].orEmpty().contains(wanted)) node else null
        }
        val children = node.children.mapNotNull { keep(it) }
        return if (children.isEmpty()) null else node.copy(children = children)
    }
    return nodes.mapNotNull { keep(it) }
}

private fun uniqueTags(values: List<String>): List<String> {
    val seen = linkedSetOf<String>()
    val result = mutableListOf<String>()
    for (raw in values) {
        val tag = normalizeTag(raw)
        if (tag.isEmpty() || tag in seen) continue
        seen += tag
        result += tag
    }
    return result
}
