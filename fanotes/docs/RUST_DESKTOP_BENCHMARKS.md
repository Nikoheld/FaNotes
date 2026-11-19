# FaNotes desktop benchmarks: Electron and Tauri (WP6)

> **Reference document.** Written on the closed branch `feature/rust-desktop` (PR #1163). Main has the Rust crates it describes (`fanotes-sync`, `fanotes-index`, `fanotes-story`, the host, famd and PDF deltas) and the benchmark harness `scripts/bench-desktop/`, but not the branch's Tauri shell, its renderer wiring or its packaging. Statements about the Tauri shell below describe the branch.

Before/after numbers for the desktop hosts, measured with one harness on one machine in one container. The metric definitions are in `RUST_DESKTOP.md` section 5. The harness lives in `scripts/bench-desktop/`. Raw results (every run, every process, load averages) are in `scripts/bench-desktop/results/*.json`.

## Results (2026-11-15, Linux, Xvfb 1440×900)

| Metric | Electron 43 | Tauri 2 (WebKitGTK) |
| --- | --- | --- |
| Startup, cold (process start → tree + last note) | 1086 ms (785–1306, n=3) | 1274 ms (1226–1472, n=3) |
| Startup, warm | 601 ms (596–711, n=3) | 796 ms (790–953, n=3) |
| Memory idle, note open: RSS sum | 835 MB (832–870, n=3) | 997 MB (886–1334, n=3) |
| Memory idle, note open: PSS sum | 536 MB (531–559, n=3) | 833 MB (710–1158, n=3) |
| Memory after the long markdown note: RSS sum | 1139 MB (1128–1173, n=3) | 1300 MB (1260–1505, n=3) |
| Memory after the 200-page PDF: RSS sum | 2445 MB (2163–2483, n=3) | 1408 MB (1265–1581, n=3) |
| Memory after the 200-page PDF: PSS sum | 1972 MB (1763–1987, n=3) | 1255 MB (1089–1404, n=3) |
| Typing, markdown: key event → frame, p50 | 17.6 ms (16.6–18.3, n=3) | 20.0 ms (18.0–21.0, n=3) |
| Typing, markdown: key event → frame, p95 | 26.0 ms (24.4–26.2, n=3) | 90.1 ms (53.0–103.1, n=3) |
| Typing, markdown: XTest injection → frame, p50 | 16.2 ms (15.5–16.6, n=3) | 20.5 ms (19.5–20.9, n=3) |
| Typing, markdown: XTest injection → frame, p95 | 24.3 ms (23.3–24.7, n=3) | 89.2 ms (54.3–104.1, n=3) |
| Scroll long markdown note: p95 frame time | 33.4 ms (33.4–33.4, n=3) | 121.8 ms (117.0–125.4, n=3) |
| Scroll long markdown note: dropped frames | 169 (146–176, n=3) | 1515 (1321–1589, n=3) |
| Scroll 200-page PDF: p95 frame time | 33.4 ms (33.4–33.4, n=3) | 454.1 ms (298.2–549.1, n=3) |
| Scroll 200-page PDF: dropped frames | 86 (79–119, n=3) | 7449 (6488–8150, n=3) |
| Writing mode (600-page story): typing p50 / p95 | 29.0 ms (24.7–30.1, n=3) / 91.5 ms (88.8–97.4, n=3) | not measurable (no story channels in the Tauri shell) |
| Writing mode: scroll p95 / dropped | 16.8 ms (16.8–33.4, n=3) / 32 (24–115, n=3) | not measurable |
| Writing mode: memory after opening the story (RSS) | 1759 MB (1744–1776, n=3) | not measurable |

| Sync (local server) | TypeScript engine | Rust engine (WP3) |
| --- | --- | --- |
| Sync: full, upload (2,000 files) | 7785 ms (7623–8270, n=3) | not measured yet (WP3 CLI) |
| Sync: full, download on a 2nd device | 5191 ms (4800–8488, n=3) | not measured yet (WP3 CLI) |
| Sync: 20 edits, upload | 206 ms (109–337, n=3) | not measured yet (WP3 CLI) |
| Sync: 20 edits, download | 150 ms (87–267, n=3) | not measured yet (WP3 CLI) |
| Sync: nothing to do | 61 ms (51–81, n=3) | not measured yet (WP3 CLI) |

Medians of 3 runs, (min–max) and the number of runs in parentheses. The machine was shared with other agents, so the load average was high during these runs (it is stored with every run). The spread is the honest error bar. Rerun on a quiet machine before you quote single-digit percentages.

### What the numbers say, and what they do not

- **Startup.** Electron is ahead. Tauri is about 17 % slower cold (1.27 s vs 1.09 s) and about 32 % slower warm (0.80 s vs 0.60 s). In both apps the tree mark comes 70–200 ms before the note mark.
- **Memory.** At idle with a note open, Tauri uses *more*: 833 MB vs 536 MB PSS. Almost all of it is the single `WebKitWebProcess` (~650 MB RSS). After the 200-page PDF, Tauri uses less: 1.26 GB vs 1.97 GB PSS. The `dist/` embedded in the Tauri binary (245 MB, the OCR models included) is mapped into the app process.
- **Typing.** The medians are close (17.6 ms vs 20.0 ms). The tail is not: Tauri's p95 is 90 ms against Electron's 26 ms. All 500 keys reached the editor in every run, and the text grew by 495 characters (5 of the keys are Return).
- **Scrolling.** Under Xvfb, with no GPU, WebKitGTK drops far more frames: on the long note a p95 of 122 ms vs 33 ms, and on the PDF 454 ms vs 33 ms with ~7,400 dropped frames. Both engines render in software here (SwiftShader and llvmpipe). This gap has to be re-measured on real hardware with a GPU before anyone draws a conclusion for users.
- **Sync (TypeScript engine).** Over loopback, the first sync of 2,000 files takes 7.8 s up and 5.2 s down (2,005 requests each), and 20 edits take 0.1–0.3 s. The load average was 22–26 during these runs, so expect lower numbers on a quiet machine. **Finding:** the stock server allows 1,200 requests per minute per account. A first sync of a 2,000-file vault therefore stops with HTTP 429 ("Too many requests") after about 1,200 files. The engine retries on its next cycle. The benchmark raises the limit in memory (`lib/sync-server.mjs --account-limit`, a module load hook; `--account-limit 0` runs the stock limit).
- **Writing mode** (Electron, `feature/writing-mode` at `9ba17be5`). The story has 98 chapters and 1.06 M characters, and its scroll height is ~592,000 px. The pages are virtualized, so the harness did not read a page count. Typing has a p50 of 29 ms and a p95 of 92 ms. Every key changed the DOM, but the text grew by only 421–439 characters for 500 keys, because autocorrect and typography rewrite while typing. Memory after opening the story is 1.76 GB RSS. The Tauri shell has no `story-*` commands, so this variant could not be run there.

**Not measured, and why**
- **Tauri on the branch as it is.** It cannot be measured, for two reasons. (1) The placeholder icons in `src-tauri/icons/*.png` are corrupt: the IHDR says 32×32 RGBA, but the image data decodes to 160 bytes. Window creation panics in `gdk-pixbuf` ("data.len() must fit the width, height, and row_stride"), and `rust/platforms-ci` at `31119bae` has the same icons. (2) The bridge `fanotes-api.js`, added with `append_invoke_initialization_script`, never runs in the page. `window.fanotes` then falls back to the **browser vault** (IndexedDB, "Browser · this device"), and the real host is never used. The Tauri numbers above come from a local build that changes only these two things: valid placeholder icons, and the bridge loaded through a plugin `js_init_script` (which runs after Tauri's core script). That build was not pushed. WP1 and WP2 should fix both on their branches.
- **Windows** startup and memory: not measured. The optional workflow was skipped in this round.
- **Rust sync engine (WP3):** the hook is ready (`--engine rust --rust-cli`). The CLI does not exist yet.
- **Sync inside the apps**, with the IPC hop: not measured. Only the engine and the host in Node were measured.
- **Cold start** is best effort. After the eviction, 33 % (Electron) and 12 % (Tauri) of the mapped bytes were still cached; these are files in the image's overlay layers.
- **Environment.** Electron's renderer crashed on the 200-page PDF with Docker's default 1 GB `/dev/shm`. The container now gets 2 GB, the same for both hosts.

## What was measured, and how

Both hosts are driven the same way, in the same container (`fanotes-bench:1`), under the same Xvfb, with the same generated vault and the same settings. The settings are: German UI, update checks off, spellcheck off, and `Start/Letzte Notiz.md` as the last open note.

| Step | Electron | Tauri |
| --- | --- | --- |
| Binary | `release/linux-unpacked/fanotes` (electron-builder `--dir`, asar, Electron 43.1.0) from this branch | `fanotes-tauri` release build (`cargo build --release -p fanotes-tauri`, Rust 1.99.0, WebKitGTK 2.50.6) embedding the same `dist/` |
| Process start | `fanotes-execstamp` writes `CLOCK_MONOTONIC` and then `exec`s the binary, for both | same |
| Page control | CDP (`--remote-debugging-port`) | WebDriver: `WebKitWebDriver --target` attached to the running app (`WEBKIT_INSPECTOR_SERVER`, `TAURI_WEBVIEW_AUTOMATION=true`) |
| Input | XTest key and mouse events (`fanotes-xinject`), for both | same |
| Sandbox | `--no-sandbox` (there are no user namespaces in the container) | `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` |
| Rendering | Chromium's software path under Xvfb (SwiftShader) | WebKitGTK with Mesa llvmpipe under Xvfb |

Page control is used only to inject `lib/page-agent.js` and to read its results. All times are taken in the page (`performance.now()`) or from `CLOCK_MONOTONIC`. Page time is mapped to `CLOCK_MONOTONIC` with the smallest-round-trip ping of 15. That round trip is stored per run, and it is the error bound of any cross-process time.

- **Startup.** The time from process start (exec) to the later of two marks: `fanotes:tree-rendered` (the file tree committed its first rows) and `fanotes:note-open` (CodeMirror was created with the restored note's text). *Cold* means a fresh profile, with the page cache of every file the app maps, its install directory and the vault evicted first (`posix_fadvise(DONTNEED)` per file, so nothing else on the machine is affected). The share of those bytes still cached before and after the eviction is stored per run. Files in the container image's overlay layers do not always leave the cache, so cold is a best-effort cold. *Warm* means the same profile on its second and later starts. One unmeasured prime start fills that profile and its caches.
- **Memory.** The sum of `VmRSS`, and also of PSS from `smaps_rollup`, over every descendant of the app process. For Electron that is the main, zygote, renderer, GPU and utility processes. For Tauri it is the app, `WebKitWebProcess`, `WebKitNetworkProcess` and `WebKitGPUProcess`. RSS counts shared pages once per process, so the sum overstates Electron (many processes share Chromium). PSS divides shared pages, so it is the fairer total. Memory is sampled 8 s after startup with the note open (*idle*), after scrolling the long markdown note, and after scrolling the 200-page PDF. Each sample is the median of three samples taken 1 s apart.
- **Typing latency.** 500 XTest keystrokes, one every 60 ms, are typed at the end of `Start/Tippen.md` (lowercase letters and spaces, and Return every 100th key). For each key the agent takes the `keydown` `event.timeStamp`. It then waits for the first animation frame after a DOM change in the editor (`MutationObserver` on the visible `.cm-content`), and takes the time of a task posted right after that frame. *event → frame* is the metric. *injection → frame* runs from the moment the XTest event left the injector. It also contains the X server and toolkit delivery, plus the clock-mapping error. Every run checks that the text really grew by the number of keys.
- **Scrolling.** The scroll container of the long markdown note (`Gross/Langes Dokument.md`, ~1.8 MB, ~600 A4 pages) and of the 200-page PDF (`Skripte/Skript 200 Seiten.pdf`) is moved from top to bottom in about 600 frames. Each frame advances by max(40 px, height/600) from `requestAnimationFrame`. The harness records rAF-to-rAF intervals. The refresh interval is the median of 120 idle frames (16.7 ms for both). A frame longer than 1.5× the refresh counts as `round(interval/refresh) − 1` dropped frames. The PDF is scrolled after all 200 page placeholders exist, 3 s after opening it.
- **Sync time.** This is the TypeScript engine (`src/lib/sync/engine.ts`) with the desktop's own file host (`electron/sync.cjs` `createSyncHost`, no keychain) in one Node process, against the real server module (`fanotes-site/sync-api.mjs`). The server runs in its own process on 127.0.0.1 with an empty data directory per run, and a throw-away account. The phases are: device A's first sync of the 2,000-file vault (upload); device B's first sync (download); 20 edited notes on A, synced up and then down to B; and a no-op sync. After each download, B's vault must equal A's byte for byte. The renderer↔main IPC hop of the real app is not part of this number.

### Fixtures

`generate-fixtures.mjs` writes the same bytes for the same seed. `fixture-manifest.json` next to the vault holds every file's SHA-256 and one digest. The default seed's digest is `075f5b54…f0f5ed`. The vault has 2,000 files and 33.7 MB:

| Path | What |
| --- | --- |
| `Start/Letzte Notiz.md`, `Start/Tippen.md` | the note reopened at startup (~6 KB), the typing note (~2 KB) |
| `Gross/Langes Dokument.md` | ~600 A4 pages of markdown (headings, lists, tables, math, code), 1.8 MB |
| `Skripte/Skript 200 Seiten.pdf` + 9 smaller PDFs | text in Helvetica, vector figures, Flate streams |
| `Handschrift/*.famd` (40) | `fanotes-famd-v1` with 60–460 ink strokes each |
| `.fanotes/assets/ink-*.json/.png` (10+10), `Bilder/*.png` (30) | drawings referenced from notes, images |
| `Fach-00…19/Notiz *.md` (1,898) | ordinary notes from 300 B to 12 KB |
| `Schreiben/Roman.story/` (only with `--story-root`) | writing-mode story built with that branch's own model code (`newStory`, `keysBetween`, `sanitizeScene`): 98 chapters, 2,940 paragraphs, 1.06 M characters (~600 A5 pages) |

## Environment

The host was a Proxmox VE node (Linux 6.17), 8 logical CPUs, 38 GB RAM, shared with 7 other agents and VMs. The container was `fanotes-bench:1`, which is `fanotes-tauri-build:1` (Debian 12, Rust 1.99.0, WebKitGTK 2.50.6, webkit2gtk-driver, Xvfb) plus libnss3, Mesa, Node 22.23.2 and the two helpers. The container was capped at 4 CPUs, 6 GB RAM and 2 GB `/dev/shm`. Each result file records the CPU model, the cgroup limits and the 1/5/15-minute load average for every run. Before each start the harness waits up to 3 minutes for the 1-minute load to drop below 12. If the load stays higher it measures anyway and records it.

## Rerun

```bash
cd fanotes
npm ci --no-audit --no-fund && node node_modules/electron/install.js
npm run build:web && npx electron-builder --linux dir --x64 --publish never      # Electron + dist/
/srv/agents/fanotes/.cargo-target/docker/cargo-in-container.sh <repo> benchmarks \
  cargo build --release -p fanotes-tauri                                          # Tauri (embeds dist/)
sudo docker build -t fanotes-bench:1 scripts/bench-desktop/docker                  # after fanotes-tauri-build:1
cd scripts/bench-desktop
node generate-fixtures.mjs --out "$TMPDIR/bench/fx1"
./run-in-container.sh -- node run.mjs --host electron --app /work/fanotes/release/linux-unpacked/fanotes \
  --fixture "$TMPDIR/bench/fx1" --runs 3 --out results/electron-markdown.json
./run-in-container.sh -- node run.mjs --host tauri --app /target/release/fanotes-tauri \
  --fixture "$TMPDIR/bench/fx1" --runs 3 --out results/tauri-markdown.json
./run-in-container.sh -- node sync-bench.mjs --fixture "$TMPDIR/bench/fx1" --runs 3 --out results/sync-ts.json
node summarize.mjs                                                                 # prints the tables above
```

Options: `--runs`, `--suites startup-cold,session`, `--tests typing,long,pdf`, `--keys`, `--key-pace`, `--max-load`, and `--tauri-identifier` (the app-data folder name; `rust/platforms-ci` renames it to `ch.fasrv.fanotes.preview`).

**Writing mode** (`feature/writing-mode`): extract the branch into a temporary directory (`git archive`), build it there, generate the vault with `--story-root <that>/fanotes`, and run `run.mjs --variant writing --suites session` against its Electron build. It types into the story and scrolls it, and measures memory after opening it.

**Rust sync engine (WP3).** `sync-bench.mjs --engine rust --rust-cli <binary>` calls the bench CLI once per step. The contract is: `register|login|sync --server <origin> --vault <dir> --state <dir> [--email --device]`. The password comes in `FANOTES_BENCH_SYNC_PASSWORD`. The last stdout line is `{"status":"idle","uploads":n,"downloads":n,"ms":n}`. The harness records wall time, the CLI's own `ms`, the requests the server saw and the same vault equality checks.

**Windows.** Not measured. The optional `workflow_dispatch` workflow was skipped in this round, so the plan's Windows startup/memory numbers are still open.

## Additions inside the app

- `src/lib/benchMarks.ts`: `markOnce(name)` calls `performance.mark` once per page load. There are no listeners and no state, and nothing is sent anywhere.
- `src/components/FileTree.tsx`: `markOnce('fanotes:tree-rendered')` runs in an effect once the tree has entries.
- `src/components/MarkdownEditor.tsx`: `markOnce('fanotes:note-open')` runs after the CodeMirror view is created with a non-empty document.
