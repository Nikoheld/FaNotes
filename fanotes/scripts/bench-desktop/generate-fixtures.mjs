#!/usr/bin/env node
// Deterministic benchmark vault for scripts/bench-desktop.
//
//   node generate-fixtures.mjs --out <dir> [--files 2000] [--seed 20261115]
//                              [--story-root <fanotes dir of a writing-mode checkout>] [--story-pages 600]
//
// Same seed → same bytes, file names and mtimes (fixture-manifest.json holds the
// SHA-256 of every file and one digest over all of them). The vault holds:
//   Start/Letzte Notiz.md         the note the app reopens at startup (~6 KB)
//   Start/Tippen.md               the typing-latency note (~2 KB)
//   Gross/Langes Dokument.md      a very long markdown note (~600 A4 pages, ~1.8 MB)
//   Skripte/Skript 200 Seiten.pdf a 200-page PDF (text + vector figures)
//   Skripte/*.pdf                 smaller PDFs
//   Fach-XX/*.md                  ordinary notes, 300 B – 12 KB
//   Handschrift/*.famd            .famd notes with ink (fanotes-famd-v1)
//   Bilder/*.png                  images
//   .fanotes/assets/ink-*.json    drawings referenced from notes (+ preview PNG)
//   Schreiben/Roman.story/        only with --story-root: a story of ~--story-pages pages
// --files is the total number of files in the vault (the sync benchmark's 2,000).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { famdV1, inkDrawing, markdownNote, paragraph, pdf, png, prng, sentence } from './lib/fixture-formats.mjs'

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, values) => (value.startsWith('--') ? [[value.slice(2), values[index + 1]?.startsWith('--') ? 'true' : values[index + 1]]] : [])))
const out = path.resolve(args.out || '')
if (!args.out) throw new Error('--out <dir> is required')
const totalFiles = Math.max(200, Number(args.files) || 2000)
const seed = Number(args.seed) || 20261115
const storyPages = Number(args['story-pages']) || 600
const BASE_TIME = Date.UTC(2026, 10, 1, 8, 0, 0)
const AT = new Date(BASE_TIME).toISOString()

if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`)
fs.mkdirSync(out, { recursive: true, mode: 0o700 })

const random = prng(seed)
const written = []
const write = (relative, content) => {
  const target = path.join(out, ...relative.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.writeFileSync(target, content, { mode: 0o600 })
  const when = new Date(BASE_TIME + written.length * 1000)
  fs.utimesSync(target, when, when)
  written.push(relative)
}

// The two notes the app tests open.
write('Start/Letzte Notiz.md', markdownNote(prng(seed + 1), 'Letzte Notiz', 6_000))
write('Start/Tippen.md', `${markdownNote(prng(seed + 2), 'Tippen', 2_000).trimEnd()}\n\n`)

// The very long note: ~600 A4 pages at ~3,000 characters a page.
write('Gross/Langes Dokument.md', markdownNote(prng(seed + 3), 'Langes Dokument', 600 * 3_000))

// PDFs.
write('Skripte/Skript 200 Seiten.pdf', pdf(prng(seed + 4), 200, 'Skript Analysis'))
const smallPdfs = 9
for (let index = 0; index < smallPdfs; index += 1) write(`Skripte/Blatt ${String(index + 1).padStart(2, '0')}.pdf`, pdf(prng(seed + 100 + index), 2 + ((index * 7) % 19), `Blatt ${index + 1}`))

// Drawings referenced from notes, with their preview images.
const drawings = 10
for (let index = 0; index < drawings; index += 1) {
  const id = `ink-${String(index).padStart(3, '0')}`
  write(`.fanotes/assets/${id}.json`, JSON.stringify(inkDrawing(prng(seed + 200 + index), id, `Skizze ${index + 1}`, 120 + index * 40, AT)))
  write(`.fanotes/assets/${id}.png`, png(prng(seed + 300 + index), 180, 254))
}

// Images.
const images = 30
for (let index = 0; index < images; index += 1) {
  const size = 64 + ((index * 53) % 449)
  write(`Bilder/Bild ${String(index + 1).padStart(2, '0')}.png`, png(prng(seed + 400 + index), size, Math.round(size * 0.75)))
}

// .famd notes with ink.
const famdNotes = 40
for (let index = 0; index < famdNotes; index += 1) {
  const noteRandom = prng(seed + 500 + index)
  const title = `Handschrift ${String(index + 1).padStart(2, '0')}`
  const ink = { ...inkDrawing(noteRandom, `famd-${index}`, title, 60 + ((index * 37) % 400), AT), searchTranscript: sentence(noteRandom) }
  write(`Handschrift/${title}.famd`, famdV1(markdownNote(noteRandom, title, 400 + ((index * 131) % 2_000)), ink, AT))
}

// Story (writing mode) before the filler notes, so --files stays the total.
let story = null
if (args['story-root']) {
  const { buildStory } = await import(pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), 'lib', 'story-fixture.mjs')))
  story = await buildStory({ writingRoot: path.resolve(args['story-root']), pages: storyPages, seed: seed + 900, at: AT })
  for (const [relative, content] of story.files) write(`Schreiben/Roman.story/${relative}`, content)
}

// Ordinary notes fill the vault up to --files.
const filler = totalFiles - written.length
if (filler < 100) throw new Error(`--files ${totalFiles} leaves only ${filler} ordinary notes`)
const folders = 20
for (let index = 0; index < filler; index += 1) {
  const folder = `Fach-${String(index % folders).padStart(2, '0')}`
  const noteRandom = prng(seed + 10_000 + index)
  // Mostly short notes, a few long ones (log-uniform 300 B .. 12 KB).
  const size = Math.round(300 * Math.exp(noteRandom.next() * Math.log(40)))
  let body = markdownNote(noteRandom, `Notiz ${index}`, size)
  if (index % 97 === 0) body += `\n<!-- fanotes-ink:ink-${String(index % drawings).padStart(3, '0')} -->\n`
  if (index % 61 === 0) body += `\n![Bild](../Bilder/Bild ${String((index % images) + 1).padStart(2, '0')}.png)\n`
  write(`${folder}/Notiz ${String(index).padStart(4, '0')}.md`, body)
}

const files = written.map((relative) => {
  const bytes = fs.readFileSync(path.join(out, ...relative.split('/')))
  return { path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}).sort((left, right) => (left.path < right.path ? -1 : 1))
const digest = createHash('sha256').update(files.map((file) => `${file.path}\0${file.sha256}`).join('\n')).digest('hex')
const manifest = {
  seed,
  files: files.length,
  bytes: files.reduce((sum, file) => sum + file.size, 0),
  digest,
  story: story ? { paragraphs: story.paragraphs, chapters: story.chapters, characters: story.characters, targetPages: storyPages } : null,
  entries: files,
}
// The manifest sits next to the vault, not in it (it would be synced otherwise).
fs.writeFileSync(`${out}.fixture-manifest.json`, `${JSON.stringify(manifest, null, 1)}\n`)
console.log(JSON.stringify({ out, files: manifest.files, bytes: manifest.bytes, digest, story: manifest.story }))
