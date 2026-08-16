import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const siteRoot = fileURLToPath(new URL('../../fanotes-site', import.meta.url))
const mainSource = await fs.readFile(join(appRoot, 'electron/main.cjs'), 'utf8')
const settingsSource = await fs.readFile(join(appRoot, 'src/components/SettingsModal.tsx'), 'utf8')
const defaultsSource = await fs.readFile(join(appRoot, 'src/defaults.ts'), 'utf8')
const typesSource = await fs.readFile(join(appRoot, 'src/types.ts'), 'utf8')
const appSource = await fs.readFile(join(appRoot, 'src/App.tsx'), 'utf8')
const catalog = JSON.parse(await fs.readFile(join(appRoot, 'resources/i18n/en.json'), 'utf8'))

const sourceNeedles = [
  [defaultsSource, 'experimentalHomeworkApi: false', 'API default off'],
  [typesSource, 'experimentalHomeworkApi: boolean', 'API setting type'],
  [settingsSource, "title=\"Hausaufgaben API\"", 'Experimentals toggle'],
  [settingsSource, 'count: 2', 'two experimental features'],
  [settingsSource, 'homeworkApiSecretReady', 'API infos wait for password'],
  [appSource, 'syncPublishedHomework', 'publish on persist/settings'],
  [mainSource, 'https://fanotes.fasrv.ch', 'desktop CSP may reach fasrv'],
  [catalog['Hausaufgaben API'] || '', 'Homework API', 'English catalog title'],
]

for (const [source, needle, label] of sourceNeedles) {
  if (!String(source).includes(needle)) throw new Error(`Hausaufgaben-API-Prüfung fehlgeschlagen: ${label}`)
}

const vite = await createViteServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  HOMEWORK_API_HOST,
  HOMEWORK_API_MIN_SECRET_LENGTH,
  HOMEWORK_CHANNEL_ID_PATTERN,
  generateHomeworkApiChannelId,
  generateHomeworkApiSecret,
  homeworkApiQueryUrl,
  homeworkApiSecretReady,
  homeworkDocumentToApiPayload,
} = await vite.ssrLoadModule('/src/lib/homeworkApi.ts')

const {
  createHomeworkSecretRecord,
  homeworkTasksToApiPayload,
  resolveHomeworkApiQuery,
  sanitizeHomeworkApiTask,
  verifyHomeworkSecret,
} = await import(join(siteRoot, 'homework-api.mjs'))

const sampleTask = {
  id: 'task-math-1',
  title: 'Mathe S. 12',
  notes: 'Heft mitbringen',
  subject: 'Mathematik',
  dueDate: '2026-08-20',
  dueTime: '08:15',
  done: false,
  kind: 'homework',
  priority: 'high',
  createdAt: '2026-08-16T10:00:00.000Z',
  updatedAt: '2026-08-16T11:00:00.000Z',
}

try {
  const channelId = generateHomeworkApiChannelId()
  const secret = generateHomeworkApiSecret()
  assert.match(channelId, HOMEWORK_CHANNEL_ID_PATTERN)
  assert.equal(channelId.length, 32)
  assert.ok(homeworkApiSecretReady(secret))
  assert.ok(secret.length >= HOMEWORK_API_MIN_SECRET_LENGTH)
  assert.equal(homeworkApiSecretReady('short'), false)
  assert.equal(homeworkApiQueryUrl(channelId), `https://${HOMEWORK_API_HOST}/api/v1/homework/${channelId}`)

  const payload = homeworkDocumentToApiPayload({ version: 1, tasks: [sampleTask] })
  assert.equal(payload.schemaVersion, 1)
  assert.deepEqual(payload.tasks[0], sampleTask)

  const sanitized = sanitizeHomeworkApiTask(sampleTask)
  assert.equal(sanitized.title, sampleTask.title)
  assert.equal(sanitized.subject, 'Mathematik')
  assert.equal(sanitized.dueTime, '08:15')
  assert.equal(sanitized.priority, 'high')
  assert.equal(sanitizeHomeworkApiTask({ title: '' }), null)

  const deniedOff = resolveHomeworkApiQuery({ enabled: false, secretOk: true, payload })
  assert.equal(deniedOff.status, 404)
  assert.equal(JSON.stringify(deniedOff.body).includes('Mathe'), false, 'off must not leak titles')

  const deniedSecret = resolveHomeworkApiQuery({ enabled: true, secretOk: false, payload })
  assert.equal(deniedSecret.status, 401)
  assert.equal(JSON.stringify(deniedSecret.body).includes('Mathe'), false, 'wrong secret must not leak titles')

  const allowed = resolveHomeworkApiQuery({ enabled: true, secretOk: true, payload })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.body.tasks[0].title, 'Mathe S. 12')
  assert.equal(allowed.body.tasks[0].notes, 'Heft mitbringen')
  assert.equal(allowed.body.tasks[0].kind, 'homework')

  const record = await createHomeworkSecretRecord(secret)
  assert.ok(record.salt && record.hash)
  assert.equal(record.hash.includes(secret), false)
  assert.equal(await verifyHomeworkSecret(secret, record), true)
  assert.equal(await verifyHomeworkSecret(`${secret}x`, record), false)

  const PORT = 18_400 + Math.floor(Math.random() * 200)
  const ORIGIN = `http://127.0.0.1:${PORT}`
  const temporary = await fs.mkdtemp(join(tmpdir(), 'fanotes-homework-api-'))
  const homeworkDir = join(temporary, 'homework')
  await fs.writeFile(join(temporary, 'enrollment-token'), randomBytes(24).toString('base64url'), { mode: 0o600 })
  const child = spawn(process.execPath, [join(siteRoot, 'server.mjs')], {
    cwd: siteRoot,
    env: {
      ...process.env,
      FANOTES_HOST: '127.0.0.1',
      FANOTES_PORT: String(PORT),
      FANOTES_PUBLIC_ORIGIN: ORIGIN,
      FANOTES_HOMEWORK_DIR: homeworkDir,
      FANOTES_BACKUP_DIR: join(temporary, 'backups'),
      FANOTES_ANALYTICS_DIR: join(temporary, 'analytics'),
      FANOTES_BACKUP_ENROLLMENT_TOKEN_PATH: join(temporary, 'enrollment-token'),
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
      } catch { /* still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Testserver wurde nicht bereit:\n${childOutput}`)
  }

  const body = async (response) => {
    try { return await response.json() } catch { return {} }
  }

  try {
    await waitForServer()
    const url = `${ORIGIN}/api/v1/homework/${channelId}`
    const missing = await fetch(url)
    assert.equal(missing.status, 404)
    assert.equal(JSON.stringify(await body(missing)).includes('Mathe'), false)

    const foreignOrigin = await fetch(url, {
      method: 'PUT',
      headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, secret, tasks: [sampleTask] }),
    })
    assert.equal(foreignOrigin.status, 403, 'fremde Origin muss blockiert werden')

    const created = await fetch(url, {
      method: 'PUT',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, secret, tasks: [sampleTask] }),
    })
    assert.equal(created.status, 200, JSON.stringify(await body(created.clone())))

    const wrong = await fetch(url, { headers: { Authorization: 'Bearer totally-wrong-secret-value' } })
    assert.equal(wrong.status, 401)
    const wrongBody = JSON.stringify(await body(wrong))
    assert.equal(wrongBody.includes('Mathe'), false)
    assert.equal(wrongBody.includes('Heft'), false)

    const listed = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } })
    assert.equal(listed.status, 200)
    const listedBody = await body(listed)
    assert.equal(listedBody.tasks.length, 1)
    assert.equal(listedBody.tasks[0].title, 'Mathe S. 12')
    assert.equal(listedBody.tasks[0].subject, 'Mathematik')
    assert.equal(listedBody.tasks[0].dueDate, '2026-08-20')
    assert.equal(listedBody.tasks[0].dueTime, '08:15')
    assert.equal(listedBody.tasks[0].done, false)
    assert.equal(listedBody.tasks[0].kind, 'homework')
    assert.equal(listedBody.tasks[0].priority, 'high')
    assert.equal(listedBody.schemaVersion, 1)

    const nextSecret = generateHomeworkApiSecret()
    const rotated = await fetch(url, {
      method: 'PUT',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        secret: nextSecret,
        previousSecret: secret,
        tasks: homeworkTasksToApiPayload([sampleTask, { ...sampleTask, id: 'task-2', title: 'Französisch Vokabeln' }]).tasks,
      }),
    })
    assert.equal(rotated.status, 200, JSON.stringify(await body(rotated.clone())))

    const oldSecret = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } })
    assert.equal(oldSecret.status, 401)
    const newListed = await fetch(url, { headers: { Authorization: `Bearer ${nextSecret}` } })
    assert.equal(newListed.status, 200)
    assert.equal((await body(newListed)).tasks.length, 2)

    const stored = JSON.parse(await fs.readFile(join(homeworkDir, `${channelId}.json`), 'utf8'))
    assert.equal(JSON.stringify(stored).includes(nextSecret), false, 'server must not store the plaintext secret')
    assert.ok(stored.hash && stored.salt)

    const hijack = await fetch(url, {
      method: 'PUT',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, secret: generateHomeworkApiSecret(), tasks: [] }),
    })
    assert.equal(hijack.status, 401, 'channel takeover without the current secret must fail')

    const disabled = await fetch(url, {
      method: 'PUT',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, secret: nextSecret, tasks: [] }),
    })
    assert.equal(disabled.status, 200)
    const afterOff = await fetch(url, { headers: { Authorization: `Bearer ${nextSecret}` } })
    assert.equal(afterOff.status, 404)
    assert.equal(JSON.stringify(await body(afterOff)).includes('Französisch'), false)
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
    await fs.rm(temporary, { recursive: true, force: true })
  }

  console.log('Hausaufgaben-API-Prüfung erfolgreich: opt-in, Scrypt, Origin, Query-all, keine Titel-Leaks.')
} finally {
  await vite.close()
}
