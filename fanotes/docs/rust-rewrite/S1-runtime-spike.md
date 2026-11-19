# Spike S1: the UI runtime for the Rust desktop host

Work package W1-B, 2026-11-19. Branch `rust/w1b-runtime-spike` (draft PR, **spike, do not merge**). Everything below was measured on one machine, in one container image and under one Xvfb, with the `fanotes/scripts/bench-desktop` harness from `feature/rust-desktop`, extended for a third host.

## Recommendation

- **Linux: Tauri 3 + CEF is the only Tauri runtime worth building on, but it is not ready yet. Electron keeps shipping on Linux.** Build the Wave 2 host so that it does not depend on the runtime (one `fanotes-host` dispatch behind a thin shell, as in this spike). Switch the Linux build to CEF only when all of these hold:
  - tauri#16189 (100 % idle CPU) is fixed, or the patch from that issue is carried in the build;
  - Tauri 3 has reached at least beta;
  - Linux packaging works for our formats (AppImage is broken today: tauri#16204; or we move to deb/rpm/tar.gz);
  - the startup and memory gaps below are re-measured on the owner's Linux machine with a real GPU and come out within the PLAN gate.
- **WebKitGTK stays ruled out.** Re-measured on WebKitGTK 2.54 (newer than the 2.50 of the 2026-11-15 run), it still loses every latency metric by 3–13×.
- **Windows: Tauri 2 + WebView2 is feasible, and it is the recommended runtime.** The branch's WebView2 shell `cargo check`s for `x86_64-pc-windows-msvc`. WebView2 is the system Chromium, sandboxed and GPU-accelerated, with no runtime in our download. Tauri 3 + CEF is not an option on Windows while it runs unsandboxed (tauri#16431).
- **One codebase for both.** Tauri 3 ships both runtimes (`tauri-runtime-wry` 3.0.0-alpha.6 for WebView2, `tauri-runtime-cef` 3.0.0-alpha.7) behind one `tauri::Builder::runtime(...)`, and this spike's shell needed no Tauri 2 → 3 code beyond renames. Wave 2 can start the Windows host on Tauri 2 now and move it to Tauri 3 (wry runtime on Windows, CEF on Linux) once Tauri 3 is beta. Alternatively it can start on Tauri 3 directly, if the team accepts alpha churn on Windows too.

## Numbers (Linux, Xvfb 1440×900, software rendering, n=3 each)

Median (min–max, n). The machine was an i3-12100F (8 threads, shared with other agents). The container was Debian 13 with 4 CPUs, 6 GB RAM and 2 GB `/dev/shm`. Every host ran in the same image `fanotes-bench-trixie:1` (Mesa 25.0.7, WebKitGTK 2.54.0, GTK 4.18.6), on the same generated vault (2,000 files, digest `075f5b54…f0f5ed`) with the same settings, and was driven through XTest. The page was controlled over CDP for Electron and CEF and over WebDriver for WebKitGTK. All three load the same `dist/` (web build of `origin/main` at `a8c34215`, plus the two inert startup marks).

| Metric | Electron 43.1 (Chromium 150) | Tauri 3 α + CEF 154 | Tauri 2 + WebKitGTK 2.54 |
| --- | --- | --- | --- |
| Startup, cold (exec → tree + last note) | 1015 ms (776–1204, n=3) | 1416 ms (1363–1457, n=3) | 1336 ms (1184–1359, n=3) |
| Startup, warm | 485 ms (464–583, n=3) | 757 ms (677–897, n=3) | 871 ms (667–889, n=3) |
| Memory idle, note open: PSS sum | 541 MB (472–618, n=3) | 781 MB (745–789, n=3) | 886 MB (685–923, n=3) |
| Memory idle, note open: RSS sum | 841 MB (768–919, n=3) | 1301 MB (1265–1308, n=3) | 1072 MB (873–1110, n=3) |
| Idle CPU, 10 s, whole process tree (% of one core) | 47.1 % (26.8–70.0, n=3) | 102.6 % (100.5–102.7, n=3) | 59.8 % (42.0–136.5, n=3) |
| Memory after the long note: RSS sum | 1139 MB (1098–1159, n=3) | 1509 MB (1489–1538, n=3) | 1140 MB (1101–1142, n=3) |
| Memory after the 200-page PDF: PSS sum | 2110 MB (1621–2346, n=3) | 1357 MB (1347–1359, n=3) | 999 MB (983–1022, n=3) |
| Memory after the 200-page PDF: RSS sum | 2660 MB (2016–2810, n=3) | 1917 MB (1903–1918, n=3) | 1188 MB (1171–1209, n=3) |
| Typing: key event → frame, p50 | 13.2 ms (11.8–17.7, n=3) | 13.7 ms (12.8–13.8, n=3) | 20.5 ms (17.0–480.0, n=3) |
| Typing: key event → frame, p95 | 20.9 ms (19.3–25.5, n=3) | 20.9 ms (20.2–21.0, n=3) | 86.0 ms (56.0–503.1, n=3) |
| Typing: XTest injection → frame, p95 | 19.2 ms (18.0–24.1, n=3) | 19.4 ms (18.5–19.5, n=3) | 86.2 ms (55.7–506.4, n=3) |
| Scroll long note: p95 frame time | 49.9 ms (33.4–50.0, n=3) | 66.6 ms (33.4–66.7, n=3) | 180.3 ms (176.0–186.3, n=3) |
| Scroll long note: dropped frames | 232 (199–285, n=3) | 402 (199–591, n=3) | 3630 (3597–3924, n=3) |
| Scroll 200-page PDF: p95 frame time | 33.4 ms (33.3–49.9, n=3) | 16.7 ms (16.7–16.7, n=3) | 214.1 ms (146.0–237.1, n=3) |
| Scroll 200-page PDF: dropped frames | 109 (35–280, n=3) | 0 (0–5, n=3) | 2761 (2351–3127, n=3) |
| 1-min load average at the starts | 5.5–6.9 | 4.2–5.7 | 6.4–7.0 |
| Errors in the run | 0 | 0 | 0 |

**Settled idle CPU.** The 10 s idle window above starts 8 s after startup, when all three hosts are still doing their startup work. A second run (`--tests none --idle-wait 60000`) measures 10 s starting 70 s after startup:

| Metric | Electron 43.1 (Chromium 150) | Tauri 3 α + CEF 154 | Tauri 2 + WebKitGTK 2.54 |
| --- | --- | --- | --- |
| Startup, warm | 569 ms (454–723, n=3) | 775 ms (758–1111, n=3) | 907 ms (857–998, n=3) |
| Memory idle, note open: PSS sum | 522 MB (521–606, n=3) | 757 MB (756–772, n=3) | 853 MB (732–853, n=3) |
| Idle CPU, 10 s, whole process tree (% of one core) | 2.4 % (1.9–4.2, n=3) | 102.0 % (101.7–106.9, n=3) | 60.3 % (53.4–60.7, n=3) |
| 1-min load average at the starts | 4.7–6.6 | 4.7–6.7 | 4.3–6.9 |
| Errors in the run | 0 | 0 | 0 |

**Repeat of the session suite** (a second, independent n=3 with the same default flags; this run was meant as the GPU-pipeline variant, but the flag did not reach the apps, see "Bugs fixed in the harness"):

| Metric | Electron 43.1 (Chromium 150) | Tauri 3 α + CEF 154 |
| --- | --- | --- |
| Startup, warm | 585 ms (460–771, n=3) | 720 ms (694–744, n=3) |
| Memory idle, note open: PSS sum | 539 MB (523–540, n=3) | 766 MB (760–768, n=3) |
| Memory idle, note open: RSS sum | 837 MB (819–839, n=3) | 1281 MB (1278–1288, n=3) |
| Idle CPU, 10 s, whole process tree (% of one core) | 34.5 % (33.4–36.9, n=3) | 102.4 % (102.4–103.6, n=3) |
| Memory after the long note: RSS sum | 1151 MB (1150–1194, n=3) | 1501 MB (1496–1523, n=3) |
| Memory after the 200-page PDF: PSS sum | 2061 MB (1873–2251, n=3) | 1306 MB (1301–1310, n=2) |
| Memory after the 200-page PDF: RSS sum | 2534 MB (2275–2707, n=3) | 1866 MB (1864–1868, n=2) |
| Typing: key event → frame, p50 | 17.6 ms (13.1–18.8, n=3) | 12.6 ms (11.7–13.6, n=3) |
| Typing: key event → frame, p95 | 24.7 ms (20.5–25.6, n=3) | 19.7 ms (19.2–20.8, n=3) |
| Typing: XTest injection → frame, p95 | 23.4 ms (18.6–24.0, n=3) | 18.4 ms (17.8–19.5, n=3) |
| Scroll long note: p95 frame time | 33.4 ms (33.4–39.2, n=3) | 50.0 ms (33.4–50.0, n=3) |
| Scroll long note: dropped frames | 192 (140–213, n=3) | 276 (157–379, n=3) |
| Scroll 200-page PDF: p95 frame time | 33.4 ms (33.3–50.0, n=3) | 16.8 ms (16.8–16.8, n=2) |
| Scroll 200-page PDF: dropped frames | 134 (81–334, n=3) | 0 (0–0, n=2) |
| 1-min load average at the starts | 3.8–6.2 | 5.5–6.7 |
| Errors in the run | 0 | 1 |

**GPU-pipeline variant** (`--ignore-gpu-blocklist`: both Chromium hosts composite and rasterize on ANGLE/llvmpipe, the pipeline real hardware uses):

| Metric | Electron 43.1 (Chromium 150) | Tauri 3 α + CEF 154 |
| --- | --- | --- |
| Startup, warm | 644 ms (600–650, n=3) | 833 ms (779–858, n=3) |
| Memory idle, note open: PSS sum | 602 MB (602–667, n=3) | 864 MB (848–884, n=3) |
| Memory idle, note open: RSS sum | 899 MB (897–963, n=3) | 1379 MB (1361–1400, n=3) |
| Idle CPU, 10 s, whole process tree (% of one core) | 35.6 % (25.7–83.4, n=3) | 102.5 % (102.3–103.0, n=3) |
| Memory after the long note: RSS sum | 1269 MB (1205–1283, n=3) | 1642 MB (1539–1652, n=3) |
| Memory after the 200-page PDF: PSS sum | 1040 MB (959–1067, n=3) | 1350 MB (1283–1435, n=3) |
| Memory after the 200-page PDF: RSS sum | 1350 MB (1269–1378, n=3) | 1879 MB (1810–1960, n=3) |
| Typing: key event → frame, p50 | 17.6 ms (16.2–17.7, n=3) | 14.1 ms (12.7–14.3, n=3) |
| Typing: key event → frame, p95 | 26.2 ms (25.8–26.6, n=3) | 21.5 ms (19.9–21.6, n=3) |
| Typing: XTest injection → frame, p95 | 25.1 ms (24.0–25.2, n=3) | 19.8 ms (18.4–20.2, n=3) |
| Scroll long note: p95 frame time | 100.0 ms (66.7–100.1, n=3) | 156.7 ms (100.0–183.3, n=3) |
| Scroll long note: dropped frames | 872 (728–1064, n=3) | 1637 (1440–1846, n=3) |
| Scroll 200-page PDF: p95 frame time | 133.4 ms (116.7–166.6, n=3) | 133.4 ms (116.7–183.3, n=3) |
| Scroll 200-page PDF: dropped frames | 1225 (1071–1633, n=3) | 1395 (1360–1794, n=3) |
| 1-min load average at the starts | 3.4–6.6 | 5.6–6.6 |
| Errors in the run | 0 | 0 |

### What the numbers say

- **Typing:** CEF equals or slightly beats Electron in all three configurations. The p95 is 20.9 against 20.9 ms with default flags, 19.7 against 24.7 ms in the repeat, and 21.5 against 26.2 ms on the GPU pipeline. WebKitGTK has 4× the tail (86 ms; one run had 503 ms).
- **PDF scrolling (200 pages):**
  - With default flags, CEF is the best of the three: p95 16.7 ms and 0 dropped frames, against Electron's 33.4 ms (35–334 dropped) and WebKitGTK's 214 ms.
  - **This is a fallback-configuration effect, not a runtime advantage.** Under Xvfb, Electron forces GPU rasterization on llvmpipe, while CEF rasterizes in software (see GPU). With both on the same GPU pipeline (`--ignore-gpu-blocklist`), the PDF result is a tie: p95 133.4 ms against 133.4 ms.
- **Long-note scrolling:** CEF is behind Electron in every configuration: p95 50–67 ms against 33–50 ms with default flags, and 157 ms against 100 ms on the GPU pipeline. WebKitGTK is at 180 ms.
- **Startup:** CEF is the slowest Chromium host: cold +40 % (1.42 s against 1.02 s) and warm +50–55 % (0.72–0.76 s against 0.49–0.59 s). WebKitGTK sits between them cold and is the slowest warm. CEF's startup maps the unstripped 1.45 GB `libcef.so` as built (a stripped one may start faster; not measured) and Tauri's DevTools-protocol round trip before the first navigation (by the runtime's design: it holds the first navigation until its document-start scripts are installed).
- **Memory:**
  - At idle, CEF uses 42–45 % more PSS than Electron in every configuration (757–864 MB against 522–602 MB). The CEF host process holds the Chromium browser process, the Rust host and the 240 MB binary with the embedded `dist/` in one PSS.
  - After the PDF with default flags, Electron uses the most (2.1 GB PSS), but that comes from GPU raster on software compositing. On the GPU pipeline, Electron uses 1.04 GB and CEF 1.35 GB. WebKitGTK uses the least (1.0 GB).
- **Idle CPU:** once the apps settle, Electron is at 2–4 % of a core. **CEF stays at 100–107 %, all of it in the main thread of the host process.** That is tauri#16189 (Chromium's `MessagePumpGlib` source returns timeout 0 under `external_message_pump`), reproduced in every run. Until it is fixed, a CEF build would drain laptop batteries. The latency numbers above were measured with that spinning core in place. WebKitGTK also does not settle: it stays at 53–61 %, mostly in `WebKitWebProcess`.
- **Reliability:** 0 harness errors for Electron and WebKitGTK. CEF had one PDF that did not open within the timeout in 9 PDF opens ("did not open in time", repeat run 3), which needs a look in Wave 2.

## Bundle and install size

| | Electron 43.1 | Tauri 3 + CEF 154 | Tauri 2 + WebKitGTK |
| --- | --- | --- | --- |
| What ships | `linux-unpacked/` (asar + Electron) | stripped binary with the embedded `dist/` + CEF runtime files | stripped binary with the embedded `dist/` |
| Install size on disk | 573 MB | 587 MB (1.76 GB unstripped `libcef.so` + binary as built) | 229 MB (+ system WebKitGTK, about 100 MB, shared with the OS) |
| …of which runtime | ≈ 265 MB | ≈ 375 MB (`libcef.so` 272 MB stripped, locales 49 MB, paks/ICU/SwiftShader 52 MB) | 0 (system) |
| Download, `tar.gz` (gzip -6, same as the release tarball) | 321 MB (the release `…x86_64.tar.gz` is 320 MB, AppImage 323 MB) | 363 MB | 215 MB |
| Windows installer | 283 MB (`FaNotes-Setup-…-x64.exe`, measured release) | n/a (not a Windows candidate) | Tauri 2 + WebView2: about 215 MB estimated (same embedded `dist/`, runtime is in the OS) |

The Electron tree also carries `native-math` and `native-ocr` (36 MB), which the two Tauri shells do not ship yet.

Most of every download is the app itself: `dist/` is 330 MB, and 295 MB of that is `dist/ocr`. The runtime cost on top of that: Electron ≈ 265 MB (220 MB `fanotes` binary + paks, ICU, SwiftShader, locales); CEF ≈ 375 MB (272 MB stripped `libcef.so` + 49 MB locales + paks/ICU/SwiftShader); WebKitGTK and WebView2 ≈ 0 (system libraries). Trimming CEF's locales to de/en saves about 47 MB. The CEF `libcef.so` as downloaded is 1.45 GB with debug info, so **packaging must strip it**: neither the `cef-dll-sys` copy nor `cargo build --release` does.

## Maturity and risk of Tauri 3 + CEF (as of 2026-11-19)

**Versions.** `tauri` 3.0.0-alpha.6 (2026-11-06), `tauri-runtime-cef` 3.0.0-alpha.7 (2026-11-06), `tauri-build` 3.0.0-alpha.4, and `cef` = 154.5.0+154.0.34. That is CEF 154.0.34 on Chromium 154.0.8037.98. The `cef` crate itself is already at 156.7.0 (CEF 156), and an open PR (tauri#16573) bumps the runtime to 156. There have been 7 runtime alphas in 10 weeks. Each alpha pins one exact CEF build (`cef = "=154.5.0"`), so the Chromium version, security fixes included, follows Tauri's release cadence and not ours.

**What worked in this spike on the first try.**
- The unchanged `dist/` and the unchanged `fanotes-api.js` bridge run on the CEF runtime. One catch-all invoke handler forwards every `fanotes:*` channel to `fanotes_host::Host::dispatch` (vault, tree, notes and PDFs all work), and the shell is about 150 lines. The bridge loads as a plugin `initialization_script`, the same fix as for Tauri 2.
- **The Linux first-run EULA** (`ContentMainRun failed with exit code 28`) is fixed upstream. tauri#15980 was merged on 2026-09-05 and is in every 3.x alpha. The runtime passes `--no-first-run` itself, and nothing was needed here.
- **libEGL/libGLESv2:** CEF 154 no longer ships them (ANGLE is inside `libcef.so`), and the bundler stopped looking for them (tauri#16441 and #16338, both closed). ANGLE initialised without them (`gl=egl-angle,angle=opengl` on Mesa).

**Build and packaging facts measured here.**
- **The runtime needs GTK ≥ 4.14** at build time and at run time. It uses `gtk4` 0.11 through `tauri-winit`, a fork of the winit 0.31 beta. Debian 12 (GTK 4.8, the base of `fanotes-bench:1`) cannot build it, so this spike moved every host to Debian 13. The supported Linux floor becomes about Ubuntu 24.04, Debian 13 or Fedora 40.
- **GTK 3 must not be loaded into the process,** because GTK 4 aborts when GTK 3 symbols are present. `fanotes-host` linked GTK 3 through `rfd/gtk3`. The spike adds a `dialogs-portal` feature (XDG portal file dialogs), and the CEF shell turns off `dialogs-gtk3`. Wave 2 has to keep every GTK 3 caller out of the CEF host: rfd, and the `webkit2gtk`/`gtk` 0.18 code in `src-tauri` (PDF export, window capture).
- **CEF download:** `cef-dll-sys` downloads the "minimal" distribution at build time (312 MB `.tar.bz2`, 1.8 GB unpacked) and copies it next to the binary. `CEF_PATH` keeps one copy per machine or CI cache. Build time on 2 cores: 10 min for the first build, 1.5 min incremental. `libcef.so` arrives with debug info (1.45 GB) and must be stripped for packaging (272 MB).
- **Linux bundles:** deb and rpm bundles of CEF apps succeed (reported in tauri#16204; not built here). **AppImage bundling is broken** (tauri#16204: the bundler downloads a helper script whose sources were deleted upstream), and FaNotes ships an AppImage and a tar.gz today. Sidecars break in CEF deb bundles (tauri#16577).
- **Updater:** `tauri-plugin-updater` 3.0.0-alpha.3 exists, and FaNotes plans its own `fanotes-updater` (W1-D) anyway. A full CEF update is about 1.7× the Tauri 2 payload (363 against 215 MB compressed) (see sizes), so delta updates matter more.

**Sandbox.**
- **Linux:** the runtime keeps Chromium's sandbox where it can (`SandboxPolicy::Auto`). That needs either the setuid `chrome-sandbox` helper (shipped, 31 KB; deb/rpm must install it root:4755) or unprivileged user namespaces. With neither, for example from an AppImage on Ubuntu ≥ 23.10, the runtime runs unsandboxed and logs a warning. Electron behaves the same way. The benchmark container has no user namespaces, so every Chromium host ran with `--no-sandbox` / `SandboxPolicy::Disabled`, and WebKitGTK ran with `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`.
- **Windows: a Tauri 3 + CEF app currently runs unsandboxed, whatever the policy says.** This is the runtime's own documentation: since M138 the broker needs CEF's `bootstrap.exe` host, which loads the app as a DLL. The fix, tauri#16431, is an open PR, last updated 2026-10-30. Electron and WebView2 are both sandboxed on Windows.

**Open issues that affect FaNotes directly** (all open on 2026-11-19):

| Issue | Effect on FaNotes | Seen here |
|---|---|---|
| tauri#16189: on Linux the idle main thread spins at 100 % (also cef#3002; a Chromium fix is in review; a patch in the issue fixes it to 0.4 %) | Battery drain on every Linux laptop | **Yes:** 100–107 % of one core in every run |
| tauri#16251 / #16351: on Linux, keyboard input is lost at startup or after refocus | Typing does not reach the editor | No: all 9 typing runs got 500/500 keys, with XTest focus on Xvfb. Must be checked on KDE and Hyprland |
| tauri#16249: Linux browser accelerators (e.g. Ctrl+Shift+T) never reach the renderer | Conflicts with FaNotes shortcuts | Not tested |
| tauri#16479: custom-protocol Range requests past byte 0 fail | pdf.js range loading, audio/video in notes | Not hit (PDFs come over IPC) |
| tauri#16131: drag and drop does not work on Linux | Importing files and images by drag and drop | Not tested |
| tauri#16204: AppImage bundling fails | The current Linux release format | n/a |
| tauri#16431 (PR): Windows sandbox | Security on Windows | n/a |
| tauri#16203: WebGPU only on SwiftShader | Future GPU work in the webview | n/a |
| tauri#16474, #16205, #16480: no WM_CLASS, white flash at map, size after fullscreen | Hyprland/KDE window rules, polish | n/a |

**X11 only.** The runtime always passes `--ozone-platform=x11` and forces `GDK_BACKEND=x11`, because it reparents CEF's X11 windows by XID. On Wayland desktops it therefore always runs under XWayland. That matches FaNotes' current policy: Electron is forced to X11 so the pen and the trackpad share one seat. It also rules out native Wayland with this runtime for now.

## Windows: Tauri 2 + WebView2 (feasibility only, no Windows machine)

- **The compile check passes.** `cargo check --release --target x86_64-pc-windows-msvc -p fanotes-tauri` succeeds on `origin/feature/rust-desktop`, the branch with the WebView2 port (`webview2.rs`, `export_webview2.rs`, `capture_webview2.rs`, 703 lines), together with `fanotes-host` and the branch's sync, index and pdf crates. Versions: tauri 2.12.3, tauri-runtime-wry 2.12.1, wry 0.57.0, webview2-com 0.39.1.
  - Two workarounds were needed, only for the cross check. `clang-cl` (clang 18 in cl mode) is the C compiler. Three stub headers (`assert.h`, `string.h`, `stdlib.h` with `_byteswap_*`) let ring's build script compile without the MSVC CRT. They are never linked.
  - Linking and running need a Windows runner. The branch has an optional `workflow_dispatch` workflow for it.
- **Main's `fanotes/src-tauri` does not build for Windows.** Its `gtk`, `webkit2gtk` and `rfd gtk3` dependencies are not target-gated. The branch already gates them, so Wave 2 should take the branch's `Cargo.toml` layout.
- **Why WebView2 is fine on Windows.** It is the system's Chromium (Edge, evergreen, preinstalled on Windows 10 21H2+ and 11). It is sandboxed, GPU-accelerated through D3D11, and runs the same Blink as Electron, so the WebKitGTK problem does not apply.
  - Pen input reaches the page as Pointer Events with pressure and tilt, from WM_POINTER underneath.
  - Risks: the Chromium version is not ours (evergreen drift; test against Edge Beta), and there are two web runtimes to maintain (WebView2 on Windows, CEF on Linux).
- **Size on Windows.** The Tauri binary with the embedded `dist/` is 240 MB on Linux (stripped), and should be about the same on Windows. Today's `FaNotes-Setup-2026.11.3-beta.5-x64.exe` is 283 MB. The runtime part of the download drops from about 180–265 MB (Electron) to 0, because WebView2 is part of the OS. The OCR models (295 MB uncompressed) stay the bulk of the download, whatever the runtime.
- **CEF on Windows** was not checked. `cef-dll-sys` downloads the Windows CEF and builds its C++ wrapper with CMake and MSVC, which cannot run here. Without a sandbox (above), it is not a candidate for Windows anyway.

## Pen input (X11 measured, XWayland by reasoning)

**X11, measured.** XTest cannot create a pen, and Xvfb only has the XTest core devices, so the probe uses a real X server instead:
- `pen-probe.sh` runs a real Xorg (dummy video driver, `evdev` input driver; libinput needs a udev database that the container lacks) in a privileged container.
- `fanotes-pen-uinput` creates a uinput tablet: BTN_TOOL_PEN, ABS_PRESSURE 0–4095, ABS_TILT_X/Y, and a Wacom-like id.
- The probe draws two 40-step strokes over the window while the page records pointer events.

| | Electron 43.1 (Chromium 150) | Tauri 3 + CEF 154 |
|---|---|---|
| `pointermove` events with `pointerType: 'pen'` | 24 | 28 |
| Distinct pressure values in moves (range) | 19 (0–0.714) | 23 (0–0.723) |
| Tilt | `20,-20` / `-30,30` on events that carry a tilt change, `0,0` otherwise | Same |
| `getCoalescedEvents()` per move | 3–5 | 3–5 |
| `pointerdown` pressure | 0 | 0 |

**CEF delivers pen input exactly like Electron.** That is expected: it is the same Chromium Ozone/X11 XI2 code reading the "Abs Pressure" and "Abs Tilt" valuators. The CEF browser window is Chromium's own X11 child window, so the GTK 4 parent does not touch its XI2 events.

The two quirks, pressure 0 on `pointerdown` and tilt only on events whose tilt valuator changed, appear in both hosts. They are Chromium's behaviour, which the shipping app already lives with.

**XWayland, by reasoning.** No Wayland compositor with tablet input could run headless here. XWayland exposes `zwp_tablet_v2` tools as XI2 slave devices with pressure and tilt valuators ("xwayland-tablet stylus"). Chromium's X11 path reads those the same way as the evdev device above. The CEF runtime forces X11, so on Hyprland or KDE it always takes this path. This is the same path the shipping Electron app takes today (forced X11), so the expectation is the same behaviour as Electron under XWayland. It still has to be confirmed on the owner's Linux machine with a real pen, using the checklist in `perf-research/02`.

## GPU: all numbers are software rendering

The RTX 3070 could not render here:
- The host's `nvidia_drv.so` is a 0-byte stub and `display_mode` is disabled, so there is no NVIDIA X server.
- Inside Xvfb with GPU 0 passed through (CDI), NVIDIA's Vulkan driver does not offer `VK_KHR_surface`/`VK_KHR_xcb_surface`. ANGLE-on-Vulkan then fails with "Internal Vulkan error (-7)" in both Electron and CEF.
- NVIDIA EGL has no X11 platform without the NVIDIA X server.

With default flags under Xvfb, `SystemInfo.getInfo` reports:
- **Electron:** software compositing, but forced GPU rasterization on ANGLE/llvmpipe (`rasterization: enabled_force`, 4 raster threads).
- **CEF:** software compositing and software rasterization (`rasterization: disabled_software`, `multiple_raster_threads: disabled_off`).
- **WebKitGTK:** Mesa llvmpipe.

So the default-flag PDF difference between Electron and CEF is partly a difference in the fallback configuration. The GPU-pipeline variant (`--ignore-gpu-blocklist`) puts both Chromium hosts on GPU compositing, GPU raster and WebGL over llvmpipe, structurally what real hardware runs. **The deciding startup, memory and scroll comparison must still be repeated on the owner's machines with a real GPU** (PLAN gate).

## What is in the PR

- `fanotes/src-tauri-cef/`: the Tauri 3 + CEF shell (its own Cargo workspace, so the alpha crates, GTK 4 and CEF never touch the main lockfile or CI). It has two unit tests. The spike-only environment switches are `FANOTES_CEF_REMOTE_DEBUGGING_PORT`, `FANOTES_CEF_NO_SANDBOX` and `FANOTES_CEF_ARGS`.
- `crates/fanotes-host`: a `dialogs-portal` feature next to the default `dialogs-gtk3`. The default build is unchanged.
- `fanotes/src-tauri` (Tauri 2): the two fixes from `RUST_DESKTOP_BENCHMARKS.md`. The valid icons come from the branch, and the bridge runs as a plugin init script. Without them that shell cannot be measured.
- `fanotes/src/lib/benchMarks.ts` + two `markOnce` calls (FileTree, MarkdownEditor): the inert startup marks from the branch.
- `fanotes/scripts/bench-desktop/`: the harness from `feature/rust-desktop`, plus:
  - a `--host cef` mode;
  - idle CPU per process (`--idle-wait`);
  - the WebGL renderer string;
  - `--chromium-args`;
  - `run-in-container.sh --image/--gpu`;
  - `Dockerfile.trixie` (the one image for all three hosts);
  - `s1-run-all.sh` and `s1-summarize.mjs`;
  - `gpu-probe.mjs` (`SystemInfo.getInfo`);
  - the pen probe (`pen-probe.sh`, `pen-probe.mjs`, `docker/Dockerfile.pen`, `docker/pen-uinput.c`);
  - the raw results in `results/s1-*.json` and `results/pen-*.json`.

### Bugs fixed in the harness

- `--chromium-args "--flag"` was read as `true`, because the generic parser treats a value that starts with `--` as a boolean flag. The first "GPU-pipeline" run therefore ran with default flags. It is kept as the repeat run, and the variant was re-run after the fix.
- `fincore` (page-cache residency) is in `util-linux-extra` on Debian 13. It was missing, so the cold runs logged "cache 0% → 0%". The eviction itself (`posix_fadvise`) worked. The Dockerfile now installs the package.

## Rerun

```bash
cd fanotes && npm run build:web && npx electron-builder --linux dir --x64 --publish never
sudo docker build -t fanotes-bench-trixie:1 -f scripts/bench-desktop/docker/Dockerfile.trixie scripts/bench-desktop/docker
# CEF shell (own workspace; CEF_PATH caches the 1.8 GB distribution)
docker run … fanotes-bench-trixie:1 bash -c 'cd /work/fanotes/src-tauri-cef && CEF_PATH=/target/cef-dist cargo build --release'
# Tauri 2 shell
docker run … fanotes-bench-trixie:1 cargo build --release -p fanotes-tauri
cd scripts/bench-desktop && node generate-fixtures.mjs --out "$TMPDIR/bench/fx1"
./s1-run-all.sh "$TMPDIR/bench/fx1" 3 && node s1-summarize.mjs
sudo docker build -t fanotes-bench-pen:1 -f docker/Dockerfile.pen docker && ./pen-probe.sh --host cef --app /target/release/fanotes-tauri-cef
```
