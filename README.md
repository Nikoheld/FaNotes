<div align="center">
  <img src="fanotes-site/public/assets/fanotes.svg" width="92" height="92" alt="FaNotes logo">
  <h1>FaNotes</h1>
  <p><strong>A local-first notebook that puts Markdown, pen handwriting and annotated PDFs on the same page.</strong></p>

  [![Stable](https://img.shields.io/github/v/release/Nikoheld/FaNotes?display_name=tag&label=stable&color=6f8cff)](https://github.com/Nikoheld/FaNotes/releases/latest)
  [![Beta](https://img.shields.io/github/v/release/Nikoheld/FaNotes?include_prereleases&display_name=tag&label=beta&color=b878eb)](https://github.com/Nikoheld/FaNotes/releases)
  [![License](https://img.shields.io/badge/license-MIT-d4b54c)](fanotes/packaging/LICENSE)

  [Website](https://fanotes.fasrv.ch/) · [Downloads](https://github.com/Nikoheld/FaNotes/releases) · [Build from source](#build-from-source)
</div>

![FaNotes desktop overview](fanotes-site/public/assets/hero-desk.webp)

FaNotes is a desktop app (Electron, Windows and Linux) for school, university and personal notes. Your notes are ordinary files in a folder you choose, so they work offline and stay yours.

## Features

- **Handwriting and pen ink.** Write with a pen or drawing tablet on a paper-like page. Pressure-sensitive brushes, an eraser, and local handwriting and math recognition that you can train with your own samples (GlyphenWerk).
- **Markdown notes.** Folders, wiki links, task lists, tables, code, math and collapsible sections, with typed text and ink on one continuous page.
- **PDFs with annotations and side pages.** Mark up worksheets and papers, and add blank pages beside a PDF page for extra writing.
- **Split view.** Open two notes side by side.
- **Sync.** Optional end-to-end encrypted sync between devices through a FaNotes account; the server only stores ciphertext (see [`fanotes/docs/SYNC.md`](fanotes/docs/SYNC.md)).
- **MCP Server.** Let AI tools such as Claude or Cursor read (and, if you allow it, write) your vault through a local Model Context Protocol server, configured under Settings. The remote connector is described in [`fanotes/docs/MCP.md`](fanotes/docs/MCP.md).
- **Offline, local-first vault.** No account is needed for local notes. Cloud AI is used only if you configure a provider yourself.
- **Customizable.** Themes, fonts, paper, brushes and German or English UI.

![Handwriting conversion in FaNotes](fanotes-site/public/assets/handwriting-conversion.webp)

## Downloads

Get the latest installer from [GitHub Releases](https://github.com/Nikoheld/FaNotes/releases).

| Platform | Package |
| --- | --- |
| Windows 10 / 11 (x64) | Installer and portable `.exe` ([install notes](fanotes/packaging/INSTALL_WINDOWS.md)) |
| Linux (x86_64) | AppImage ([install notes](fanotes/packaging/INSTALL_ARCH.md)) |

Releases ship in two channels, **Stable** and **Beta** (marked as prerelease). Switch under Settings, Updates. Update manifests are signed and packages are verified with SHA-256 before installation. See [`fanotes/RELEASE_POLICY.md`](fanotes/RELEASE_POLICY.md).

## Build from source

Requirements: Node.js 22 and npm.

```bash
cd fanotes
npm install
npm run dev          # Electron + Vite dev server
npm run dev:web      # browser build only
npm run typecheck
npm run dist:linux   # AppImage, output in fanotes/release
```

`npm run dist:windows` builds the Windows installer and portable package. Many checks live in `fanotes/scripts` and run as `npm run check:<name>`, for example `check:sync`, `check:updater` and `check:i18n`.

## Project structure

```text
fanotes/        Desktop app: React UI (src/), Electron main process (electron/), scripts, packaging, docs
fanotes-site/   Website, update API, sync and backup server
crates/         Rust crates (ink, recognition, spelling, .famd codec, sync), partly compiled to WebAssembly
android/        Native Android tablet client (Kotlin, Jetpack Compose), see android/README.md
src/            GlyphenWerk, the handwriting training tool, and the shared recognition engine
```

## File format

Notes are plain `.md` files. Handwritten and PDF notes use a `.famd` companion file that holds the Markdown text plus the ink and page data (schema `fanotes-famd-v1`). The codec is in [`fanotes/src/lib/famd.ts`](fanotes/src/lib/famd.ts) and the format contract is described in [`android/ARCHITECTURE.md`](android/ARCHITECTURE.md).

## Contributing

Issues and pull requests are welcome. Keep changes focused, run `npm run typecheck` and the checks that touch your change, and do not commit build output, `node_modules`, keys or personal vaults.

## License

FaNotes source code is available under the [MIT License](fanotes/packaging/LICENSE). Bundled models, fonts, dictionaries and third-party components retain their respective licenses; see [THIRD_PARTY_NOTICES.md](fanotes/packaging/THIRD_PARTY_NOTICES.md).
