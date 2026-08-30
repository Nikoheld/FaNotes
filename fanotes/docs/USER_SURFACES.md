# FaNotes user surfaces

Inventory walked from the shipped UI entry points. Each row names a user-visible surface and the source that implements it. The check `scripts/check-user-surfaces.cjs` re-reads those files and fails if a listed needle disappears.

Command-palette action ids walked from `src/App.tsx`: `new-note`, `import-pdf-note`, `new-folder`, `new-subfolder`, `save`, `search`, `drawing`, `note-link`, `subject-book`, `worksheet`, `onenote-import`, `ai-assistant`, `glyphenwerk`, `overview`, `homework`, `daily`, `export-pdf`, `history`, `split`, `focus`, `sidebar`, `inspector`, `settings`, `reveal`, `bug-report`, `quit`.

## Notes / vault

| Surface | Source | Needle |
| --- | --- | --- |
| Note tabs, dirty marker, close | `src/App.tsx` | `NoteTabButton` |
| New note / folder / daily note | `src/App.tsx` | `id: 'new-note'` |
| File tree create / rename / trash / color | `src/components/FileTree.tsx` | `file-tree__menu-label">Erstellen` |
| Tag filter and note tags | `src/App.tsx` | `aria-label="Nach Schlagwort filtern"` |
| Tag parse / apply | `src/lib/noteTags.ts` | `export const applyNoteTags` |
| First-run subject folders | `src/components/FirstRunOnboarding.tsx` | `FirstRunOnboarding` |
| Vault overview | `src/components/VaultOverview.tsx` | `VaultOverview` |
| FAMD companion files | `src/lib/famd.ts` | `export const parseFamd` |
| Placed note Verlinkung | `src/lib/noteLink.ts` | `export const placeNewNoteLink` |
| Verlinkung overlay | `src/components/NoteLinkLayer.tsx` | `export function NoteLinkLayer` |
| Remove placed Verlinkung | `src/lib/noteLink.ts` | `export const removeNoteLink` |
| Zurück after a Verlinkung | `src/App.tsx` | `note-nav-back` |
| Note backup snapshots | `src/lib/noteBackup.ts` | `export const createNoteBackup` |
| Backup control policy | `src/lib/noteBackup.ts` | `export const noteBackupControlPolicy` |
| Backup top chrome | `src/App.tsx` | `note-backup-control` |
| Notiz-Backup Experimentell | `src/components/SettingsModal.tsx` | `title="Notiz-Backup"` |
| Send Data Experimentell | `src/components/SettingsModal.tsx` | `title="Send Data"` |
| Send Data policy | `src/lib/sendData.ts` | `export const sendDataPolicy` |
| Send Data payload | `src/lib/sendData.ts` | `export const buildSendDataPayload` |
| Send Data battery schedule | `src/lib/sendData.ts` | `export const decideSendDataTick` |
| Send Data server accept | `../fanotes-site/send-data-api.mjs` | `export const acceptSendDataPayload` |
| Subject PDF book attach | `src/lib/subjectBook.ts` | `export const attachSubjectBook` |
| Subject book view policy | `src/lib/subjectBook.ts` | `export const subjectBookViewPolicy` |
| Subject book last page | `src/lib/subjectBook.ts` | `export const recordSubjectBookPage` |
| Subject book notes | `src/lib/subjectBook.ts` | `export const persistSubjectBookNotes` |
| Book top chrome | `src/App.tsx` | `subject-book-control` |
| Book pane | `src/components/SubjectBookPane.tsx` | `export function SubjectBookPane` |
| Book pop-out window | `electron/main.cjs` | `openSubjectBookPopout` |
| Attach book in folder menu | `src/components/FileTree.tsx` | `Buch hinzufügen` |
| Desktop vault IPC | `electron/preload.cjs` | `createNote: 'fanotes:create-note'` |

## Paper / ink

| Surface | Source | Needle |
| --- | --- | --- |
| Drawing board / pen mode | `src/components/DrawingBoard.tsx` | `export const DrawingBoard` |
| Visible ink paint | `src/lib/inkStrokePaint.ts` | `export const drawInkStroke` |
| Markdown note Stift path | `src/lib/inkStrokePaint.ts` | `export const paintMarkdownNoteStiftStroke` |
| Markdown overlay size | `src/lib/pdfInkHit.ts` | `markdownNoteInkOverlaySize` |
| OneNote-like write page | `src/lib/noteCanvas.ts` | `export const growPageFromMark` |
| Overlay covers write page | `src/lib/noteCanvas.ts` | `export const inkOverlaySize` |
| Ink map and paint share the write page | `src/lib/noteCanvas.ts` | `export const markdownInkPageBox` |
| Page grows at every edge | `src/lib/noteCanvas.ts` | `export const growWriteOrigin` |
| Paper layout | `src/lib/paperCanvas.ts` | `export const paperCanvasLayout` |
| Paper styles | `src/lib/paperStyles.ts` | `export const PAPER_STYLES` |
| Paper zoom / rotation | `src/lib/paperView.ts` | `export const clampViewZoom` |
| 500% zoom handwriting sharpness | `src/lib/paperGrow.ts` | `export const inkOverlayPixelSize` / `inkViewQualityZoom` |
| 500% zoom keep-vs-window | `src/lib/pdfInkHit.ts` | `export const resolveInkOverlayWindow` |
| 500% zoom PDF page sharpness | `src/lib/pdfDocument.ts` | `export const paintBoxForPage` / `visiblePageCssWindow` |
| Zoom-in writing stay-put | `src/lib/paperView.ts` | `export const applyPaperZoomStayPut` |
| Fast paper-scroll text stay-put | `src/lib/paperCaretScroll.ts` | `export const lockPaperViewportScrollStayPut` |
| Pen-write text stay-put | `src/lib/noteCanvas.ts` | `export const markdownAndInkAfterMinEdgeGrow` |
| Long downward write stay-put | `src/lib/noteCanvas.ts` | `export const markdownAndInkAfterGrowSequence` |
| Corner write stay-put | `src/lib/noteCanvas.ts` | `export const paintedStayExtent` / `markdownAndInkAfterGrowSequence` |
| Corner grow ruling lattice | `src/lib/paperRuling.ts` | `originPad` |
| Paper grow while writing | `src/lib/noteCanvas.ts` | `export const growWriteExtent` |
| Finite extra-paper scroll | `src/lib/noteCanvas.ts` | `export const canvasScrollBounds` |
| Clamp pan to extra paper | `src/lib/noteCanvas.ts` | `export const clampCanvasScroll` |
| Paper ruling fill on the page | `src/lib/paperRuling.ts` | `export const paperRulingFillBox` |
| Ink pointer session (Wacom lift) | `src/lib/inkPointerSession.ts` | `shouldHardEndInkPointerSession` |
| Wheel / pen-up cleanup | `src/lib/inkPointerPolicy.ts` | `applyPenUpInkCleanup` |
| Scribble erase | `src/lib/scribbleErase.ts` | `detectScribbleErase` |
| Tool erase | `src/lib/toolErase.ts` | `applyToolErase` |
| Shape snap | `src/lib/shapeSnap.ts` | `strokeLooksLikeShape` |
| Drafting tools (ruler / set square / compass) | `src/lib/draftingTools.ts` | `millimetresAlongEdge` |
| Drafting guides UI | `src/components/DraftingGuides.tsx` | `DraftingGuides` |
| Text to handwriting | `src/lib/textToHandwriting.ts` | `synthesizeHandwriting` |
| Pen-only factory default | `src/defaults.ts` | `defaultSettingsForPlatform` |

## Recognition

| Surface | Source | Needle |
| --- | --- | --- |
| GlyphenWerk workspace | `src/components/GlyphenWerkWorkspace.tsx` | `GlyphenWerkWorkspace` |
| GlyphenWerk bridge | `src/lib/glyphenWerkRecognitionBridge.ts` | `validatedGlyphenWerkTextPrefixHint` |
| Recognition mode | `src/lib/recognitionModeSelection.ts` | `recognitionModeSelection` |
| Neural text recognition | `src/lib/neuralTextRecognition.ts` | `recognizeNeuralText` |
| Personalized recognition | `src/lib/personalizedTextRecognition.ts` | `fusePersonalizedTextRecognition` |
| Native OCR IPC | `electron/preload.cjs` | `recognizeNativeHandwritingLine` |
| Enhanced math model | `src/lib/enhancedMathRecognition.ts` | `renderEnhancedMathImage` |
| Qwen vision | `src/lib/qwenVisionRecognition.ts` | `renderQwenVisionImage` |

## Math solver / corrector

| Surface | Source | Needle |
| --- | --- | --- |
| Math solver | `src/lib/mathSolver.ts` | `solveMathExpression` |
| Math solver input | `src/lib/mathSolverInput.ts` | `normalizeMathInput` |
| Math corrector | `src/lib/mathChecker.ts` | `checkMathSteps` |
| Math ink selection | `src/lib/mathInkSelection.ts` | `selectMathInkAtPoint` |

## Settings / AI

| Surface | Source | Needle |
| --- | --- | --- |
| Settings modal sections | `src/components/SettingsModal.tsx` | `id: 'appearance'` |
| Theme / zoom / updates / experimental | `src/components/SettingsModal.tsx` | `id: 'experimental'` |
| Remote Support session | `src/lib/remoteSupport.ts` | `startRemoteSupportSession` |
| Remote Support Experimentell row | `src/components/SettingsModal.tsx` | `title="Remote Support"` |
| Accessibility / advanced settings | `src/components/SettingsModal.tsx` | `id: 'accessibility'` |
| AI panel | `src/components/AiPanel.tsx` | `AiPanel` |
| LM Studio panel | `src/components/LmStudioPanel.tsx` | `LmStudioPanel` |
| AI provider browser | `src/lib/aiProviderBrowser.ts` | `transformWithBrowserAi` |
| Formatting toolbar | `src/components/FormattingToolbar.tsx` | `FormattingToolbar` |
| Markdown editor | `src/components/MarkdownEditor.tsx` | `MarkdownEditorHandle` |
| Markdown preview | `src/components/MarkdownPreview.tsx` | `MarkdownPreview` |
| Outline jump / tags | `src/lib/noteOutline.ts` | `parseNoteOutline` |
| Right inspector | `src/components/RightInspector.tsx` | `onJumpToLine` |
| App version | `src/lib/appVersion.ts` | `APP_VERSION` |

## Homework

| Surface | Source | Needle |
| --- | --- | --- |
| Homework board | `src/components/HomeworkBoard.tsx` | `HomeworkBoard` |
| Homework store | `src/lib/homeworkStore.ts` | `HOMEWORK_NOTE_PATH` |
| Homework API | `src/lib/homeworkApi.ts` | `publishHomeworkList` |
| Homework API control | `src/lib/homeworkApi.ts` | `export const setHomeworkApiTaskDone` |

## PDF notes

| Surface | Source | Needle |
| --- | --- | --- |
| PDF as note | `src/components/PdfNoteView.tsx` | `PdfNoteView` |
| PDF chrome in top bar | `src/lib/pdfInkHit.ts` | `PDF_TOOLBAR_SLOT_ID` |
| Last opened note | `src/lib/lastOpenNote.ts` | `chooseRestoredNote` |
| PDF document loader | `src/lib/pdfDocument.ts` | `openPdfDocument` |
| Worksheet layer | `src/components/WorksheetLayer.tsx` | `WorksheetLayer` |
| Import worksheet / PDF IPC | `electron/preload.cjs` | `importPdfNote: 'fanotes:import-pdf-note'` |

## Search / palette

| Surface | Source | Needle |
| --- | --- | --- |
| Vault search | `src/components/SearchPanel.tsx` | `SearchPanel` |
| Command palette | `src/components/CommandPalette.tsx` | `CommandPalette` |
| Palette actions | `src/App.tsx` | `id: 'bug-report'` |
| Reveal in folder | `src/App.tsx` | `id: 'reveal'` |
| Palette ids | `src/App.tsx` | `id: 'new-folder'` |
| Place Verlinkung palette | `src/App.tsx` | `id: 'note-link'` |
| Subject book palette | `src/App.tsx` | `id: 'subject-book'` |
| Editor more menu | `src/App.tsx` | `editor-menu-label">Datei` |

## Bug report

| Surface | Source | Needle |
| --- | --- | --- |
| Bug report modal | `src/components/BugReportModal.tsx` | `BugReportModal` |
| 5-minute log + fasrv cap | `src/lib/bugReport.ts` | `MAX_BODY_BYTES` |

## Linux / Windows desktop

| Surface | Source | Needle |
| --- | --- | --- |
| Ozone X11 / Hyprland scale | `electron/startup-preflight.cjs` | `linuxOzoneLaunchPlan` |
| Native window frame | `electron/startup-preflight.cjs` | `linuxWindowFrameOptions` |
| BrowserWindow | `electron/main.cjs` | `linuxWindowFrameOptions()` |
| AppImage AppRun Ozone | `scripts/harden-appimage.cjs` | `linuxOzoneAppRunExecLine` |
| Desktop Exec | `packaging/fanotes.desktop` | `ozone-platform=x11` |
| Windows pen-only default | `electron/ink-defaults.cjs` | `defaultPenOnlyForPlatform` |
| Wacom pen/tablet button map | `src/lib/tabletButtons.ts` | `export const tabletButtonActionFromPointer` |
| Wacom button Settings | `src/components/SettingsModal.tsx` | `settings-tablet-buttons` |
| Auto-updater | `electron/updater.cjs` | `update` |
