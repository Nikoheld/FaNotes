import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(siteRoot, '..')
const publicKey = createPublicKey(fs.readFileSync(path.join(root, 'fanotes/electron/update-public-key.pem'), 'utf8'))
const expectedKeyId = createHash('sha256')
  .update(publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex')
  .slice(0, 16)
const origin = process.env.FANOTES_UPDATE_ORIGIN || 'https://fanotes.fasrv.ch'
const currentVersion = process.env.FANOTES_CURRENT_VERSION || '2.34.1'
const handwritingManifest = JSON.parse(fs.readFileSync(path.join(siteRoot, 'public/notes/ocr/manifest.json'), 'utf8'))
const handwritingModel = handwritingManifest.models?.web
assert.equal(handwritingManifest.format, 'fanotes-neural-handwriting-v3')
assert.equal(handwritingModel?.precision, 'q8-dynamic')
const handwritingModelPath = `/notes/ocr/${handwritingModel.file}`
const contextManifest = JSON.parse(fs.readFileSync(path.join(siteRoot, 'public/notes/ocr/fanotes-trocr-web/manifest.json'), 'utf8'))
const serverSource = fs.readFileSync(path.join(siteRoot, 'server.mjs'), 'utf8')

assert.ok(
  fs.statSync(path.join(siteRoot, 'public/notes/ocr', handwritingModel.file)).size <= 12 * 1024 * 1024,
  'The Q8 line model must remain inside the server’s general 12 MiB static limit.',
)
assert.equal(contextManifest.quantization, 'q8-encoder-q8-decoder')
for (const asset of contextManifest.assets.filter((candidate) => candidate.file.endsWith('.onnx'))) {
  const publicPath = `/notes/ocr/fanotes-trocr-web/${asset.file}`
  assert.match(serverSource, new RegExp(publicPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.ok(asset.size <= 100 * 1024 * 1024, `${publicPath} exceeds the explicit OCR asset limit.`)
}

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

const proseWithoutExamples = (releaseNotes) => releaseNotes
  .join(' ')
  .replace(/`[^`]*`/gu, ' ')
  .replace(/[“"][^”"]*[”"]/gu, ' ')

const fetchManifest = async (platform, language, channel) => {
  const response = await fetch(`${origin}/api/v1/updates/${platform}-x64?current=${currentVersion}&channel=${channel}`, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': language,
      'User-Agent': `FaNotes/${currentVersion} ${platform === 'windows' ? 'Windows' : 'Linux'} updater signature check`,
    },
  })
  assert.equal(response.status, 200, `${platform}/${language} update endpoint must respond successfully.`)
  const manifest = await response.json()
  assert.equal(manifest.channel, channel)
  assert.equal(manifest.signature?.algorithm, 'ed25519')
  assert.equal(manifest.signature?.keyId, expectedKeyId)
  const signature = Buffer.from(manifest.signature.value, 'base64')
  const payload = { ...manifest }
  delete payload.signature
  assert.equal(
    verify(null, Buffer.from(stableStringify(payload)), publicKey, signature),
    true,
    `${platform}/${language} manifest signature must verify after transport.`,
  )
  return manifest
}

for (const platform of ['linux', 'windows']) {
  for (const channel of ['stable', 'beta']) {
    const german = await fetchManifest(platform, 'de-CH,de;q=0.9', channel)
    const english = await fetchManifest(platform, 'en-US,en;q=0.9', channel)
    assert.deepEqual(
      { ...english, releaseNotes: [], signature: undefined },
      { ...german, releaseNotes: [], signature: undefined },
      `Signed ${platform}/${channel} manifests may differ only in localized notes and their signature.`,
    )
    if (german.releaseNotes.length) {
      assert.notDeepEqual(english.releaseNotes, german.releaseNotes, `${platform}/${channel} release notes must be localized before signing.`)
      assert.doesNotMatch(proseWithoutExamples(english.releaseNotes), /\b(?:die|der|das|und|wird|werden|behebt|lädt)\b|[äöüß]/iu)
    }
  }
}

console.log(`Live-Update-Signaturen für Linux und Windows sind auf Stable und Beta mit Schlüssel ${expectedKeyId} in Deutsch und Englisch gültig.`)
