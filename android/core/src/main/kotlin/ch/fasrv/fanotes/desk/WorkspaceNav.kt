package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import java.text.Collator
import java.text.Normalizer
import java.util.Locale
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Pure helpers behind workspace navigation, ported from
 * `fanotes/src/lib/workspaceNav.ts`: visited-note history, split layout,
 * tab order, the remembered workspace, and the quick switcher.
 */

data class NoteTrail(val entries: List<String> = emptyList(), val index: Int = -1)

data class NoteTrailStep(val history: NoteTrail, val path: String?)

const val NOTE_HISTORY_LIMIT = 120

val EMPTY_NOTE_TRAIL = NoteTrail()

/** Record a visit: drops any forward entries, skips a repeat of the current note. */
fun visitNote(history: NoteTrail, path: String): NoteTrail {
    if (path.isEmpty()) return history
    if (history.index in history.entries.indices && history.entries[history.index] == path) return history
    val kept = history.entries.take(history.index + 1).toMutableList()
    kept.add(path)
    val overflow = max(0, kept.size - NOTE_HISTORY_LIMIT)
    val entries = if (overflow > 0) kept.drop(overflow) else kept
    return NoteTrail(entries, entries.lastIndex)
}

fun canGoBack(history: NoteTrail) = history.index > 0

fun canGoForward(history: NoteTrail) = history.index >= 0 && history.index < history.entries.lastIndex

/**
 * Step through the history, skipping entries that no longer exist.
 * Missing notes stay in the list so a reopened note keeps its place.
 */
fun stepNoteHistory(
    history: NoteTrail,
    direction: Int,
    exists: (String) -> Boolean = { true },
): NoteTrailStep {
    var index = history.index + direction
    while (index >= 0 && index < history.entries.size) {
        val path = history.entries[index]
        if (exists(path)) return NoteTrailStep(history.copy(index = index), path)
        index += direction
    }
    return NoteTrailStep(history, null)
}

/** Rename or move: every visit of the old path (or a note inside a moved folder) follows. */
fun remapNoteHistory(history: NoteTrail, from: String, to: String): NoteTrail {
    val entries = history.entries.map { entry -> remapPath(entry, from, to) ?: entry }
    return collapseHistoryRepeats(NoteTrail(entries, history.index))
}

/** Forget every visit of the path, or of notes inside a removed folder. */
fun forgetNoteHistory(history: NoteTrail, path: String): NoteTrail {
    val entries = mutableListOf<String>()
    var index = -1
    history.entries.forEachIndexed { position, entry ->
        if (isSelfOrInside(entry, path)) return@forEachIndexed
        entries.add(entry)
        if (position <= history.index) index = entries.lastIndex
    }
    return collapseHistoryRepeats(NoteTrail(entries, index))
}

private fun collapseHistoryRepeats(history: NoteTrail): NoteTrail {
    val entries = mutableListOf<String>()
    var index = -1
    history.entries.forEachIndexed { position, entry ->
        if (entries.lastOrNull() == entry) {
            if (position <= history.index) index = entries.lastIndex
            return@forEachIndexed
        }
        entries.add(entry)
        if (position <= history.index) index = entries.lastIndex
    }
    val clamped = if (entries.isEmpty()) -1 else min(index, entries.lastIndex)
    return NoteTrail(entries, clamped)
}

fun isSelfOrInside(candidate: String, ancestor: String) =
    candidate == ancestor || candidate.startsWith("$ancestor/")

/**
 * Folders a move dialog can offer. The current parent is omitted (that move
 * is a no-op), and a folder cannot be moved into itself or a descendant.
 */
fun movableFolderTargets(folders: List<String>, moving: String): List<String> {
    val path = moving.replace('\\', '/').trim('/')
    val parent = path.substringBeforeLast('/', "")
    return folders.map { it.replace('\\', '/').trim('/') }.filter { folder ->
        folder.isNotEmpty() && folder != parent && folder != path && !folder.startsWith("$path/")
    }
}

/** The path after `from` was renamed or moved to `to`, or null when unaffected. */
fun remapPath(path: String, from: String, to: String): String? =
    if (isSelfOrInside(path, from)) to + path.substring(from.length) else null

data class Breadcrumb(val label: String, val path: String, val isNote: Boolean)

private val NOTE_EXTENSION = Regex("\\.(md|markdown|famd|pdf)$", RegexOption.IGNORE_CASE)

/** Breadcrumb trail: each folder, then the note with its extension stripped. */
fun breadcrumbsFor(path: String): List<Breadcrumb> {
    val parts = path.split('/').filter { it.isNotEmpty() }
    return parts.mapIndexed { index, part ->
        val isNote = index == parts.lastIndex
        Breadcrumb(
            label = if (isNote) part.replace(NOTE_EXTENSION, "") else part,
            path = parts.take(index + 1).joinToString("/"),
            isNote = isNote,
        )
    }
}

enum class SplitOrientation { COLUMNS, ROWS }

data class SplitLayout(val ratio: Double, val orientation: SplitOrientation)

const val SPLIT_MIN_RATIO = 0.2
const val SPLIT_MAX_RATIO = 0.8
const val SPLIT_RATIO_STEP = 0.05
val DEFAULT_SPLIT_LAYOUT = SplitLayout(0.5, SplitOrientation.COLUMNS)

data class SplitBox(val left: Double, val top: Double, val width: Double, val height: Double)
data class SplitPointer(val x: Double, val y: Double)

fun clampSplitRatio(ratio: Double): Double {
    if (!ratio.isFinite()) return DEFAULT_SPLIT_LAYOUT.ratio
    return min(SPLIT_MAX_RATIO, max(SPLIT_MIN_RATIO, ratio))
}

/** The saved split ratio. A missing or broken value is the desktop default, half and half. */
fun splitRatioFromSetting(value: String?): Double = clampSplitRatio(value?.toDoubleOrNull() ?: Double.NaN)

fun splitRatioFromPointer(container: SplitBox, pointer: SplitPointer, orientation: SplitOrientation): Double {
    val along = if (orientation == SplitOrientation.COLUMNS) {
        (pointer.x - container.left) / max(1.0, container.width)
    } else {
        (pointer.y - container.top) / max(1.0, container.height)
    }
    return clampSplitRatio(along)
}

/** First pane size in CSS px, snapped so both sheets stay on the pixel grid. */
fun splitFirstPaneSize(containerSize: Double, dividerSize: Double, ratio: Double, devicePixelRatio: Double): Double {
    val size = if (containerSize.isFinite()) containerSize else 0.0
    val available = max(0.0, size - max(0.0, dividerSize))
    return snapToDevicePixels(available * clampSplitRatio(ratio), devicePixelRatio)
}

fun snapToDevicePixels(cssPx: Double, devicePixelRatio: Double): Double {
    val dpr = if (devicePixelRatio.isFinite() && devicePixelRatio > 0.0) devicePixelRatio else 1.0
    val value = if (cssPx.isFinite()) cssPx else 0.0
    return floor(value * dpr + 0.5) / dpr
}

fun nudgeSplitRatio(ratio: Double, direction: Int): Double =
    clampSplitRatio(floor((ratio + direction * SPLIT_RATIO_STEP) * 100.0 + 0.5) / 100.0)

/** Folder that contains a note. A root note has no parent. */
fun parentFolderOf(path: String): String {
    val normalized = path.replace('\\', '/').trim('/')
    val slash = normalized.lastIndexOf('/')
    return if (slash < 0) "" else normalized.substring(0, slash)
}

/**
 * Opening the note that is already in the second pane swaps the panes.
 * The pair is the new main path, then the note that moves into the split.
 */
fun swappedSplit(active: String?, split: String?): Pair<String, String>? {
    if (active.isNullOrBlank() || split.isNullOrBlank() || active == split) return null
    return split to active
}

/**
 * Note that „Rechts öffnen“ puts in the second pane.
 * The open note stays where it is. Choosing it uses the newest other tab,
 * then the first other tab. Null means there is no second note yet.
 * [history] is oldest first, the same order as [NoteTrail.entries].
 */
fun splitPanePath(requested: String, active: String?, tabs: List<String>, history: List<String>): String? {
    if (requested.isBlank()) return null
    if (requested != active) return requested
    return history.asReversed().firstOrNull { entry -> entry != requested && entry in tabs }
        ?: tabs.firstOrNull { it != requested }
}

fun normalizeSplitLayout(value: Any?): SplitLayout {
    val raw = value as? Map<*, *> ?: return DEFAULT_SPLIT_LAYOUT
    val ratio = (raw["ratio"] as? Number)?.toDouble() ?: Double.NaN
    val orientation = if (raw["orientation"] == "rows") SplitOrientation.ROWS else SplitOrientation.COLUMNS
    return SplitLayout(clampSplitRatio(ratio), orientation)
}

data class DeskTab(val path: String, val pinned: Boolean = false)

/** Pinned tabs sit first in their existing order; the rest keep theirs. */
fun sortPinnedFirst(tabs: List<DeskTab>): List<DeskTab> {
    if (tabs.none { it.pinned }) return tabs
    return tabs.filter { it.pinned } + tabs.filter { !it.pinned }
}

/**
 * Drop `fromPath` in front of `toPath`, or at the end when `toPath` is null.
 * A pinned tab stays in the pinned block and an unpinned one outside it.
 */
fun reorderTabs(tabs: List<DeskTab>, fromPath: String, toPath: String?): List<DeskTab> {
    val fromIndex = tabs.indexOfFirst { it.path == fromPath }
    if (fromIndex == -1 || fromPath == toPath) return tabs
    val moving = tabs[fromIndex]
    val without = tabs.filter { it.path != fromPath }
    var insertAt = if (toPath == null) without.size else without.indexOfFirst { it.path == toPath }
    if (insertAt == -1) insertAt = without.size
    val target = without.getOrNull(insertAt)
    if (target != null && target.pinned != moving.pinned) return tabs
    if (target == null && without.isNotEmpty() && without.last().pinned != moving.pinned) return tabs
    return without.toMutableList().apply { add(insertAt, moving) }
}

/**
 * Drop a dragged tab before or after another tab.
 * `toPath` null means the end of the strip. A pinned tab cannot leave its block.
 */
fun moveTab(tabs: List<DeskTab>, fromPath: String, toPath: String?, side: String): List<DeskTab> {
    if (toPath == null) return reorderTabs(tabs, fromPath, null)
    if (side == "before") return reorderTabs(tabs, fromPath, toPath)
    val toIndex = tabs.indexOfFirst { it.path == toPath }
    val after = tabs.getOrNull(toIndex + 1)
    val insertBefore = if (after != null && after.path != fromPath) after.path else if (after != null) toPath else null
    return reorderTabs(tabs, fromPath, insertBefore)
}

fun togglePinnedTab(tabs: List<DeskTab>, path: String): List<DeskTab> =
    sortPinnedFirst(tabs.map { tab -> if (tab.path == path) tab.copy(pinned = !tab.pinned) else tab })

/** 1..8 pick that tab, 9 always the last one. */
fun tabIndexForDigit(digit: Int, count: Int): Int? {
    if (count == 0 || digit !in 1..9) return null
    if (digit == 9) return count - 1
    return if (digit <= count) digit - 1 else null
}

/** Tabs to close for "close others" / "close to the right". Pinned tabs stay. */
fun tabsToClose(tabs: List<DeskTab>, anchor: String, scope: String): List<String> {
    val anchorIndex = tabs.indexOfFirst { it.path == anchor }
    if (anchorIndex == -1) return emptyList()
    return tabs.mapIndexedNotNull { index, tab ->
        if (tab.pinned || tab.path == anchor) return@mapIndexedNotNull null
        if (scope == "others" || index > anchorIndex) tab.path else null
    }
}

const val CLOSED_TABS_LIMIT = 20

fun rememberClosedTab(stack: List<String>, path: String): List<String> =
    (listOf(path) + stack.filter { it != path }).take(CLOSED_TABS_LIMIT)

data class WorkspaceMemory(
    val tabs: List<String>,
    val pinned: List<String>,
    val active: String?,
    val split: String?,
)

const val WORKSPACE_STORAGE_PREFIX = "fanotes.workspace.v1:"

fun workspaceStorageKey(vaultPath: String) = WORKSPACE_STORAGE_PREFIX + vaultPath.ifEmpty { "default" }

fun normalizeWorkspaceMemory(value: Any?): WorkspaceMemory? {
    val raw = value as? Map<*, *> ?: return null
    fun strings(list: Any?): List<String> =
        (list as? List<*>)?.mapNotNull { item -> (item as? String)?.takeIf { it.isNotEmpty() } }.orEmpty()
    val tabs = strings(raw["tabs"]).distinct()
    return WorkspaceMemory(
        tabs = tabs,
        pinned = strings(raw["pinned"]).filter { it in tabs },
        active = (raw["active"] as? String)?.takeIf { it in tabs },
        split = (raw["split"] as? String)?.takeIf { it in tabs },
    )
}

/** Forget notes that no longer exist. The split needs two distinct notes. */
fun pruneWorkspaceMemory(memory: WorkspaceMemory, exists: (String) -> Boolean): WorkspaceMemory {
    val tabs = memory.tabs.filter(exists)
    val active = memory.active?.takeIf { it in tabs }
    val split = memory.split?.takeIf { it in tabs && it != active }
    return WorkspaceMemory(tabs, memory.pinned.filter { it in tabs }, active, split)
}

fun workspaceMemoryJson(memory: WorkspaceMemory): String {
    fun strings(values: List<String>) = JsonValue.Arr(values.map(::jsonString).toMutableList())
    return jsonObject(
        "tabs" to strings(memory.tabs),
        "pinned" to strings(memory.pinned),
        "active" to memory.active?.let(::jsonString),
        "split" to memory.split?.let(::jsonString),
    ).stringify()
}

fun parseWorkspaceMemory(text: String): WorkspaceMemory? = runCatching {
    val obj = parseJson(text) as? JsonValue.Obj ?: return@runCatching null
    fun strings(key: String): List<String> =
        obj.array(key)?.items?.mapNotNull { item -> (item as? JsonValue.Str)?.value?.takeIf { it.isNotEmpty() } }.orEmpty()
    val tabs = strings("tabs").distinct()
    WorkspaceMemory(
        tabs = tabs,
        pinned = strings("pinned").filter { it in tabs },
        active = obj.string("active")?.takeIf { it in tabs },
        split = obj.string("split")?.takeIf { it in tabs },
    )
}.getOrNull()

data class SwitcherNote(val path: String, val title: String, val folder: String)

fun switcherNoteFor(path: String): SwitcherNote {
    val parts = path.split('/').filter { it.isNotEmpty() }
    val name = parts.lastOrNull() ?: path
    return SwitcherNote(
        path = path,
        title = name.replace(NOTE_EXTENSION, ""),
        folder = parts.dropLast(1).joinToString(" › "),
    )
}

private val WORD_EDGE = Regex("[\\s\\-_./›(]")
private val switcherCollator: Collator = Collator.getInstance(Locale.GERMAN).apply {
    strength = Collator.PRIMARY
}

private val numberChunk = Regex("\\d+|\\D+")

/** German base collation, with digit runs compared as whole numbers (`numeric: true`). */
private fun compareNatural(left: String, right: String): Int {
    val leftParts = numberChunk.findAll(left).map { it.value }.toList()
    val rightParts = numberChunk.findAll(right).map { it.value }.toList()
    val count = min(leftParts.size, rightParts.size)
    for (index in 0 until count) {
        val a = leftParts[index]
        val b = rightParts[index]
        val compared = if (a.all { it.isDigit() } && b.all { it.isDigit() }) {
            val aValue = a.trimStart('0').ifEmpty { "0" }
            val bValue = b.trimStart('0').ifEmpty { "0" }
            val byLength = aValue.length.compareTo(bValue.length)
            if (byLength != 0) byLength else aValue.compareTo(bValue)
        } else {
            switcherCollator.compare(a, b)
        }
        if (compared != 0) return compared
    }
    return leftParts.size.compareTo(rightParts.size)
}

private fun normalizeForMatch(text: String): String {
    val lower = text.lowercase(Locale.GERMAN)
    val decomposed = Normalizer.normalize(lower, Normalizer.Form.NFD)
    return decomposed.replace(Regex("\\p{M}+"), "")
}

private fun wordStart(haystack: String, at: Int) =
    at == 0 || WORD_EDGE.matches(haystack[at - 1].toString())

/**
 * Subsequence match with a bias for word starts and tight runs. 0 means no match.
 * A title match outranks the same match deep in a folder.
 */
fun fuzzyScore(query: String, text: String): Int {
    val needle = normalizeForMatch(query).replace(Regex("\\s+"), "")
    if (needle.isEmpty()) return 1
    val haystack = normalizeForMatch(text)
    val direct = haystack.indexOf(needle)
    if (direct >= 0) {
        return 1000 - direct * 2 + (if (wordStart(haystack, direct)) 200 else 0) + min(200, needle.length * 20)
    }
    var score = 0
    var position = 0
    var previousHit = -2
    for (char in needle) {
        val at = haystack.indexOf(char, position)
        if (at == -1) return 0
        score += 10 + (if (wordStart(haystack, at)) 25 else 0) + (if (at == previousHit + 1) 15 else 0) - min(8, at - position)
        previousHit = at
        position = at + 1
    }
    return max(1, score)
}

/**
 * Empty query: most recently visited notes, then the rest alphabetically.
 * With a query, the best fuzzy match on the title, then the path, decides.
 */
fun rankSwitcherNotes(
    paths: List<String>,
    query: String,
    recent: List<String> = emptyList(),
    limit: Int = 40,
): List<SwitcherNote> {
    val recency = HashMap<String, Int>()
    recent.forEachIndexed { index, path -> if (path !in recency) recency[path] = index }
    val notes = paths.map(::switcherNoteFor)
    val trimmed = query.trim()
    if (trimmed.isEmpty()) {
        return notes.sortedWith { left, right ->
            val leftRecent = recency[left.path] ?: Int.MAX_VALUE
            val rightRecent = recency[right.path] ?: Int.MAX_VALUE
            if (leftRecent != rightRecent) leftRecent - rightRecent
            else compareNatural(left.title, right.title).takeIf { it != 0 }
                ?: compareNatural(left.path, right.path)
        }.take(limit)
    }
    return notes
        .map { note -> note to max(fuzzyScore(trimmed, note.title) * 2, fuzzyScore(trimmed, note.path)) }
        .filter { (_, score) -> score > 0 }
        .sortedWith { left, right ->
            if (left.second != right.second) right.second - left.second
            else (recency[left.first.path] ?: Int.MAX_VALUE) - (recency[right.first.path] ?: Int.MAX_VALUE)
        }
        .take(limit)
        .map { it.first }
}
