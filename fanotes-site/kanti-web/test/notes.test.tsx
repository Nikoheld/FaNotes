import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { crc32Hex, collectPages, decode85, readFamd, stripPayload } from '../src/lib/famd'
import { plainText, renderMarkdown, type MarkdownHooks } from '../src/lib/markdown'
import { readStoryText } from '../src/lib/story'
import { buildTextIndex, folderContents, kindOf, libraryNotes, resolveVaultPath, resolveWikiLink, searchNotes, sortNotes } from '../src/vault/notes'
import { MemoryBackend } from '../src/vault/backend'
import type { VaultEntry } from '../src/vault/client'

const hooks: MarkdownHooks = { image: (src, alt) => <img data-src={src} alt={alt} />, openNote: () => {}, noteExists: (target) => target === 'Da' }
const html = (markdown: string) => renderToStaticMarkup(<>{renderMarkdown(markdown, hooks)}</>)

describe('markdown rendering is sanitised', () => {
  it('shows raw html and script as text and never as elements', () => {
    const out = html('Hallo <script>alert(1)</script> <img src=x onerror=alert(1)> <b>fett</b>\n\n<iframe src="https://x.test"></iframe>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
  it('only lets http(s) and mailto links through, with rel noopener', () => {
    const out = html('[ok](https://example.test) [mail](mailto:a@b.test) [bad](javascript:alert(1)) [data](data:text/html;base64,AAAA)')
    expect(out).toContain('href="https://example.test" target="_blank" rel="noopener noreferrer"')
    expect(out).toContain('href="mailto:a@b.test"')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('data:text/html')
  })
  it('renders the usual blocks and inline marks', () => {
    const out = html('# Titel\n\n**fett** *kursiv* ~~weg~~ `code`\n\n- a\n- [x] b\n\n1. eins\n\n> Zitat\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\nx < y\n```\n\n---')
    for (const part of ['<h1>Titel</h1>', '<strong>fett</strong>', '<em>kursiv</em>', '<del>weg</del>', '<code>code</code>', '<ul>', 'type="checkbox"', '<ol>', '<blockquote>', '<table>', 'x &lt; y', '<hr/>']) expect(out).toContain(part)
  })
  it('hides the app\'s data markers and the front matter; wiki links and vault images go through the hooks', () => {
    const out = html('---\ntitle: x\n---\nText <!-- fanotes-cards-v1 {"x":1} -->\n\n[[Da]] [[Weg|Anders]] ![Bild](a%20b.png) ![[c.png]] ![fremd](https://x.test/y.png)')
    expect(out).not.toContain('fanotes-cards')
    expect(out).not.toContain('title: x')
    expect(out).toContain('class="wikilink"')
    expect(out).toContain('class="wikilink missing"')
    expect(out).toContain('data-src="a b.png"')
    expect(out).toContain('data-src="c.png"')
  })
  it('makes plain text for searching', () => {
    expect(plainText('# Titel\n\n**fett** [Link](https://x.test) `c`\n\n```\nverborgen\n```')).toBe('Titel fett Link c')
  })
})

// The encoder of the app's base-85 (inverse of decode85) to build a packed stroke.
const A85 = "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvw"
const encode85 = (bytes: Uint8Array) => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 4) {
    let v = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0
    let group = ''
    for (let k = 0; k < 5; k += 1) { group = A85[v % 85] + group; v = Math.floor(v / 85) }
    out += group
  }
  return out
}
const packed = (points: { x: number; y: number; pressure: number }[]) => {
  const bytes = new Uint8Array(points.length * 36)
  const view = new DataView(bytes.buffer)
  points.forEach((point, index) => {
    const o = index * 36
    view.setUint16(o, Math.round(point.x * 65535), true)
    view.setUint16(o + 2, Math.round(point.y * 65535), true)
    view.setFloat64(o + 4, point.pressure, true)
    view.setFloat64(o + 12, Number.NaN, true)
  })
  return encode85(bytes)
}

describe('handwriting notes (.famd)', () => {
  const payload = (ink: unknown) => JSON.stringify({ schema: 'fanotes-famd-v2', paperStyle: 'grid', ink })
  const v2 = (markdown: string, json: string, crc = crc32Hex(json)) => `${markdown}\n<!-- fanotes-famd:v2 chars=${json.length} crc=${crc} -->\n${json}`

  it('reads a v2 note with a packed stroke and finds its page', () => {
    const ink = { sourceWidth: 900, sourceHeight: 1273, strokes: [{ famdPts: packed([{ x: 0.25, y: 0.5, pressure: 0.5 }, { x: 0.5, y: 0.75, pressure: 1 }]), baseWidth: 4 }] }
    const read = readFamd(v2('# Titel\n\nText', payload(ink)))
    expect(read.version).toBe(2)
    expect(read.markdown).toBe('# Titel\n\nText')
    const [page] = collectPages(read.payload)
    expect(page.paper).toBe('grid')
    const points = (page.doc.strokes[0] as { points: { x: number; y: number; pressure: number }[] }).points
    expect(points).toHaveLength(2)
    expect(points[0].x).toBeCloseTo(0.25, 3)
    expect(points[1].y).toBeCloseTo(0.75, 3)
    expect(points[1].pressure).toBe(1)
  })
  it('refuses a damaged payload without throwing and keeps the text', () => {
    const json = payload({ strokes: [] })
    const bad = readFamd(v2('Text', json, '00000000'))
    expect(bad.payload).toBeNull()
    expect(bad.error).toMatch(/checksum/u)
    expect(bad.markdown).toBe('Text')
    expect(readFamd('').payload).toBeNull()
    expect(readFamd('nur Text')).toEqual({ version: null, markdown: 'nur Text', payload: null })
  })
  it('strips the payload and decodes base-85 strictly', () => {
    expect(stripPayload(v2('Hallo', payload({ strokes: [] })))).toBe('Hallo')
    expect(() => decode85('abc')).toThrow()
    expect(crc32Hex('123456789')).toBe('cbf43926')
  })
  it('lists one page per PDF side page', () => {
    const ink = { kind: 'fanotes-pdf-side-pages', ink: [{ page: 2, ink: { strokes: [], sourceWidth: 600, sourceHeight: 800 } }, { page: 1, ink: { strokes: [], sourceWidth: 600, sourceHeight: 800 } }, { page: 3, ink: { strokes: [] } }] }
    expect(collectPages({ ink }).map((page) => page.label)).toEqual(['PDF 1', 'PDF 2'])
  })
})

const entry = (path: string, mtimeMs = 1, size = 10): VaultEntry => ({ id: path, path, revision: 1, size, mtimeMs })

describe('note library', () => {
  const entries = [
    entry('Mathematik/Ableitungen.md', 30), entry('Mathematik/Skript.pdf', 20), entry('Physik/Mechanik/Kraft.md', 50), entry('Idee.md', 10), entry('Foto.png', 5),
    entry('Hausaufgaben.md'), entry('Kalender.md'), entry('.fanotes/schulnetz/grade-book.json'), entry('Mathematik/.versteckt.md'),
    entry('Roman.story/story.json', 40), entry('Roman.story/scenes/abc.json', 60),
  ]
  const notes = libraryNotes(entries)
  it('hides the app\'s files and folders, groups a story into one entry', () => {
    expect(notes.map((note) => note.path).sort()).toEqual(['Foto.png', 'Idee.md', 'Mathematik/Ableitungen.md', 'Mathematik/Skript.pdf', 'Physik/Mechanik/Kraft.md', 'Roman.story'])
    expect(notes.find((note) => note.kind === 'story')).toMatchObject({ name: 'Roman', mtimeMs: 60, size: 20 })
    expect(kindOf('a.famd')).toBe('famd')
    expect(kindOf('a.M4A')).toBe('audio')
    expect(kindOf('x.zip')).toBe('other')
  })
  it('lists folders and notes of one level, recently edited first', () => {
    const root = folderContents(notes, '')
    expect(root.folders).toEqual(['Mathematik', 'Physik'])
    expect(sortNotes(root.notes, 'recent').map((note) => note.name)).toEqual(['Roman', 'Idee', 'Foto.png'])
    expect(sortNotes(root.notes, 'name').map((note) => note.name)).toEqual(['Foto.png', 'Idee', 'Roman'])
    expect(folderContents(notes, 'Physik').folders).toEqual(['Mechanik'])
    expect(folderContents(notes, 'Mathematik').notes.map((note) => note.name).sort()).toEqual(['Ableitungen', 'Skript'])
  })
  it('searches titles and text, titles first', async () => {
    const backend = new MemoryBackend({ 'Mathematik/Ableitungen.md': '# Ableitungen\n\nDie Potenzregel hilft.', 'Idee.md': 'Etwas über Potenzen', 'Physik/Mechanik/Kraft.md': 'F = m a' })
    const texts = new Map<string, string>()
    const libs = libraryNotes(await backend.list())
    await buildTextIndex(backend, libs, texts, () => false)
    expect(searchNotes(libs, 'potenz', texts).map((hit) => hit.note.name).sort()).toEqual(['Ableitungen', 'Idee'])
    // A title match comes before a text match.
    expect(searchNotes(libs, 'idee', new Map([['Mathematik/Ableitungen.md', 'idee im text']])).map((hit) => hit.note.name)).toEqual(['Idee', 'Ableitungen'])
    expect(searchNotes(libs, 'kraft', texts).map((hit) => hit.note.name)).toEqual(['Kraft'])
    expect(searchNotes(libs, 'k', texts)).toEqual([])
  })
  it('resolves paths and wiki links', () => {
    const known = new Set(entries.map((item) => item.path))
    expect(resolveVaultPath('Foto.png', 'Mathematik/Ableitungen.md', known)).toBe('Foto.png')
    expect(resolveVaultPath('../Foto.png', 'Mathematik/Ableitungen.md', known)).toBe('Foto.png')
    expect(resolveVaultPath('Skript.pdf', 'Mathematik/Ableitungen.md', known)).toBe('Mathematik/Skript.pdf')
    expect(resolveVaultPath('nirgends.png', 'Idee.md', known)).toBeNull()
    expect(resolveWikiLink('Kraft', notes)?.path).toBe('Physik/Mechanik/Kraft.md')
    expect(resolveWikiLink('Mathematik/Ableitungen', notes)?.path).toBe('Mathematik/Ableitungen.md')
    expect(resolveWikiLink('gibt es nicht', notes)).toBeNull()
  })
})

describe('stories (StoryReader.kt)', () => {
  it('reads the binder in order, skipping excluded nodes and deleted paragraphs', async () => {
    const files: Record<string, string> = {
      'story.json': JSON.stringify({ format: 'fanotes-story-v1', title: 'Roman', author: 'A', binder: [
        { id: 'part0001', kind: 'part', title: 'Teil 1', children: [{ id: 'scene001', kind: 'scene', title: 'Anfang' }, { id: 'scene002', kind: 'scene', title: 'Weg', exclude: true }] },
      ] }),
      'scenes/scene001.json': JSON.stringify({ format: 'fanotes-story-scene-v1', id: 'scene001', paragraphs: [
        { id: 'b', key: 'b', runs: [{ text: 'zweiter' }] }, { id: 'a', key: 'a', runs: [{ text: 'erster' }, { text: ' Satz' }] }, { id: 'c', key: 'c', deleted: true, runs: [{ text: 'gelöscht' }] },
      ] }),
      'scenes/scene002.json': JSON.stringify({ format: 'fanotes-story-scene-v1', id: 'scene002', paragraphs: [{ id: 'x', key: 'a', runs: [{ text: 'versteckt' }] }] }),
    }
    const story = await readStoryText(async (path) => files[path] ?? null)
    expect(story?.title).toBe('Roman')
    expect(story?.blocks.map((block) => `${block.kind}:${block.text}`)).toEqual(['part:Teil 1', 'scene:Anfang', 'paragraph:erster Satz', 'paragraph:zweiter'])
    expect(await readStoryText(async () => null)).toBeNull()
    expect(await readStoryText(async () => '{"format":"other"}')).toBeNull()
  })
})
