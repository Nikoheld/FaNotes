// The Android recognition host (src/recognitionHost) and the tablet's Kotlin side agree on the
// bridge encoding: float32 arrays as base64 of their little-endian bytes. The same vector is
// asserted in android/core RecognitionCoreTest.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const { float32ToBase64, base64ToFloat32 } = await server.ssrLoadModule('/src/recognitionHost/codec.ts')
  const values = new Float32Array([1, -2.5, 0.1, 3.4028234663852886e38])
  assert.equal(float32ToBase64(values), 'AACAPwAAIMDNzMw9//9/fw==')
  assert.deepEqual(Array.from(base64ToFloat32('AACAPwAAIMDNzMw9//9/fw==')), Array.from(values))
  assert.throws(() => base64ToFloat32('AAA='), /unvollständig/u)
  // A whole line image (64 × 2048) survives the round trip, also past the 32 KiB chunk size.
  const image = new Float32Array(64 * 2048).map((_, index) => (index % 97) / 96)
  assert.deepEqual(base64ToFloat32(float32ToBase64(image)), image)
  // The bundle entry and the app's pinned model manifest stay in place.
  assert.match(fs.readFileSync('recognition.html', 'utf8'), /src\/recognitionHost\/main\.ts/u)
  assert.equal(
    fs.readFileSync('../android/app/src/main/assets/recognition/fanotes-ink-manifest.json', 'utf8'),
    fs.readFileSync('public/ocr/fanotes-ink/manifest.json', 'utf8'),
  )
  console.log('Android-Erkennungshost erfolgreich: Brückenkodierung und Modellmanifest geprüft.')
} finally {
  await server.close()
}
