# Canvas text stay-put audit

Audit of the FaNotes camera (`fanotes/`) on `main` at `c380947`. Typed text, ink, ruling, worksheet marks, and note-link pins must share one paper point after every camera change. German identifiers and comments were left as they are.

The camera is not a `transform: scale()` canvas. One CSS `zoom` is written on `.paper-sheet-plane` (`paperView.ts:256`, fallback `.unified-paper`). `transform: rotate()` uses `transform-origin: center center` on that same node (`paperView.ts:259`). Pan is `scrollLeft` / `scrollTop` on `.paper-view` / `.unified-note-view`. `stripSheetLayerZooms` (`paperView.ts:141`, called at `paperView.ts:275`) clears child zoom. A search of `src` finds no other `style.zoom` assignment.

`getBoundingClientRect()` includes CSS zoom. `offsetWidth` / `offsetHeight` do not. Scroll offsets are visual CSS pixels: scrolling by 632 moves the plane by 632 even at zoom 2. A layout shift of P px inside the zoomed plane moves on screen by P × zoom.

## Coordinate spaces

| Space | What lives there | How code reads it |
| --- | --- | --- |
| Screen / client | Viewport CSS px after zoom and rotate. `getBoundingClientRect()` is the axis-aligned box. | Pointer events, `documentTop`, anchor client Y |
| Scroller content | Same visual px as client deltas. `scrollLeft` / `scrollTop` on `.paper-view` or `.unified-note-view`. | Pan, stay-put restore, grow pin |
| Unzoomed paper / layout px | `offsetWidth`, CSS `left` / `top` / `padding`, CodeMirror coords after `/ scaleY`, origin pad, `PaperTextAnchor.offset` | Glyphs, ruling tile, ink window CSS |
| Zoomed visual px | Layout px × the plane’s CSS zoom | Rect width/height, sheet-origin shift from visual bounds |
| Stored ink | Opaque 0–1 of the painted sheet in `.famd` (`fanotes-famd-v1`). Remapped with `keepMarkOnPage` on grow. | `mapClientToPaperPoint` |
| Stored anchor | `{ pos, offset }` plus unzoomed `centreX` / `centreY` in `localStorage` key `fanotes.paperView.v1`. Not in the sidecar. `offset` and centres are rounded to 2 decimals. | `paperTextAnchor.ts`, `paperViewMemory.ts` |

## Findings

### 1. Note-link pins use zoomed rects as unzoomed CSS

Severity: high. Layers: note-link pins against text, ink, ruling, and PDF page marks. Text and ink stay together; the pin does not.

On `main`, `NoteLinkLayer` `measure` set `left: link.x * paperRect.width` and `top: link.y * paperRect.height`, where `paperRect` is `getBoundingClientRect()` (already zoomed). CSS `left` / `top` on `.note-link-wrap` are layout px, and the plane zooms them again. The PDF branch did the same with `rect.left - layerRect.left + link.x * rect.width` (`NoteLinkLayer.tsx` before this fix, the `measure` callback). Stored `link.x` / `link.y` are 0–1 from `noteLinkPointFromRect` (`noteLink.ts`), which divides by the same visual rect, so the saved fraction is zoom-independent. Only the paint was wrong. `.famd` still stores 0–1; the schema is unchanged.

A Chromium probe on this machine, with a pin and an ink mark on the same fraction, measured the pin against the ink at about 0.5px at zoom 1 (the `translate(-50%, -50%)` of a 1px box). At zoom 1.5 / 2 / 2.5 / 3.25 the pin was 35.5 / 71.5 / 107.5 / 161.5 unzoomed paper px off. Placing the pin with `offsetWidth` (layout px) kept it within about 0.5px at those zooms, including after `rotate(15deg)` and `rotate(90deg)` for 1px markers.

Reproduce: place a note link on a heading, zoom with the button or ctrl+wheel to 200%. The heading and any ink on it stay put. The pin slides away by about `fraction × layout × (zoom − 1)` layout px. Rotate after that and the wrong CSS point rotates away from the heading as well.

Existing checks missed it. `check-note-link-place.mjs` calls `noteLinkPageAtPoint` on fake rects and never applies CSS zoom or marker `left` / `top`. Worksheet marks use percentages, so they were not this bug.

Smallest fix: `noteLinkMarkerCss` (`noteLink.ts`) places a markdown pin at `link.x * layoutWidth`. For a PDF page it converts the visual page rect back to layout px with `visual / layout` (the plane zoom) before adding `link.x * pageLayoutWidth`. `NoteLinkLayer` passes `offsetWidth` / `offsetHeight` and `readUsedSheetZoom`, not the rotated axis-aligned box, as the paper zoom. Example: layout 800×1000, zoom 2, link (0.25, 0.4) is CSS (200, 400), not (400, 800). PDF page visual left 100, width 1600, zoom 2, `link.x` 0.5 is CSS left 450, not 900.

### 2. A min-edge grow while zoomed pans the scroller by the unzoomed pad

Severity: high while zoomed and the page grows at the origin (writing into the top or left margin). Layers: typed text and ink move together; both slip against the viewport by `pad × (zoom − 1)`.

`paperOriginScrollDelta` (`noteCanvas.ts`) returns the unzoomed CSS pad and must not be scaled: existing checks treat reducer camera units as that pad. `setPageExtent` in `DrawingBoard.tsx` applied `liveWriteStayPut(...).cam` with `pinPaperViewportAfterExtentGrow`. `scrollLeft` / `scrollTop` are visual px. If the paper box does not move, `paperSheetLayoutShift` is ~0, and the viewport is short by `pad × (zoom − 1)`.

Chromium, zoom 2.5, `padding-top` and the ink mark both increased by 48 layout px, sheet shift 0: `liveWriteStayPut` camera y went from 472 to 520 (plus 48 only). The glyph slipped 72px in the viewport, which is `48 × (2.5 − 1)`. Scrolling by `48 × 2.5` left a slip of 0, and the glyph stayed on the ink (both had moved 48 layout px). Text was not shoved relative to ink. The paper point under the cursor did not stay under the cursor.

Reproduce: zoom to 250%, write toward the top or left edge until the page grows a min-edge pad. The line and the stroke jump down or right together by `pad × (zoom − 1)` CSS px. At zoom 1 the jump is 0, which is why the old checks stayed green.

Existing checks missed it. `markdownAndInkAfterMinEdgeGrow` and `check-stay-put.mjs` subtract the unzoomed pad from unzoomed text and ink. They never multiply a DOM scroll by CSS zoom. `check-bug-text-shift.mjs` is the origin-pad contract, not the zoomed scroller.

Smallest fix: `scrollForZoomedOriginPad` (`noteCanvas.ts`) is the DOM write only. It adds `shift` (already visual) plus `pad × zoom`. `liveWriteStayPut` and `paperOriginScrollDelta` stay unscaled, so zoom 1 matches the old camera (`200 + 48 = 248`). At zoom 2.5, scroll y 200 and pad 48 become 320. `setPageExtent` pins, corrects, and refreshes with that visual scroll and `readUsedSheetZoom(paper)`. Shift is not scaled: scroll (100, 200), pad 48, shift y 10, zoom 2 → y = 306.

## Hypotheses

Refuted, so the next pass can skip them:

- Text, ink, and ruling sit outside `.paper-sheet-plane`, or a child sets its own zoom. `PaperView.tsx` renders `.paper-ruling` and the note children inside `.paper-sheet-plane`. The only `style.zoom` write is `paperView.ts:256`. `stripSheetLayerZooms` clears the rest. In Chromium, `style.zoom = 1` on `.editor-pane` did not freeze the glyph once the plane was zoomed.
- Pan updates scroll while a rAF overlay keeps the previous camera. A glyph and an absolute ink mark moved by the same client delta. Note-link `measure` runs on the scroll listener, not a lagged frame. Ink-window CSS is layout px on the same plane (`inkWindowPlan.ts`, `pdfInkHit.ts`).
- Zoom stay-put uses the wrong point, or `centrePageInViewportIfFits` undoes it for in-plane text versus ink. `applyPaperZoomStayPut` to 2.5 kept the paper point. A 4px layout inset became a 6px visual inset (`4 × 2.5 − 4`), which is scaling, not drift. Text-anchor restore error was 0. Recentering a page that fits the viewport is specified, not drift.
- `clampPaperScrollerToZoomedSheet` mixes rect width with `offsetWidth × zoom` and pulls text, including the right edge. The clamp uses `Math.max` of the visual rect and `offsetWidth × zoom`. It does not shrink the restored point.
- `usedScale` falls back to 1 and applies the anchor offset unscaled, and X drifts because it has no line anchor. After a real zoom, `scaleY` was already ~2.4997 and the restore error was ~0. Forcing `scaleY` to 1 did miss by `offset × (zoom − 1)` (−396.8 vs −440). The shipped path measures before it converts (`paperTextAnchor.ts`). The 0/NaN fallback is intentional. X is restored from unzoomed `centreX` with the same zoom (`paperViewMemory.ts`). Nested `.cm-scroller` scroll is sealed to 0.
- Two-decimal rounding of `PaperTextAnchor.offset` and of the paper centre accumulates. Two hundred remember/restore cycles of `paperCentreFromCamera` / `cameraForPaperCentre` drifted 0px at zoom 2.5 and at most 0.03px at zoom 6. Two hundred text-anchor round-trips on a stable line block drifted at most 0.003px at scale 1, 2.5, and 6. The error settles on the 0.01 grid. It does not walk.
- CodeMirror height estimates make the same `{ pos, offset }` a different client Y, worse on fast scroll and long notes. A live `EditorView` (80 lines) after pan and after zoom 2.5 restored with error 0; `block.top` was in the same screen space as `clientY − documentTop`. The fake estimate case is already in `check-paper-view-memory.mjs`. No separate long-note failure showed up in that probe.
- `documentTop` is stale during pan, wheel zoom, or when a sticky toolbar is the offset parent. `documentTop` and `clientY` are both viewport rects. Restore error was 0 after pan and after zoom.
- Paper growth inserts space above or left of existing content, or remaps ink and not text. `keepMarkOnPage` and the origin pad move ink and text by the same layout px. They stay aligned. The viewport slip is finding 2, not a text-versus-ink split. `paperCaretScroll.ts` `applyLiveWriteStayPut` has no caller outside that file; the live stroke grows through `setPageExtent`.
- Rotation uses a different origin for text than for ink or pins. In-plane 1px markers that share a layout point stayed within 0.5px at 15° and 90°. One `transform-origin: center center` (`paperView.ts:260`). Rotation does not hold the pointer the way zoom does. That is a different camera anchor, not a layer split.
- Ink is stored in screen px, zoomed px, or pre-grow page px and read back in another space from `.famd`. `mapClientToPaperPoint` stores 0–1. `famd.ts` passes ink through. `electron/famd.cjs` clamps note-link `x` / `y` to 0–1. Reload does not treat those numbers as CSS px.
- View memory applies the centre, then the text anchor, then a programmatic scroll that the user listener stores as a pan. `isProgrammaticScroll` tolerates 1.5px. Centre and anchor rounding is 0.01px, inside that tolerance. No overwrite showed up.
- `stripFamdPayload` changes the markdown (BOM, sidecar comment left in the buffer, dropped worksheet markers) so every line block moves against saved ink. The strip removes the `fanotes-famd:v1` sidecar and trailing whitespace. A dropped trailing newline is EOF-only. Worksheet markers stay in the body on purpose.
- Worksheet / PDF drawing has its own pan and zoom, so text selection and typed text drift apart. There is still one CSS zoom. `pdfCamera.ts` only recenters the same scroller. `visiblePageCssWindow` (`pdfDocument.ts`) divides visual scroll by the sheet zoom to get layout px. `.pdf-note-text-layer` (`styles.css`) is pdf.js glyph placement inside the page, which sits in the plane. Worksheet marks are percentages. `oneNoteScale` fits an imported iframe to the column; the plane then zooms that column. PDF text selection was not clicked in Electron.

Untestable here:

- A physical pinch, as distinct from ctrl+wheel. The wheel path calls `applyPaperZoomStayPut`, which the Chromium probe ran.
- The Electron compositor and `devicePixelRatio` versus this Chromium. `npm run dev` cannot start: the Electron binary is not installed (`npm ci --ignore-scripts`), and the download failed (`fetch failed`). PDF bitmap backing uses DPR for sharpness (`pdfPaintDeviceScale`), not for the CSS paper point. `check-paper-zoom-browser.mjs` did start in Chromium. At zoom 2 the plane, ruling, and editor report zoom 2, child inline zoom stays empty, the 16px font is 32px on screen, and the 28px ruling tile is 56px. Two runs matched.

Residual, not a confirmed separate bug: a PDF note-link pin while the plane is rotated. The page rect is an axis-aligned box, so `noteLinkMarkerCss` is exact when the plane is only zoomed. At zoom 1 the rotated case matches the previous formula (`readUsedSheetZoom` is 1). Markdown pins use layout px and rotate with the plane.

## Checks

Added `fanotes/scripts/check-canvas-text-stay.mjs`. It loads `noteLinkMarkerCss`, `scrollForZoomedOriginPad`, and `liveWriteStayPut` through Vite `ssrLoadModule` and asserts the paper point. On the pre-patch math (visual width used as CSS px, pad not scaled) it failed with `zoom-2 markdown left: 400 must be 200`. After the patch it prints `{"zoomedLeft":200,"pdfLeft":450,"growY":320,"reducerY":520}` and `canvas-text-stay ok`. It also asserts the call sites: `NoteLinkLayer` uses `offsetWidth` and `readUsedSheetZoom`, and `DrawingBoard` pins `stayScroll` from `scrollForZoomedOriginPad(originCamera, …, readUsedSheetZoom(paper))`. `liveWriteStayPut` is still required to keep the unzoomed pad (`reducerY` 520).

Still needed, not landed as a passing check of an unconfirmed bug:

- Electron, or a rotated PDF page, for the residual AABB pin.
- A note long enough that CodeMirror’s estimated line tops and measured tops disagree across a fast fling. The live 80-line probe did not show it. Do not add a check that passes on a stable fake block and call that a proof.

Existing stay-put scripts were not weakened. `check-stay-put.mjs` still requires `liveWriteStayPut` and `pinPaperViewportAfterExtentGrow` in `DrawingBoard.tsx`.
