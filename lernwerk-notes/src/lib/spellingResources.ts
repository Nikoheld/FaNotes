import type {
  SpellingFilterManifest,
  SpellingLanguage,
  SpellingResources,
  SpellingWordCandidatesResource,
} from '../types'

const MAX_MANIFEST_BYTES = 16 * 1024
const MAX_FILTER_BYTES = 2 * 1024 * 1024
const MAX_CANDIDATE_BYTES = 8 * 1024 * 1024
const FILES: Record<SpellingLanguage, string> = { de: 'de.bloom', en: 'en.bloom' }
const CANDIDATE_FILES: Record<SpellingLanguage, string> = { de: 'de.words', en: 'en.words' }

const isManifest = (value: unknown): value is SpellingFilterManifest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<SpellingFilterManifest>
  if (candidate.format !== 'fanotes-spelling-bloom-v2' || candidate.hashes !== 8 || !candidate.languages) return false
  return (Object.keys(FILES) as SpellingLanguage[]).every((language) => {
    const filter = candidate.languages?.[language]
    return filter?.file === FILES[language]
      && Number.isSafeInteger(filter.bitCount)
      && filter.bitCount > 0
      && filter.bitCount % 8 === 0
      && Number.isSafeInteger(filter.wordCount)
      && filter.wordCount > 10_000
      && /^[a-f0-9]{64}$/u.test(filter.sha256)
      && filter.candidates?.file === CANDIDATE_FILES[language]
      && Number.isSafeInteger(filter.candidates.size)
      && filter.candidates.size > 100_000
      && filter.candidates.size <= MAX_CANDIDATE_BYTES
      && Number.isSafeInteger(filter.candidates.wordCount)
      && filter.candidates.wordCount > 10_000
      && /^[a-f0-9]{64}$/u.test(filter.candidates.sha256)
  })
}

const fetchBounded = async (url: URL, maximumBytes: number) => {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Rechtschreibressource nicht verfügbar (${response.status}).`)
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (declaredLength > maximumBytes) throw new Error('Rechtschreibressource ist unerwartet groß.')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.byteLength || bytes.byteLength > maximumBytes) throw new Error('Rechtschreibressource ist leer oder unerwartet groß.')
  return bytes
}

export async function loadBrowserSpellingResources(): Promise<SpellingResources> {
  const root = new URL('./spell/', document.baseURI)
  const manifestBytes = await fetchBounded(new URL('manifest.json', root), MAX_MANIFEST_BYTES)
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown
  if (!isManifest(manifest)) throw new Error('Das lokale Rechtschreibwörterbuch ist beschädigt.')

  const [de, en] = await Promise.all([
    fetchBounded(new URL(manifest.languages.de.file, root), MAX_FILTER_BYTES),
    fetchBounded(new URL(manifest.languages.en.file, root), MAX_FILTER_BYTES),
  ])
  if (de.byteLength * 8 !== manifest.languages.de.bitCount || en.byteLength * 8 !== manifest.languages.en.bitCount) {
    throw new Error('Das lokale Rechtschreibwörterbuch besitzt eine ungültige Länge.')
  }
  return { manifest, de, en }
}

let manifestPromise: Promise<SpellingFilterManifest> | null = null

const loadManifest = async () => {
  manifestPromise ??= (async () => {
    const root = new URL('./spell/', document.baseURI)
    const bytes = await fetchBounded(new URL('manifest.json', root), MAX_MANIFEST_BYTES)
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (!isManifest(manifest)) throw new Error('Das lokale Rechtschreibwörterbuch ist beschädigt.')
    return manifest
  })().catch((error) => {
    manifestPromise = null
    throw error
  })
  return manifestPromise
}

export async function loadBrowserSpellingWordCandidates(
  language: SpellingLanguage,
): Promise<SpellingWordCandidatesResource> {
  const manifest = await loadManifest()
  const descriptor = manifest.languages[language].candidates
  const root = new URL('./spell/', document.baseURI)
  const bytes = await fetchBounded(new URL(descriptor.file, root), MAX_CANDIDATE_BYTES)
  if (bytes.byteLength !== descriptor.size) throw new Error('Die OCR-Wortliste besitzt eine ungültige Länge.')
  return { language, descriptor, bytes }
}
