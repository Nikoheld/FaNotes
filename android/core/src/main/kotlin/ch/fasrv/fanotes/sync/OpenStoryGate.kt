package ch.fasrv.fanotes.sync

/**
 * Sync and the story open in the writing mode (the Kotlin side of fanotes/src/writing/liveSync.ts).
 *
 * While a story is open, sync may write its scenes and `story.json` only while the editor has
 * nothing unsaved and is not saving. The editor pushes that state ([report]); Kotlin cannot ask
 * the WebView synchronously. Until the first report, after [reset], and for every other file of the
 * story (bible, progress, snapshots, recovery) the file counts as busy until the story is closed.
 */
class OpenStoryGate(val path: String) {
    /** null = the editor has not reported yet (or the page reloaded): everything waits. */
    @Volatile private var editorBusy: Boolean? = null

    fun report(busy: Boolean) { editorBusy = busy }

    fun reset() { editorBusy = null }

    /** Must sync leave [filePath] (vault path) alone right now? */
    fun isBusy(filePath: String): Boolean {
        if (!filePath.startsWith("$path/")) return false
        val relative = filePath.substring(path.length + 1)
        if (!isLiveStoryFile(relative)) return true
        return editorBusy != false
    }

    /** The files of this story among [written] that the editor merges live, relative to the story folder. */
    fun liveFiles(written: Collection<String>): List<String> =
        written.filter { it.startsWith("$path/") }.map { it.substring(path.length + 1) }.filter(::isLiveStoryFile).distinct()

    companion object {
        private val SCENE = Regex("^scenes/[0-9a-z]{6,40}\\.json$")

        fun isLiveStoryFile(relative: String): Boolean = relative == "story.json" || SCENE.matches(relative)
    }
}
