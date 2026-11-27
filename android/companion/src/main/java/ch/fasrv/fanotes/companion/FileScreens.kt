package ch.fasrv.fanotes.companion

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.BitmapDrawable
import android.media.MediaPlayer
import android.net.Uri
import android.util.Base64
import android.view.Gravity
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.AudioFile
import androidx.compose.material.icons.outlined.BrokenImage
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.VideoFile
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Button
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.StoryFiles
import ch.fasrv.fanotes.vault.VaultFiles
import ch.fasrv.fanotes.vault.extensionOf
import ch.fasrv.fanotes.vault.fileKindOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.File

/** An SVG may be at most this large; a bigger one is not opened. */
const val SVG_MAX_BYTES = 8 * 1024 * 1024

/** The page that shows one vault file (an image, audio, video or story folder) without any note editor. */
@Composable
fun FileViewerScreen(model: CompanionModel) {
    val path = model.filePath
    val context = LocalContext.current
    val kind = path?.let { if (StoryFiles.isStoryFolder(it)) NoteKind.STORY else fileKindOf(it) ?: NoteKind.FILE }
    val name = path?.substringAfterLast('/')?.let { if (kind == NoteKind.STORY) it.replace(Regex("\\.story$", RegexOption.IGNORE_CASE), "") else it }.orEmpty()
    val file = path?.let { model.graph.root.resolve(it) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            ActionIcon(Icons.AutoMirrored.Outlined.ArrowBack, t(R.string.back)) { model.back() }
            Text(name, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(start = 4.dp))
            if (file != null && kind != null && kind != NoteKind.STORY) ActionIcon(Icons.AutoMirrored.Outlined.OpenInNew, t(R.string.open_in_another_app)) { openFileInAnotherApp(context, model.graph.root, file) }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                path == null || file == null || kind == null -> EmptyState(Icons.Outlined.BrokenImage, t(R.string.file_unavailable), t(R.string.file_unavailable_body))
                kind == NoteKind.STORY -> StoryFileView(model, path)
                !file.isFile -> EmptyState(Icons.Outlined.BrokenImage, t(R.string.file_unavailable), t(R.string.file_unavailable_body))
                kind == NoteKind.IMAGE -> ImageFileView(file)
                kind == NoteKind.VIDEO -> VideoFileView(file)
                kind == NoteKind.AUDIO -> AudioFileView(file, name)
                kind == NoteKind.FILE -> Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Icon(Icons.AutoMirrored.Outlined.InsertDriveFile, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(16.dp))
                    Button(onClick = { openFileInAnotherApp(context, model.graph.root, file) }) { Text(t(R.string.open_in_another_app)) }
                }
                else -> EmptyState(Icons.Outlined.BrokenImage, t(R.string.file_unavailable), t(R.string.file_unavailable_body))
            }
        }
    }
}

/**
 * Hands a vault file to another app: a FileProvider address with a read grant for one `ACTION_VIEW`, typed by its extension.
 * Only a file inside the vault [root] is offered.
 */
fun openFileInAnotherApp(context: Context, root: File, file: File) {
    val vault = runCatching { root.canonicalFile }.getOrNull()
    val target = runCatching { file.canonicalFile }.getOrNull()
    if (vault == null || target == null || !target.isFile || !target.path.startsWith(vault.path + File.separator)) {
        android.widget.Toast.makeText(context, t(R.string.could_not_share_that_file), android.widget.Toast.LENGTH_LONG).show()
        return
    }
    try {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", target)
        val mime = VaultFiles.mimeOf(target.name)
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        view.clipData = ClipData.newRawUri(target.name, uri)
        val chooser = Intent.createChooser(view, t(R.string.open_in_another_app)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (context !is android.app.Activity) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(chooser)
    } catch (_: ActivityNotFoundException) {
        android.widget.Toast.makeText(context, t(R.string.no_app_to_open), android.widget.Toast.LENGTH_LONG).show()
    } catch (_: IllegalArgumentException) {
        android.widget.Toast.makeText(context, t(R.string.could_not_share_that_file), android.widget.Toast.LENGTH_LONG).show()
    }
}

// --- Images ---------------------------------------------------------------------------------------------------

/** A decoded still image or an animation, with its size for the zoomable page. */
private class LoadedImage(val bitmap: Bitmap?, val animation: AnimatedImageDrawable?, val width: Int, val height: Int)

private fun loadImage(file: File): LoadedImage? {
    val extension = extensionOf(file.name)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    val sample = imageSampleSize(bounds.outWidth, bounds.outHeight)
    if (extension == ".gif" || extension == ".webp") {
        // ImageDecoder keeps animated GIF and WebP moving.
        val drawable = runCatching {
            ImageDecoder.decodeDrawable(ImageDecoder.createSource(file)) { decoder, info, _ ->
                decoder.setTargetSampleSize(imageSampleSize(info.size.width, info.size.height))
            }
        }.getOrNull()
        if (drawable is AnimatedImageDrawable) return LoadedImage(null, drawable, drawable.intrinsicWidth, drawable.intrinsicHeight)
        if (drawable is BitmapDrawable && drawable.bitmap != null) return LoadedImage(drawable.bitmap, null, drawable.bitmap.width, drawable.bitmap.height)
    }
    val bitmap = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    return LoadedImage(bitmap, null, bitmap.width, bitmap.height)
}

@Composable
fun ImageFileView(file: File) {
    if (extensionOf(file.name) == ".svg") { SvgFileView(file); return }
    val state by produceState<Result<LoadedImage?>?>(null, file.path, file.lastModified()) {
        value = withContext(Dispatchers.IO) {
            try { Result.success(loadImage(file)) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Throwable) { Result.failure(failure) }
        }
    }
    val result = state
    when {
        result == null -> LoadingState()
        result.getOrNull() == null -> EmptyState(Icons.Outlined.BrokenImage, t(R.string.image_unavailable), t(R.string.image_unavailable_body))
        else -> ZoomableImage(result.getOrThrow()!!.let { it.bitmap to it.animation }, result.getOrThrow()!!.width, result.getOrThrow()!!.height)
    }
}

@Composable
private fun ZoomableImage(source: Pair<Bitmap?, AnimatedImageDrawable?>, width: Int, height: Int) {
    val aspect = height.toFloat() / width.coerceAtLeast(1)
    ZoomablePages(listOf(aspect), Modifier.fillMaxSize().background(Color(0xFF14161F)), fit = true) { _, _, _ ->
        val (bitmap, animation) = source
        if (bitmap != null) Image(bitmap.asImageBitmap(), t(R.string.image_label), Modifier.fillMaxSize(), contentScale = ContentScale.FillBounds)
        else if (animation != null) {
            val owner = LocalLifecycleOwner.current
            DisposableEffect(animation, owner) {
                val observer = LifecycleEventObserver { _, event ->
                    if (event == Lifecycle.Event.ON_PAUSE) animation.stop() else if (event == Lifecycle.Event.ON_RESUME) animation.start()
                }
                owner.lifecycle.addObserver(observer)
                onDispose { owner.lifecycle.removeObserver(observer); animation.stop() }
            }
            AndroidView(factory = { context -> ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_XY; setImageDrawable(animation); animation.start() } }, modifier = Modifier.fillMaxSize())
        }
    }
}

/** An SVG in a locked-down WebView: no script, no file or content access, no network. It is drawn as an `<img>`. */
@Composable
fun SvgFileView(file: File) {
    val page by produceState<String?>(null, file.path, file.lastModified()) {
        value = withContext(Dispatchers.IO) {
            if (file.length() > SVG_MAX_BYTES) "" else runCatching { svgPage(file.readBytes()) }.getOrDefault("")
        }
    }
    val html = page
    when {
        html == null -> LoadingState()
        html.isEmpty() -> EmptyState(Icons.Outlined.BrokenImage, t(R.string.image_unavailable), t(R.string.image_unavailable_body))
        else -> AndroidView(
            factory = { context ->
                WebView(context).apply {
                    settings.apply {
                        javaScriptEnabled = false
                        allowFileAccess = false
                        allowContentAccess = false
                        blockNetworkLoads = true
                        blockNetworkImage = true
                        domStorageEnabled = false
                        databaseEnabled = false
                        setGeolocationEnabled(false)
                        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                        setSupportZoom(true)
                        builtInZoomControls = true
                        displayZoomControls = false
                        useWideViewPort = true
                        loadWithOverviewMode = true
                    }
                    setBackgroundColor(android.graphics.Color.WHITE)
                    webViewClient = object : WebViewClient() {
                        // The page is a single data address; nothing else may be loaded or followed.
                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = true
                    }
                    loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
                }
            },
            onRelease = { view -> view.stopLoading(); view.destroy() },
            modifier = Modifier.fillMaxSize(),
        )
    }
}

/** The HTML page around an SVG: the file as a base64 data address in an image, so its own markup never runs as a page. */
internal fun svgPage(bytes: ByteArray): String {
    val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
    return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, user-scalable=yes\">" +
        "<style>html,body{margin:0;background:#fff}img{display:block;max-width:100%;height:auto;margin:0 auto}</style></head>" +
        "<body><img src=\"data:image/svg+xml;base64,$encoded\" alt=\"\"></body></html>"
}

// --- Video ----------------------------------------------------------------------------------------------------

@Composable
fun VideoFileView(file: File) {
    var failed by remember(file.path) { mutableStateOf(false) }
    if (failed) { EmptyState(Icons.Outlined.VideoFile, t(R.string.video_unavailable), t(R.string.media_unavailable_body)); return }
    val owner = LocalLifecycleOwner.current
    var view by remember(file.path) { mutableStateOf<VideoView?>(null) }
    DisposableEffect(owner, view) {
        val target = view
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE) runCatching { target?.pause() } }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    AndroidView(
        factory = { context ->
            FrameLayout(context).apply {
                setBackgroundColor(android.graphics.Color.BLACK)
                val video = VideoView(context)
                addView(video, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER))
                val controller = MediaController(context)
                controller.setAnchorView(this)
                video.setMediaController(controller)
                video.setOnErrorListener { _, _, _ -> failed = true; true }
                runCatching { video.setVideoURI(Uri.fromFile(file)); video.setOnPreparedListener { video.start() } }.onFailure { failed = true }
                view = video
            }
        },
        onRelease = { frame ->
            // Stop playback and let go of the decoder before the view is dropped.
            (frame.getChildAt(0) as? VideoView)?.let { runCatching { it.stopPlayback() }; runCatching { it.setMediaController(null) } }
            view = null
        },
        modifier = Modifier.fillMaxSize(),
    )
}

// --- Audio ----------------------------------------------------------------------------------------------------

private fun formatClock(ms: Int): String {
    val seconds = (ms.coerceAtLeast(0) / 1000)
    return "%d:%02d".format(seconds / 60, seconds % 60)
}

/** The audio player's surface. Stateless, so a screenshot test can drive it. */
@Composable
fun AudioPlayerContent(title: String, playing: Boolean, positionMs: Int, durationMs: Int, onToggle: () -> Unit, onSeek: (Int) -> Unit) {
    Column(Modifier.fillMaxSize().padding(Space.page), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        IconTile(Icons.Outlined.AudioFile, StateTone.Accent, 96.dp)
        Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = Space.lg))
        Spacer(Modifier.height(Space.lg))
        Slider(
            value = positionMs.toFloat().coerceIn(0f, durationMs.coerceAtLeast(1).toFloat()),
            onValueChange = { onSeek(it.toInt()) },
            valueRange = 0f..durationMs.coerceAtLeast(1).toFloat(),
            modifier = Modifier.fillMaxWidth(),
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(formatClock(positionMs), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(formatClock(durationMs), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(Space.md))
        ActionIcon(if (playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, if (playing) t(R.string.pause) else t(R.string.play), onClick = onToggle)
    }
}

@Composable
fun AudioFileView(file: File, title: String) {
    val owner = LocalLifecycleOwner.current
    var player by remember(file.path) { mutableStateOf<MediaPlayer?>(null) }
    var failed by remember(file.path) { mutableStateOf(false) }
    var playing by remember(file.path) { mutableStateOf(false) }
    var position by remember(file.path) { mutableIntStateOf(0) }
    var duration by remember(file.path) { mutableIntStateOf(0) }
    // The player is released when the screen leaves, however playback ended.
    DisposableEffect(file.path) {
        onDispose { player?.let { runCatching { it.reset() }; runCatching { it.release() } }; player = null }
    }
    LaunchedEffect(file.path, file.lastModified()) {
        val prepared = withContext(Dispatchers.IO) {
            val next = MediaPlayer()
            try {
                next.setDataSource(file.path)
                next.prepare()
                next
            } catch (cancelled: CancellationException) {
                runCatching { next.release() }; throw cancelled
            } catch (_: Throwable) {
                runCatching { next.release() }; null
            }
        }
        if (prepared == null) { failed = true; return@LaunchedEffect }
        if (!isActive) { runCatching { prepared.release() }; return@LaunchedEffect }
        prepared.setOnCompletionListener { playing = false; position = 0; runCatching { it.seekTo(0) } }
        prepared.setOnErrorListener { _, _, _ -> failed = true; playing = false; true }
        duration = runCatching { prepared.duration }.getOrDefault(0)
        player = prepared
    }
    DisposableEffect(owner, player) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) { runCatching { player?.pause() }; playing = false }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(playing, player) {
        while (playing && player != null) {
            position = runCatching { player?.currentPosition ?: 0 }.getOrDefault(0)
            delay(250)
        }
    }
    if (failed) { EmptyState(Icons.Outlined.AudioFile, t(R.string.audio_unavailable), t(R.string.media_unavailable_body)); return }
    if (player == null) { LoadingState(); return }
    AudioPlayerContent(title, playing, position, duration,
        onToggle = {
            val active = player ?: return@AudioPlayerContent
            runCatching { if (active.isPlaying) { active.pause(); playing = false } else { active.start(); playing = true } }.onFailure { failed = true }
        },
        onSeek = { target -> position = target; runCatching { player?.seekTo(target) } })
}

// --- Stories --------------------------------------------------------------------------------------------------

@Composable
fun StoryFileView(model: CompanionModel, path: String) {
    val story by produceState<Result<StoryText?>?>(null, path) {
        value = withContext(Dispatchers.IO) {
            try {
                Result.success(readStoryText { relative -> runCatching { StoryFiles.read(model.graph.vault, "$path/$relative") }.getOrNull() })
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Throwable) { Result.failure(failure) }
        }
    }
    val result = story
    when {
        result == null -> LoadingState()
        result.getOrNull() == null -> EmptyState(Icons.AutoMirrored.Outlined.MenuBook, t(R.string.story_unavailable), t(R.string.story_unavailable_body))
        else -> StoryContent(result.getOrThrow()!!)
    }
}

/** The text of a story, read-only, at the reading text size. Public so a screenshot test can feed a synthetic story. */
@Composable
fun StoryContent(story: StoryText, initialZoom: Float? = null) {
    val context = LocalContext.current
    var zoom by remember { mutableFloatStateOf(initialZoom ?: readerTextZoom(context)) }
    Box(Modifier.fillMaxSize().textPinchZoom({ zoom }, { zoom = it }) { saveReaderTextZoom(context, zoom) }) {
        SelectionContainer {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(Space.page), verticalArrangement = Arrangement.spacedBy(10.dp * zoom)) {
                item(key = "banner") { InfoBanner(t(R.string.story_readonly_title), t(R.string.story_readonly_body)) }
                if (story.title.isNotBlank()) item(key = "title") { Text(story.title, style = MaterialTheme.typography.headlineLarge.zoomed(zoom), fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp * zoom)) }
                if (story.subtitle.isNotBlank()) item(key = "subtitle") { Text(story.subtitle, style = MaterialTheme.typography.titleMedium.zoomed(zoom), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                if (story.author.isNotBlank()) item(key = "author") { Text(story.author, style = MaterialTheme.typography.bodyMedium.zoomed(zoom), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                itemsIndexed(story.blocks, key = { index, _ -> "block:$index" }) { _, block -> StoryBlockView(block, zoom) }
                if (story.truncated) item(key = "truncated") { Text(t(R.string.story_truncated), style = MaterialTheme.typography.bodySmall.zoomed(zoom), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                item(key = "end") { Spacer(Modifier.height(72.dp)) }
            }
        }
        ZoomControls(zoom,
            onMinus = { zoom = ReaderZoomMath.step(zoom, false, ReaderZoomMath.TEXT_MIN, ReaderZoomMath.TEXT_MAX).also { saveReaderTextZoom(context, it) } },
            onPlus = { zoom = ReaderZoomMath.step(zoom, true, ReaderZoomMath.TEXT_MIN, ReaderZoomMath.TEXT_MAX).also { saveReaderTextZoom(context, it) } },
            onReset = { zoom = 1f; saveReaderTextZoom(context, 1f) },
            Modifier.align(Alignment.BottomEnd).padding(12.dp), low = ReaderZoomMath.TEXT_MIN, high = ReaderZoomMath.TEXT_MAX)
    }
}

@Composable
private fun StoryBlockView(block: StoryBlock, zoom: Float) {
    val type = MaterialTheme.typography
    when (block.kind) {
        StoryBlockKind.PART -> Text(block.text, style = type.headlineMedium.zoomed(zoom), fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 20.dp * zoom))
        StoryBlockKind.CHAPTER -> Text(block.text, style = type.headlineSmall.zoomed(zoom), fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 16.dp * zoom))
        StoryBlockKind.SCENE -> Text(block.text, style = type.titleMedium.zoomed(zoom), fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp * zoom))
        StoryBlockKind.PARAGRAPH -> when (block.style) {
            "heading" -> Text(block.text, style = type.titleLarge.zoomed(zoom), fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp * zoom))
            "subheading" -> Text(block.text, style = type.titleMedium.zoomed(zoom), fontStyle = FontStyle.Italic)
            "chapter" -> Text(block.text, style = type.headlineSmall.zoomed(zoom), fontWeight = FontWeight.SemiBold)
            "quote", "epigraph", "letter", "poem" -> Text(block.text, style = type.bodyLarge.zoomed(zoom), fontStyle = FontStyle.Italic, modifier = Modifier.padding(start = 16.dp * zoom))
            else -> Text(block.text, style = type.bodyLarge.zoomed(zoom))
        }
    }
}
