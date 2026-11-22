package ch.fasrv.fanotes

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import ch.fasrv.fanotes.desk.ChromeText

/**
 * The screens' `Text` for interface text: the string goes through the UI language (German source, English
 * catalog, Swiss spelling). User data (note titles, file names, tab names) is shown with [VerbatimText] instead.
 * Files of this package use this `Text` in place of `androidx.compose.material3.Text` (same package, no import).
 */
@Composable
fun Text(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = Color.Unspecified,
    fontSize: TextUnit = TextUnit.Unspecified,
    fontStyle: FontStyle? = null,
    fontWeight: FontWeight? = null,
    fontFamily: FontFamily? = null,
    letterSpacing: TextUnit = TextUnit.Unspecified,
    textDecoration: TextDecoration? = null,
    textAlign: TextAlign? = null,
    lineHeight: TextUnit = TextUnit.Unspecified,
    overflow: TextOverflow = TextOverflow.Clip,
    softWrap: Boolean = true,
    maxLines: Int = Int.MAX_VALUE,
    minLines: Int = 1,
    onTextLayout: ((TextLayoutResult) -> Unit)? = null,
    style: TextStyle = androidx.compose.material3.LocalTextStyle.current,
) = androidx.compose.material3.Text(
    text = ChromeText.ui(text), modifier = modifier, color = color, fontSize = fontSize, fontStyle = fontStyle, fontWeight = fontWeight, fontFamily = fontFamily, letterSpacing = letterSpacing, textDecoration = textDecoration, textAlign = textAlign, lineHeight = lineHeight, overflow = overflow, softWrap = softWrap, maxLines = maxLines, minLines = minLines, onTextLayout = onTextLayout ?: {}, style = style,
)

@Composable
fun Text(
    text: AnnotatedString,
    modifier: Modifier = Modifier,
    color: Color = Color.Unspecified,
    fontSize: TextUnit = TextUnit.Unspecified,
    fontStyle: FontStyle? = null,
    fontWeight: FontWeight? = null,
    fontFamily: FontFamily? = null,
    letterSpacing: TextUnit = TextUnit.Unspecified,
    textDecoration: TextDecoration? = null,
    textAlign: TextAlign? = null,
    lineHeight: TextUnit = TextUnit.Unspecified,
    overflow: TextOverflow = TextOverflow.Clip,
    softWrap: Boolean = true,
    maxLines: Int = Int.MAX_VALUE,
    minLines: Int = 1,
    inlineContent: Map<String, androidx.compose.foundation.text.InlineTextContent> = mapOf(),
    onTextLayout: (TextLayoutResult) -> Unit = {},
    style: TextStyle = androidx.compose.material3.LocalTextStyle.current,
) = androidx.compose.material3.Text(
    text = text, modifier = modifier, color = color, fontSize = fontSize, fontStyle = fontStyle, fontWeight = fontWeight, fontFamily = fontFamily, letterSpacing = letterSpacing, textDecoration = textDecoration, textAlign = textAlign, lineHeight = lineHeight, overflow = overflow, softWrap = softWrap, maxLines = maxLines, minLines = minLines, inlineContent = inlineContent, onTextLayout = onTextLayout, style = style,
)

/** User data shown as written: note titles, folder and file names, tab names, event and task text. */
@Composable
fun VerbatimText(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = Color.Unspecified,
    fontSize: TextUnit = TextUnit.Unspecified,
    fontStyle: FontStyle? = null,
    fontWeight: FontWeight? = null,
    fontFamily: FontFamily? = null,
    letterSpacing: TextUnit = TextUnit.Unspecified,
    textDecoration: TextDecoration? = null,
    textAlign: TextAlign? = null,
    lineHeight: TextUnit = TextUnit.Unspecified,
    overflow: TextOverflow = TextOverflow.Clip,
    softWrap: Boolean = true,
    maxLines: Int = Int.MAX_VALUE,
    minLines: Int = 1,
    onTextLayout: ((TextLayoutResult) -> Unit)? = null,
    style: TextStyle = androidx.compose.material3.LocalTextStyle.current,
) = androidx.compose.material3.Text(
    text = text, modifier = modifier, color = color, fontSize = fontSize, fontStyle = fontStyle, fontWeight = fontWeight, fontFamily = fontFamily, letterSpacing = letterSpacing, textDecoration = textDecoration, textAlign = textAlign, lineHeight = lineHeight, overflow = overflow, softWrap = softWrap, maxLines = maxLines, minLines = minLines, onTextLayout = onTextLayout ?: {}, style = style,
)

/** An uppercased interface label: translated first, then upper-cased in the language's own rules. */
fun upperUi(text: String): String =
    ChromeText.ui(text).uppercase(if (ChromeText.language == "en") java.util.Locale.ENGLISH else java.util.Locale.GERMAN)
