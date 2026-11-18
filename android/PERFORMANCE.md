# Tablet app performance

Notes on what keeps the FaNotes tablet app (`android/app`, shared `android/core`) smooth, what was changed for
that, and how to measure it on a device. Kanti+ (`android/companion`) is not covered here.

## Pen ink

The paper is one hardware-accelerated `View` (`InkSurfaceView`). The input side was already in good shape:
stylus events ask for unbuffered dispatch (`requestUnbufferedDispatch`), every historical sample of a move
event is used, Android 14+ adds one predicted sample (`MotionPredictor`), and Android 15+ asks for 120 Hz.
Committed ink is rasterized into page tiles (`TILE_PAGE` page px, at the highest zoom seen), so a frame only
redraws the stroke under the pen on top of cached bitmaps.

What changed:

- **Live stroke in chunks** (`LiveInkLayers.kt`, `ink/LiveInk.kt`). A pressure brush (the default pen,
  pencil, brush, watercolour, highlighter with pressure) paints one short path per sample and pass. The live
  stroke used to be repainted whole every frame: a 2 s pencil line at 240 Hz is ~480 samples × 3 passes,
  about 1,400 `drawPath` calls per frame, rising with the stroke. Segments whose samples are final (segment
  `i` reads samples `i - 2 .. i + 1`) are now recorded once, 32 at a time, into a `RenderNode` that renders
  into its own GPU layer. Each frame composites those layers and repaints only the open tail (≤ 33 segments
  plus the predicted one), so the cost per frame no longer grows with the stroke. The geometry comes from
  `pencilGrainSegmentRange`, which is the same arithmetic as `pencilGrainSegments` (a unit test checks that
  slices equal the whole). Chunks sit at whole-pixel positions, so compositing does not resample. A change of
  zoom, pan, page size, style, a snapped shape or a regrown page drops the chunks and rebuilds them.
  Rotated sheets, software canvases, marker, calligraphy, spray and pressure-off strokes keep the old path.
  The committed stroke is still painted whole into the tiles, so the ink after lifting is unchanged. One
  visible difference is possible only while the pen is down: where two chunks meet, the thin grain passes of
  the pencil are stacked per chunk rather than per stroke. `LIVE_INK_LAYERS_ENABLED` switches it off.
- **No sample-list copy per sample** (`InkSession`). `livePoints + sample` copied every sample before it
  for each new one (O(n²) per stroke, ~2 MB of garbage for a long line). The live stroke now appends to one
  buffer; a restart, snap, page regrow or the end of the stroke starts a new one, so a committed stroke's
  list never changes. The live stroke plus its predicted samples is a `JoinedList` view instead of a copy.
- **Pen lift does not re-rasterize the tiles under it** (`paintIntoTiles`). Lifting the pen dropped every
  tile the stroke touched and rebuilt each one from all strokes of the page on the next frame; on a dense page
  that is a visible hitch at every lift. A tile holds the strokes before it in document order, so the new last
  stroke is painted on top of the existing tiles instead; the pixels are the same as a fresh raster.
- **Tile tests use cached stroke bounds** (`StrokeBoundsCache`, `boundsNearTile`). Building a tile walked
  every sample of every stroke of the page. It now checks one cached box per stroke; boxes are reused for
  strokes an edit did not touch. The box test also includes a stroke that only crosses a tile between two far
  apart samples (a snapped straight line), which the per-sample test could miss.
- **Empty tiles have no bitmap.** A tile no stroke reaches is remembered without allocating a bitmap
  (480×480 ARGB at 2.5× zoom is ~0.9 MB) or uploading a texture. A mostly empty page now holds only the
  tiles that have ink.
- **Smaller per-frame and per-event allocations**: stroke colours are parsed once instead of per stroke and
  frame; the shape-snap brush list is a constant instead of a set per move event; the bug-report pen log
  (`BugReportLog.penSampleDue`) is checked before an event is built, where it used to copy its whole
  buffer (up to 900 events) on every pen move.

## Notes and PDFs

- **PDF notes show their first page at once** (`FaNotesViewModel.loadPdfBackdrop`). Every page (up to 40)
  was rendered at 1200 px before anything was shown, which took seconds on a long PDF, and opening the note
  (autosave state, the trail, the timer) waited for it. Pages now appear as they are drawn (pages 1 and 2 at
  once, then in batches of four), opening continues after the first page, and the rest renders in the
  background. A newer load (another note, a sheet attached) cancels the old render and frees its unshown
  bitmaps; an older render can no longer replace a newer note's pages. Sizes, layout and the blank-PDF page
  height are the same as before.
- **The PDF thumbnail strip is lazy** (`PdfThumbStrip`): a page change recomposes only the visible
  thumbnails, not all 80.

## Build

- **R8 for release** (`app/build.gradle.kts`, `app/proguard-rules.pro`). The release APK was not shrunk:
  all of Compose, `material-icons-extended`, OkHttp and coroutines shipped unoptimized. R8 removes unused
  library code and optimizes the rest, which shortens start-up and makes Compose faster (Compose is designed
  to run R8-optimized). The app's own classes are kept as written, with the same rules Kanti+ releases with,
  so manifest entries, WebView bridges, WorkManager and stack traces in bug reports are unaffected.
  `-Pfanotes.minify=false` builds the release without R8.
- **Baseline profile** (`app/src/main/baseline-prof.txt`, `androidx.profileinstaller`). Rules for start-up,
  opening a note, the pen path and the core ink, tile, note-parsing and storage code. The release build
  compiles them into the APK and ProfileInstaller applies them on first start (also for APKs installed by the
  in-app updater), so those paths run compiled instead of interpreted until the JIT warms up. Compose and
  AndroidX add their own profiles.

`android:hardwareAccelerated` was already on. The Kotlin 2.2 Compose compiler has strong skipping on by
default, so unstable list parameters already skip when the same instance is passed again.

## Not changed yet

- **Front-buffered ink.** `androidx.graphics:graphics-core` (`CanvasFrontBufferedRenderer`) would draw the
  live stroke straight into the front buffer and cut one to two frames of latency. It needs a new dependency
  (not in the offline build cache) and a separate `SurfaceView` layer over the page; worth doing next, behind
  a setting.
- **Caching the page under the live stroke.** During a pen stroke the paper, ruling, PDF pages, Markdown
  text and committed tiles are re-recorded every frame although they do not change. Recording them once per
  stroke into a `RenderNode` (with a layer while the pen is down) would leave only the live stroke per frame.
  It needs every state change of the view to mark that cache dirty, so it was left for a change that can be
  tested on a device. Dirty-rectangle invalidation does not help here: hardware rendering redraws the whole
  view either way.
- **Moving a selection** drops all tiles on every move event and re-rasterizes the visible page each frame.
  Drawing the selected strokes live and leaving them out of the tiles during the drag would fix it.
- **PDF memory.** All pages stay in memory as 1200 px ARGB bitmaps (~8 MB per A4 page, up to 40 pages).
  Rendering only the pages near the viewport, with an LRU, would cap that.
- **Opening a note** still reads every note of the vault in the background for backlinks (and again for the
  tag index). It is off the main thread but competes with the note's own reads on SAF; an index cached by
  modification time would avoid it.
- **`FaNotesScreen` collects ~50 flows at its root**, so a keystroke (`markdown`) or a save phase change
  recomposes that whole function; children skip when their inputs are unchanged. Moving the fast-changing
  reads into the composables that use them would narrow it.
- `onPause` blocks the main thread for up to 4 s to save. That is deliberate (no lost ink), but a slow SAF
  provider can make leaving the app feel stuck.

## Measuring on a device

Use a release build (`./gradlew :app:assembleRelease`, R8 and the baseline profile only apply there) on the
actual tablet, with "Profile HWUI rendering" off.

Frame timing while writing or scrolling:

```sh
adb shell dumpsys gfxinfo ch.fasrv.fanotes reset
# write a long pencil stroke / scroll a PDF for ~10 s
adb shell dumpsys gfxinfo ch.fasrv.fanotes framestats   # per-frame timings
adb shell dumpsys gfxinfo ch.fasrv.fanotes | grep -E "Janky|percentile"
```

Compare `Janky frames` and the 90th/95th/99th percentiles before and after, with the same stroke (e.g. a
spiral filling the page with the pencil, then the default pen) and the same note.

Perfetto (system trace with `gfx`, `view`, `input`, `sched` categories):

```sh
adb shell perfetto -o /data/misc/perfetto-traces/ink.pftrace -t 15s gfx view input sched freq
adb pull /data/misc/perfetto-traces/ink.pftrace
```

Open it in ui.perfetto.dev and look at the app's `Choreographer#doFrame` / `draw` slices on the main
thread and `DrawFrames` on the RenderThread during a long stroke: they should stay flat instead of growing
with the stroke length. Pen lift should no longer show a long `draw` with tile rasterization. For a PDF
note, the time from tapping it to the first page is the gap to the first `DrawFrames` showing the page.

Start-up and the baseline profile:

```sh
adb shell am force-stop ch.fasrv.fanotes
adb shell am start -W -n ch.fasrv.fanotes/.MainActivity        # TotalTime, cold start
adb shell cmd package compile -f -m speed-profile ch.fasrv.fanotes   # apply the profile immediately
adb shell dumpsys package dexopt | grep -A2 ch.fasrv.fanotes   # status should be speed-profile
```

For repeatable numbers, a Macrobenchmark module (`androidx.benchmark:benchmark-macro-junit4`) with
`StartupTimingMetric` for a cold start, `FrameTimingMetric` for a scripted stylus stroke
(`UiDevice.swipe` with many steps on the page) and a PDF-open scenario would give before/after numbers in
CI on a device; the same module can generate the baseline profile with `BaselineProfileRule` instead of the
hand-written rules.
