package ch.fasrv.fanotes.desk

import java.text.Collator
import java.util.Locale

/**
 * Sidebar order from the desktop file tree: folders first, then a German
 * base-letter comparison that treats digit runs as numbers (`Note 2` before
 * `Note 10`).
 */
fun compareVaultEntries(leftFolder: Boolean, leftName: String, rightFolder: Boolean, rightName: String): Int {
    if (leftFolder != rightFolder) return if (leftFolder) -1 else 1
    return compareVaultNames(leftName, rightName)
}

fun compareVaultNames(left: String, right: String): Int {
    val a = vaultNameChunks(left)
    val b = vaultNameChunks(right)
    val count = minOf(a.size, b.size)
    for (index in 0 until count) {
        val cmp = compareVaultChunk(a[index], b[index])
        if (cmp != 0) return cmp
    }
    return a.size.compareTo(b.size)
}

private val treeCollator: ThreadLocal<Collator> = ThreadLocal.withInitial {
    Collator.getInstance(Locale.GERMAN).apply { strength = Collator.PRIMARY }
}

private sealed class VaultChunk {
    data class Text(val value: String) : VaultChunk()
    data class Number(val raw: String) : VaultChunk()
}

private fun vaultNameChunks(name: String): List<VaultChunk> {
    if (name.isEmpty()) return emptyList()
    val chunks = mutableListOf<VaultChunk>()
    var index = 0
    while (index < name.length) {
        val digit = name[index].isDigit()
        val start = index
        index++
        while (index < name.length && name[index].isDigit() == digit) index++
        val slice = name.substring(start, index)
        chunks += if (digit) VaultChunk.Number(slice) else VaultChunk.Text(slice)
    }
    return chunks
}

private fun compareVaultChunk(left: VaultChunk, right: VaultChunk): Int = when {
    left is VaultChunk.Number && right is VaultChunk.Number -> compareVaultNumber(left.raw, right.raw)
    left is VaultChunk.Text && right is VaultChunk.Text -> treeCollator.get().compare(left.value, right.value)
    left is VaultChunk.Number -> treeCollator.get().compare(left.raw, (right as VaultChunk.Text).value)
    else -> treeCollator.get().compare((left as VaultChunk.Text).value, (right as VaultChunk.Number).raw)
}

/** Numeric value, so `02` and `2` tie the way `Intl.Collator({ numeric: true })` does. */
private fun compareVaultNumber(left: String, right: String): Int {
    val a = left.trimStart('0').ifEmpty { "0" }
    val b = right.trimStart('0').ifEmpty { "0" }
    val byLength = a.length.compareTo(b.length)
    if (byLength != 0) return byLength
    return a.compareTo(b)
}
