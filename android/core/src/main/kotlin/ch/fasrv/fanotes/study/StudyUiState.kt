package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonBool
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify

/**
 * Transient state of the "Lernen" tools that has to survive a configuration change (rotation, font
 * scale, dark mode) and process death: the open tool and selection, the stamp and colour choices, measure
 * points still being collected, a crop rectangle that is not confirmed yet and the label editor with the
 * text typed so far. Committed annotations are not part of it, they live in the note.
 *
 * The state travels as one JSON string, so the activity can keep it in its saved instance state. Reading
 * is defensive: a stale, truncated or hand-edited value yields null or clamped fields, never a crash.
 */
const val STUDY_DEFAULT_STAMP = "gain"
const val STUDY_DEFAULT_LABEL_COLOR = "#1d4ed8"
const val STUDY_DEFAULT_BRANCH_COLOR = "#facc15"
const val STUDY_DEFAULT_BRANCH_WIDTH = 18.0
const val STUDY_BRANCH_WIDTH_MIN = 2.0
const val STUDY_BRANCH_WIDTH_MAX = 60.0

/** Longest text a study editor accepts (the word bank); the callout and legend editors are shorter. */
const val STUDY_DIALOG_TEXT_MAX = 4000

/** Which editor the dialog is. */
enum class StudyDialogKind { CALLOUT, LEGEND_ROW, TERMS }

/**
 * The label editor that is open. [id] is the callout or legend, [key] the legend row, [text] what was typed
 * so far. The word bank editor has neither an id nor a key.
 */
data class StudyDialogState(val kind: StudyDialogKind, val id: String = "", val key: String = "", val text: String = "")

data class StudyUiState(
    val tool: StudyTool? = null,
    val selectedId: String? = null,
    val stampId: String = STUDY_DEFAULT_STAMP,
    val numbered: Boolean = false,
    val labelColor: String = STUDY_DEFAULT_LABEL_COLOR,
    val branchColor: String = STUDY_DEFAULT_BRANCH_COLOR,
    val branchWidth: Double = STUDY_DEFAULT_BRANCH_WIDTH,
    val pending: StudyPending? = null,
    val crop: StudyCrop? = null,
    val dialog: StudyDialogState? = null,
)

private val STATE_ID_RE = Regex("^[a-zA-Z0-9._-]{1,96}$")
private val STATE_COLOR_RE = Regex("^#[0-9a-fA-F]{6}$")

private fun pointJson(p: SPoint): JsonValue = jsonArray(jsonNumber(p.x), jsonNumber(p.y))

private fun finite(value: Double) = !value.isNaN() && !value.isInfinite()

/** The state as JSON text; the inverse of [decodeStudyUiState]. */
fun StudyUiState.encode(): String = jsonObject(
    "tool" to tool?.let { jsonString(it.name) },
    "selected" to selectedId?.let { jsonString(it) },
    "stamp" to jsonString(stampId),
    "numbered" to jsonBool(numbered),
    "labelColor" to jsonString(labelColor),
    "branchColor" to jsonString(branchColor),
    "branchWidth" to jsonNumber(branchWidth),
    "pending" to pending?.let {
        jsonObject(
            "tool" to jsonString(it.tool.name),
            "page" to jsonNumber(it.page.toDouble()),
            "pts" to JsonValue.Arr(it.pts.mapTo(mutableListOf<JsonValue>()) { p -> pointJson(p) }),
        )
    },
    "crop" to crop?.let {
        jsonObject(
            "page" to jsonNumber(it.page.toDouble()),
            "rect" to jsonArray(jsonNumber(it.rect.l), jsonNumber(it.rect.t), jsonNumber(it.rect.r), jsonNumber(it.rect.b)),
        )
    },
    "dialog" to dialog?.let {
        jsonObject(
            "kind" to jsonString(it.kind.name),
            "id" to jsonString(it.id),
            "key" to jsonString(it.key),
            "text" to jsonString(it.text),
        )
    },
).stringify()

private fun toolOf(name: String?): StudyTool? = StudyTool.entries.firstOrNull { it.name == name }

private fun colorOf(value: String?, fallback: String): String =
    if (value != null && STATE_COLOR_RE.matches(value)) value.lowercase() else fallback

private fun idOf(value: String?): String? = value?.takeIf { STATE_ID_RE.matches(it) }

private fun pointOf(value: JsonValue?): SPoint? {
    val items = (value as? JsonValue.Arr)?.items ?: return null
    val x = (items.getOrNull(0) as? JsonValue.Num)?.value ?: return null
    val y = (items.getOrNull(1) as? JsonValue.Num)?.value ?: return null
    if (!finite(x) || !finite(y)) return null
    return SPoint(x.coerceIn(0.0, 1.0), y.coerceIn(0.0, 1.0))
}

private fun pageOf(value: Double?): Int? = value?.takeIf { finite(it) && it >= 1.0 && it <= 100_000.0 }?.toInt()

private fun pendingOf(obj: JsonValue.Obj?): StudyPending? {
    obj ?: return null
    val tool = toolOf(obj.string("tool")) ?: return null
    val needed = measurePointsNeeded(tool)
    val page = pageOf(obj.double("page")) ?: return null
    val pts = (obj.array("pts")?.items ?: return null).map { pointOf(it) ?: return null }
    // A measure with every point is committed at once, so a stored list must be short of that.
    if (needed == 0 || pts.isEmpty() || pts.size >= needed) return null
    return StudyPending(tool, page, pts)
}

private fun cropOf(obj: JsonValue.Obj?): StudyCrop? {
    obj ?: return null
    val page = pageOf(obj.double("page")) ?: return null
    val rect = (obj.array("rect")?.items ?: return null).map { (it as? JsonValue.Num)?.value ?: return null }
    if (rect.size != 4 || rect.any { !finite(it) }) return null
    val clean = cropFromCorners(rect[0], rect[1], rect[2], rect[3])
    return if (cropIsUsable(clean)) StudyCrop(page, clean) else null
}

private fun dialogOf(obj: JsonValue.Obj?): StudyDialogState? {
    obj ?: return null
    val kind = StudyDialogKind.entries.firstOrNull { it.name == obj.string("kind") } ?: return null
    val text = (obj.string("text") ?: "").take(STUDY_DIALOG_TEXT_MAX)
    return when (kind) {
        StudyDialogKind.TERMS -> StudyDialogState(kind, text = text)
        StudyDialogKind.CALLOUT -> StudyDialogState(kind, id = idOf(obj.string("id")) ?: return null, text = text)
        StudyDialogKind.LEGEND_ROW -> {
            val key = obj.string("key")?.takeIf { stampById(it) != null } ?: return null
            StudyDialogState(kind, id = idOf(obj.string("id")) ?: return null, key = key, text = text)
        }
    }
}

/**
 * Reads what [encode] wrote. Null for missing or unreadable text. Unknown tools, stamps, colours and
 * ids fall back to the defaults, numbers are clamped to the page, and a crop or pending list that does not
 * fit the tool that is open is dropped (the tool setter clears both too).
 */
fun decodeStudyUiState(raw: String?): StudyUiState? {
    if (raw.isNullOrBlank()) return null
    val root = try {
        parseJson(raw) as? JsonValue.Obj
    } catch (_: Exception) {
        null
    } ?: return null
    val tool = toolOf(root.string("tool"))
    val width = root.double("branchWidth")?.takeIf { finite(it) }
    val pending = pendingOf(root.obj("pending"))?.takeIf { it.tool == tool }
    val crop = cropOf(root.obj("crop"))?.takeIf { tool == StudyTool.CROP }
    return StudyUiState(
        tool = tool,
        selectedId = idOf(root.string("selected")),
        stampId = root.string("stamp")?.takeIf { stampById(it) != null } ?: STUDY_DEFAULT_STAMP,
        numbered = root.bool("numbered") == true,
        labelColor = colorOf(root.string("labelColor"), STUDY_DEFAULT_LABEL_COLOR),
        branchColor = colorOf(root.string("branchColor"), STUDY_DEFAULT_BRANCH_COLOR),
        branchWidth = (width ?: STUDY_DEFAULT_BRANCH_WIDTH).coerceIn(STUDY_BRANCH_WIDTH_MIN, STUDY_BRANCH_WIDTH_MAX),
        pending = pending,
        crop = crop,
        dialog = dialogOf(root.obj("dialog")),
    )
}
