package ch.fasrv.fanotes.sync

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsNumber
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify

/**
 * Story files (`Name.story/…`) in sync, the same rules as the desktop/web
 * engine (`fanotes/src/writing/syncMerge.ts`, `model/merge.ts`) and checked on
 * the same fixtures (`fanotes/scripts/fixtures/writing-sync/cases.json`):
 *
 * - `scenes/<id>.json`: paragraph merge by version vector; both versions of a
 *   paragraph changed on two devices are kept (`conflictOf`), an edit wins
 *   over a delete. No conflict copy.
 * - `story.json`: manifest merge; binder by node id (nothing dropped), the
 *   newer `updatedAt` gives titles and attributes, dictionaries are unioned.
 * - `bible/<kind>/<id>.json`, `bible/notes/<id>.md`: the newer keeps the path,
 *   the other is kept as a conflict copy.
 * - `progress/`, `snapshots/`: per device / immutable, the general rules.
 *
 * Both devices compute the same merge whichever side is local, so they converge.
 */
enum class StoryRole { MANIFEST, SCENE, ENTITY, NOTE, PROGRESS, SNAPSHOT, OTHER }

private val STORY_ROOT = Regex("^(.+?\\.story)/(.+)$", RegexOption.IGNORE_CASE)
private val SCENE_FILE = Regex("^scenes/[0-9a-z]{6,40}\\.json$")
private val ENTITY_FILE = Regex("^bible/(?:characters|places|events)/[0-9a-z]{6,40}\\.json$")
private val NOTE_FILE = Regex("^bible/notes/[0-9a-z]{6,40}\\.md$")
private const val SCENE_FORMAT = "fanotes-story-scene-v1"
private const val STORY_FORMAT = "fanotes-story-v1"

fun storyRoleOf(path: String): StoryRole? {
    val relative = STORY_ROOT.find(path)?.groupValues?.get(2) ?: return null
    return when {
        relative == "story.json" -> StoryRole.MANIFEST
        SCENE_FILE.matches(relative) -> StoryRole.SCENE
        ENTITY_FILE.matches(relative) -> StoryRole.ENTITY
        NOTE_FILE.matches(relative) -> StoryRole.NOTE
        relative.startsWith("progress/") -> StoryRole.PROGRESS
        relative.startsWith("snapshots/") -> StoryRole.SNAPSHOT
        else -> StoryRole.OTHER
    }
}

/** Exactly what JavaScript's `JSON.stringify` prints, for comparisons that must match the desktop. */
fun jsStringify(value: JsonValue): String = buildString { appendJs(value) }

private fun StringBuilder.appendJs(value: JsonValue) {
    when (value) {
        is JsonValue.Null -> append("null")
        is JsonValue.Bool -> append(if (value.value) "true" else "false")
        is JsonValue.Num -> append(jsNumber(value.value))
        is JsonValue.Str -> appendJsString(value.value)
        is JsonValue.Arr -> {
            append('[')
            value.items.forEachIndexed { index, item -> if (index > 0) append(','); appendJs(item) }
            append(']')
        }
        is JsonValue.Obj -> {
            append('{')
            var first = true
            for ((key, item) in value.fields) {
                if (!first) append(',')
                first = false
                appendJsString(key)
                append(':')
                appendJs(item)
            }
            append('}')
        }
    }
}

private fun StringBuilder.appendJsString(text: String) {
    append('"')
    var index = 0
    while (index < text.length) {
        val char = text[index]
        when {
            char == '"' -> append("\\\"")
            char == '\\' -> append("\\\\")
            char == '\b' -> append("\\b")
            char == '\u000C' -> append("\\f")
            char == '\n' -> append("\\n")
            char == '\r' -> append("\\r")
            char == '\t' -> append("\\t")
            char.code < 0x20 -> append("\\u%04x".format(char.code))
            char.isHighSurrogate() && index + 1 < text.length && text[index + 1].isLowSurrogate() -> {
                append(char); append(text[index + 1]); index += 1
            }
            char.isSurrogate() -> append("\\u%04x".format(char.code))
            else -> append(char)
        }
        index += 1
    }
    append('"')
}

private fun JsonValue.Obj.copyObj() = JsonValue.Obj(LinkedHashMap(fields))
private fun truthy(value: JsonValue?): Boolean = when (value) {
    null, is JsonValue.Null -> false
    is JsonValue.Bool -> value.value
    is JsonValue.Num -> value.value != 0.0 && !value.value.isNaN()
    is JsonValue.Str -> value.value.isNotEmpty()
    else -> true
}
private fun orEmpty(value: JsonValue?): JsonValue = if (value == null || value is JsonValue.Null) JsonValue.Str("") else value

// ── Scenes ─────────────────────────────────────────────────────────────────

private enum class Order { EQUAL, LEFT, RIGHT, CONCURRENT }

private fun vector(paragraph: JsonValue.Obj): JsonValue.Obj = paragraph.obj("v") ?: JsonValue.Obj()

private fun compareVectors(left: JsonValue.Obj, right: JsonValue.Obj): Order {
    var leftAhead = false
    var rightAhead = false
    for (device in (left.fields.keys + right.fields.keys)) {
        val a = left.double(device) ?: 0.0
        val b = right.double(device) ?: 0.0
        if (a > b) leftAhead = true
        if (b > a) rightAhead = true
    }
    return when {
        leftAhead && rightAhead -> Order.CONCURRENT
        leftAhead -> Order.LEFT
        rightAhead -> Order.RIGHT
        else -> Order.EQUAL
    }
}

private fun mergeVectors(left: JsonValue.Obj, right: JsonValue.Obj): JsonValue.Obj {
    val out = left.copyObj()
    for ((device, count) in right.fields) {
        val current = out.double(device) ?: 0.0
        val next = (count as? JsonValue.Num)?.value ?: 0.0
        if (next > current || out[device] == null) out.fields[device] = if (next >= current) count else jsonNumber(current)
    }
    return out
}

private fun content(paragraph: JsonValue.Obj): String {
    val parts = JsonValue.Arr(
        mutableListOf(
            jsonNumber(if (truthy(paragraph["deleted"])) 1.0 else 0.0),
            paragraph["style"] ?: JsonValue.Null,
            orEmpty(paragraph["align"]),
            orEmpty(paragraph["lang"]),
            orEmpty(paragraph["breakBefore"]),
            paragraph["runs"] ?: JsonValue.Null,
        ),
    )
    return jsStringify(parts)
}

private fun vectorSum(vector: JsonValue.Obj) = vector.fields.values.sumOf { (it as? JsonValue.Num)?.value ?: 0.0 }

private fun prefer(left: JsonValue.Obj, right: JsonValue.Obj): JsonValue.Obj {
    val sums = vectorSum(vector(left)) - vectorSum(vector(right))
    if (sums != 0.0) return if (sums > 0) left else right
    return if (content(left) >= content(right)) left else right
}

private fun shortHash(value: String): String {
    var hash = 0x811c9dc5.toInt()
    for (char in value) {
        hash = hash xor char.code
        hash *= 0x01000193
    }
    return (hash.toLong() and 0xffffffffL).toString(36).padStart(7, '0')
}

private fun idOf(paragraph: JsonValue.Obj) = paragraph.string("id").orEmpty()
private fun keyOf(paragraph: JsonValue.Obj) = paragraph.string("key").orEmpty()

private fun isVector(value: JsonValue?) = value is JsonValue.Obj && value.fields.values.all { it is JsonValue.Num && it.value.isFinite() }

/** A scene the merge can work on (see `mergeableScene` in syncMerge.ts); null leaves it to a conflict copy. */
fun mergeableScene(value: JsonValue?, expectedId: String? = null): JsonValue.Obj? {
    val scene = value as? JsonValue.Obj ?: return null
    if (scene.string("format") != SCENE_FORMAT) return null
    val id = scene.string("id") ?: return null
    if (expectedId != null && id != expectedId) return null
    val paragraphs = scene.array("paragraphs") ?: return null
    val seen = HashSet<String>()
    for (item in paragraphs.items) {
        val paragraph = item as? JsonValue.Obj ?: return null
        val pid = paragraph.string("id") ?: return null
        if (paragraph.string("key") == null || paragraph.string("style") == null) return null
        if (!isVector(paragraph["v"]) || paragraph["runs"] !is JsonValue.Arr || !seen.add(pid)) return null
    }
    val footnotes = scene["footnotes"]
    val comments = scene["comments"]
    if (footnotes != null && footnotes !is JsonValue.Obj) return null
    if (comments != null && comments !is JsonValue.Obj) return null
    return scene
}

private fun mergeById(left: JsonValue.Obj?, right: JsonValue.Obj?): JsonValue.Obj {
    val out = JsonValue.Obj()
    for (source in listOf(right ?: JsonValue.Obj(), left ?: JsonValue.Obj())) {
        for ((id, value) in source.fields) {
            val current = out[id]
            if (current == null || jsStringify(value) > jsStringify(current)) out.fields[id] = value
        }
    }
    // Sorted, so both devices write the same bytes.
    return JsonValue.Obj(LinkedHashMap<String, JsonValue>().also { sorted -> for (key in out.fields.keys.sorted()) sorted[key] = out.fields[key]!! })
}

data class SceneMergeResult(val scene: JsonValue.Obj, val conflicts: Int)

/** `mergeScenes` from model/merge.ts plus the deterministic footnotes and comments of syncMerge.ts. */
fun mergeSceneVersions(left: JsonValue.Obj, right: JsonValue.Obj): SceneMergeResult {
    val leftById = LinkedHashMap<String, JsonValue.Obj>()
    for (item in left.array("paragraphs")?.items.orEmpty()) (item as? JsonValue.Obj)?.let { leftById[idOf(it)] = it }
    val rightById = LinkedHashMap<String, JsonValue.Obj>()
    for (item in right.array("paragraphs")?.items.orEmpty()) (item as? JsonValue.Obj)?.let { rightById[idOf(it)] = it }
    val merged = ArrayList<JsonValue.Obj>()
    var conflicts = 0
    val ids = LinkedHashSet<String>().apply { addAll(leftById.keys); addAll(rightById.keys) }
    for (id in ids) {
        val a = leftById[id]
        val b = rightById[id]
        if (a == null || b == null) {
            merged += (a ?: b)!!.copyObj()
            continue
        }
        val order = compareVectors(vector(a), vector(b))
        if (order == Order.LEFT || (order == Order.EQUAL && content(a) == content(b))) {
            merged += a.copyObj()
            continue
        }
        if (order == Order.RIGHT) {
            merged += b.copyObj()
            continue
        }
        val both = mergeVectors(vector(a), vector(b))
        if (content(a) == content(b)) {
            merged += a.copyObj().put("v", both)
            continue
        }
        if (truthy(a["deleted"]) || truthy(b["deleted"])) {
            val kept = if (truthy(a["deleted"])) b else a
            merged += kept.copyObj().put("v", both)
            continue
        }
        val winner = prefer(a, b)
        val other = if (winner === a) b else a
        conflicts += 1
        merged += winner.copyObj().put("v", both)
        val copyId = "${id.take(24)}x${shortHash(content(other))}"
        if (!leftById.containsKey(copyId) && !rightById.containsKey(copyId)) {
            val suffix = shortHash(copyId).trimEnd('0').ifEmpty { "V" }
            merged += other.copyObj()
                .put("id", JsonValue.Str(copyId))
                .put("key", JsonValue.Str("${keyOf(winner)}V$suffix"))
                .put("conflictOf", JsonValue.Str(id))
        }
    }
    val sorted = merged.sortedWith { x, y ->
        val kx = keyOf(x)
        val ky = keyOf(y)
        if (kx != ky) kx.compareTo(ky) else idOf(x).compareTo(idOf(y))
    }
    val scene = JsonValue.Obj()
    scene.fields["format"] = JsonValue.Str(SCENE_FORMAT)
    scene.fields["id"] = left["id"] ?: JsonValue.Str("")
    scene.fields["paragraphs"] = JsonValue.Arr(sorted.toMutableList<JsonValue>())
    val footnotes = mergeById(left.obj("footnotes"), right.obj("footnotes"))
    val comments = mergeById(left.obj("comments"), right.obj("comments"))
    if (footnotes.fields.isNotEmpty()) scene.fields["footnotes"] = footnotes
    if (comments.fields.isNotEmpty()) scene.fields["comments"] = comments
    return SceneMergeResult(scene, conflicts)
}

// ── Manifest ───────────────────────────────────────────────────────────────

/** A manifest the merge can work on (see `mergeableManifest` in syncMerge.ts). */
fun mergeableManifest(value: JsonValue?): JsonValue.Obj? {
    val manifest = value as? JsonValue.Obj ?: return null
    if (manifest.string("format") != STORY_FORMAT || manifest.string("id") == null || manifest.string("updatedAt") == null) return null
    val binder = manifest.array("binder") ?: return null
    fun ok(nodes: List<JsonValue>, depth: Int): Boolean = depth < 12 && nodes.all { node ->
        node is JsonValue.Obj && node.string("id") != null && (node["children"] == null || (node["children"] is JsonValue.Arr && ok((node["children"] as JsonValue.Arr).items, depth + 1)))
    }
    return if (ok(binder.items, 0)) manifest else null
}

private fun nodeId(node: JsonValue.Obj) = node.string("id").orEmpty()
private fun childrenOf(node: JsonValue.Obj): List<JsonValue.Obj>? = (node["children"] as? JsonValue.Arr)?.items?.map { it as JsonValue.Obj }

private fun binderIds(nodes: List<JsonValue.Obj>, into: MutableSet<String> = HashSet()): MutableSet<String> {
    for (node in nodes) {
        into += nodeId(node)
        childrenOf(node)?.let { binderIds(it, into) }
    }
    return into
}

private fun mergeBinders(newer: List<JsonValue.Obj>, older: List<JsonValue.Obj>): List<JsonValue.Obj> {
    val inNewer = binderIds(newer)
    val placed = HashSet<String>()
    fun olderOnly(node: JsonValue.Obj): JsonValue.Obj {
        placed += nodeId(node)
        val out = node.copyObj()
        val children = childrenOf(node)
        if (children != null) {
            val kept = children.filter { nodeId(it) !in inNewer && nodeId(it) !in placed }
            out.fields["children"] = JsonValue.Arr(kept.map { olderOnly(it) }.toMutableList<JsonValue>())
        }
        return out
    }
    val olderChildren = HashMap<String?, List<JsonValue.Obj>>()
    fun indexOlder(nodes: List<JsonValue.Obj>, parent: String?) {
        olderChildren[parent] = nodes
        for (node in nodes) childrenOf(node)?.let { indexOlder(it, nodeId(node)) }
    }
    indexOlder(older, null)
    fun weave(list: List<JsonValue.Obj>, parent: String?): List<JsonValue.Obj> {
        val out = list.toMutableList()
        var anchor: String? = null
        for (node in olderChildren[parent].orEmpty()) {
            val id = nodeId(node)
            if (id in inNewer) { anchor = id; continue }
            if (id in placed) continue
            val kept = olderOnly(node)
            val at = if (anchor == null) -1 else out.indexOfFirst { nodeId(it) == anchor }
            out.add(at + 1, kept)
            anchor = id
        }
        return out
    }
    fun walk(nodes: List<JsonValue.Obj>, parent: String?): List<JsonValue.Obj> {
        val own = ArrayList<JsonValue.Obj>()
        for (node in nodes) {
            val id = nodeId(node)
            if (id in placed) continue
            placed += id
            val out = node.copyObj()
            val original = childrenOf(node)
            val children = walk(original.orEmpty(), id)
            if (original != null || children.isNotEmpty()) out.fields["children"] = JsonValue.Arr(children.toMutableList<JsonValue>())
            own += out
        }
        return weave(own, parent)
    }
    return walk(newer, null)
}

private fun unionList(first: JsonValue?, second: JsonValue?): JsonValue.Arr? {
    val lists = listOf(first, second).filterIsInstance<JsonValue.Arr>()
    if (lists.isEmpty()) return null
    val out = JsonValue.Arr()
    val seen = HashSet<String>()
    for (list in lists) for (item in list.items) if (item is JsonValue.Str && seen.add(item.value)) out.items += item
    return out
}

/** `mergeManifests` from model/merge.ts. */
fun mergeManifests(left: JsonValue.Obj, right: JsonValue.Obj): JsonValue.Obj {
    val leftJson = jsStringify(left)
    val rightJson = jsStringify(right)
    val lu = left.string("updatedAt").orEmpty()
    val ru = right.string("updatedAt").orEmpty()
    val leftNewer = if (lu != ru) lu > ru else leftJson >= rightJson
    val newer = if (leftNewer) left else right
    val older = if (leftNewer) right else left
    val merged = older.copyObj()
    for ((key, value) in newer.fields) merged.fields[key] = value
    val oc = older.string("createdAt")
    val nc = newer.string("createdAt")
    if (!oc.isNullOrEmpty() && nc != null && oc < nc) merged.fields["createdAt"] = JsonValue.Str(oc)
    else if (newer["createdAt"] != null) merged.fields["createdAt"] = newer["createdAt"]!! else merged.fields.remove("createdAt")
    newer["updatedAt"]?.let { merged.fields["updatedAt"] = it }
    val newerStyles = newer["styles"]
    val olderStyles = older["styles"]
    if (truthy(newerStyles) || truthy(olderStyles)) {
        val styles = JsonValue.Obj()
        (olderStyles as? JsonValue.Obj)?.fields?.let { styles.fields.putAll(it) }
        (newerStyles as? JsonValue.Obj)?.fields?.let { styles.fields.putAll(it) }
        merged.fields["styles"] = styles
    }
    val binder = mergeBinders(
        (newer["binder"] as? JsonValue.Arr)?.items?.map { it as JsonValue.Obj }.orEmpty(),
        (older["binder"] as? JsonValue.Arr)?.items?.map { it as JsonValue.Obj }.orEmpty(),
    )
    merged.fields["binder"] = JsonValue.Arr(binder.toMutableList<JsonValue>())
    unionList(newer["dictionary"], older["dictionary"])?.let { merged.fields["dictionary"] = it }
    unionList(newer["ignored"], older["ignored"])?.let { merged.fields["ignored"] = it }
    return merged
}

// ── Engine entry points ────────────────────────────────────────────────────

sealed class StoryMergeOutcome {
    class Merged(val bytes: ByteArray, val sameAsRemote: Boolean, val sameAsLocal: Boolean, val conflicts: Int) : StoryMergeOutcome()
    class Pick(val keepLocal: Boolean) : StoryMergeOutcome()
    data object KeepLocal : StoryMergeOutcome()
}

private fun parseOrNull(bytes: ByteArray): JsonValue? = try {
    parseJson(bytes.decodeToString(throwOnInvalidSequence = true))
} catch (_: Exception) {
    null
}

private fun sceneIdOf(path: String) = path.substringAfterLast('/').removeSuffix(".json")

/** Desktop `serializeScene` / `serializeManifest` shapes: compact scene, manifest indented by one space. */
fun serializeStoryScene(scene: JsonValue.Obj): ByteArray = "${scene.stringify()}\n".encodeToByteArray()
fun serializeStoryManifest(manifest: JsonValue.Obj): ByteArray = "${indentJson(manifest, 0)}\n".encodeToByteArray()

private fun indentJson(value: JsonValue, depth: Int): String = when (value) {
    is JsonValue.Obj -> if (value.fields.isEmpty()) "{}" else value.fields.entries.joinToString(",\n", "{\n", "\n${" ".repeat(depth)}}") { (key, item) ->
        "${" ".repeat(depth + 1)}${jsStringify(JsonValue.Str(key))}: ${indentJson(item, depth + 1)}"
    }
    is JsonValue.Arr -> if (value.items.isEmpty()) "[]" else value.items.joinToString(",\n", "[\n", "\n${" ".repeat(depth)}]") { "${" ".repeat(depth + 1)}${indentJson(it, depth + 1)}" }
    else -> jsStringify(value)
}

/** Both sides changed a story file (see `mergeStoryFile` in syncMerge.ts). Null: keep today's conflict copy. */
fun mergeStoryFile(path: String, local: ByteArray, remote: ByteArray, localMtimeMs: Long, remoteMtimeMs: Long): StoryMergeOutcome? {
    when (storyRoleOf(path)) {
        StoryRole.SCENE -> {
            val mine = mergeableScene(parseOrNull(local), sceneIdOf(path)) ?: return null
            val theirs = mergeableScene(parseOrNull(remote), sceneIdOf(path)) ?: return StoryMergeOutcome.KeepLocal
            val result = mergeSceneVersions(mine, theirs)
            val json = jsStringify(result.scene)
            return StoryMergeOutcome.Merged(serializeStoryScene(result.scene), json == jsStringify(theirs), json == jsStringify(mine), result.conflicts)
        }
        StoryRole.MANIFEST -> {
            val mine = mergeableManifest(parseOrNull(local)) ?: return null
            val theirs = mergeableManifest(parseOrNull(remote)) ?: return StoryMergeOutcome.KeepLocal
            if (mine.string("id") != theirs.string("id")) return null
            val merged = mergeManifests(mine, theirs)
            val json = jsStringify(merged)
            return StoryMergeOutcome.Merged(serializeStoryManifest(merged), json == jsStringify(theirs), json == jsStringify(mine), 0)
        }
        StoryRole.ENTITY -> {
            val mine = parseOrNull(local) as? JsonValue.Obj ?: return null
            val theirs = parseOrNull(remote) as? JsonValue.Obj ?: return StoryMergeOutcome.KeepLocal
            val a = mine.string("updatedAt").orEmpty()
            val b = theirs.string("updatedAt").orEmpty()
            return StoryMergeOutcome.Pick(if (a != b) a > b else localMtimeMs > remoteMtimeMs)
        }
        StoryRole.NOTE -> return StoryMergeOutcome.Pick(localMtimeMs > remoteMtimeMs)
        else -> return null
    }
}

sealed class ShrinkVerdict {
    data object Cut : ShrinkVerdict()
    class Merge(val bytes: ByteArray) : ShrinkVerdict()
    data object Guard : ShrinkVerdict()
}

/** A much smaller (or any) scene upload against the server's copy (see `judgeStoryShrink` in syncMerge.ts). */
fun judgeStoryShrink(path: String, local: ByteArray, server: ByteArray): ShrinkVerdict {
    when (storyRoleOf(path)) {
        StoryRole.SCENE -> {
            val mine = mergeableScene(parseOrNull(local), sceneIdOf(path)) ?: return ShrinkVerdict.Guard
            val theirs = mergeableScene(parseOrNull(server), sceneIdOf(path)) ?: return ShrinkVerdict.Guard
            val present = mine.array("paragraphs")!!.items.map { idOf(it as JsonValue.Obj) }.toSet()
            if (theirs.array("paragraphs")!!.items.all { idOf(it as JsonValue.Obj) in present }) return ShrinkVerdict.Cut
            return ShrinkVerdict.Merge(serializeStoryScene(mergeSceneVersions(mine, theirs).scene))
        }
        StoryRole.MANIFEST -> {
            val mine = mergeableManifest(parseOrNull(local)) ?: return ShrinkVerdict.Guard
            val theirs = mergeableManifest(parseOrNull(server)) ?: return ShrinkVerdict.Guard
            if (mine.string("id") != theirs.string("id")) return ShrinkVerdict.Guard
            if (mine.string("updatedAt").orEmpty() >= theirs.string("updatedAt").orEmpty()) return ShrinkVerdict.Cut
            return ShrinkVerdict.Merge(serializeStoryManifest(mergeManifests(mine, theirs)))
        }
        else -> return ShrinkVerdict.Guard
    }
}
