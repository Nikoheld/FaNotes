// A writing-mode story (`X.story/`) for the benchmarks, built with the model
// code of a feature/writing-mode checkout (its defaults, keys and sanitizer), so
// the files are exactly what that branch reads. Ids and timestamps are fixed.
import path from 'node:path'
import { createRequire } from 'node:module'
import { paragraph, prng } from './fixture-formats.mjs'

// Characters per A5 page at the default 11 pt body style (measured in the app:
// see RUST_DESKTOP_BENCHMARKS.md); used only to size the story.
const CHARS_PER_PAGE = 1_750

export const buildStory = async ({ writingRoot, pages, seed, at }) => {
  const require = createRequire(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'package.json'))
  const { createServer } = await import(require.resolve('vite'))
  const vite = await createServer({ root: writingRoot, configFile: false, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } })
  try {
    const defaults = await vite.ssrLoadModule('/src/writing/model/defaults.ts')
    const keys = await vite.ssrLoadModule('/src/writing/model/keys.ts')
    const sanitize = await vite.ssrLoadModule('/src/writing/model/sanitize.ts')
    const random = prng(seed)
    const { manifest } = defaults.newStory({ title: 'Roman', language: 'de', deviceId: 'bench0001', now: new Date(at) })
    manifest.id = 'benchstory000001'
    manifest.binder = []
    const targetChars = pages * CHARS_PER_PAGE
    const paragraphsPerChapter = 30
    const files = []
    let characters = 0
    let counter = 0
    let chapter = 0
    while (characters < targetChars) {
      const sceneId = `scene${String(chapter).padStart(6, '0')}`
      const sceneKeys = keys.keysBetween(null, null, paragraphsPerChapter)
      const paragraphs = []
      for (let index = 0; index < paragraphsPerChapter; index += 1) {
        counter += 1
        const text = paragraph(random, 3, 7)
        characters += text.length
        paragraphs.push({ id: `para${String(counter).padStart(8, '0')}`, key: sceneKeys[index], v: { bench0001: 1 }, style: index === 0 ? 'first' : 'body', runs: [{ text }] })
      }
      const scene = sanitize.sanitizeScene({ format: 'fanotes-story-scene-v1', id: sceneId, paragraphs }, sceneId)
      if (!scene) throw new Error('the writing-mode sanitizer refused a generated scene')
      files.push([`scenes/${sceneId}.json`, JSON.stringify(scene)])
      manifest.binder.push({ id: `chapter${String(chapter).padStart(6, '0')}`, kind: 'chapter', title: `Kapitel ${chapter + 1}`, children: [{ id: sceneId, kind: 'scene', title: 'Szene', status: 'draft' }] })
      chapter += 1
    }
    const clean = sanitize.sanitizeManifest(manifest)
    if (!clean) throw new Error('the writing-mode sanitizer refused the generated manifest')
    files.unshift(['story.json', JSON.stringify(clean, null, 2)])
    return { files, paragraphs: counter, chapters: chapter, characters }
  } finally {
    await vite.close()
  }
}
