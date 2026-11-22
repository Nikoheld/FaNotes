// Windows-only bugs, checked on any OS: busy-file retry, names NTFS cannot hold, NTFS case rules, byte order marks.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const appRoot = fileURLToPath(new URL('..', import.meta.url))
const { renameWithRetry, openWithRetry, retryWhileBusy } = require('../electron/fs-retry.cjs')
const { isWindowsUnsafeSegment, isWindowsUnsafePath, safeEntryName, samePhysicalPath } = require('../electron/entry-names.cjs')
const { hasBom, stripBom } = require('../electron/line-endings.cjs')
const { createSyncHost } = require('../electron/sync.cjs')

const busy = (code) => Object.assign(new Error(code), { code })

// A file held by Defender / OneDrive: rename and open are retried with backoff on Windows only.
{
  const waits = []
  const wait = async (ms) => { waits.push(ms) }
  let calls = 0
  await renameWithRetry('a', 'b', { platform: 'win32', wait, rename: async () => { calls += 1; if (calls < 4) throw busy(['EBUSY', 'EPERM', 'EACCES'][calls - 1]) } })
  assert.equal(calls, 4)
  assert.deepEqual(waits, [20, 40, 80])
  calls = 0
  await assert.rejects(renameWithRetry('a', 'b', { platform: 'linux', wait, rename: async () => { calls += 1; throw busy('EPERM') } }), { code: 'EPERM' })
  assert.equal(calls, 1, 'no retry outside Windows')
  calls = 0
  await assert.rejects(renameWithRetry('a', 'b', { platform: 'win32', wait, rename: async () => { calls += 1; throw busy('ENOENT') } }), { code: 'ENOENT' })
  assert.equal(calls, 1, 'other errors are not retried')
  calls = 0
  await assert.rejects(retryWhileBusy(async () => { calls += 1; throw busy('EBUSY') }, { platform: 'win32', wait, delays: [1, 2] }), { code: 'EBUSY' })
  assert.equal(calls, 3, 'gives up after the last delay')
  assert.equal(await openWithRetry('x', 0, 0o600, { platform: 'win32', wait, open: async () => 'handle' }), 'handle')
}

// Names Windows cannot hold.
for (const name of ['a:b.md', 'C:x', 'CON', 'con.md', 'Nul.txt', 'COM1.md', 'lpt9', 'COM\u00b9.md', 'CONIN$', 'note.', 'note ', 'what?.md', 'a|b', 'a"b', '<x>', 'a*b', 'tab\tname', '']) {
  assert.ok(isWindowsUnsafeSegment(name), `${JSON.stringify(name)} must be unsafe`)
}
for (const name of ['Notiz.md', 'COM10.md', 'console.md', 'a b.md', '.fanotes', 'Mathe (2).md', 'auxiliary.md', 'Ü.md']) {
  assert.ok(!isWindowsUnsafeSegment(name), `${name} must be safe`)
}
assert.ok(isWindowsUnsafePath('Mathe/CON/Notiz.md'))
assert.ok(isWindowsUnsafePath('Mathe/Zeit 12:30.md'))
assert.ok(!isWindowsUnsafePath('Mathe/Zeit 12-30.md'))
assert.throws(() => safeEntryName('COM\u00b2.md', 'x'))
assert.throws(() => safeEntryName('CONOUT$', 'x'))

// NTFS ignores case: moving into the same folder spelled differently is not a move.
assert.ok(samePhysicalPath('C:\\Vault\\Notes', 'c:\\vault\\notes', 'win32'))
assert.ok(!samePhysicalPath('/vault/Notes', '/vault/notes', 'linux'))

// Notepad's byte order mark.
assert.ok(hasBom('\uFEFF# Titel'))
assert.equal(stripBom('\uFEFF# Titel'), '# Titel')
assert.equal(stripBom('# Titel'), '# Titel')

// The sync host never writes a name Windows would turn into a stream or a device.
{
  const root = mkdtempSync(join(tmpdir(), 'fanotes-win-review-'))
  try {
    const user = mkdtempSync(join(tmpdir(), 'fanotes-win-review-user-'))
    const make = (platform) => createSyncHost({ vaultRoot: async () => root, userDataDirectory: user, safeStorage: { isEncryptionAvailable: () => false }, platform })
    const bytes = new Uint8Array([104, 105])
    const windows = make('win32')
    for (const bad of ['Mathe/a:b.md', 'CON.md', 'Ordner/nul.txt', 'Notiz.md.', 'x/y ']) {
      await assert.rejects(windows.write(bad, bytes, 0), /Windows/u, bad)
    }
    await windows.write('Mathe/Zeit 12-30.md', bytes, 0)
    assert.equal(readFileSync(join(root, 'Mathe', 'Zeit 12-30.md'), 'utf8'), 'hi')
    await make('linux').write('Mathe/a:b.md', bytes, 0)
    rmSync(user, { recursive: true, force: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// The engine skips such remote names on a Windows device only.
{
  const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
  try {
    const { isSyncablePath, isWindowsUnsafeSyncName } = await vite.ssrLoadModule('/src/lib/sync/engine.ts')
    assert.ok(isSyncablePath('Mathe/a:b.md'))
    assert.ok(isSyncablePath('Mathe/a:b.md', { windowsNames: false }))
    for (const bad of ['Mathe/a:b.md', 'CON.md', 'Mathe/aux/x.md', 'Notiz.md.', 'Frage?.md', 'COM\u00b3.md']) {
      assert.ok(!isSyncablePath(bad, { windowsNames: true }), `${bad} must not sync to Windows`)
    }
    assert.ok(isSyncablePath('Mathe/Zeit 12-30.md', { windowsNames: true }))
    assert.ok(isSyncablePath('.fanotes/settings.json', { windowsNames: true }))
    assert.ok(isWindowsUnsafeSyncName('nul'))
  } finally {
    await vite.close()
  }
}

// Source guards for the wiring that cannot run off Windows.
const main = readFileSync(join(appRoot, 'electron/main.cjs'), 'utf8')
assert.match(main, /process\.platform === 'win32' && isWindowsUnsafePath\(trimmed\)/u, 'vault paths reject Windows-unsafe names on Windows')
assert.match(main, /else await renameWithRetry\(temporaryPath, targetPath\)/u, 'atomicWrite retries a busy target')
assert.match(main, /await renameWithRetry\(source, destination\)/u, 'moves retry a busy file')
assert.match(main, /stripBom\(buffer\.toString\('utf8'\)\)/u, 'read-file drops the byte order mark')
for (const file of ['sync.cjs', 'note-history.cjs', 'onenote-importer.cjs', 'local-mcp-vault.cjs']) {
  assert.match(readFileSync(join(appRoot, 'electron', file), 'utf8'), /renameWithRetry\(/u, `${file} retries busy renames`)
}
console.log('Windows review checks passed')
