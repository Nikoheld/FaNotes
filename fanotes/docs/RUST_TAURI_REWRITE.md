# FaNotes on Rust + Tauri

Incremental rewrite plan. The current app stays the shipping product until each crate has parity with the code it replaces.

This plan is grounded in the tree as of `2026.10.2`: Electron 43 host (`fanotes/electron/main.cjs`, 4,865 lines), React shell (`fanotes/src/App.tsx`, 5,147 lines), paper surface (`fanotes/src/components/DrawingBoard.tsx`, 7,457 lines), shared GlyphenWerk engine (`src/lib/recognition.ts`, 8,330 lines).

## Current architecture

FaNotes is one React UI with two hosts.

| Host | Entry | Storage | Inference |
| --- | --- | --- | --- |
| Desktop | `electron/main.cjs` + `preload.cjs`, `contextIsolation`, sandboxed renderer | Vault directory plus Electron `userData` | PyLaia FP32 in a `worker_threads` helper (`electron/native-ocr-worker.cjs`, 92 lines) via `onnxruntime-node`. TrOCR in a renderer worker via Transformers.js |
| Web/PWA | `createBrowserApi()` in `src/lib/browserApi.ts` | IndexedDB `fanotes-web-vault` | Same UI. PyLaia Q8 + TrOCR Q8 through `onnxruntime-web` 1.22.0 |

Both hosts implement `FaNotesApi` (`src/types.ts`). Desktop-only methods are optional on that interface: native vault picker, `recognizeNativeHandwritingLine`, PosFormer (`crispembed` + GGUF), Qwen vision (Python/OpenVINO), OneNote import, subject-book popout, auto-update, addon network fetch.

### Processes and trust boundary

The renderer has no direct filesystem or arbitrary network access. `preload.cjs` exposes `window.fanotes`. `main.cjs` rejects IPC whose navigation is not the dev server or the packaged `dist/index.html`.

The main process is a monolith that delegates to siblings: `startup-preflight.cjs` (Linux Ozone/Hyprland), `famd.cjs`, `sync.cjs`, `addons.cjs`, `ai-provider.cjs`, `updater.cjs`, `enhanced-math.cjs`, `native-ocr-worker.cjs`. Notes are written with `atomicWrite` (exclusive temp file, `fsync`, `rename`).

Linux always launches Chromium as X11 (`--ozone-platform=x11` in `startup-preflight.cjs` and the AppImage exec line) so the pen and the trackpad share one seat. The window uses the native frame so Hyprland can decorate it. If Hyprland has `force_zero_scaling = true`, the app reads the focused monitor scale from `hyprctl` (override `FANOTES_DEVICE_SCALE`). Vulkan/ANGLE is left off on the native Wayland path.

### Vault and profile

Visible notes are ordinary `.md` / `.markdown` files. A sibling `.famd` carries schema `fanotes-famd-v1`: markdown body, then `<!-- fanotes-famd:v1 chars=N -->`, then JSON (`src/lib/famd.ts`). The payload holds ink, worksheet ids, paper style, note links, backups, and page stats. PDF notes keep the PDF bytes untouched and store markdown plus ink in the `.famd`.

| Path | Contents |
| --- | --- |
| `<note>.md` | User markdown. FAMD trailer stripped on read |
| `<note>.famd` | Sidecar payload. Also the markdown source for PDF notes |
| `.fanotes/assets/<id>.json` + `.png` | Drawing library copy and preview |
| `.fanotes/worksheets/<id>.*` | Imported PDF/image plus field JSON |
| `.fanotes/folder-colors.json`, `subject-books.json` | Folder chrome and subject PDF books |
| `.fanotes/recognition-model.json` | Sync bundle of the personal model, when sync wants it |
| `.fanotes/history/` | Local note history. Excluded from sync scan |

The Electron profile (`~/.config/FaNotes` on Linux, `%APPDATA%\FaNotes` on Windows) holds `config.json` (secrets via `safeStorage`), the Chromium IndexedDB directory, addon files, downloaded PosFormer/Qwen weights, and sync account material. Handwriting samples live in IndexedDB `fanotes-handwriting` (`samples`, `layoutExamples`, `labels` — `src/lib/handwritingDb.ts`, 1,863 lines), not as loose files in the vault.

Sync (`src/lib/sync/engine.ts`) runs in the renderer. The host only supplies confined file bytes and an encrypted secret blob. Add-ons are a JS runtime with a narrow host bridge (`src/lib/addons/`, `electron/addons.cjs`). AI HTTP calls happen in the main process against an allow-list of providers.

### Paper and ink

Stored ink is a `DrawingDocument` (schema version 1, owned by `DrawingBoard.tsx`): page size in CSS px (`sourceWidth`, `sourceHeight`), cumulative origin pad (`sourceOriginX/Y`), and strokes whose `x`/`y` are normalized to that page. A point is `StrokePoint` (`src/types.ts`): `x`, `y`, `t`, `pressure`, `tiltX`, `tiltY`, `pointerType`. Color and brush live on the stroke. The active tool is runtime state and is not saved.

The camera is one CSS `zoom` on `.paper-sheet-plane` plus native `scrollLeft`/`scrollTop` (`src/lib/paperView.ts`). Children must not set their own zoom. The write page starts at 900×1273 CSS px, grows by `WRITE_MARGIN_*` (108×144), and the scroll surface adds `SCROLL_ROOM` (560) on every side (`src/lib/noteCanvas.ts`). Typed text sits in a fixed 820 px column so a Hyprland width change pans the camera instead of reflowing the page.

Stay-put is a pure reducer. `applyStayPutOp` / `liveWriteStayPut` are the closed step: a new origin pad may move paper coordinates; pan, max-edge grow, and the scroll-room overlay must not. Nested CodeMirror scroll is hard-wired to zero (`nestedEditorOffsetOnWritePage`). The 2026.9.15 note in `docs/stay-put-left-pad-scroll-room.md` is the important diagnosis: paper coordinates were already right, and the glyph still slipped until a later canvas mutation. The remaining bug is frame coupling in the Chromium compositor, not the reducer.

Paint is two page-scaled canvases (committed + live) clipped by a vertical window of about three viewports (`src/lib/inkWindowPlan.ts`). Moving that window copies bitmap rows. That cache exists so a 500% zoom does not allocate a page-sized bitmap. It is also a second coordinate system that has to be kept in lockstep with CSS zoom.

Undo stores up to 80 stroke-array snapshots that **share point objects** with the live strokes (`snapshotStrokes`). `forEachTrackedPoint` then mutates live strokes, undo, redo, the in-progress stroke, and section edges together. Collapse/expand clears history because a snapshot would restore hidden ink at a layout position that no longer exists (`docs/INK_SECTIONS.md`).

Pen policy is already pure and battle-tested for Linux Wacom:

- `isInkTipDown` treats pressure `<= 0` on a pen as hover, including a stuck button bit (`src/lib/inkPointerSession.ts`).
- A session ends on a real lift or after `INK_POINTER_IDLE_MS` (1600).
- Mouse and trackpad are ignored for `POST_PEN_IGNORE_MS` (850) after a pen sample (`src/lib/inkPointerPolicy.ts`).
- Samples that leap by `INK_JUMP_DY` 0.08 or `INK_JUMP_HYPOT` 0.12 are dropped (`src/lib/inkSampleMap.ts`).
- Inline pen/touch does not call `setPointerCapture` (Wayland/Hyprland).

### Recognition

Personalization does not fine-tune weights. Samples become geometry and 32×32 raster prototypes (`buildRecognitionModel`). A line is fused from three evidence sources: classical DTW (`src/lib/recognition.ts`), PyLaia CTC, and the personal prototypes (`personalizedTextRecognition.ts`).

PyLaia input is fixed in code: float tensor `[1, 1, 128, W]`, `W` from 32 to 4096, grayscale, inverted relative to the white canvas (`neuralTextRecognition.ts`, `MODEL_HEIGHT`). Desktop ships `pylaia-iam.onnx` FP32 (21,334,652 bytes). The web ships the dynamic Q8 file (5,488,416 bytes). Both are pinned with SHA-256 in `public/ocr/manifest.json`. Thread caps: at most 4 on desktop, 2 on web, `interOpNumThreads: 1`.

TrOCR is a separate renderer worker. Desktop extended mode loads an FP32 encoder (87,433,588 bytes) and a Q8 merged decoder (40,503,785 bytes) from `public/ocr/fanotes-trocr/`. Compact desktop mode is PyLaia only. The web always runs the Q8 encoder/decoder pair.

PosFormer math is a spawned `crispembed` binary over a downloaded GGUF, not ONNX. The symbolic solver is nerdamer inside `mathSolverWorker.ts`. Qwen vision is an optional Python/OpenVINO NPU worker.

Background search transcripts are text stored on the drawing (`searchTranscript`), produced on idle, and never written into the markdown body.

### What is expensive, and what is not

The Electron binary and its GPU/browser processes are the idle cost. The recognition working set is the models: a warm extended session holds the 21 MB PyLaia file plus an 87 MB encoder and a 40 MB decoder, plus activations. Moving the shell from Electron to Tauri removes the bundled Chromium. It does not shrink that model working set. Running ONNX outside the webview heap is the memory win that matters while writing.

The paper bugs are concentrated in `DrawingBoard.tsx` plus `noteCanvas.ts`, `paperView.ts`, and `inkWindowPlan.ts`. The product chrome (tree, settings, themes, calendar, AI, add-ons, CodeMirror, KaTeX, GlyphenWerk iframe) is large and is not the Hyprland problem.

## Recommendation

Keep the React shell. Move the paper camera, the stroke document, and native PyLaia into Rust crates that the current renderer calls first. Adopt Tauri 2 as the desktop host only after those crates have parity. Give the desktop paper plane its own native surface when, and only when, a viewport raster inside the webview still slips under Hyprland.

A full rewrite of the shell in Iced, egui, Slint, or Dioxus would discard the add-on JS runtime, the CodeMirror paper, the GlyphenWerk iframe, and the PWA, which is the same UI (`README.md`). Those toolkits are a good fit for a pen surface and a poor fit for this product shell.

```text
┌──────────────────────────────────────────────────────────┐
│ Host (Electron today, Tauri 2 later, browser for PWA)    │
│  React chrome: tree, settings, calendar, AI, add-ons    │
│  CodeMirror + KaTeX for typed markdown                   │
│  GlyphenWerk iframe                                      │
├──────────────────────────────────────────────────────────┤
│ fanotes-wasm  (wasm-bindgen)                             │
│   paper camera, stroke arena, famd, pen policy,         │
│   line raster, CTC decode, tiny-skia tiles               │
├─────────────── native only ─────────────────────────────┤
│ fanotes-ort   PyLaia via the ort crate, CPU EP           │
│ Tauri commands later: vault, secrets, updater, add-ons   │
│ Optional wgpu/vello paper surface (desktop)             │
└──────────────────────────────────────────────────────────┘
```

The web build keeps `onnxruntime-web` for `session.run`. The `ort` crate links the native ONNX Runtime and is not the web runtime. One Rust CTC decoder consumes both outputs.

## Architecture

### Rust core and TypeScript shell

The boundary that already exists is `FaNotesApi`. Rust should grow under it, not beside a second app.

| Concern | Owner | Why |
| --- | --- | --- |
| Stroke document, undo arena, sections | `fanotes-ink` | Shared by desktop, PWA, and tests. The JS object-identity trick has to become an explicit arena |
| Camera, grow, stay-put reducer | `fanotes-paper` | Already pure in `noteCanvas.ts`. Golden tests exist |
| `.famd` v1 parse and serialize | `fanotes-famd` | Bit-compatible with `parseFamd` / `serializeFamd` |
| Tip-down, idle lift, post-pen ignore, jump filter | `fanotes-input` | Pure functions, host supplies samples |
| Tile raster of `drawInkStroke` | `fanotes-raster` | `tiny-skia`, builds to wasm and native |
| Prototypes, fusion, CTC decode, line tensor | `fanotes-recog` | Portable. No ONNX linked in |
| PyLaia session | `fanotes-ort` | Native only. Replaces `native-ocr-worker.cjs` |
| JS exports | `fanotes-wasm` | The only FFI the renderer needs during the Electron years |
| Chrome, markdown editing, themes, add-on UI | React, unchanged | PWA parity |
| Vault bytes, secrets, updater, AI HTTP, add-on SSRF | Host process | Electron IPC now, Tauri commands later |
| TrOCR generation, nerdamer, pdf.js text layer, Qwen | Stay in their current runtimes | Each is a product of its own |

### Ink model

JavaScript undo works because `snapshotStrokes` copies the stroke array and aliases the point objects, and `forEachTrackedPoint` mutates each `StrokePoint` once. Rust has no aliasing across `Vec` clones. Encode the alias on purpose:

```rust
struct InkDocument {
    points: Vec<StrokePoint>,          // f64, matches JS numbers and golden files
    strokes: SlotMap<StrokeId, Stroke>, // range into `points`, plus color/brush
    sections: Vec<Section>,            // edge points are PointIds, not loose floats
    undo: Vec<UndoFrame>,              // stroke-id lists, cap 80
    redo: Vec<UndoFrame>,
    page: PageExtent,                  // source size + origin pad
}

struct StrokePoint {
    x: f64,
    y: f64,
    t: f64,
    pressure: f32,
    tilt_x: f32,
    tilt_y: f32,
    pointer: PointerKind,
}
```

Grow, origin pad, and rescale walk `points` once. Undo frames hold `StrokeId`s. Editing one stroke copy-on-writes its point range so older frames keep the previous samples. Collapse and expand clear undo and redo, matching `afterSectionChange({ resetHistory: true })`.

Persist the same JSON `DrawingDocument` (schema 1). Accept missing `sections`, `sourceOriginX/Y`, and `overlayQuality`. Refuse a `schemaVersion` other than 1. Hidden section ink stays normalized to the `widthPx`×`heightPx` box captured at collapse time.

### Paper camera

`applyStayPutOp` moves into `fanotes-paper` with the same fields (`StayPutState`, `StayPutOp`) and the same 1e-6 pad-only predicate (`stayPutPaperMovedByPadOnly`). Constants move with it: `SCROLL_ROOM = 560`, write margins 108×144, text column 820, text pad 72.

The reducer stays the source of truth for coordinates. The paint path changes.

Today a page-sized canvas is clipped to a scrolling bitmap window, and CSS `zoom` scales that bitmap in the compositor. Those two updates do not land in one frame, which is the slip described in `docs/stay-put-left-pad-scroll-room.md`.

The replacement paint is a viewport raster:

1. The camera's visible rect is in page coordinates (zoom, scroll, origin pad).
2. `fanotes-raster` paints only that rect into a bitmap of `viewport × device_scale`.
3. The live stroke is the samples since pointer-down, painted on top.
4. Committed ink is a tile cache: 512 page-px tiles, invalidated on erase, undo, and section shift. Zoom buckets (1×, 2×, 4×) keep 500% sharp without a page-sized allocation.
5. `inkWindowPlan.ts` and `shiftInkWindowBitmap` go away once the flag is default. They exist to bound the old backing store.

`drawInkStroke` / `pressureWidth` in `fanotes/src/lib/inkStrokePaint.ts` are the raster spec. The first raster crate reproduces that stroke, including the current brushes, rather than inventing a new brush model.

CodeMirror stays a child of the same camera. `nestedEditorOffsetOnWritePage` remains zero. The host applies the camera's scroll pin and the ink matrix from the same Rust return value in the same turn. CSS `zoom` on `.paper-sheet-plane` stays until the viewport raster is in front of it; after that, zoom is a camera field, and the sheet's layout size is the unscaled page.

### Recognition pipeline

```text
strokes (page 0–1)
  → group lines                  fanotes-recog   (port of groupNeuralTextLines / groupRecognitionLines)
  → line tensor 1×1×128×W        fanotes-recog   (port of renderLineImage, no DOM canvas)
  → probabilities                ort on desktop, onnxruntime-web in the PWA
  → CTC decode                   fanotes-recog   (one implementation)
  → fuse personal prototypes     fanotes-recog   (port, fixture-driven)
  → polish + spelling            TypeScript until the fusion port is green
  → markdown or $latex$          React insert path, unchanged
```

`fanotes-ort` session options copy the worker: CPU execution provider, sequential mode, full graph optimization, CPU memory arena, `intraOpNumThreads` from the setting (clamp 1–4), `interOpNumThreads = 1`. Weights are verified with the SHA-256 already stored in `public/ocr/manifest.json` before the session is created. The model is loaded on first conversion, not at startup, matching the worker comment.

Personal data stays samples plus prototypes. The Rust builder reads the same `Sample` / `MathLayoutExample` / `LabelDefinition` records. IndexedDB remains the writer until GlyphenWerk itself moves. The sync file `.fanotes/recognition-model.json` stays the exchange format (`fanotes/src/lib/sync/recognitionModelBundle.ts`).

TrOCR stays on Transformers.js. Generation is a loop over a merged decoder plus a 4.5 MB `tokenizer.json`, and the desktop extended mode is optional. A later `ort` encoder/decoder session can replace that worker behind the same `recognizeNeuralText` result type. Compact mode (PyLaia only) is the native milestone.

PosFormer continues to spawn `crispembed`. Qwen continues to spawn Python. nerdamer stays the symbolic solver. None of these block the ink crate or the PyLaia swap.

### Host split when Tauri arrives

Tauri commands should be a direct map of the preload channel groups, not a new API: vault read/write, famd mutation, drawings, worksheets, settings/secrets, spelling resources, native line OCR, enhanced math, AI HTTP, add-ons, sync host, updater. The renderer keeps `FaNotesApi`. `createBrowserApi` remains the PWA implementation.

Secrets that `safeStorage` holds today move to the OS credential store (`keyring` crate or Tauri's stronghold plugin) at the host swap. The vault format does not change in that swap.

## Migration strategy

Each milestone is done when the listed checks pass and the Electron app still ships. Tauri is milestone 7, not milestone 1. Re-platforming first would move the compositor bugs into WebKitGTK and add a second set.

| # | Crate / change | Exit criterion |
| --- | --- | --- |
| 0 | Workspace, `fanotes-paper`, `fanotes-ink` arena | Rust tests replay `applyStayPutOp` fixtures and the history-remap cases. No UI call yet |
| 1 | `fanotes-wasm`, thin TS wrappers | `DrawingBoard` calls the wasm reducer for grow and remap. `npm run check:stay-put`, `check:ink-history-remap`, `check:ink-stay-put`, `check:zoom-stay-put` pass |
| 2 | `fanotes-famd`, `fanotes-input` | Roundtrip against `check:famd`. Pointer and jump checks pass (`check:ink-pointer-session`, `check:jump-filter`, `check:ink-sections`) |
| 3 | `fanotes-raster` viewport tiles, flag in `DrawingBoard` | Visual checks (`check:ink-stroke`, `check:ink-visible`, `check:paper-canvas`, `check:zoom-500-sharp`) pass with the flag on. Slice bitmap still available as the flag-off path until then |
| 4 | `fanotes-ort` replaces `native-ocr-worker.cjs` | `check:native-ocr` and `check:packaged-native-ocr` pass. Same tensor shape, same SHA-256 gate, same thread cap. Startup still does not load the model |
| 5 | Line tensor + CTC decode in `fanotes-recog` | Desktop and web share the decoder. Web `session.run` stays `onnxruntime-web`. `check:neural-text-recognition` passes |
| 6 | Prototype fusion, ported function by function from `recognition.ts` | Existing audit scripts (`check:recognition`, `audit:recognition*`, letter holdout) are the gate. No behavior change "while we are here" |
| 7 | Tauri 2 host implements `FaNotesApi` | Channel-parity checklist from `preload.cjs`. React bundle unchanged. Electron remains the release host until that checklist is green |
| 8 | Desktop paper surface | Only if milestone 3 still slips on Hyprland. wgpu/vello viewport, Wayland `zwp_tablet_v2`, Win32 `WM_POINTER`. Webview keeps chrome and CodeMirror |
| 9 | PDFium page textures in the same camera | `check:pdf-write-stay`, `check:pdf-paint-sharp`, `check:pdf-text-while-write`. pdf.js text selection stays until this surface owns hit testing |

Vault filesystem code moves with milestone 7. A wasm crate cannot be the desktop vault. Adding an N-API addon only for files would be a third host.

### Port, wrap, or leave

| Port into Rust, with the current tests as the spec | Wrap and keep | Leave until a dedicated project |
| --- | --- | --- |
| `noteCanvas.ts` reducer, `paperView.ts` zoom anchor math | React shell, CodeMirror, KaTeX, themes, i18n | TrOCR generation loop |
| `inkPointerSession.ts`, `inkPointerPolicy.ts`, `inkSampleMap.ts` jump filter | GlyphenWerk iframe and IndexedDB | nerdamer solver and checker |
| `famd.ts` / `electron/famd.cjs` v1 codec | `onnxruntime-web` session | Qwen OpenVINO worker |
| `inkSections.ts` geometry | pdf.js text layer and worker | CrispEmbed / PosFormer binary |
| `drawInkStroke` raster | Add-on JS runtime | A new markdown editor |
| `native-ocr-worker.cjs` session (as `ort`) | Electron updater until milestone 7 | Weight fine-tuning |
| CTC decode, line raster, then classical recognition behind audits | | |
| `searchInkAnchor` transcript lines | | |

`DrawingBoard.tsx` is not ported as a component. It shrinks into a view that sends `PenSample`s and blits the viewport image. `electron/main.cjs` is not translated line by line. It is replaced by Tauri commands once the preload list is the checklist.

### Risks and mitigations

**Stay-put.** The reducer port can be perfect and the glyph can still slip, because that is the current bug. Mitigation: milestone 1 is a behavior-preserving call into Rust; milestone 3 changes paint. Both stay behind the existing `check:stay-put` family, including reports `1788366080812`, `1788376550462`, `1788416428895`, `1788433450822`, `1788435936618`, and `1788704214528`. Text and ink must consume one camera value per turn.

**Pen on Wayland.** Chromium is on X11 specifically so pen and trackpad share a seat (`linuxOzoneLaunchPlan`). A native Wayland window gets both devices from the compositor through `zwp_tablet_v2`, which Hyprland implements. The X11 flag does not carry over to that window. Mitigation: the pure policy (hover vs tip, 1600 ms idle, 850 ms post-pen ignore, jump filter) runs on every backend, because stuck Wacom button bits are a device behavior. Ship an XWayland fallback switch only after a named tablet fails tablet-v2. Do not read evdev from the app; that bypasses the compositor and needs extra permissions.

**Hyprland scale.** `force_zero_scaling` makes XWayland lie about scale, so the Electron app probes `hyprctl`. A Wayland paper surface should use the output's integer buffer scale and render ink at that scale. The webview chrome may still need the probe until WebKitGTK fractional scaling is measured on the same machine. Measure before deleting the probe.

**WebKitGTK is a different compositor.** Milestone 7 will move CSS zoom bugs, not delete them. That is why the raster crate lands while Electron is still the host, and why milestone 8 exists as a measured follow-up.

**Recognition drift.** `recognition.ts` is 8,330 lines of scoring behavior. Mitigation: port one function at a time under the audit scripts already in `package.json`. Keep the TS implementation callable until the Rust scores match. The idle transcript (`updateHiddenTranscript`) stays off the pointer thread; the UI takes the latest finished result.

**Sync and format.** The sync engine hashes file bytes. A new ink encoding is a migration for every client. Mitigation: Rust reads and writes `fanotes-famd-v1` JSON. A compact stroke blob can be an internal cache, never the vault file, until a versioned schema bump is its own milestone.

**Add-ons and secrets at the host swap.** `addons.cjs` SSRF checks and `safeStorage` are load-bearing. They are part of the milestone 7 checklist, and add-ons stay disabled in Tauri builds until that port lands.

## Key technical decisions

### Canvas

Use `tiny-skia` for the shared raster. It is pure Rust, deterministic, and compiles to `wasm32-unknown-unknown`, so the PWA and the desktop debug the same tiles.

Use `wgpu` plus `vello` for the desktop paper surface in milestone 8, behind a feature flag, painting the same tiles. `vello` is the Linebender GPU 2D renderer and is the right end state for pressure strokes plus PDF textures in one frame. It is the wrong first step: the current bug is frame coupling, and a GPU renderer inside the same CSS zoom would reproduce it.

`softbuffer` is enough for the standalone prototype window. Avoid a GPU bring-up before the camera tests are green.

WebGPU inside WebKitGTK is not the Linux plan. Ink pixels for the webview path are produced by wasm `tiny-skia` and uploaded to a normal canvas. That copy is one viewport, not a page, and it does not depend on WebGPU.

### ONNX and personalization

Desktop PyLaia uses the `ort` crate (pykeio) against the CPU ONNX Runtime, same provider policy as `native-ocr-worker.cjs`. Pin the runtime the way `package.json` pins `onnxruntime-node` 1.21.0 / `onnxruntime-web` 1.22.0, and keep the manifest hash check.

The PWA keeps `onnxruntime-web` and the Q8 model. `fanotes-recog` builds the tensor and decodes CTC on both sides.

Samples stay in IndexedDB `fanotes-handwriting` through the GlyphenWerk bridge. A SQLite file in the profile is justified when a native host writes samples without the iframe. The on-disk sync unit remains `.fanotes/recognition-model.json`.

There is no weight-training step to port. Do not add one.

### File format

Keep plain Markdown plus the `.famd` sidecar plus `.fanotes/` companions. That is the property the README promises to Git, Syncthing, Nextcloud, and a NAS.

A unified notebook file (SQLite, zip, custom package) would break that property and the sync hasher together. Stroke JSON is verbose. If a profile shows the sidecar dominating sync time, add a later schema version with a compact binary *inside* the same trailer, and keep a JSON export. Do not start there.

PDF bytes stay the original file. Ink for a PDF note stays in the `.famd`.

### Pen and tablet input

One `PenSample` type for every host: phase, position in client px, pressure, tilt, buttons, time. `fanotes-input` turns samples into document points and applies the existing filters. Backends only fill `PenSample`.

| Backend | When |
| --- | --- |
| Pointer Events | PWA, and the Electron/Tauri webview until milestone 8. Pressure is whatever the webview delivers. `DrawingBoard.tsx` already expands `getCoalescedEvents`; the wasm and native backends have to consume that full sample list |
| Wayland `zwp_tablet_manager_v2` | Native paper surface. Hyprland's tablet protocol. This is the seat-sharing replacement for `--ozone-platform=x11` |
| Win32 `WM_POINTER` / `POINTER_PEN_INFO` | Native paper surface on Windows. The `windows` crate |
| AppKit tablet events | Later. `dist:mac` exists; pen policy is the same trait |

`winit` pointer events are not a complete pen backend on Wayland. The native surface should bind tablet-v2 itself (or a small crate that does) rather than assume `winit` exposes pressure. Button mapping already lives in `src/lib/tabletButtons.ts` and should be data on the sample, not a browser switch.

Windows default `penOnly` (`defaultPenOnlyForPlatform`) stays a host setting passed into `fanotes-input`.

## Concrete starting points

### Crate layout

Workspace at the repo root, next to `fanotes/` and `src/`, so GlyphenWerk and FaNotes link the same crates.

```text
Cargo.toml                      # workspace
crates/fanotes-ink/             # document, arena, sections, undo
crates/fanotes-paper/           # StayPutState, grow, camera
crates/fanotes-famd/            # fanotes-famd-v1
crates/fanotes-input/           # tip, idle, jump, post-pen
crates/fanotes-raster/          # tiny-skia tiles, port of drawInkStroke
crates/fanotes-recog/           # tensors, CTC, later prototypes
crates/fanotes-ort/             # native feature, depends on ort
crates/fanotes-wasm/            # wasm-bindgen facade used by Vite
apps/paper-proto/               # winit + softbuffer prototype, not shipped
```

Suggested dependencies, and nothing else in milestone 0–2: `serde`, `serde_json`, `thiserror`, `slotmap`. Milestone 3 adds `tiny-skia`. Milestone 4 adds `ort` and `sha2` in `fanotes-ort` only. The wasm crate adds `wasm-bindgen` and `serde-wasm-bindgen`. Later host work adds `tauri` 2, `tokio`, `notify`, `rusqlite`, `keyring`, `reqwest`, `ed25519-dalek`, `pdfium-render` (BSD PDFium; avoid AGPL MuPDF bindings in an MIT app), and, for milestone 8, `wgpu` and `vello`.

`fanotes-ort` is excluded from the wasm dependency graph so the PWA build does not link ONNX Runtime.

Vite loads `fanotes-wasm` from `fanotes/src/lib/paperCore.ts`, which re-exports the functions `noteCanvas.ts` exposes today. Call sites change after the wrappers are bit-compatible, not before.

### Prototype scope

`apps/paper-proto` is a single window:

- Load a drawing JSON or a `.famd` and show the strokes.
- Draw with the mouse (synthetic pressure 0.5) and with a real pen if the backend already returns pressure.
- Zoom with the wheel around the cursor. Pan by drag with the empty hand.
- Grow the page at the write margin using the Rust reducer.
- Undo and redo through the arena, including a grow that must move points inside undo frames.
- Save JSON that the current `validateDrawingJson` path accepts.
- Replay the stay-put fixture ops and print the pad-only predicate.

Out of scope for the prototype: markdown, CodeMirror, PDF, recognition, Tauri, sync, accounts.

### First tests to mechanize

Lift the numeric cases out of these scripts into Rust tests, and keep the scripts running against the wasm wrappers:

- `fanotes/scripts/check-stay-put.mjs`
- `fanotes/scripts/check-ink-history-remap.mjs`
- `fanotes/scripts/check-ink-sections.mjs`
- `fanotes/scripts/check-jump-filter.mjs`
- `fanotes/scripts/check-ink-pointer-session.mjs`
- `fanotes/scripts/check-famd.cjs`
- `fanotes/public/ocr/manifest.json` hashes, once `fanotes-ort` exists

### First pull request

Milestone 0 only. Crate skeletons, `StayPutState` port, arena with one grow remap, fixture tests. No `package.json` change and no `DrawingBoard` change. The Electron app is unaffected, which is the point.

## Trade-offs

### Where a native surface is the better paper

The paper plane wants one frame that contains the camera matrix, the ink tiles, the ruling, and the PDF page texture, plus pen samples that were not coalesced by a webview. That is `wgpu`/`vello` (or a `tiny-skia` viewport if GPU bring-up is still in the way) in a window that receives Wayland tablet-v2 or Win32 pointer messages. Latency and Hyprland scale are properties of that window.

Typed markdown, settings, the file tree, the calendar, AI panels, themes, and add-ons want the web stack they already run in. Tauri 2 is the host that can show that stack without shipping Chromium. The PWA continues to load the same bundle and the wasm core.

A native toolkit for the whole window becomes the better product choice only if the PWA and the JS add-on runtime are dropped. They are current product requirements (`README.md`, `docs/ADDONS.md`).

egui's immediate mode fights a document editor. Iced's text stack is not a stand-in for CodeMirror's GFM hiding, spellcheck, tables, and KaTeX. Slint does not host the add-on runtime. Dioxus targeting HTML would put the paper back on the DOM camera this plan is trying to leave. Any of those can still host `apps/paper-proto` as a debug window; `winit` + `softbuffer` is the smaller dependency.

### Difficulty of the three hard parts

**Ink stay-put under zoom.** The math is a contained port: `noteCanvas.ts` is 872 lines and already a pure reducer, with a written invariant (`stayPutPaperMovedByPadOnly`). The paint coupling is the cross-cutting part. It sits in `DrawingBoard.tsx` (7,457 lines) together with sections, PDF hit testing, and undo. The work is to stop maintaining a second bitmap coordinate system (`inkWindowPlan.ts`, 382 lines) and to feed CodeMirror and the ink tiles from one camera value. Expect the reducer port to be straightforward and the flag-on visual pass to find residual one-frame ordering bugs. Those bugs are the reason milestone 3 keeps the old path behind a flag.

**Live recognition.** The PyLaia swap is contained: a 92-line worker, a fixed `[1, 1, 128, W]` tensor, a hash manifest, a thread cap. The classical engine is the large part: 8,330 lines in `recognition.ts` plus 2,944 in `neuralTextRecognition.ts`, scored by an existing audit zoo. Treat that as a parity port. TrOCR is a second inference stack (tokenizer, 87 MB encoder, 40 MB decoder, generation loop) and stays in Transformers.js until PyLaia-in-`ort` is boring. Live transcription must remain cancellable and off the pointer path, or ink latency regresses while recognition improves.

**PDF worksheets.** Rasterizing pages with PDFium into the same camera is contained. The interaction on top is not: selectable PDF text, pen writing, and keyboard fields share one viewport and swap pointer ownership (`src/lib/pdfInkHit.ts`, `WorksheetLayer.tsx`, `PdfNoteView.tsx`). Multi-page columns use `pdfCamera.ts` and must be the same `PaperCamera` or ink drifts from the page. First PDF milestone: rasters plus the existing ink overlay. Text selection moves only when the native surface owns hit testing.

### Memory and binary size, stated as they are

A Tauri Linux build links system WebKitGTK instead of bundling Chromium. A Tauri Windows build uses the system WebView2. The download shrinks by roughly the Chromium runtime Electron-builder currently unpacks. The JS bundle, KaTeX, pdf.js, and the OCR files do not shrink. Extended recognition still maps the 21 MB PyLaia model and, when enabled, the 87 MB TrOCR encoder and 40 MB decoder.

The RSS change that users feel while writing comes from keeping the ONNX session out of the webview process (milestone 4) and from not retaining a page-sized canvas at 500% zoom (milestone 3). Quote measurements from those milestones. Do not quote a multiplier in advance.

### Open questions to settle with a measurement

1. After milestone 3, does Hyprland still move glyphs? If the viewport raster is stable, milestone 8 waits. If a one-frame slip remains, the native surface is justified and the webview keeps chrome only.
2. Does WebKitGTK, once Tauri is up, deliver pen pressure and coalesced samples well enough for the webview path? If yes, the Wayland tablet backend is only for the native surface. If no, milestone 8 is required for Linux pen quality even when stay-put looks fine.
3. After milestone 4, what is the latency of `ort` versus `onnxruntime-node` on the same lines and thread cap? Keep the worker if `ort` is not ahead; the crate is still worth it if the Node addon is the last Electron-only native module.
4. When GlyphenWerk's iframe is the only IndexedDB writer left, is that acceptable? SQLite is extra machinery until a second writer exists.
5. Child webviews in Tauri 2 (chrome webview beside a wgpu child) need a spike on Hyprland before milestone 8 is scheduled. Subsurface placement and popup coordinates are the risk, not Rust rendering.

## What this plan refuses

- A big-bang rewrite branch that replaces Electron, the paper, and recognition together.
- A new note file format.
- Fine-tuning or replacing PyLaia as part of the port.
- Reading tablet devices via evdev.
- Treating a Tauri port of the untouched React app as the fix for stay-put.
- Dropping the PWA. The wasm crates exist so the PWA and the desktop run one camera and one decoder.
