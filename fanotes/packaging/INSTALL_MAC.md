# FaNotes on macOS

FaNotes ships a macOS disk image and a zip for Apple Silicon and Intel. Build them on a Mac; a Linux or Windows machine cannot sign or staple the package.

```bash
cd fanotes
npm ci
npm run dist:mac
```

The artifacts land in `release/`:

- `FaNotes-<version>-arm64.dmg` and `.zip` for Apple Silicon
- `FaNotes-<version>-x64.dmg` and `.zip` for Intel

The app uses the same handwriting, math, worksheet and sync code as Linux and Windows. The line recognizer runs on the CPU through ONNX Runtime. Pen input follows the same pointer path, including the macOS word-navigation shortcut already used by the note history.

Gatekeeper: the first open of an unsigned build needs a right-click → Open. A signed and notarized build can be added later with an Apple Developer certificate; this package does not embed one.
