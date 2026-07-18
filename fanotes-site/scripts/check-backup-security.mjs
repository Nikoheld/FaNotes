import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = 18_300 + Math.floor(Math.random() * 300)
const ORIGIN = `http://127.0.0.1:${PORT}`
const temporary = await fs.mkdtemp(join(tmpdir(), 'fanotes-backup-security-'))
const backupDir = join(temporary, 'backups')
const analyticsDir = join(temporary, 'analytics')
const enrollmentPath = join(temporary, 'enrollment-token')
const enrollment = randomBytes(36).toString('base64url')
await fs.writeFile(enrollmentPath, enrollment, { mode: 0o600 })

const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    FANOTES_HOST: '127.0.0.1',
    FANOTES_PORT: String(PORT),
    FANOTES_PUBLIC_ORIGIN: ORIGIN,
    FANOTES_BACKUP_DIR: backupDir,
    FANOTES_BACKUP_ENROLLMENT_TOKEN_PATH: enrollmentPath,
    FANOTES_ANALYTICS_DIR: analyticsDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childOutput = ''
child.stdout.on('data', (chunk) => { childOutput += chunk })
child.stderr.on('data', (chunk) => { childOutput += chunk })

const waitForServer = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Testserver wurde beendet:\n${childOutput}`)
    try {
      const response = await fetch(`${ORIGIN}/api/health`)
      if (response.ok) return
    } catch { /* The server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Testserver wurde nicht bereit:\n${childOutput}`)
}

const mutationHeaders = { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' }
const body = async (response) => {
  try { return await response.json() } catch { return {} }
}

try {
  await waitForServer()

  const anonymous = await fetch(`${ORIGIN}/api/v1/backups/register`, { method: 'POST', headers: mutationHeaders })
  assert.equal(anonymous.status, 401, 'Registrierung ohne privaten Einrichtungs-Code muss scheitern')

  const crossOrigin = await fetch(`${ORIGIN}/api/v1/backups/register`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.invalid', 'X-FaNotes-Enrollment': enrollment },
  })
  assert.equal(crossOrigin.status, 403, 'Fremde Origin muss blockiert werden')

  const registration = await fetch(`${ORIGIN}/api/v1/backups/register`, {
    method: 'POST',
    headers: { ...mutationHeaders, 'X-FaNotes-Enrollment': enrollment },
  })
  assert.equal(registration.status, 201)
  const recoveryCode = (await body(registration)).recoveryCode
  const recoveryMatch = /^fanotes1_([a-f0-9]{32})_([A-Za-z0-9_-]{43})$/u.exec(recoveryCode)
  assert.ok(recoveryMatch, 'Server muss einen hochentropischen Wiederherstellungscode ausgeben')
  const authorization = `FaNotes ${recoveryMatch[1]}.${recoveryMatch[2]}`

  const badAuth = await fetch(`${ORIGIN}/api/v1/backups/status`, { headers: { Authorization: `FaNotes ${recoveryMatch[1]}.${'A'.repeat(43)}` } })
  assert.equal(badAuth.status, 401, 'Falscher Schlüssel muss ohne Tresor-Leak scheitern')

  const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')
  const eicarDigest = createHash('sha256').update(eicar).digest('hex')
  const malware = await fetch(`${ORIGIN}/api/v1/backups/assets/${eicarDigest}`, {
    method: 'PUT',
    headers: { ...mutationHeaders, Authorization: authorization, 'Content-Type': 'image/png' },
    body: eicar,
  })
  assert.equal(malware.status, 422, 'ClamAV-Testsignatur muss blockiert werden')
  assert.match((await body(malware)).error, /Malware-Schutz|malware protection/iu)

  const image = await fs.readFile(join(ROOT, 'design-source', 'app-overview.png'))
  const imageDigest = createHash('sha256').update(image).digest('hex')
  const uploaded = await fetch(`${ORIGIN}/api/v1/backups/assets/${imageDigest}`, {
    method: 'PUT',
    headers: { ...mutationHeaders, Authorization: authorization, 'Content-Type': 'image/png' },
    body: image,
  })
  assert.equal(uploaded.status, 201, JSON.stringify(await body(uploaded.clone())))
  const cleanAsset = await body(uploaded)
  assert.match(cleanAsset.digest, /^[a-f0-9]{64}$/u)
  assert.ok(cleanAsset.size > 0)

  const traversal = await fetch(`${ORIGIN}/api/v1/backups/snapshot`, {
    method: 'PUT',
    headers: { ...mutationHeaders, Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 1,
      files: [{ path: '../../server.mjs', content: 'x', modifiedAt: new Date().toISOString() }],
      folders: [], assets: [], drawings: [], worksheets: [], settings: {}, onboardingComplete: true,
      training: { samples: [], labels: [], layouts: [] },
    }),
  })
  assert.equal(traversal.status, 422, 'Path Traversal muss vor dem Speichern scheitern')

  const saved = await fetch(`${ORIGIN}/api/v1/backups/snapshot`, {
    method: 'PUT',
    headers: { ...mutationHeaders, Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 1,
      files: [{ path: 'Mathematik/Test.md', content: '# Sicher\n\n$E=mc^2$', modifiedAt: new Date().toISOString() }],
      folders: [{ path: 'Mathematik', color: '#8b7cff' }],
      assets: [{ path: '.fanotes/assets/example.png', digest: cleanAsset.digest, mimeType: cleanAsset.mimeType, size: cleanAsset.size }],
      drawings: [], worksheets: [], settings: { theme: 'dark', lmStudioApiToken: 'must-not-survive' }, onboardingComplete: true,
      training: { samples: [], labels: [], layouts: [] },
    }),
  })
  assert.equal(saved.status, 200, JSON.stringify(await body(saved.clone())))

  const restored = await fetch(`${ORIGIN}/api/v1/backups/snapshot`, { headers: { Authorization: authorization } })
  assert.equal(restored.status, 200)
  const snapshot = await body(restored)
  assert.equal(snapshot.files.length, 1)
  assert.equal(snapshot.assets.length, 1)
  assert.equal(Object.hasOwn(snapshot.settings, 'lmStudioApiToken'), false, 'LM-Studio-Token darf nicht gespeichert werden')

  const restoredAsset = await fetch(`${ORIGIN}/api/v1/backups/snapshot/assets/${cleanAsset.digest}`, { headers: { Authorization: authorization } })
  assert.equal(restoredAsset.status, 200)
  const restoredBytes = Buffer.from(await restoredAsset.arrayBuffer())
  assert.equal(createHash('sha256').update(restoredBytes).digest('hex'), cleanAsset.digest)
  assert.equal(restoredBytes.length, cleanAsset.size)

  const deleted = await fetch(`${ORIGIN}/api/v1/backups`, { method: 'DELETE', headers: { ...mutationHeaders, Authorization: authorization } })
  assert.equal(deleted.status, 204)
  const afterDelete = await fetch(`${ORIGIN}/api/v1/backups/status`, { headers: { Authorization: authorization } })
  assert.equal(afterDelete.status, 401)

  console.log('Backup-Sicherheitsprüfung erfolgreich: Enrollment, Origin, Scrypt-Schlüssel, AV, Medien-CDR, Traversal, Secret-Filter, Restore-Hash und Löschung.')
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
  await fs.rm(temporary, { recursive: true, force: true })
}
