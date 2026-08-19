# FaNotes user surfaces

Inventory walked from the shipped UI entry points. Each row names a user-visible surface and the source that implements it. The check `scripts/check-user-surfaces.cjs` re-reads those files and fails if a listed needle disappears.

Command-palette action ids walked from `src/App.tsx`: `new-note`, `import-pdf-note`, `new-folder`, `new-subfolder`, `save`, `search`, `drawing`, `worksheet`, `onenote-import`, `ai-assistant`, `glyphenwerk`, `overview`, `homework`, `daily`, `export-pdf`, `history`, `split`, `focus`, `sidebar`, `inspector`, `settings`, `reveal`, `bug-report`, `quit`.

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
| Desktop vault IPC | `electron/preload.cjs` | `createNote: 'fanotes:create-note'` |

## Paper / ink

| Surface | Source | Needle |
| --- | --- | --- |
| Drawing board / pen mode | `src/components/DrawingBoard.tsx` | `export const DrawingBoard` |
| Paper styles | `src/lib/paperStyles.ts` | `export const PAPER_STYLES` |
| Paper zoom / rotation | `src/lib/paperView.ts` | `export const clampViewZoom` |
| Paper grow while writing | `src/lib/paperGrow.ts` | `neededWriteExtent` |
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

## PDF notes

| Surface | Source | Needle |
| --- | --- | --- |
| PDF as note | `src/components/PdfNoteView.tsx` | `PdfNoteView` |
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
| Auto-updater | `electron/updater.cjs` | `update` |
