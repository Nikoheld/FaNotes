import type {
  HandwritingRecognitionManifest,
  HandwritingRecognitionResources,
} from '../types'

const MAX_MANIFEST_BYTES = 16 * 1024
const MAX_MODEL_BYTES = 32 * 1024 * 1024
const MAX_RUNTIME_BYTES = 16 * 1024 * 1024
const MAX_CHARACTERS_BYTES = 256 * 1024

const SHA256 = /^[a-f0-9]{64}$/u

const isFileDescriptor = (value: unknown, maximumBytes: number): value is {
  file: string
  size: number
  sha256: string
} => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const descriptor = value as { file?: unknown; size?: unknown; sha256?: unknown }
  return typeof descriptor.file === 'string'
    && /^[a-z0-9][a-z0-9._-]*$/u.test(descriptor.file)
    && Number.isSafeInteger(descriptor.size)
    && Number(descriptor.size) > 0
    && Number(descriptor.size) <= maximumBytes
    && typeof descriptor.sha256 === 'string'
    && SHA256.test(descriptor.sha256)
}

const isManifest = (value: unknown): value is HandwritingRecognitionManifest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<HandwritingRecognitionManifest>
  return candidate.format === 'fanotes-neural-handwriting-v3'
    && candidate.models?.desktop?.name === 'PyLaia_IAM_CTC'
    && candidate.models.desktop.precision === 'fp32'
    && isFileDescriptor(candidate.models.desktop, MAX_MODEL_BYTES)
    && candidate.models?.web?.name === 'PyLaia_IAM_CTC'
    && candidate.models.web.precision === 'q8-dynamic'
    && isFileDescriptor(candidate.models.web, MAX_MODEL_BYTES)
    && candidate.models.web.size < candidate.models.desktop.size * 0.4
    && candidate.runtime?.name === 'onnxruntime-web'
    && candidate.runtime.version === '1.22.0'
    && isFileDescriptor(candidate.runtime, MAX_RUNTIME_BYTES)
    && Number.isSafeInteger(candidate.characters?.count)
    && Number(candidate.characters?.count) >= 64
    && Number(candidate.characters?.count) <= 20_000
    && isFileDescriptor(candidate.characters, MAX_CHARACTERS_BYTES)
}

const fetchBounded = async (url: URL, expectedBytes: number, maximumBytes: number) => {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Lokales Handschriftmodell nicht verfügbar (${response.status}).`)
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (declaredLength && declaredLength !== expectedBytes) throw new Error('Das lokale Handschriftmodell besitzt eine ungültige Länge.')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== expectedBytes || bytes.byteLength > maximumBytes) {
    throw new Error('Das lokale Handschriftmodell ist beschädigt oder unvollständig.')
  }
  return bytes
}

const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))]
  .map((value) => value.toString(16).padStart(2, '0'))
  .join('')

export async function loadBrowserHandwritingRecognitionResources(): Promise<HandwritingRecognitionResources> {
  const root = new URL('./ocr/', document.baseURI)
  const manifestResponse = await fetch(new URL('manifest.json', root), { credentials: 'same-origin' })
  if (!manifestResponse.ok) throw new Error(`Handschriftmodell-Manifest nicht verfügbar (${manifestResponse.status}).`)
  const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer())
  if (!manifestBytes.byteLength || manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error('Das Handschriftmodell-Manifest ist beschädigt.')
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown
  if (!isManifest(manifest)) throw new Error('Das Handschriftmodell-Manifest ist ungültig.')

  const [model, wasm, charactersBytes] = await Promise.all([
    fetchBounded(new URL(manifest.models.web.file, root), manifest.models.web.size, MAX_MODEL_BYTES),
    fetchBounded(new URL(manifest.runtime.file, root), manifest.runtime.size, MAX_RUNTIME_BYTES),
    fetchBounded(new URL(manifest.characters.file, root), manifest.characters.size, MAX_CHARACTERS_BYTES),
  ])
  const [modelDigest, wasmDigest, charactersDigest] = await Promise.all([
    sha256(model), sha256(wasm), sha256(charactersBytes),
  ])
  if (
    modelDigest !== manifest.models.web.sha256
    || wasmDigest !== manifest.runtime.sha256
    || charactersDigest !== manifest.characters.sha256
  ) throw new Error('Das lokale Handschriftmodell hat die Integritätsprüfung nicht bestanden.')
  const parsedCharacters = JSON.parse(new TextDecoder().decode(charactersBytes)) as unknown
  if (
    !Array.isArray(parsedCharacters)
    || parsedCharacters.length !== manifest.characters.count
    || parsedCharacters.some((character) => typeof character !== 'string' || Array.from(character).length !== 1)
  ) {
    throw new Error('Der Zeichensatz des Handschriftmodells ist ungültig.')
  }
  return { manifest, model, wasm, characters: parsedCharacters }
}
