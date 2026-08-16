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
const modes = new Set(process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => value.slice(2)))
const runUnit = modes.size === 0 || modes.has('unit')
const runLaunch = modes.size === 0 || modes.has('launch')

const assertNoLeak = (value, document, label) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const task of document.tasks) {
    assert.equal(text.includes(task.title), false, `${label} must not leak title ${task.title}`)
    if (task.notes) assert.equal(text.includes(task.notes), false, `${label} must not leak notes`)
  }
}

const assertSameTasks = (actual, expected, label) => {
  assert.ok(Array.isArray(actual), `${label} must return a task list`)
  assert.equal(actual.length, expected.length, `${label} must return every published task`)
  const byId = new Map(actual.map((task) => [task.id, task]))
  for (const task of expected) {
    const got = byId.get(task.id)
    assert.ok(got, `${label} missing task ${task.id}`)
    for (const field of ['id', 'title', 'notes', 'subject', 'dueDate', 'dueTime', 'done', 'kind', 'priority', 'createdAt', 'updatedAt']) {
      assert.equal(got[field], task[field], `${label} field ${field} for ${task.id}`)
    }
  }
}

const document = {
  version: 1,
  tasks: [
    {
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
    },
    {
      id: 'task-fr-2',
      title: 'Französisch Vokabeln',
      notes: 'Unité 4',
      subject: 'Französisch',
      dueDate: '2026-08-21',
      dueTime: '09:00',
      done: false,
      kind: 'appointment',
      priority: 'normal',
      createdAt: '2026-08-16T10:05:00.000Z',
      updatedAt: '2026-08-16T11:05:00.000Z',
    },
  ],
}

const vite = await createViteServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const {
    HOMEWORK_API_HOST,
    HOMEWORK_API_MIN_SECRET_LENGTH,
    HOMEWORK_CHANNEL_ID_PATTERN,
    generateHomeworkApiChannelId,
    generateHomeworkApiSecret,
    homeworkApiQueryUrl,
    homeworkApiSecretReady,
    homeworkDocumentToApiPayload,
    publishHomeworkList,
  } = await vite.ssrLoadModule('/src/lib/homeworkApi.ts')

  const {
    createHomeworkSecretRecord,
    resolveHomeworkApiQuery,
    verifyHomeworkSecret,
  } = await import(join(siteRoot, 'homework-api.mjs'))

  if (runUnit) {
    const payload = homeworkDocumentToApiPayload(document)
    assert.equal(payload.schemaVersion, 1)
    assertSameTasks(payload.tasks, document.tasks, 'document payload')
    assert.equal(homeworkApiSecretReady('short'), false)
    assert.equal(homeworkApiSecretReady('x'.repeat(HOMEWORK_API_MIN_SECRET_LENGTH)), true)
    assert.equal(HOMEWORK_API_HOST, 'fanotes.fasrv.ch')

    const off = resolveHomeworkApiQuery({ enabled: false, secretOk: false, payload })
    assert.equal(off.status, 404)
    assertNoLeak(off.body, document, 'toggle off')

    const noSecret = resolveHomeworkApiQuery({ enabled: true, secretOk: false, payload })
    assert.equal(noSecret.status, 401)
    assertNoLeak(noSecret.body, document, 'missing/wrong secret')

    const allowed = resolveHomeworkApiQuery({ enabled: true, secretOk: true, payload })
    assert.equal(allowed.status, 200)
    assertSameTasks(allowed.body.tasks, document.tasks, 'authenticated query')

    const secret = generateHomeworkApiSecret()
    const record = await createHomeworkSecretRecord(`  ${secret}  `)
    assert.equal(JSON.stringify(record).includes(secret), false)
    assert.equal(await verifyHomeworkSecret(secret, record), true, 'stored hash must match the trimmed secret')
    assert.equal(await verifyHomeworkSecret(`  ${secret}  `, record), true, 'verify must trim incoming secret')
    assert.equal(await verifyHomeworkSecret(`${secret}x`, record), false)

    const mainSource = await fs.readFile(join(appRoot, 'electron/main.cjs'), 'utf8')
    const secretBlock = /const SECRET_SETTING_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/u.exec(mainSource)
    assert.ok(secretBlock, 'desktop SECRET_SETTING_KEYS must exist')
    assert.match(secretBlock[1], /'homeworkApiSecret'/u, 'homework API password must be encrypted like other secrets')
    const appSource = await fs.readFile(join(appRoot, 'src/App.tsx'), 'utf8')
    assert.match(appSource, /openSettings/u, 'settings open must load protected secrets first')
    assert.match(appSource, /lastHomeworkSecretRef\.current = next\.homeworkApiSecret/u, 'decrypt then republish')
    console.log('UNIT deny/allow fields:', JSON.stringify({
      off: off.body,
      noSecret: noSecret.body,
      allowedTitles: allowed.body.tasks.map((task) => task.title),
      allowedFields: Object.keys(allowed.body.tasks[0]).sort(),
    }))
    console.log('Hausaufgaben-API-Unit erfolgreich: off/no-auth deny ohne Titel, Query-all mit allen Feldern.')
  }

  if (runLaunch) {
    const channelId = generateHomeworkApiChannelId()
    const secret = generateHomeworkApiSecret()
    assert.match(channelId, HOMEWORK_CHANNEL_ID_PATTERN)
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

    const readJson = async (response) => {
      try { return await response.json() } catch { return {} }
    }

    try {
      await waitForServer()
      const url = homeworkApiQueryUrl(channelId, ORIGIN)
      const off = await fetch(url)
      const offBody = await readJson(off)
      console.log('LAUNCH off', off.status, JSON.stringify(offBody))
      assert.equal(off.status, 404)
      assertNoLeak(offBody, document, 'launch off')

      const published = await publishHomeworkList({
        enabled: true,
        channelId,
        secret,
        document,
        origin: ORIGIN,
      })
      assert.equal(published.ok, true, `publish failed with ${published.status}`)
      console.log('LAUNCH published', published.status, url)

      const unauth = await fetch(url)
      const unauthBody = await readJson(unauth)
      console.log('LAUNCH no-auth', unauth.status, JSON.stringify(unauthBody))
      assert.ok(unauth.status === 401 || unauth.status === 404)
      assertNoLeak(unauthBody, document, 'launch no-auth')

      const wrong = await fetch(url, { headers: { Authorization: 'Bearer totally-wrong-secret-value' } })
      const wrongBody = await readJson(wrong)
      console.log('LAUNCH wrong-secret', wrong.status, JSON.stringify(wrongBody))
      assert.equal(wrong.status, 401)
      assertNoLeak(wrongBody, document, 'launch wrong-secret')

      for (const run of [1, 2]) {
        const listed = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } })
        const listedBody = await readJson(listed)
        console.log(`LAUNCH query-${run}`, listed.status, JSON.stringify(listedBody))
        assert.equal(listed.status, 200)
        assert.equal(listedBody.schemaVersion, 1)
        assertSameTasks(listedBody.tasks, document.tasks, `launch query ${run}`)
      }

      const stored = JSON.parse(await fs.readFile(join(homeworkDir, `${channelId}.json`), 'utf8'))
      assert.equal(JSON.stringify(stored).includes(secret), false, 'server must not store the plaintext secret')
      assert.ok(stored.hash && stored.salt)
      console.log('Hausaufgaben-API-Launch erfolgreich: enable/publish/query zweimal, keine Titel-Leaks.')
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }
} finally {
  await vite.close()
}
