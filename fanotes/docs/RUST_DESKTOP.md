# FaNotes desktop on Rust: Windows and Linux (phase 2026-11)

> **Reference document.** Written on the closed branch `feature/rust-desktop` (PR #1163). Main has the Rust crates it describes (`fanotes-sync`, `fanotes-index`, `fanotes-story`, the host, famd and PDF deltas) and the benchmark harness `scripts/bench-desktop/`, but not the branch's Tauri shell, its renderer wiring or its packaging. Statements about the Tauri shell below describe the branch.

This document plans the phase that turns the Rust work already in the tree into the desktop app FaNotes ships on Windows and Linux. `RUST_TAURI_REWRITE.md` is the long-range plan and stays valid; this document is the work order for this phase, split into packages that can run in parallel.

Scope: the Windows and Linux desktop app only. Android, the web app/PWA and Kanti+ are not changed. Shared TypeScript may gain *optional* desktop capabilities (`FaNotesApi` methods that only the Tauri bridge provides), and everything stays exactly as it is wherever a capability is missing.

## 1. Where we start (main at 25f01a67, 2026-11-15)

| Area | State |
| --- | --- |
| Crates | 12 crates, ~70k lines: `fanotes-paper`, `-ink`, `-input`, `-famd`, `-raster`, `-recog`, `-ort`, `-pdf`, the wasm facades, and `fanotes-host` (27k lines: vault, notes, drawings, worksheets, settings, secrets via the OS keyring, add-ons with SSRF checks, AI, OneNote import, Linux runtime, Electron profile import) |
| Tauri shell | `fanotes/src-tauri` (Tauri 2) loads the unchanged React bundle; 104 of 112 preload channels have a command. Missing: `handwriting-learning`, `read-pdf-ocr`, `write-pdf-ocr`, `read-page-text`, `write-page-text`, `convert-famd-notes`, `set-file-color`, `share-open`. The writing mode (branch `feature/writing-mode`) adds `story-read/-write/-list/-create` |
| Platforms | The shell links `gtk`, `gdk`, `webkit2gtk` unconditionally: it does not build on Windows |
| Shipping | Electron 43 is the release host (`bundle.active: false` in `tauri.conf.json`, asserted by `check-tauri-channel-parity.mjs`). Rust already ships inside Electron and the PWA through wasm (paper camera, viewport raster, recognition decoder) |
| CI | No Rust job. Workflows: `alpha.yml`, `version.yml`, `release.yml`, `android-companion.yml` |
| Engines still in TypeScript | Sync (`src/lib/sync`, 4.8k lines, runs in the renderer), document search (`src/lib/docSearch`, `germanSearch.ts`), writing-mode model/layout (`src/writing`), notes import/export |

## 2. Rules nobody may bend

1. **Same formats.** `.md`, `.famd` (`fanotes-famd-v1`), `.fanotes/*`, `X.story/` (`fanotes-story-v1`, `fanotes-story-scene-v1`), the sync protocol and the server API stay byte-compatible. Writes are atomic (exclusive temp file, fsync, rename), as in `electron/main.cjs`.
2. **Zero data loss.** No code path deletes, truncates or replaces user data without a recoverable copy. The profile migration backs up first and can be rolled back; Electron keeps working on the same vault.
3. **Sync never writes older or empty content over newer**, locally or on the server. The Rust sync engine passes every case of the TypeScript engine's checks (`check-sync*`, the conflict and shrink guards from PR #1084) through shared fixtures, before any device uses it.
4. **Test parity.** Each port runs the existing TypeScript checks against the Rust code (wasm or a CLI harness) or golden fixtures produced by the TypeScript code. "Equivalent" means equal output on the fixtures, not "looks right".
5. **Electron stays the release host** until the gates in section 6 pass. Tauri builds reach testers as separate artifacts first; no release, tag or Alpha/Beta workflow is triggered without Fabio's explicit go.
6. **No secrets** in code, fixtures, logs, CI output, PRs or chat.

## 3. Target architecture

```text
Tauri 2 window (WebKitGTK on Linux, WebView2 on Windows)
  unchanged React bundle  ──window.fanotes──►  fanotes-api.js bridge
                                                  │ invoke("fanotes:…")        (parity with preload.cjs)
                                                  │ invoke("fanotes-native:…") (desktop-only engines)
fanotes/src-tauri  (commands, window, dialogs, print/export, updater)
  ├─ fanotes-host     vault, notes, drawings, settings, secrets, add-ons, AI, migration
  ├─ fanotes-sync     sync engine (port of src/lib/sync/engine.ts)            new
  ├─ fanotes-index    vault full-text index and search                        new
  ├─ fanotes-story    writing mode: model, merge, typeset, export             new
  └─ fanotes-pdf / -ort / -raster / -recog (existing)
```

Desktop-only engine commands are named `fanotes-native:<area>-<verb>`. They are not preload channels, so the parity check ignores that prefix. The renderer reaches them through optional `FaNotesApi` methods; Electron and the web app do not have them and keep the TypeScript path.

## 4. Work packages

Each package has its own branch off `feature/rust-desktop` and its own worktree, and opens a draft PR into `feature/rust-desktop`. A package owns the files listed for it. Touching a file another package owns is limited to small, clearly separated additions (a `mod` line, a command registration, an optional type field), and is named in the PR.

| WP | Branch | Owns | Delivers | Gate |
| --- | --- | --- | --- | --- |
| 1 Host parity | `rust/host-parity` | `crates/fanotes-host/**` (except `profile.rs`, `migrate*`), `src-tauri/src/lib.rs` command list, `src-tauri/src/fanotes-api.js` | The 8 missing channels with the same validation and results as `main.cjs`; Rust tests per channel | `check-tauri-channel-parity.mjs` green; `cargo test -p fanotes-host` |
| 2 Platforms, CI, installers | `rust/platforms-ci` | `src-tauri/Cargo.toml`, `build.rs`, `capture.rs`, `export.rs`, platform modules, `tauri.conf.json`, `.github/workflows/rust-desktop.yml`, `packaging/tauri/**` | Shell builds on Windows (WebView2) and Linux (WebKitGTK); CI: fmt, clippy, tests on ubuntu + windows, Tauri bundles (AppImage, deb, NSIS) as artifacts; a reproducible Linux build container | CI green on both OSes; installers install and start |
| 3 Sync engine | `rust/sync-engine` | `crates/fanotes-sync/**`, `src-tauri/src/native/sync.rs`, optional sync hooks in `src/lib/sync/**` (desktop capability only) | Rust port of the sync engine with the same protocol, guards and conflict copies; fixture harness running the TS and Rust engines on the same cases; native sync behind a setting (off by default) | All fixtures equal; zero-loss cases; sync-time benchmark |
| 4 Search index | `rust/search-index` | `crates/fanotes-index/**`, `src-tauri/src/native/search.rs`, optional hook in `src/lib/docSearch/**` | Incremental full-text index (notes, `.famd` transcripts, PDF text sidecars, story scenes) with German/English folding identical to `germanSearch.ts`; results ranked like the TS search | Same hits as the TS search on fixtures; index/query benchmark |
| 5 Writing engine | `rust/story-engine` (based on `feature/writing-mode`) | `crates/fanotes-story/**`, fixture generator script | Story model + sanitize + `mergeScenes`/`stampEdits` (needed by Rust sync), typeset (line breaking, hyphenation with the same patterns, pagination, footnotes) with a measurement trait, wasm facade | Equal to the TS engine on fixtures (merge, layout, pagination) |
| 6 Benchmarks | `rust/benchmarks` | `fanotes/scripts/bench-desktop/**`, `fanotes/docs/RUST_DESKTOP_BENCHMARKS.md` | Repeatable before/after numbers for Electron and Tauri: startup, memory, typing latency, large-document scrolling, sync time | Baseline published; same harness reruns after each package |
| 7 Migration | `rust/migration` | `crates/fanotes-host/src/profile.rs`, `crates/fanotes-host/src/migrate/**` | Electron → Tauri profile migration with a verified backup first: settings, secrets (Electron `safeStorage` on Linux and Windows), IndexedDB data (`fanotes-handwriting`, `fanotes-ink-personal`), sync account and sync state; rollback | Synthetic Electron profiles migrate with nothing lost; rollback restores; rerun is a no-op |
| 8 Rendering | `rust/rendering` | `crates/fanotes-pdf/**`, `crates/fanotes-raster*/**`, `src-tauri/src/native/pdf.rs` | Native PDF page rendering (PDFium) and the Rust viewport raster wired into the Tauri host behind flags, with the existing visual checks | `check:pdf-*`, `check:ink-*` visual checks pass with the flags on |

Integration (coordinator): merges the packages into `feature/rust-desktop` in dependency order (2 → 1 → 7 → 3/4/5/8 → 6 rerun), resolves the small shared edits, runs every gate, and opens the PR into `main`.

## 5. Benchmarks (WP6)

Same machine, same vault, five runs each, median and spread reported; Linux under Xvfb at 1440×900, Windows on the CI runner for startup and memory only.

| Metric | Definition |
| --- | --- |
| Startup | Process start → file tree rendered and the last note open (cold and warm) |
| Memory | Sum of RSS (Linux) / private working set (Windows) of every process of the app, idle with a note open, and after opening a 300-page story |
| Typing latency | Key event → glyph painted (`requestAnimationFrame` after the input event), p50/p95 over 500 keystrokes, in a markdown note and in the writing mode |
| Large-document scrolling | Frame times while scrolling a 600-page story and a 200-page PDF top to bottom; p95 frame time and dropped frames |
| Sync time | Full sync of a 2,000-file vault against a local sync server, then an incremental sync after 20 edits |

## 6. Gates before testers, and before Tauri becomes the default

Before testers: WP1, WP2 and WP7 merged; every existing desktop check green on the Tauri build; migration tested on copies of real profile layouts; the benchmark table filled in. Before Tauri becomes the default installer: a tester round without data loss reports, sync engine fixtures equal, Fabio's explicit go.

## 7. Working rules for the packages

- Worktrees under `/srv/agents/fanotes/chats/rust-<wp>/repo`; `CARGO_TARGET_DIR=/srv/agents/fanotes/.cargo-target/<wp>`; `CARGO_BUILD_JOBS=2`; build under `nice`. The machine is shared (8 cores): prefer `cargo check` and `cargo test -p <crate>`; full Tauri builds run in the build container (WP2) or in CI.
- WebKitGTK development files are not installed on the host and must not be installed there. Linux Tauri builds run in a container (`sudo docker`) or in CI.
- Commits use the repository owner's identity and the session trailer; PRs are drafts into `feature/rust-desktop`.
- Known failures on `main` that are not a package's job: `check-i18n-catalog` (settings strings), `check-share`, `check-recommendations` (release.yml assertion), the flaky Kanti+ commute E2E, and `check-tauri-channel-parity` (WP1 fixes it).
