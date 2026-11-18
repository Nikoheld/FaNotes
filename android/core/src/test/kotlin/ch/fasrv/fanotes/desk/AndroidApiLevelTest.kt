package ch.fasrv.fanotes.desk

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * `core` is a JVM module, so Android lint does not check which Java APIs it calls. These calls compile against the
 * JDK but are missing on the tablet app's minSdk 29 (Android 10) and are not backported by D8/R8, so they throw
 * NoSuchMethodError / NoSuchFieldError there. Each has a drop-in that works everywhere.
 */
class AndroidApiLevelTest {
    private val banned = listOf(
        Regex("""Files\.readString\(""") to "Files.readString (API 33+): String(Files.readAllBytes(path), Charsets.UTF_8)",
        Regex("""Files\.writeString\(""") to "Files.writeString (API 33+): Files.write(path, text.toByteArray())",
        Regex("""\bPath\.of\(""") to "Path.of (API 34): Paths.get",
        Regex("""BigInteger\.TWO\b""") to "BigInteger.TWO (API 33): BigInteger.valueOf(2)",
        Regex("""URL(En|De)coder\.(encode|decode)\([^)]*,\s*(Charsets|StandardCharsets)\.""") to "URLEncoder/URLDecoder with a Charset (API 33): pass \"UTF-8\"",
        Regex("""\.sorted\(\)\.toList\(\)""") to "Stream.toList (API 34): collect(Collectors.toList())",
        Regex("""\.readAllBytes\(\)""") to "InputStream.readAllBytes (API 33): readBytes()",
        Regex("""\.transferTo\(""") to "InputStream.transferTo (API 33): copyTo",
    )

    @Test
    fun androidCodeAvoidsJavaApisNewerThanMinSdk() {
        val roots = listOf(File("src/main/kotlin"), File("../app/src/main/java"))
        val found = ArrayList<String>()
        for (root in roots.filter { it.isDirectory }) {
            root.walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach { file ->
                file.readLines().forEachIndexed { index, line ->
                    for ((pattern, hint) in banned) {
                        if (pattern.containsMatchIn(line)) found += "${file.path}:${index + 1}: $hint"
                    }
                }
            }
        }
        assertEquals(emptyList<String>(), found)
    }
}
