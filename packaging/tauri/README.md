# Tauri desktop preview: build container and packages

The Tauri shell (`fanotes/src-tauri`) needs WebKitGTK 4.1 development files on
Linux. They stay off the shared host; builds run in this container or in CI
(`.github/workflows/rust-desktop.yml`).

## Image

```sh
sudo docker build -t fanotes-tauri-build:2 packaging/tauri
```

Rust 1.99.0 (as `rust-toolchain.toml`), rustfmt, clippy, WebKitGTK/GTK 3
development packages, Xvfb, and Node 22 for the React bundle and the Tauri CLI.
`fanotes-tauri-build:1` is the same image without Node; do not retag it.

## Run a command

```sh
packaging/tauri/cargo-in-container.sh <worktree> <target-name> <command...>
```

The worktree is mounted at `/work`, the target dir is
`/srv/agents/fanotes/.cargo-target/container-<target-name>`, the host cargo
registry is shared, and the container is capped at 2 CPUs and 6 GB.
`FANOTES_TAURI_IMAGE` selects the image (default `fanotes-tauri-build:1`).

```sh
# Lint and test the shell (the GTK tests need a display).
packaging/tauri/cargo-in-container.sh . platforms-ci \
  bash -c 'cargo clippy -p fanotes-tauri --all-targets && xvfb-run -a cargo test -p fanotes-tauri'

# Build the React bundle and the deb + AppImage, then launch the AppImage once.
FANOTES_TAURI_IMAGE=fanotes-tauri-build:2 packaging/tauri/cargo-in-container.sh . platforms-ci bash -c '
  cd fanotes && npm ci --no-audit --no-fund && npm run build:web &&
  npx --yes @tauri-apps/cli@2.12.4 build --ci --config "{\"bundle\":{\"active\":true}}" --bundles deb,appimage &&
  APPIMAGE_EXTRACT_AND_RUN=1 FANOTES_SMOKE_TEST=1 xvfb-run -a /target/release/bundle/appimage/*.AppImage'
```

## Packages

`tauri.conf.json` keeps `bundle.active: false`, so a plain `tauri build` makes
no installer and Electron stays the release host. CI and the command above turn
bundling on with `--config '{"bundle":{"active":true}}'`. The packages are
workflow artifacts only; nothing is published.

The preview installs next to the shipping Electron app:

| | Electron (release) | Tauri preview |
| --- | --- | --- |
| Identifier | `ch.fanotes.app` | `ch.fasrv.fanotes.preview` |
| Product name | FaNotes | FaNotes Preview |
| Executable | `fanotes` / `FaNotes.exe` | `fanotes-preview` / `fanotes-preview.exe` |
| Profile (Linux) | `~/.config/FaNotes` | `~/.local/share/ch.fasrv.fanotes.preview` |
| Profile (Windows) | `%APPDATA%\FaNotes` | `%APPDATA%\ch.fasrv.fanotes.preview` (WebView2 data in `%LOCALAPPDATA%\ch.fasrv.fanotes.preview`) |
| Windows install | `%LOCALAPPDATA%\Programs\…` (electron-builder) | `%LOCALAPPDATA%\FaNotes Preview` (NSIS, per user) |

## Smoke test

`FANOTES_SMOKE_TEST=1` makes the shell exit with 0 once the React bundle
reported `fanotes:renderer-ready`, and with 3 when that does not happen within
`FANOTES_SMOKE_TIMEOUT_SECS` (default 120). Without the variable nothing
changes. See `fanotes/src-tauri/src/smoke.rs`.
