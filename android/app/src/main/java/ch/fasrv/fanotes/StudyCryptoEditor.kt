package ch.fasrv.fanotes

import android.graphics.Paint
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.fasrv.fanotes.desk.ChromeText
import ch.fasrv.fanotes.study.crypto.ALPHABET
import ch.fasrv.fanotes.study.crypto.AnswerState
import ch.fasrv.fanotes.study.crypto.BITS
import ch.fasrv.fanotes.study.crypto.CaesarData
import ch.fasrv.fanotes.study.crypto.CaesarMode
import ch.fasrv.fanotes.study.crypto.CellState
import ch.fasrv.fanotes.study.crypto.CryptoData
import ch.fasrv.fanotes.study.crypto.CryptoLimits
import ch.fasrv.fanotes.study.crypto.DhData
import ch.fasrv.fanotes.study.crypto.DhField
import ch.fasrv.fanotes.study.crypto.FieldState
import ch.fasrv.fanotes.study.crypto.FreqData
import ch.fasrv.fanotes.study.crypto.FreqLang
import ch.fasrv.fanotes.study.crypto.FreqRow
import ch.fasrv.fanotes.study.crypto.KeywordPartKind
import ch.fasrv.fanotes.study.crypto.MOD_RULES
import ch.fasrv.fanotes.study.crypto.ModData
import ch.fasrv.fanotes.study.crypto.ModField
import ch.fasrv.fanotes.study.crypto.ModOp
import ch.fasrv.fanotes.study.crypto.PLAIN_ROW
import ch.fasrv.fanotes.study.crypto.VigenereData
import ch.fasrv.fanotes.study.crypto.XorData
import ch.fasrv.fanotes.study.crypto.XorRow
import ch.fasrv.fanotes.study.crypto.applyMap
import ch.fasrv.fanotes.study.crypto.asciiBits
import ch.fasrv.fanotes.study.crypto.cellText
import ch.fasrv.fanotes.study.crypto.checkAlphabet
import ch.fasrv.fanotes.study.crypto.checkAnswer
import ch.fasrv.fanotes.study.crypto.checkBitsRow
import ch.fasrv.fanotes.study.crypto.checkBuilt
import ch.fasrv.fanotes.study.crypto.checkDhField
import ch.fasrv.fanotes.study.crypto.checkModField
import ch.fasrv.fanotes.study.crypto.checkVigenere
import ch.fasrv.fanotes.study.crypto.dhProblems
import ch.fasrv.fanotes.study.crypto.duplicateAssignments
import ch.fasrv.fanotes.study.crypto.emptyBits
import ch.fasrv.fanotes.study.crypto.fitCells
import ch.fasrv.fanotes.study.crypto.frequencyRows
import ch.fasrv.fanotes.study.crypto.hintAnswer
import ch.fasrv.fanotes.study.crypto.hintVigenere
import ch.fasrv.fanotes.study.crypto.insertCodes
import ch.fasrv.fanotes.study.crypto.keywordAlphabet
import ch.fasrv.fanotes.study.crypto.keywordParts
import ch.fasrv.fanotes.study.crypto.modFields
import ch.fasrv.fanotes.study.crypto.modProblem
import ch.fasrv.fanotes.study.crypto.nextOpenVigenere
import ch.fasrv.fanotes.study.crypto.referenceRows
import ch.fasrv.fanotes.study.crypto.secretsAgree
import ch.fasrv.fanotes.study.crypto.setCharAt
import ch.fasrv.fanotes.study.crypto.shiftAlphabet
import ch.fasrv.fanotes.study.crypto.summariseAnswer
import ch.fasrv.fanotes.study.crypto.unusedLetters
import ch.fasrv.fanotes.study.crypto.vigenereLetter
import ch.fasrv.fanotes.study.crypto.vigenereRows
import ch.fasrv.fanotes.study.crypto.xorLetters

/**
 * Editor of a `fanotes-crypto` block for the tablet. The six tools help, they do not solve: the student does every
 * step, a check only marks right or wrong, and a hint reveals exactly one letter. Letters go in through the pad.
 */
@Composable
fun CryptoEditor(data: CryptoData, onChange: (CryptoData) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        SyncField("title", data.title, "Titel", Modifier.fillMaxWidth(), maxChars = CryptoLimits.TITLE) {
            onChange(when (data) {
                is CaesarData -> data.copy(title = it)
                is FreqData -> data.copy(title = it)
                is VigenereData -> data.copy(title = it)
                is XorData -> data.copy(title = it)
                is ModData -> data.copy(title = it)
                is DhData -> data.copy(title = it)
            })
        }
        when (data) {
            is CaesarData -> CaesarTool(data, onChange)
            is FreqData -> FreqTool(data, onChange)
            is VigenereData -> VigenereTool(data, onChange)
            is XorData -> XorTool(data, onChange)
            is ModData -> ModTool(data, onChange)
            is DhData -> DhTool(data, onChange)
        }
    }
}

private fun CellState.verdict() = when (this) { CellState.OK -> CellVerdict.OK; CellState.BAD -> CellVerdict.BAD; CellState.OPEN -> CellVerdict.OPEN }
private fun FieldState.verdict() = when (this) { FieldState.OK -> CellVerdict.OK; FieldState.BAD -> CellVerdict.BAD; FieldState.OPEN -> CellVerdict.OPEN }

private fun digitsOnly(value: String, max: Int = CryptoLimits.NUMBER) = value.filter { it in '0'..'9' }.take(max)

private fun counted(german: String, english: String) = if (ChromeText.language == "en") english else german

// -- Caesar -----------------------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CaesarTool(data: CaesarData, onChange: (CryptoData) -> Unit) {
    var checked by remember { mutableStateOf(false) }
    var builtChecked by remember { mutableStateOf(false) }
    var pick by remember { mutableStateOf<Int?>(null) }
    var note by remember { mutableStateOf("") }
    fun edit(next: CaesarData) {
        checked = false
        builtChecked = false
        note = ""
        onChange(next)
    }
    val given = remember(data.alphabet) { checkAlphabet(data.alphabet) }
    val target = when (data.mode) {
        CaesarMode.SHIFT -> shiftAlphabet(data.shift)
        CaesarMode.ALPHABET -> if (given.ok) given.letters else ""
        CaesarMode.KEYWORD -> keywordAlphabet(data.keyword)
    }
    val builtStates = remember(data.keyword, data.built) { checkBuilt(data.keyword, data.built) }
    val cells = remember(checked, target, data.task, data.answer) { if (checked && target.isNotEmpty()) checkAnswer(data.task, data.answer, target) else emptyList() }
    val summary = summariseAnswer(data.task, cells)

    FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        listOf(CaesarMode.SHIFT to "Verschiebung", CaesarMode.ALPHABET to "Vorgegebenes Alphabet", CaesarMode.KEYWORD to "Schlüsselwort").forEach { (mode, label) ->
            StudyChoice(label, data.mode == mode, { edit(data.copy(mode = mode)) })
        }
    }
    when (data.mode) {
        CaesarMode.SHIFT -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
            ActionButton("−", data.shift > 0) { edit(data.copy(shift = data.shift - 1)) }
            Text(
                counted("Verschiebung um ${data.shift}", "Shift by ${data.shift}"),
                modifier = Modifier.padding(horizontal = 16.dp), fontWeight = FontWeight.SemiBold,
            )
            ActionButton("+", data.shift < 25) { edit(data.copy(shift = data.shift + 1)) }
        }
        CaesarMode.ALPHABET -> {
            SyncField("alphabet", data.alphabet, "Vorgegebenes Geheimalphabet (26 Buchstaben)", Modifier.fillMaxWidth().padding(top = 8.dp), maxChars = CryptoLimits.ALPHABET, mono = true) {
                edit(data.copy(alphabet = it))
            }
            if (data.alphabet.isNotBlank() && !given.ok) {
                val parts = buildList {
                    if (given.invalid.isNotEmpty()) add(counted("Ungültige Zeichen: ${given.invalid.joinToString(" ")}.", "Invalid characters: ${given.invalid.joinToString(" ")}."))
                    if (given.duplicates.isNotEmpty()) add(counted("Mehrfach vorhanden: ${given.duplicates.joinToString(" ")}.", "Repeated: ${given.duplicates.joinToString(" ")}."))
                    if (given.missing.isNotEmpty()) add(counted("Es fehlen: ${given.missing.joinToString(" ")}.", "Missing: ${given.missing.joinToString(" ")}."))
                }
                ErrorText(parts.joinToString(" "))
            }
        }
        CaesarMode.KEYWORD -> {
            SyncField("keyword", data.keyword, "Schlüsselwort", Modifier.fillMaxWidth().padding(top = 8.dp), maxChars = CryptoLimits.KEYWORD) { edit(data.copy(keyword = it)) }
            if (data.keyword.isNotBlank()) {
                Text(
                    buildAnnotatedString {
                        keywordParts(data.keyword).forEach { part ->
                            when (part.kind) {
                                KeywordPartKind.SPACE -> append("  ")
                                KeywordPartKind.REPEAT -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough, color = MaterialTheme.colorScheme.error)) { append(part.ch.uppercaseChar().toString()) }
                                KeywordPartKind.LETTER -> append(part.ch.uppercaseChar().toString())
                            }
                        }
                    },
                    fontSize = 22.sp, fontFamily = FontFamily.Monospace, letterSpacing = 4.sp, modifier = Modifier.padding(vertical = 6.dp),
                )
                Muted("Streiche Leerzeichen und doppelte Buchstaben (durchgestrichen) weg, schreibe das Wort in die Zeile unten und fülle mit den freien Buchstaben weiter, beginnend nach dem letzten Buchstaben des Schlüsselworts.")
                val free = unusedLetters(data.built)
                Text(
                    buildAnnotatedString {
                        ALPHABET.forEach { ch ->
                            withStyle(SpanStyle(fontWeight = if (ch in free) FontWeight.Bold else FontWeight.Normal, color = if (ch in free) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.3f))) { append("$ch ") }
                        }
                    },
                    fontSize = 16.sp, fontFamily = FontFamily.Monospace,
                )
            }
        }
    }

    // The alphabet strip: plain letters over the cipher letters; a tap on a plain letter highlights its pair.
    Box(Modifier.fillMaxWidth().padding(top = 8.dp).horizontalScroll(rememberScrollState())) {
        Column {
            Row {
                PLAIN_ROW.forEachIndexed { index, ch -> PadCell(ch.toString(), selected = pick == index, description = "Klartextbuchstabe $ch") { pick = if (pick == index) null else index } }
            }
            Row {
                for (index in 0 until 26) {
                    if (data.mode == CaesarMode.KEYWORD) {
                        PadCell(
                            cellText(data.built.getOrNull(index)).uppercase(),
                            verdict = if (builtChecked) builtStates[index].verdict() else CellVerdict.OPEN,
                            selected = pick == index,
                            description = "Geheimbuchstabe zu ${PLAIN_ROW[index]}",
                        ) { pick = index }
                    } else {
                        PadCell(target.getOrNull(index)?.toString().orEmpty(), selected = pick == index) { pick = if (pick == index) null else index }
                    }
                }
            }
        }
    }
    if (data.mode == CaesarMode.KEYWORD) {
        val selected = pick
        if (selected != null) {
            Pad(
                ALPHABET,
                dim = ALPHABET.filter { it !in unusedLetters(data.built) }.toSet(),
                onKey = { key ->
                    edit(data.copy(built = setCharAt(data.built, selected, key, 26)))
                    pick = (selected + 1).takeIf { it < 26 }
                },
                onClear = { edit(data.copy(built = setCharAt(data.built, selected, null, 26))) },
            )
        } else Muted("Tippe ein Feld der unteren Zeile an und wähle dann den Buchstaben.")
        Row(verticalAlignment = Alignment.CenterVertically) {
            ActionButton("Alphabet prüfen", data.keyword.isNotBlank()) { builtChecked = true }
            if (builtChecked && builtStates.any { it != CellState.OPEN }) {
                val right = builtStates.count { it == CellState.OK }
                Muted(counted("$right von 26 Feldern stimmen", "$right of 26 cells are right") + if (builtStates.any { it == CellState.BAD }) counted(", die falschen sind rot markiert.", ", the wrong ones are red.") else ".", Modifier.padding(start = 12.dp))
            }
        }
    }

    SyncField("task", data.task, "Aufgabentext (Klartext)", Modifier.fillMaxWidth().padding(top = 8.dp), maxChars = CryptoLimits.TEXT, minLines = 2) { edit(data.copy(task = it)) }
    SyncField("answer", data.answer, "Deine Antwort (Geheimtext, Leerzeichen und Satzzeichen wie im Text)", Modifier.fillMaxWidth().padding(top = 8.dp), mono = true, maxChars = CryptoLimits.ANSWER, minLines = 2) { edit(data.copy(answer = it)) }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
        ActionButton("Prüfen", target.isNotEmpty() && data.task.isNotBlank()) { checked = true }
        ActionButton("Hinweis", target.isNotEmpty() && data.task.isNotBlank()) {
            val hint = hintAnswer(data.task, data.answer, target)
            if (hint == null) {
                note = counted("Es gibt nichts mehr zu verraten: Alle Buchstaben stimmen.", "Nothing left to reveal: every letter is right.")
            } else {
                edit(data.copy(answer = hint.answer))
                note = counted("Ein Buchstabe wurde bei Position ${hint.index + 1} eingesetzt.", "One letter was filled in at position ${hint.index + 1}.")
            }
        }
    }
    if (target.isEmpty()) Muted(if (data.mode == CaesarMode.KEYWORD) "Prüfen und Hinweis brauchen ein Schlüsselwort." else "Prüfen und Hinweis brauchen ein gültiges Alphabet.")
    if (checked && cells.isNotEmpty()) {
        Text(
            buildAnnotatedString {
                cells.forEach { cell ->
                    val color = when (cell.state) {
                        AnswerState.OK -> OkGreen
                        AnswerState.BAD -> MaterialTheme.colorScheme.error
                        else -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
                    }
                    withStyle(SpanStyle(color = color, fontWeight = if (cell.state == AnswerState.BAD) FontWeight.Bold else FontWeight.Normal, textDecoration = if (cell.state == AnswerState.BAD) TextDecoration.Underline else null)) { append(cell.ch.toString()) }
                }
            },
            fontFamily = FontFamily.Monospace, fontSize = 18.sp, modifier = Modifier.padding(top = 8.dp),
        )
        Muted(counted("${summary.ok} richtig, ${summary.bad} falsch, ${summary.open} offen (von ${summary.total} Buchstaben).", "${summary.ok} right, ${summary.bad} wrong, ${summary.open} open (of ${summary.total} letters)."))
    }
    if (note.isNotEmpty()) Muted(note)
}

// -- Frequency analysis -----------------------------------------------------------------------------

@Composable
private fun Bars(rows: List<FreqRow>, max: Double) {
    Column {
        rows.forEach { row ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.height(26.dp)) {
                VerbatimText(row.letter.toString(), fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace, modifier = Modifier.width(22.dp))
                Box(Modifier.weight(1f)) {
                    Box(Modifier.fillMaxWidth(if (max > 0) (row.percent / max).toFloat().coerceIn(0.01f, 1f) else 0.01f).height(12.dp).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.55f)))
                }
                Text("${"%.1f".format(java.util.Locale.ROOT, row.percent)} %" + if (row.count > 0) " · ${row.count}" else "", fontSize = 12.sp, modifier = Modifier.padding(start = 6.dp).width(84.dp))
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FreqTool(data: FreqData, onChange: (CryptoData) -> Unit) {
    var selected by remember { mutableStateOf<Char?>(null) }
    val rows = remember(data.text) { frequencyRows(data.text) }
    val present = rows.filter { it.count > 0 }
    val reference = remember(data.lang) { referenceRows(data.lang) }
    val max = maxOf(1.0, present.maxOfOrNull { it.percent } ?: 0.0, reference.maxOfOrNull { it.percent } ?: 0.0)
    val tokens = remember(data.text, data.map) { applyMap(data.text, data.map) }
    val duplicates = duplicateAssignments(data.map)

    SyncField("freqtext", data.text, "Geheimtext einfügen", Modifier.fillMaxWidth().padding(top = 8.dp), minLines = 4, mono = true, maxChars = CryptoLimits.FREQ_TEXT) { onChange(data.copy(text = it)) }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
        StudyChoice("Deutsch", data.lang == FreqLang.DE, { onChange(data.copy(lang = FreqLang.DE)) })
        StudyChoice("Englisch", data.lang == FreqLang.EN, { onChange(data.copy(lang = FreqLang.EN)) })
    }
    if (present.isNotEmpty()) {
        androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().padding(top = 8.dp)) {
            val side = maxWidth > 560.dp
            val mine: @Composable () -> Unit = { Column { Text(ui("Dein Geheimtext"), fontWeight = FontWeight.SemiBold); Bars(present, max) } }
            val ref: @Composable () -> Unit = { Column { Text(ui(if (data.lang == FreqLang.DE) "Deutsch (Skript)" else "Englisch (Standardwerte)"), fontWeight = FontWeight.SemiBold); Bars(reference, max) } }
            if (side) Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) { Box(Modifier.weight(1f)) { mine() }; Box(Modifier.weight(1f)) { ref() } }
            else Column { mine(); Gap(); ref() }
        }
        SectionTitle("Zuordnung: Geheimbuchstabe → Klartextbuchstabe")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            present.forEach { row ->
                val plain = data.map[row.letter]
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    VerbatimText(row.letter.toString(), fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                    PadCell(
                        plain?.toString().orEmpty(),
                        verdict = if (plain != null && duplicates[plain] != null) CellVerdict.BAD else CellVerdict.OPEN,
                        selected = selected == row.letter,
                        description = "Klartextbuchstabe für ${row.letter}",
                    ) { selected = if (selected == row.letter) null else row.letter }
                }
            }
        }
        val chosen = selected
        if (chosen != null) {
            Muted(counted("Klartextbuchstabe für $chosen:", "Plain letter for $chosen:"))
            Pad(
                ALPHABET.lowercase(),
                dim = data.map.values.toSet(),
                onKey = { key -> onChange(data.copy(map = LinkedHashMap(data.map).also { it[chosen] = key })); selected = present.map { it.letter }.let { l -> l.getOrNull(l.indexOf(chosen) + 1) } },
                onClear = { onChange(data.copy(map = LinkedHashMap(data.map).also { it.remove(chosen) })) },
            )
        }
        duplicates.forEach { (plain, ciphers) ->
            ErrorText(counted("Der Buchstabe „$plain“ ist mehrfach vergeben (${ciphers.joinToString(", ")}). Ein Klartextbuchstabe passt zu genau einem Geheimbuchstaben.", "The letter “$plain” is assigned more than once (${ciphers.joinToString(", ")})."))
        }
        SectionTitle("Text mit deinen Zuordnungen")
        Text(
            buildAnnotatedString {
                tokens.forEach { token ->
                    if (token.plain != null) withStyle(SpanStyle(color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)) { append(token.plain.toString()) }
                    else append(token.ch.toString())
                }
            },
            fontFamily = FontFamily.Monospace, fontSize = 17.sp,
        )
        Muted("Eingesetzte Buchstaben sind farbig, die übrigen bleiben Geheimbuchstaben. Das Werkzeug schlägt nichts vor: Vergleiche die Balken und entscheide selbst.")
    }
}

// -- Vigenère ---------------------------------------------------------------------------------------

private const val SQUARE_CELL = 28

@Composable
private fun VigenereSquare(keyLetter: Char?, plainLetter: Char?, hit: Boolean) {
    val density = LocalDensity.current
    val cell = with(density) { SQUARE_CELL.dp.toPx() }
    val ink = MaterialTheme.colorScheme.onSurface.toArgb()
    val accent = MaterialTheme.colorScheme.primary
    val hScroll = rememberScrollState()
    val vScroll = rememberScrollState()
    LaunchedEffect(keyLetter, plainLetter) {
        if (plainLetter != null) hScroll.animateScrollTo(((plainLetter - 'A' - 2).coerceAtLeast(0) * cell).toInt())
        if (keyLetter != null) vScroll.animateScrollTo(((keyLetter - 'A' - 2).coerceAtLeast(0) * cell).toInt())
    }
    val paint = remember(ink) { Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ink; textAlign = Paint.Align.CENTER; typeface = android.graphics.Typeface.MONOSPACE } }
    Box(Modifier.fillMaxWidth().height(300.dp).horizontalScroll(hScroll).verticalScroll(vScroll)) {
        Canvas(Modifier.size((SQUARE_CELL * 27).dp)) {
            paint.textSize = cell * 0.55f
            for (row in -1 until 26) for (col in -1 until 26) {
                val x = (col + 1) * cell
                val y = (row + 1) * cell
                val rowOn = keyLetter != null && row == keyLetter - 'A'
                val colOn = plainLetter != null && col == plainLetter - 'A'
                if (row >= 0 && col >= 0 && (rowOn || colOn)) drawRect(accent.copy(alpha = if (rowOn && colOn && hit) 0.45f else 0.14f), Offset(x, y), Size(cell, cell))
                if ((row == -1) != (col == -1) && (rowOn || colOn)) drawRect(accent.copy(alpha = 0.3f), Offset(x, y), Size(cell, cell))
                val letter = when {
                    row == -1 && col == -1 -> null
                    row == -1 -> ALPHABET[col]
                    col == -1 -> ALPHABET[row]
                    else -> vigenereLetter(ALPHABET[row], ALPHABET[col])
                } ?: continue
                paint.isFakeBoldText = row == -1 || col == -1 || (rowOn && colOn && hit)
                drawIntoCanvas { it.nativeCanvas.drawText(letter.toString(), x + cell / 2, y + cell * 0.7f, paint) }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun VigenereTool(data: VigenereData, onChange: (CryptoData) -> Unit) {
    var checked by remember { mutableStateOf(false) }
    var focus by remember { mutableStateOf<Int?>(null) }
    val rows = remember(data.key, data.plain) { vigenereRows(data.key, data.plain) }
    val states = remember(checked, rows, data.answer) { if (checked) checkVigenere(rows, data.answer) else emptyList() }
    fun edit(next: VigenereData) { checked = false; onChange(next) }
    val at = focus?.takeIf { it < rows.plain.length }
    val entered = at != null && cellText(data.answer.getOrNull(at)).isNotEmpty()

    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
        SyncField("vkey", data.key, "Schlüssel", Modifier.weight(1f), maxChars = CryptoLimits.KEY) { edit(data.copy(key = it)) }
        SyncField("vplain", data.plain, "Klartext (ohne Leerzeichen)", Modifier.weight(2f), maxChars = CryptoLimits.TEXT) { edit(data.copy(plain = it)) }
    }
    Muted("Suche die Zeile des Schlüsselbuchstabens und die Spalte des Klartextbuchstabens. Der Geheimbuchstabe steht dort, wo sie sich treffen.")
    VigenereSquare(at?.let { rows.key.getOrNull(it) }, at?.let { rows.plain.getOrNull(it) }, entered)
    if (rows.plain.isNotEmpty() && rows.key.isNotEmpty()) {
        FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            rows.plain.forEachIndexed { index, ch ->
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    VerbatimText(ch.toString(), fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                    Text(rows.key[index].toString(), fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.primary)
                    PadCell(cellText(data.answer.getOrNull(index)).uppercase(), states.getOrNull(index)?.verdict() ?: CellVerdict.OPEN, focus == index, description = "Geheimtext, Position ${index + 1}") { focus = index }
                }
            }
        }
        val current = focus
        if (current != null && current < rows.plain.length) {
            Pad(
                ALPHABET,
                onKey = { key ->
                    edit(data.copy(answer = setCharAt(data.answer, current, key, rows.plain.length)))
                    focus = (current + 1).takeIf { it < rows.plain.length }
                },
                onClear = { edit(data.copy(answer = setCharAt(data.answer, current, null, rows.plain.length))) },
            )
        } else Muted("Tippe eine Stelle der Geheimtext-Zeile an und wähle den Buchstaben.")
    } else Muted("Gib Schlüssel und Klartext ein.")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        ActionButton("Prüfen", rows.key.isNotEmpty() && rows.plain.isNotEmpty()) { checked = true }
        ActionButton("Hinweis", rows.key.isNotEmpty() && rows.plain.isNotEmpty()) {
            val index = at ?: nextOpenVigenere(rows, data.answer)
            if (index >= 0) {
                focus = index
                edit(data.copy(answer = hintVigenere(rows, data.answer, index)))
            }
        }
        if (checked && states.isNotEmpty()) {
            Muted(counted("${states.count { it == CellState.OK }} richtig, ${states.count { it == CellState.BAD }} falsch, ${states.count { it == CellState.OPEN }} offen.", "${states.count { it == CellState.OK }} right, ${states.count { it == CellState.BAD }} wrong, ${states.count { it == CellState.OPEN }} open."))
        }
    }
}

// -- ASCII / XOR ------------------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun XorTool(data: XorData, onChange: (CryptoData) -> Unit) {
    var checked by remember { mutableStateOf(false) }
    var table by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<Triple<XorRow, Int, Int>?>(null) }
    val letters = remember(data.plain, data.key) { xorLetters(data.plain, data.key) }
    val cells = remember(data, letters) { fitCells(ch.fasrv.fanotes.study.crypto.XorCells(data.p, data.k, data.c), letters.plain.length) }
    fun commit(next: ch.fasrv.fanotes.study.crypto.XorCells, plain: String = data.plain, key: String = data.key) {
        checked = false
        onChange(data.copy(plain = plain, key = key, p = next.p, k = next.k, c = next.c))
    }
    fun edit(plain: String, key: String) {
        val next = xorLetters(plain, key)
        commit(fitCells(cells, next.plain.length), plain, key)
    }
    val rowsSpec = listOf(XorRow.P to "Klartext (ASCII)", XorRow.K to "Schlüssel (ASCII)", XorRow.C to "Geheimtext")

    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
        SyncField("xplain", data.plain, "Klartext (Grossbuchstaben)", Modifier.weight(1f), maxChars = CryptoLimits.TEXT) { edit(it, data.key) }
        SyncField("xkey", data.key, "Schlüssel", Modifier.weight(1f), maxChars = CryptoLimits.KEY) { edit(data.plain, it) }
    }
    Muted(counted("XOR bitweise: gleich → 0, verschieden → 1. Der Schlüssel wird über den Klartext wiederholt. Es werden höchstens ${CryptoLimits.ROWS} Buchstaben bearbeitet.", "XOR bit by bit: equal → 0, different → 1. At most ${CryptoLimits.ROWS} letters."))
    ActionButton(if (table) "ASCII-Tabelle ausblenden" else "ASCII-Tabelle A bis Z (7 Bit)") { table = !table }
    if (table) {
        FlowRow(Modifier.padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            ALPHABET.forEach { ch -> Text("$ch ${asciiBits(ch)}", fontFamily = FontFamily.Monospace, fontSize = 14.sp) }
        }
    }
    if (letters.plain.isNotEmpty() && letters.key.isNotEmpty()) {
        FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            letters.plain.forEachIndexed { index, ch ->
                Column(Modifier.padding(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        VerbatimText(ch.toString(), fontWeight = FontWeight.Bold, fontSize = 18.sp, fontFamily = FontFamily.Monospace)
                        Text("  ⊕  ${letters.key[index]}", fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.primary)
                    }
                    rowsSpec.forEach { (row, label) ->
                        val states = if (checked) checkBitsRow(letters, cells, row, index) else emptyList()
                        Text(label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                        Row {
                            for (bit in 0 until BITS) {
                                PadCell(
                                    cellText(cells[row].getOrNull(index)?.getOrNull(bit)),
                                    states.getOrNull(bit)?.verdict() ?: CellVerdict.OPEN,
                                    selected?.let { it.first == row && it.second == index && it.third == bit } == true,
                                    description = "$label, Bit ${bit + 1}",
                                ) { selected = Triple(row, index, bit) }
                            }
                        }
                    }
                }
            }
        }
        val current = selected
        if (current != null && current.second < letters.plain.length) {
            Pad(
                "01",
                onKey = { key ->
                    val (row, index, bit) = current
                    val list = cells[row].toMutableList()
                    list[index] = setCharAt(list[index], bit, key, BITS)
                    commit(cells.with(row, list))
                    selected = if (bit + 1 < BITS) Triple(row, index, bit + 1) else current
                },
                onClear = {
                    val (row, index, bit) = current
                    val list = cells[row].toMutableList()
                    list[index] = setCharAt(list[index].ifEmpty { emptyBits() }, bit, null, BITS)
                    commit(cells.with(row, list))
                },
            )
        } else Muted("Tippe ein Bit-Feld an und wähle 0 oder 1.")
    } else Muted("Gib Klartext und Schlüssel ein.")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ActionButton("Prüfen", letters.key.isNotEmpty() && letters.plain.isNotEmpty()) { checked = true }
        ActionButton("Codes einsetzen", letters.key.isNotEmpty() && letters.plain.isNotEmpty()) { commit(insertCodes(letters, cells)) }
    }
    Muted("„Codes einsetzen“ füllt nur die Zeilen Klartext (ASCII) und Schlüssel (ASCII) aus der Tabelle. Den Geheimtext rechnest du selbst.")
}

// -- Modulo -----------------------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ModTool(data: ModData, onChange: (CryptoData) -> Unit) {
    val problem = modProblem(data.op, data.a, data.b, data.m)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
        listOf(ModOp.TIMES to "a · b", ModOp.PLUS to "a + b", ModOp.POWER to "a hoch b").forEach { (op, label) ->
            StudyChoice(label, data.op == op, { onChange(data.copy(op = op, s1 = "", s2 = "", s3 = "", s4 = "")) })
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
        SyncField("ma", data.a, "a", Modifier.weight(1f), numeric = true) { onChange(data.copy(a = digitsOnly(it))) }
        SyncField("mb", data.b, if (data.op == ModOp.POWER) "b (Exponent)" else "b", Modifier.weight(1f), numeric = true) { onChange(data.copy(b = digitsOnly(it))) }
        SyncField("mm", data.m, "m (Modulus)", Modifier.weight(1f), numeric = true) { onChange(data.copy(m = digitsOnly(it))) }
    }
    MOD_RULES.forEach { Text(it, fontFamily = FontFamily.Monospace, fontSize = 13.sp, modifier = Modifier.padding(vertical = 2.dp)) }
    if (data.a.isNotEmpty() && data.b.isNotEmpty() && data.m.isNotEmpty()) {
        val head = if (data.op == ModOp.POWER) "${data.a} hoch ${data.b}" else "${data.a} ${if (data.op == ModOp.TIMES) "·" else "+"} ${data.b}"
        Text("$head mod ${data.m}", fontWeight = FontWeight.Bold, fontSize = 17.sp, modifier = Modifier.padding(vertical = 8.dp))
    }
    if (problem.isNotEmpty()) Muted(problem) else {
        modFields(data.op).forEach { field ->
            val typed = when (field.key) { ModField.S1 -> data.s1; ModField.S2 -> data.s2; ModField.S3 -> data.s3; ModField.S4 -> data.s4 }
            val state = checkModField(data.op, data.a, data.b, data.m, field.key, typed)
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                Text("${ui(field.label)} =", modifier = Modifier.width(180.dp))
                SyncField("m-${field.key.id}", typed, "", Modifier.width(200.dp), numeric = true) {
                    val value = digitsOnly(it, if (field.key == ModField.S3) 400 else CryptoLimits.NUMBER)
                    onChange(when (field.key) { ModField.S1 -> data.copy(s1 = value); ModField.S2 -> data.copy(s2 = value); ModField.S3 -> data.copy(s3 = value); ModField.S4 -> data.copy(s4 = value) })
                }
                StateMark(state)
            }
        }
    }
}

@Composable
private fun StateMark(state: FieldState) {
    if (state == FieldState.OPEN) return
    Text(
        if (state == FieldState.OK) "✓ richtig" else "✗ falsch",
        color = if (state == FieldState.OK) OkGreen else MaterialTheme.colorScheme.error,
        fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 12.dp),
    )
}

// -- Diffie-Hellman ---------------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DhTool(data: DhData, onChange: (CryptoData) -> Unit) {
    val asked = remember { mutableStateMapOf<DhField, Boolean>() }
    val problems = dhProblems(data.y, data.p, data.a, data.b)
    fun edit(next: DhData) { asked.clear(); onChange(next) }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
        SyncField("dy", data.y, "Y (öffentlich, kleiner als P)", Modifier.weight(1f), numeric = true) { edit(data.copy(y = digitsOnly(it))) }
        SyncField("dp", data.p, "P (öffentlich)", Modifier.weight(1f), numeric = true) { edit(data.copy(p = digitsOnly(it))) }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
        SyncField("da", data.a, "A (privat, Alice)", Modifier.weight(1f), numeric = true) { edit(data.copy(a = digitsOnly(it))) }
        SyncField("db", data.b, "B (privat, Bob)", Modifier.weight(1f), numeric = true) { edit(data.copy(b = digitsOnly(it))) }
    }
    if (data.y.isNotEmpty() && data.p.isNotEmpty() && data.a.isNotEmpty() && data.b.isNotEmpty()) problems.forEach { ErrorText(it) }

    @Composable
    fun Step(field: DhField, label: String, value: String, set: (String) -> DhData) {
        val state = if (asked[field] == true) checkDhField(data.y, data.p, data.a, data.b, field, value) else FieldState.OPEN
        Column(Modifier.padding(vertical = 6.dp)) {
            Text(label, fontSize = 13.sp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                SyncField("d-${field.id}", value, "", Modifier.width(180.dp), numeric = true) { asked[field] = false; onChange(set(digitsOnly(it))) }
                Gap(8.dp)
                ActionButton("Prüfen", value.isNotBlank() && problems.isEmpty()) { asked[field] = true }
                StateMark(state)
            }
        }
    }
    androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth()) {
        val side = maxWidth > 640.dp
        val alice: @Composable () -> Unit = {
            Column {
                SectionTitle("Alice")
                Step(DhField.ALPHA, "α = Y hoch A mod P", data.alpha) { data.copy(alpha = it) }
                Step(DhField.SA, "s (Alice) = β hoch A mod P", data.sa) { data.copy(sa = it) }
            }
        }
        val bob: @Composable () -> Unit = {
            Column {
                SectionTitle("Bob")
                Step(DhField.BETA, "β = Y hoch B mod P", data.beta) { data.copy(beta = it) }
                Step(DhField.SB, "s (Bob) = α hoch B mod P", data.sb) { data.copy(sb = it) }
            }
        }
        if (side) Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) { Box(Modifier.weight(1f)) { alice() }; Box(Modifier.weight(1f)) { bob() } }
        else Column { alice(); bob() }
    }
    Muted("Alice schickt α an Bob, Bob schickt β an Alice. Beide rechnen dann den gemeinsamen Schlüssel s aus: s (Alice) und s (Bob) müssen gleich sein.")
    when (secretsAgree(data.sa, data.sb)) {
        true -> Text(ui("s (Alice) und s (Bob) sind gleich."), color = OkGreen, fontWeight = FontWeight.SemiBold)
        false -> ErrorText("s (Alice) und s (Bob) sind verschieden. Mindestens eine Rechnung enthält einen Fehler.")
        null -> Unit
    }
}
