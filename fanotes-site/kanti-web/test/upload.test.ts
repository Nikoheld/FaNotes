import { describe, expect, it } from 'vitest'
import { MemoryBackend } from '../src/vault/backend'
import { UPLOAD_MAX_BYTES, isListedUserFile, uniqueUploadPath, uploadFiles, uploadMessage, uploadNameParts } from '../src/vault/upload'
import { libraryNotes } from '../src/vault/notes'
import { vaultDe, vaultEn } from '../src/lib/i18n-vault'

const entry = (path: string) => ({ id: path, path, revision: 1, size: 1, mtimeMs: 1 })
const file = (name: string, text = 'x') => new File([text], name)

describe('upload names', () => {
  it('makes the name safe and keeps the extension', () => {
    expect(uploadNameParts('Bericht:Final?.docx')).toEqual({ stem: 'Bericht Final', ext: '.docx' })
    expect(uploadNameParts('../../evil.zip')).toEqual({ stem: 'evil', ext: '.zip' })
    expect(uploadNameParts('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: '.gz' })
    expect(uploadNameParts('Makefile')).toEqual({ stem: 'Makefile', ext: '' })
    expect(uploadNameParts('...').stem).toBe('File')
  })
  it('fits the 255-byte name limit', () => {
    const { stem, ext } = uploadNameParts(`${'ä'.repeat(300)}.docx`)
    expect(new TextEncoder().encode(stem + ext + ' 12').length).toBeLessThanOrEqual(255)
  })
  it('numbers a taken name, ignoring case, in the right folder', () => {
    const existing = ['Ordner/Folien.PPTX', 'Folien.pptx']
    expect(uniqueUploadPath('Ordner', 'folien.pptx', existing)).toBe('Ordner/folien 2.pptx')
    expect(uniqueUploadPath('Ordner', 'folien.pptx', [...existing, 'Ordner/folien 2.PPTX'])).toBe('Ordner/folien 3.pptx')
    expect(uniqueUploadPath('', 'neu.zip', existing)).toBe('neu.zip')
  })
  it('never joins another note\'s family', () => {
    expect(uniqueUploadPath('', 'Buch.famd', ['Buch.pdf'])).toBe('Buch 2.famd')
    expect(uniqueUploadPath('', 'Buch.md', ['Buch.pdf'])).toBe('Buch 2.md')
  })
})

describe('uploading several files', () => {
  it('stores each file, numbers equal names, skips a too large one and carries on', async () => {
    const backend = new MemoryBackend({ 'Ordner/a.docx': 'old' })
    const big = file('gross.zip')
    Object.defineProperty(big, 'size', { value: UPLOAD_MAX_BYTES + 1 })
    const progress: string[] = []
    const summary = await uploadFiles(backend, [file('a.docx', 'new'), file('a.docx', 'newer'), big, file('b.txt')], 'Ordner', (await backend.list()).map((item) => item.path), (done, total) => progress.push(`${done}/${total}`))
    expect(summary).toEqual({ uploaded: 3, tooLarge: ['gross.zip'], failed: [] })
    expect([...backend.files.keys()].sort()).toEqual(['Ordner/a 2.docx', 'Ordner/a 3.docx', 'Ordner/a.docx', 'Ordner/b.txt'])
    expect(new TextDecoder().decode(backend.files.get('Ordner/a.docx')!.bytes)).toBe('old')
    expect(progress.at(-1)).toBe('4/4')
  })
  it('counts a failing write and continues', async () => {
    const backend = new MemoryBackend()
    const real = backend.create.bind(backend)
    backend.create = async (path, bytes) => { if (path.startsWith('bad')) throw new Error('boom'); return real(path, bytes) }
    const summary = await uploadFiles(backend, [file('bad.zip'), file('ok.zip')], '', [])
    expect(summary).toEqual({ uploaded: 1, tooLarge: [], failed: ['bad.zip'] })
  })
  it('numbers again when the name was taken meanwhile', async () => {
    const backend = new MemoryBackend()
    backend.put('x.zip', new Uint8Array([1]))
    const summary = await uploadFiles(backend, [file('x.zip')], '', [])
    expect(summary.uploaded).toBe(1)
    expect(backend.files.has('x 2.zip')).toBe(true)
  })
  it('writes one summary line in both languages', () => {
    for (const t of [vaultDe, vaultEn]) {
      expect(uploadMessage({ uploaded: 3, tooLarge: [], failed: [] }, t)).toMatch(/3/u)
      expect(uploadMessage({ uploaded: 0, tooLarge: ['a.zip'], failed: [] }, t)).toContain('a.zip')
      const mixed = uploadMessage({ uploaded: 2, tooLarge: ['a.zip'], failed: [] }, t)
      expect(mixed).toContain('2')
      expect(mixed).toContain('a.zip')
    }
    expect(uploadMessage({ uploaded: 2, tooLarge: ['a.zip'], failed: ['b'] }, vaultEn)).toBe('2 uploaded, 1 too large (over 96 MB: a.zip), 1 could not be uploaded')
  })
})

describe('the library lists user files only', () => {
  it('shows a docx and a zip, hides dot-files, lock, temp and index files and a .famd companion', () => {
    const paths = ['Notiz.md', 'Notiz.famd', 'Buch.pdf', 'Buch.famd', 'Ordner/Bericht.docx', 'Ordner/Daten.ZIP', 'Ordner/.keep', 'Ordner/.versteckt.docx',
      '.privat/a.docx', '.fanotes/x.json', 'Ordner/~$Entwurf.docx', 'Ordner/Thumbs.db', 'Ordner/desktop.ini', 'Ordner/x.tmp', 'Einzeln.famd']
    expect(libraryNotes(paths.map(entry)).map((note) => note.path).sort()).toEqual(['Buch.pdf', 'Einzeln.famd', 'Notiz.md', 'Ordner/Bericht.docx', 'Ordner/Daten.ZIP'])
    expect(libraryNotes([entry('a.docx')])[0].kind).toBe('other')
    expect(isListedUserFile('a/.x')).toBe(false)
  })
})
