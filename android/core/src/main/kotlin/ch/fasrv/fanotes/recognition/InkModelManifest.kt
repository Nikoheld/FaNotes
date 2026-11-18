package ch.fasrv.fanotes.recognition

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/**
 * The desktop's FaNotes ink recognizer (`fanotes/public/ocr/fanotes-ink`): one ONNX line model and
 * one character language model per language. The tablet downloads these files on demand into app
 * storage instead of shipping ~57 MB in the APK. The manifest itself ships in the APK
 * (`assets/recognition/fanotes-ink-manifest.json`) and pins every file by size and SHA-256, so a
 * download is only used when it is byte-identical to the desktop's model.
 */
const val INK_MANIFEST_FORMAT = "fanotes-ink-recognizer-v1"

/**
 * The repository commit whose `fanotes/public/ocr/fanotes-ink/` matches the pinned manifest. Update
 * it together with the manifest asset when the desktop model changes (`InkModelManifestTest` fails
 * while the two manifests differ).
 */
const val INK_MODEL_COMMIT = "d24ae2d60fcdce02ec92b51704b9dce9a436ff00"
const val INK_MODEL_BASE_URL = "https://raw.githubusercontent.com/Nikoheld/FaNotes/$INK_MODEL_COMMIT/fanotes/public/ocr/fanotes-ink/"

private const val MAX_MODEL_BYTES = 64L * 1024 * 1024
private const val MAX_LM_BYTES = 24L * 1024 * 1024
private val SHA256 = Regex("^[a-f0-9]{64}$")
private val FILE_NAME = Regex("^[a-z0-9][a-z0-9._-]*$")

data class InkModelFile(val role: String, val file: String, val size: Long, val sha256: String)

data class InkModelManifest(
    val name: String,
    val version: String,
    val model: InkModelFile,
    val languageModels: List<InkModelFile>,
) {
    val files: List<InkModelFile> get() = listOf(model) + languageModels
    val totalBytes: Long get() = files.sumOf { it.size }
}

class InkManifestException(message: String) : IllegalArgumentException(message)

private fun descriptor(role: String, value: JsonValue.Obj?, maximum: Long): InkModelFile? {
    value ?: return null
    val file = value.string("file") ?: return null
    val size = value.double("size") ?: return null
    val sha = value.string("sha256") ?: return null
    if (!FILE_NAME.matches(file) || !SHA256.matches(sha)) return null
    if (size <= 0 || size > maximum || size != Math.floor(size)) return null
    return InkModelFile(role, file, size.toLong(), sha)
}

/** `isInkManifest` in `inkRecognition.ts`, plus the parsed file list. */
fun parseInkModelManifest(text: String): InkModelManifest {
    if (text.isEmpty() || text.length > 64 * 1024) throw InkManifestException("Das Handschriftmodell-Manifest ist beschädigt.")
    val root = runCatching { parseJson(text) as? JsonValue.Obj }.getOrNull()
        ?: throw InkManifestException("Das Handschriftmodell-Manifest ist ungültig.")
    val alphabet = root.string("alphabet")
    val classes = root.double("classes")
    val decoder = root.obj("decoder")
    val valid = root.string("format") == INK_MANIFEST_FORMAT &&
        root.string("name") != null &&
        root.string("version") != null &&
        alphabet != null && classes != null &&
        alphabet.codePointCount(0, alphabet.length) + 1 == classes.toInt() &&
        root.double("height") == 64.0 &&
        root.double("frameStride") == 4.0 &&
        root.double("featureDim") != null &&
        decoder != null &&
        listOf("lmWeight", "wordBonus", "unknownWordPenalty", "insertionBonus", "beamWidth").all { decoder.double(it)?.isFinite() == true }
    val model = descriptor("model", root.obj("models")?.obj("desktop"), MAX_MODEL_BYTES)
    val de = descriptor("de", root.obj("languageModels")?.obj("de"), MAX_LM_BYTES)
    val en = descriptor("en", root.obj("languageModels")?.obj("en"), MAX_LM_BYTES)
    if (!valid || model == null || de == null || en == null) throw InkManifestException("Das Handschriftmodell-Manifest ist ungültig.")
    return InkModelManifest(root.string("name")!!, root.string("version")!!, model, listOf(de, en))
}

fun sha256Of(input: InputStream): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(64 * 1024)
    while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

/** A file in [directory] counts only when its size and digest match the manifest. */
fun inkModelFileValid(directory: File, entry: InkModelFile, checkDigest: Boolean = true): Boolean {
    val file = File(directory, entry.file)
    if (!file.isFile || file.length() != entry.size) return false
    return !checkDigest || file.inputStream().use(::sha256Of) == entry.sha256
}

/** Download state of the on-demand model, shown in the settings card. */
sealed class InkModelState {
    data object Missing : InkModelState()
    data class Downloading(val bytes: Long, val total: Long) : InkModelState() {
        val percent: Int get() = if (total <= 0) 0 else ((bytes * 100) / total).toInt().coerceIn(0, 100)
    }
    data object Verifying : InkModelState()
    data class Installed(val version: String, val bytes: Long) : InkModelState()
    data class Failed(val message: String) : InkModelState()
}

/** `1234567` → `1.2 MB`, the way the settings show file sizes. */
fun megabytes(bytes: Long): String = "%.1f MB".format(java.util.Locale.ROOT, bytes / 1_048_576.0)
