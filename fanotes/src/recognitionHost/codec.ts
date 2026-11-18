/**
 * Float32 arrays cross the Android JavaScript bridge as base64 of their little-endian bytes
 * (`ch.fasrv.fanotes.recognition.RecognitionCodec` on the Kotlin side). Strings are the only
 * type a `@JavascriptInterface` method passes cheaply; a JSON number array would be 4–6× larger.
 */

const CHUNK = 0x8000

export const float32ToBase64 = (values: Float32Array): string => {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

export const base64ToFloat32 = (encoded: string): Float32Array => {
  const binary = atob(encoded)
  if (binary.length % 4 !== 0) throw new Error('Die Modellausgabe ist unvollständig.')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Float32Array(bytes.buffer)
}
