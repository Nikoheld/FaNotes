package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson

/**
 * Android release choice using the desktop version order from
 * `fanotes/electron/releaseVersion.cjs`. Same triple: beta, then stable, then nightly.
 * A later patch beats every nightly of the previous triple.
 */

private val VERSION_PATTERN = Regex("""^\d+\.\d+\.\d+(?:-beta\.\d+|-nightly\.\d{14}\.[a-f0-9]{7,40})?$""")
private val VERSION_CAPTURE = Regex("""^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+)|-nightly\.(\d{14})\.([a-f0-9]{7,40}))?$""")
private val CHANNEL_RANK = mapOf("beta" to 0, "stable" to 1, "nightly" to 2)

data class ReleaseVersion(
    val numbers: List<Int>,
    val channel: String,
    val pre: Long,
    val sha: String,
)

data class UpdateChannelCopy(val small: String, val description: String, val auto: String)

data class GithubAndroidRelease(val tag: String, val assets: List<String>)

data class AndroidUpdate(val version: String, val fileName: String, val url: String)

fun parseReleaseVersion(value: String): ReleaseVersion? {
    val match = VERSION_CAPTURE.matchEntire(value) ?: return null
    val beta = match.groups[4]?.value
    val nightlyStamp = match.groups[5]?.value
    val sha = match.groups[6]?.value.orEmpty()
    val channel = when {
        beta != null -> "beta"
        nightlyStamp != null -> "nightly"
        else -> "stable"
    }
    return ReleaseVersion(
        numbers = listOf(match.groupValues[1].toInt(), match.groupValues[2].toInt(), match.groupValues[3].toInt()),
        channel = channel,
        pre = when (channel) {
            "beta" -> beta?.toLong() ?: 0L
            "nightly" -> nightlyStamp?.toLong() ?: 0L
            else -> 0L
        },
        sha = if (channel == "nightly") sha else "",
    )
}

fun compareReleaseVersions(left: String, right: String): Int {
    val a = parseReleaseVersion(left) ?: throw IllegalArgumentException("Ungültige Versionsnummer.")
    val b = parseReleaseVersion(right) ?: throw IllegalArgumentException("Ungültige Versionsnummer.")
    for (index in 0..2) {
        if (a.numbers[index] != b.numbers[index]) return a.numbers[index] - b.numbers[index]
    }
    if (a.channel != b.channel) return CHANNEL_RANK.getValue(a.channel) - CHANNEL_RANK.getValue(b.channel)
    if (a.pre != b.pre) return a.pre.compareTo(b.pre)
    if (a.sha == b.sha) return 0
    return if (a.sha < b.sha) -1 else 1
}

fun releaseVersionChannel(version: String): String? = parseReleaseVersion(version)?.channel

fun releaseVisibleOnChannel(version: String, channel: String): Boolean {
    val kind = releaseVersionChannel(version) ?: return false
    return when (channel) {
        "stable" -> kind == "stable"
        "beta" -> kind == "beta" || kind == "stable"
        "nightly" -> kind == "nightly" || kind == "stable"
        else -> false
    }
}

/** A missing or unknown channel is Stable, the same default as the desktop updater. */
fun updateChannelId(raw: String?): String = when (raw) {
    "beta", "nightly" -> raw
    else -> "stable"
}

/** Preference key of the one-time Beta-to-Stable migration marker (value: the version that ran it). */
const val CHANNEL_AUTO_STABLE_KEY = "update-channel-auto-stable"

/**
 * The owner moves every Beta device to Stable again from this stable on: a marker older than
 * this version counts as not done, so the migration runs once more on the first stable at or
 * above it (2026.11.4 or a later one). Same value as desktop `AUTO_STABLE_ROUND`.
 */
const val CHANNEL_AUTO_STABLE_ROUND = "2026.11.4"

/**
 * Migration once per round: a device on Beta that first runs a Stable version moves to Stable,
 * silently. The marker is written even when nothing changes, so a later manual switch back
 * to Beta sticks within the round, also across later stables. Nightly is not beta-like (it
 * only prefers newer stables) and stays unchanged. Returns null when [settings] need no write.
 * The switch never downgrades: updates are only offered when newer than the installed version.
 */
fun migrateBetaToStable(settings: Map<String, String>, installed: String): Map<String, String>? {
    if (releaseVersionChannel(installed) != "stable") return null
    val marker = settings[CHANNEL_AUTO_STABLE_KEY].orEmpty()
    if (marker.isNotEmpty()) {
        val earlierRound = parseReleaseVersion(marker) != null &&
            compareReleaseVersions(installed, CHANNEL_AUTO_STABLE_ROUND) >= 0 &&
            compareReleaseVersions(marker, CHANNEL_AUTO_STABLE_ROUND) < 0
        if (!earlierRound) return null
    }
    val next = settings + (CHANNEL_AUTO_STABLE_KEY to installed)
    return if (settings["update-channel"] == "beta") next + ("update-channel" to "stable") else next
}

fun updateChannelCopy(channel: String): UpdateChannelCopy = when (updateChannelId(channel)) {
    "beta" -> UpdateChannelCopy(
        "Signierter Beta-Kanal",
        "Beta erhält neue Funktionen früher. Vorabversionen können noch Fehler enthalten; der nächste Stable-Stand wird automatisch bevorzugt, sobald er neuer ist.",
        "Prüft beim Öffnen den signierten Beta-Kanal.",
    )
    "nightly" -> UpdateChannelCopy(
        "Signierter Nightly-Kanal",
        "Nightly folgt jedem Commit auf main, auch ohne Stable- oder Beta-Release. Diese Stände können unfertig sein. Ein neuerer Stable-Stand wird automatisch bevorzugt.",
        "Prüft beim Öffnen den signierten Nightly-Kanal.",
    )
    else -> UpdateChannelCopy(
        "Signierter Stable-Kanal",
        "Stable bündelt gründlich geprüfte Änderungen in zwei bis höchstens vier Releases pro Monat.",
        "Prüft beim Öffnen den signierten Stable-Kanal.",
    )
}

fun androidApkFileName(version: String): String {
    if (parseReleaseVersion(version) == null) throw IllegalArgumentException("Ungültige Versionsnummer.")
    return "FaNotes-$version-android.apk"
}

/** Canonical GitHub asset URL. The API download link is not trusted. */
fun androidApkDownloadUrl(version: String): String {
    val file = androidApkFileName(version)
    return "https://github.com/Nikoheld/FaNotes/releases/download/v$version/$file"
}

fun androidReleasesFromGithub(json: String): List<GithubAndroidRelease> {
    if (json.length > 2_000_000) return emptyList()
    val root = runCatching { parseJson(json) }.getOrNull() as? JsonValue.Arr ?: return emptyList()
    return root.items.mapNotNull { item ->
        val obj = item as? JsonValue.Obj ?: return@mapNotNull null
        val tag = obj.string("tag_name") ?: return@mapNotNull null
        val assets = obj.array("assets")?.items.orEmpty().mapNotNull { asset ->
            (asset as? JsonValue.Obj)?.string("name")
        }
        GithubAndroidRelease(tag, assets)
    }
}

/**
 * Newest release on [channel] that is newer than [installed] and publishes an Android APK.
 * Stable never sees a beta. Beta prefers a newer stable over an older beta.
 */
fun chooseAndroidUpdate(installed: String, channel: String, releases: List<GithubAndroidRelease>): AndroidUpdate? {
    val selected = updateChannelId(channel)
    val installedVersion = parseReleaseVersion(installed)
    return releases.mapNotNull { release ->
        val version = release.tag.removePrefix("v")
        if (parseReleaseVersion(version) == null) return@mapNotNull null
        if (!releaseVisibleOnChannel(version, selected)) return@mapNotNull null
        if (installedVersion != null && compareReleaseVersions(version, installed) <= 0) return@mapNotNull null
        val file = androidApkFileName(version)
        if (file !in release.assets) return@mapNotNull null
        AndroidUpdate(version, file, androidApkDownloadUrl(version))
    }.maxWithOrNull { left, right -> compareReleaseVersions(left.version, right.version) }
}
