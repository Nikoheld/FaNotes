# FaNotes für Android-Tablets

Native tablet client (Kotlin, Jetpack Compose) for the FaNotes vault. The writing surface is an Android view, not a WebView. It speaks the same `.md` + `.famd` files and the same end-to-end sync protocol as the desktop and web apps. Format and protocol details are in [ARCHITECTURE.md](ARCHITECTURE.md).

## What this version does

- Pen, eraser, and selection on a paper page, with pressure, tilt, orientation, the stylus eraser, the barrel button, and hover.
- Palm rejection for 850 ms after the pen lifts, the same window as the desktop. A finger scrolls, pinches to zoom, long-presses to select, and swipes between notes. A finger does not lay ink unless **Finger zeichnet** is on.
- Notes and folders: create, open, rename is available on the store, delete. Markdown sits beside the page. PDF and image worksheets can be annotated.
- Autosave, undo/redo, paper styles, and the desktop brushes (fineliner, pencil, marker, highlighter, calligraphy).
- Account login and bidirectional sync with `https://fanotes.fasrv.ch`. Offline writes sync when the network returns. Conflicts keep both copies under the desktop name `Konflikt`.

Handwriting recognition is a `HandwritingRecognizer` seam. The stroke JSON already matches the desktop, so a later NDK build of GlyphenWerk can plug in without a format change. Math editing and collapsible sections are preserved in the file and not edited here yet.

## Requirements

- JDK 17 or newer (the project compiles the core module to JVM 17 bytecode).
- Android SDK platform `android-37.0` and build-tools 36. `compileSdk` is 37, `targetSdk` is 36, `minSdk` is 29 (Android 10), which covers current Galaxy Tabs.
- A tablet or a stylus-capable emulator. Fingers navigate; a mouse can ink, so a desktop emulator can still draw.

## Build

From `android/`:

```bash
# Either export the SDK or write android/local.properties (gitignored):
#   sdk.dir=/path/to/Android/sdk
export ANDROID_HOME="$HOME/Android/Sdk"

./gradlew :core:test
./gradlew :app:assembleDebug
```

The debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`. Install it with `adb install -r` that file. Android Studio can open the `android/` directory directly; the Gradle wrapper is 9.6 and the Android Gradle Plugin is 9.4 (built-in Kotlin 2.2.10).

`:core:test` does not need a device. It checks the FAMD codec, the ink JSON shape, palm rejection, vault round-trips, the WebCrypto sync vectors, and a two-device sync against an in-memory server.

## Use

The app starts in a private vault on the tablet and creates a welcome note. **Vault-Ordner öffnen** attaches a directory you choose; that permission is kept across restarts. **Tablet-Vault verwenden** switches back to the private vault.

**Anmelden** uses the same email and password as the desktop app. The password never leaves the device. The auth key is derived with PBKDF2, and note bytes are AES-256-GCM before upload. A forgotten password cannot be recovered; the dialog says so before an account is created. Sync runs when you edit (about 2.5 seconds after the last change), every minute, and when the network returns. The status button shows whether the vault is signed out, syncing, offline, or in sync.

## Project map

```text
android/core     Vault codec, ink model, palm policy, sync crypto and engine
android/app      Tablet UI, ink surface, storage, OkHttp, foreground sync
```
